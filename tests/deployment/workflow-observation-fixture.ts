import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  verifyWorkflowObservation,
  workflowObservationAudience,
  WORKFLOW_OBSERVATION_ISSUER,
  WORKFLOW_OBSERVATION_PATH,
  type CutoverObservation,
} from "@/deployment/workflow-observation";

export const OBSERVATION_NOW = new Date("2026-10-21T12:00:00.000Z");
export const OBSERVATION_TRUST = {
  repository: "example/project-krypto",
  repositoryId: "1234",
  repositoryOwnerId: "5678",
};
const pair = generateKeyPair("RS256", { modulusLength: 2048, extractable: true });

export async function signedCutoverFixture(
  overrides: Partial<CutoverObservation> = {},
  now = OBSERVATION_NOW,
  claims: JWTPayload = {},
) {
  const prefix = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/krypto/providers/Microsoft.App";
  const observation: CutoverObservation = {
    schemaVersion: 1,
    purpose: "cutover-release",
    workflow: { ...OBSERVATION_TRUST, sha: "b".repeat(40), runId: "9876", runAttempt: 1 },
    observedAt: new Date(now.getTime() - 2000).toISOString(),
    completedAt: new Date(now.getTime() - 1000).toISOString(),
    operationExecutionId: "run1-a1-deployment-admission",
    releaseSha: "b".repeat(40),
    imageDigest: `sha256:${"d".repeat(64)}`,
    opsImageDigest: `sha256:${"e".repeat(64)}`,
    targetOrigin: "https://krypto.example.com",
    resources: {
      web: `${prefix}/containerApps/ca-prod-web`,
      hourly: `${prefix}/jobs/caj-prod-agent-run`,
      daily: `${prefix}/jobs/caj-prod-daily-summary`,
      ops: `${prefix}/jobs/caj-prod-activation-check`,
    },
    owner: "11111111-1111-4111-8111-111111111111",
    sourceReleaseSha: "a".repeat(40),
    candidateReleaseSha: "b".repeat(40),
    sourceImageDigest: `sha256:${"c".repeat(64)}`,
    revision: "ca-prod-web--disabled",
    rolloutMode: "disabled",
    hourlyTriggerType: "Manual",
    dailyTriggerType: "Manual",
    inactiveRevisionsQuiescent: true,
    schedulerExecutionsQuiescent: true,
    ...overrides,
  };
  const { publicKey, privateKey } = await pair;
  const key = { ...await exportJWK(publicKey), kid: "test-observation", alg: "RS256" };
  const keys = createLocalJWKSet({ keys: [key] });
  const epoch = Math.floor(now.getTime() / 1000);
  const token = await new SignJWT({
    iss: WORKFLOW_OBSERVATION_ISSUER,
    sub: "repo:example@5678/project-krypto@1234:environment:production-deploy",
    aud: workflowObservationAudience(observation),
    iat: epoch - 1,
    nbf: epoch - 1,
    exp: epoch + 120,
    jti: randomUUID(),
    repository: OBSERVATION_TRUST.repository,
    repository_id: OBSERVATION_TRUST.repositoryId,
    repository_owner_id: OBSERVATION_TRUST.repositoryOwnerId,
    ref: "refs/heads/main",
    ref_type: "branch",
    workflow_ref: `${OBSERVATION_TRUST.repository}/${WORKFLOW_OBSERVATION_PATH}@refs/heads/main`,
    workflow_sha: observation.workflow.sha,
    run_id: observation.workflow.runId,
    run_attempt: String(observation.workflow.runAttempt),
    environment: "production-deploy",
    event_name: "workflow_dispatch",
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "test-observation" }).sign(privateKey);
  return {
    observation, token, keys,
    proof: JSON.stringify({ observation, token }),
    expected: {
      ...OBSERVATION_TRUST,
      purpose: "cutover-release" as const,
      workflowSha: "b".repeat(40),
      operationExecutionId: observation.operationExecutionId,
    },
  };
}

export async function verifiedCutoverFixture(
  overrides: Partial<CutoverObservation> = {},
  now = OBSERVATION_NOW,
) {
  const fixture = await signedCutoverFixture(overrides, now);
  return verifyWorkflowObservation(fixture.proof, fixture.expected, { now, keys: fixture.keys });
}
