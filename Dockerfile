# syntax=docker/dockerfile:1.7

# Project Krypto — Azure Container Apps runtime image.
#
# Produces two independent final targets (see ADR
# specs/decisions/0008-azure-native-deployment-architecture.md):
#
#   * `web` — minimal, non-root image for the always-on Container App and
#     for the scheduled-trigger Container Apps Job (see
#     src/deployment/scheduled-trigger.ts). Contains only the Next.js
#     standalone server, static assets, public files, and the
#     dependency-free scheduler runner.
#
#   * `ops` — full source + full dependency graph + PostgreSQL 17
#     client/server binaries for one-off/manually-triggered Container Apps
#     Jobs: Drizzle migrations, `pg_dump` backups, and scratch-loopback
#     restore verification (specs/deployment.md Step 5 /
#     src/deployment/backup.ts). Not used for recurring HTTP scheduling —
#     see `web`'s scheduler runner for that, which avoids needing this much
#     heavier image just to fire two HTTP calls on a timer.
#
# Build either target explicitly, e.g.:
#   docker build --target web -t project-krypto-web .
#   docker build --target ops -t project-krypto-ops .

# Pinned to satisfy `engines.node` (">=22.13.0 <23") in package.json.
ARG NODE_VERSION=22.13.0-bookworm-slim

################################################################################
# Stage: base — shared Node.js base image.
################################################################################
FROM node:${NODE_VERSION} AS base
WORKDIR /app

################################################################################
# Stage: deps — install the full dependency graph (including
# devDependencies) once. Reused by `builder` (needs devDependencies to run
# `next build`) and by the final `ops` stage (needs devDependencies to run
# drizzle-kit, tsx, etc. at operator invocation time).
################################################################################
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

################################################################################
# Stage: builder — produce the Next.js standalone production build.
################################################################################
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ is optional in this repo; ensure it exists so the `web` stage's
# COPY --from=builder .../public below is unconditionally valid.
RUN mkdir -p public
# Build-time environment validation (src/lib/config.ts) only needs
# syntactically valid values to let `next build` evaluate route modules; no
# real secret is baked into any image layer. Actual configuration is
# supplied at container start via Key-Vault-sourced environment variables.
ENV NEXT_TELEMETRY_DISABLED=1 \
    AZURE_OPENAI_BASE_URL=https://build-placeholder.openai.azure.com/openai/v1/ \
    AZURE_OPENAI_DEPLOYMENT_NAME=build-placeholder \
    AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000000 \
    AZURE_COMMUNICATION_CONNECTION_STRING="endpoint=https://build-placeholder.communication.azure.com/;accesskey=build-placeholder" \
    AZURE_COMMUNICATION_EMAIL_SENDER=DoNotReply@build-placeholder.azurecomm.net \
    ALERT_EMAIL_TO=operator@example.com \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    DATABASE_POOL_MAX=1 \
    AGENT_RUN_ADMISSION_CAPACITY=1 \
    COINBASE_DAILY_REQUEST_BUDGET=1000 \
    FOUNDRY_DAILY_REQUEST_BUDGET=200 \
    POSTHOG_DAILY_REQUEST_BUDGET=2000 \
    ACS_DAILY_REQUEST_BUDGET=100 \
    RELEASE_SHA=0000000000000000000000000000000000000000 \
    IMAGE_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000 \
    EXECUTION_CONTRACT_VERSION=bounded-sync-v1 \
    POSTHOG_API_KEY=build-placeholder \
    POSTHOG_ENVIRONMENT=dev \
    CRON_SECRET=build-placeholder \
    APP_ORIGIN=https://build-placeholder.example.com \
    ADMIN_PASSWORD=build-placeholder \
    ADMIN_SESSION_SECRET=build-placeholder \
    ROLLOUT_MODE=disabled
RUN npm run build

################################################################################
# Final stage: web — minimal, non-root runtime for the always-on Container
# App, and for the recurring scheduled-trigger Container Apps Job (override
# this image's CMD with the scheduler command below).
################################################################################
FROM node:${NODE_VERSION} AS web
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Next.js standalone output: a self-contained server.js plus only the
# production node_modules subset the app actually needs (no devDependencies,
# no full npm install at runtime).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Dependency-free scheduled-trigger runner for the recurring Container Apps
# Job that fires /api/agent/run and /api/agent/daily-summary on a schedule.
# Executed with Node's built-in TypeScript type stripping
# (--experimental-strip-types), so no TypeScript toolchain is installed in
# this image. See src/deployment/scheduled-trigger.ts for the full
# validation/request/idempotency implementation.
COPY --from=builder /app/scripts/scheduled-trigger.mjs ./scripts/scheduled-trigger.mjs
COPY --from=builder /app/src/deployment/scheduled-trigger.ts ./src/deployment/scheduled-trigger.ts
COPY --from=builder /app/scripts/safety-incident-relay.mjs ./scripts/safety-incident-relay.mjs
COPY --from=builder /app/src/deployment/safety-incident-relay.ts ./src/deployment/safety-incident-relay.ts

# The official Node images provision a non-root `node` user (uid/gid 1000).
USER node

EXPOSE 3000

# Default command runs the always-on web server. The scheduled-trigger
# Container Apps Job overrides this command to:
#   node --experimental-strip-types scripts/scheduled-trigger.mjs
CMD ["node", "server.js"]

################################################################################
# Final stage: ops — full source + full dependency graph + PostgreSQL 17
# client/server binaries, for manually-triggered/scheduled Container Apps
# Jobs that need Drizzle, pg_dump, and a scratch loopback restore target.
################################################################################
FROM node:${NODE_VERSION} AS ops
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- PostgreSQL 17 client + server binaries -----------------------------
# pg_dump/pg_restore (client) plus a full server (postgres/initdb/pg_ctl) so
# an ops job can stand up a throwaway, loopback-only PostgreSQL instance and
# restore a logical dump into it for backup verification
# (src/deployment/backup.ts, specs/deployment.md Step 5). Installed from the
# official, GPG-verified PGDG apt repository rather than Debian's own
# (older) postgresql package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates curl gnupg \
    && install -d -m 0755 /usr/share/keyrings \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/keyrings/pgdg.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         postgresql-17 postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

# Debian's postgresql-common only symlinks the *client* tools (psql, pg_dump,
# pg_restore, ...) onto PATH via update-alternatives. The server binaries
# (postgres, initdb, pg_ctl) needed to stand up the scratch loopback restore
# target live under the versioned libdir and are not on PATH by default.
ENV PATH="/usr/lib/postgresql/17/bin:${PATH}"

# --- AzCopy --------------------------------------------------------------
# Pinned to one exact release and verified against the sha256 GitHub itself
# publishes for that specific asset (the release API's `digest` field),
# so this step is fully reproducible and never silently picks up a newer
# AzCopy build. To bump the version: update AZCOPY_VERSION and both
# AZCOPY_SHA256_* values from that release's GitHub API asset digests
# (https://api.github.com/repos/Azure/azure-storage-azcopy/releases/tags/v<version>).
#
# If this step cannot be verified (checksum mismatch, asset unavailable),
# the build fails closed here rather than silently shipping an
# unverified/absent binary.
ARG AZCOPY_VERSION=10.32.7
ARG AZCOPY_SHA256_AMD64=99400b4640aac6467a27f4d99c29ba5f96b5723a0377908fec172a80848c9a63
ARG AZCOPY_SHA256_ARM64=5ef6fb329a54a2a17af55e2b9bddf2975ef4fa60a9de538fa41da6dfbeca0340
ARG TARGETARCH
RUN set -eu; \
    resolved_arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${resolved_arch}" in \
      amd64) azcopy_arch=x86_64; azcopy_sha256="${AZCOPY_SHA256_AMD64}" ;; \
      arm64) azcopy_arch=arm64; azcopy_sha256="${AZCOPY_SHA256_ARM64}" ;; \
      *) echo "Unsupported target architecture '${resolved_arch}' for AzCopy; add a pinned version+checksum for it above." >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/azcopy.deb \
      "https://github.com/Azure/azure-storage-azcopy/releases/download/v${AZCOPY_VERSION}/azcopy-${AZCOPY_VERSION}.${azcopy_arch}.deb"; \
    echo "${azcopy_sha256}  /tmp/azcopy.deb" | sha256sum -c -; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/azcopy.deb; \
    rm -rf /var/lib/apt/lists/* /tmp/azcopy.deb; \
    azcopy --version

# Full source + full dependency graph (including devDependencies: drizzle-kit,
# tsx, typescript) so operator-invoked jobs can run migrations, backups, and
# restore verification exactly as documented in specs/deployment.md.
#
# Reuse `deps`'s node_modules (installed with devDependencies intact, no
# NODE_ENV set at that point) instead of running `npm ci` again here: doing
# `npm ci` in this stage with NODE_ENV=production already set would silently
# omit devDependencies (drizzle-kit, tsx, typescript) that operator jobs
# require, so we deliberately never run npm install in this stage at all.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `azure:ops-job` (scripts/azure/ops-job.ts) writes its report under
# `resolve(process.cwd(), "ops-reports")` by default, i.e. /app/ops-reports.
# Create it and hand ownership of the whole app directory to the non-root
# `node` user so both the report directory and any operator-invoked
# migration/backup/restore command (drizzle-kit, tsx, pg_dump, initdb/pg_ctl
# against a scratch PGDATA under /tmp) can run without root.
RUN mkdir -p /app/ops-reports && chown -R node:node /app

# NODE_ENV=production is set only now, after node_modules already has
# devDependencies physically installed from the `deps` stage above, so it
# cannot cause any dependency to be silently dropped; it only affects
# runtime behavior (e.g. some libraries branch on it).
ENV NODE_ENV=production

# initdb (used for the scratch loopback restore target) refuses to run as
# the root Unix user; run this stage as the same non-root `node` user the
# `web` stage uses. `docker run --user root ... bash` can still override
# this for one-off root-only diagnostics if ever needed.
USER node

# Default command runs the strict, validated Azure ops job entrypoint
# (scripts/azure/ops-job.ts, dispatched by OPERATION/ENVIRONMENT_NAME/
# RELEASE_SHA/JOB_EXECUTION_ID/EVIDENCE_CONTAINER_URL). Override with an
# explicit command for ad hoc invocations, e.g.:
#   docker run ... project-krypto-ops npx drizzle-kit migrate
#   docker run ... project-krypto-ops npx tsx scripts/create-verified-backup.ts
CMD ["npm", "run", "azure:ops-job"]
