-- Durable append-only safety incident evidence (GitHub issue #125).
-- This migration preserves all existing run, trade, journal, and state rows.
SET ROLE "krypto_schema_owner";
--> statement-breakpoint
CREATE TYPE "krypto"."SafetyIncidentEventKind" AS ENUM('CREATED', 'ACKNOWLEDGED', 'ESCALATED', 'RESOLVED', 'DELIVERY_CONFIRMED', 'DELIVERY_FAILED');--> statement-breakpoint
CREATE TYPE "krypto"."SafetyIncidentSeverity" AS ENUM('WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "krypto"."SafetyIncidentStatus" AS ENUM('OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "krypto"."SafetyIncidentType" AS ENUM('PAPER_TRADE_POST_COMMIT', 'POST_COMMIT_FAILURE', 'TELEMETRY_FAILURE', 'JOURNAL_FAILURE', 'EMAIL_DELIVERY_FAILURE', 'DAILY_DELIVERY_OBLIGATION', 'DRAWDOWN_LOCK', 'STALE_OR_OVERLAPPING_LEASE', 'RECONCILIATION_QUARANTINE', 'UNEXPECTED_SHADOW_TRADE', 'AUTH_PROVENANCE_MISMATCH', 'PROVIDER_FAILURE', 'DEADLINE_BUDGET_EXHAUSTION', 'READINESS_CAPACITY_FAILURE', 'MISSING_RUN', 'CREDENTIAL_CONCERN', 'TEST_FIRE_WARNING', 'TEST_FIRE_CRITICAL', 'ROUTE_RUN_FAILURE');--> statement-breakpoint
CREATE TABLE "krypto"."SafetyIncidentOutbox" (
	"eventId" text PRIMARY KEY NOT NULL,
	"incidentId" text NOT NULL,
	"eventSequence" integer NOT NULL,
	"eventKind" "krypto"."SafetyIncidentEventKind" NOT NULL,
	"incidentType" "krypto"."SafetyIncidentType" NOT NULL,
	"severity" "krypto"."SafetyIncidentSeverity" NOT NULL,
	"status" "krypto"."SafetyIncidentStatus" NOT NULL,
	"dedupKey" text NOT NULL,
	"requestId" text NOT NULL,
	"agentRunId" text,
	"releaseId" text NOT NULL,
	"deploymentId" text NOT NULL,
	"providerAttemptId" text,
	"transactionId" text,
	"redactedContext" jsonb NOT NULL,
	"occurredAt" timestamp (3) with time zone NOT NULL,
	"persistedAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"acknowledgedAt" timestamp (3) with time zone,
	"resolvedAt" timestamp (3) with time zone,
	"escalatedAt" timestamp (3) with time zone,
	"ownerRole" text NOT NULL,
	"backupRole" text NOT NULL,
	"runbook" text NOT NULL,
	"actorId" text,
	"actorRole" text,
	"evidence" jsonb,
	CONSTRAINT "SafetyIncidentOutbox_eventSequence_positive_check" CHECK ("eventSequence" > 0),
	CONSTRAINT "SafetyIncidentOutbox_redactedContext_object_check" CHECK (jsonb_typeof("redactedContext") = 'object'),
	CONSTRAINT "SafetyIncidentOutbox_evidence_object_check" CHECK ("evidence" IS NULL OR jsonb_typeof("evidence") = 'object'),
	CONSTRAINT "SafetyIncidentOutbox_persistedAt_consistency_check" CHECK ("persistedAt" >= "occurredAt"),
	CONSTRAINT "SafetyIncidentOutbox_acknowledgedAt_consistency_check" CHECK ("acknowledgedAt" IS NULL OR "acknowledgedAt" >= "occurredAt"),
	CONSTRAINT "SafetyIncidentOutbox_escalatedAt_consistency_check" CHECK ("escalatedAt" IS NULL OR "escalatedAt" >= "occurredAt"),
	CONSTRAINT "SafetyIncidentOutbox_resolvedAt_consistency_check" CHECK ("resolvedAt" IS NULL OR "resolvedAt" >= "occurredAt"),
	CONSTRAINT "SafetyIncidentOutbox_event_timestamp_check" CHECK (("eventKind" <> 'ACKNOWLEDGED' OR "acknowledgedAt" IS NOT NULL)
        AND ("eventKind" <> 'ESCALATED' OR "escalatedAt" IS NOT NULL)
        AND ("eventKind" <> 'RESOLVED' OR "resolvedAt" IS NOT NULL)),
	CONSTRAINT "SafetyIncidentOutbox_status_timestamp_check" CHECK (("status" <> 'OPEN'
          OR ("acknowledgedAt" IS NULL AND "escalatedAt" IS NULL AND "resolvedAt" IS NULL))
        AND ("status" <> 'ACKNOWLEDGED'
          OR ("acknowledgedAt" IS NOT NULL AND "escalatedAt" IS NULL AND "resolvedAt" IS NULL))
        AND ("status" <> 'ESCALATED'
          OR ("escalatedAt" IS NOT NULL AND "resolvedAt" IS NULL))
        AND ("status" <> 'RESOLVED' OR "resolvedAt" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun" ADD COLUMN "requestId" text;--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun" ADD COLUMN "releaseId" text;--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun" ADD COLUMN "deploymentId" text;--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun" ADD COLUMN "providerAttemptId" text;--> statement-breakpoint
-- Deterministic, non-secret legacy provenance. No payload, credential, provider
-- response, or redacted incident context is copied into these columns.
UPDATE "krypto"."AgentRun"
SET
	"requestId" = 'legacy-agent-run:' || "id",
	"releaseId" = 'legacy-pre-0010',
	"deploymentId" = 'legacy-pre-0010'
WHERE "requestId" IS NULL
	OR "releaseId" IS NULL
	OR "deploymentId" IS NULL;
--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun" ALTER COLUMN "requestId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun" ALTER COLUMN "releaseId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."AgentRun" ALTER COLUMN "deploymentId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "krypto"."SafetyIncidentOutbox" ADD CONSTRAINT "SafetyIncidentOutbox_agentRunId_AgentRun_id_fk" FOREIGN KEY ("agentRunId") REFERENCES "krypto"."AgentRun"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "krypto"."SafetyIncidentOutbox" ADD CONSTRAINT "SafetyIncidentOutbox_transactionId_TradeExecution_id_fk" FOREIGN KEY ("transactionId") REFERENCES "krypto"."TradeExecution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "SafetyIncidentOutbox_incidentId_eventSequence_uidx" ON "krypto"."SafetyIncidentOutbox" USING btree ("incidentId","eventSequence");--> statement-breakpoint
CREATE UNIQUE INDEX "SafetyIncidentOutbox_created_dedupKey_uidx" ON "krypto"."SafetyIncidentOutbox" USING btree ("dedupKey") WHERE "eventKind" = 'CREATED';--> statement-breakpoint
CREATE INDEX "SafetyIncidentOutbox_incident_status_occurredAt_idx" ON "krypto"."SafetyIncidentOutbox" USING btree ("incidentId","status","occurredAt");--> statement-breakpoint
CREATE INDEX "SafetyIncidentOutbox_severity_status_occurredAt_idx" ON "krypto"."SafetyIncidentOutbox" USING btree ("severity","status","occurredAt");--> statement-breakpoint
CREATE INDEX "SafetyIncidentOutbox_agentRunId_idx" ON "krypto"."SafetyIncidentOutbox" USING btree ("agentRunId");--> statement-breakpoint
CREATE INDEX "SafetyIncidentOutbox_transactionId_idx" ON "krypto"."SafetyIncidentOutbox" USING btree ("transactionId");
--> statement-breakpoint

-- Validate the append-only state machine at the database boundary. Runtime may
-- create incident origins and append delivery evidence, but it cannot forge a
-- RESOLVED latest event. Protected owner/migrator operations remain the only
-- database path for human resolution until identity-bearing operator auth is
-- proven.
CREATE FUNCTION "krypto"."validate_safety_incident_outbox_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	prior "krypto"."SafetyIncidentOutbox"%ROWTYPE;
	complementary_role text;
	complementary_confirmations integer;
BEGIN
	IF jsonb_typeof(NEW."redactedContext") <> 'object'
		OR (
			NEW."evidence" IS NOT NULL
			AND jsonb_typeof(NEW."evidence") <> 'object'
		) THEN
		RAISE EXCEPTION 'Safety incident context/evidence must be objects'
			USING ERRCODE = 'check_violation';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM jsonb_each(NEW."redactedContext") AS item(key, value)
		WHERE item.key <> ALL (ARRAY[
			'accountingStatus', 'attempt', 'component', 'deliveryChannel',
			'drill', 'environment', 'expectedRunSlot', 'failureCode',
			'httpStatus', 'journalWritten', 'leaseAgeSeconds', 'locked',
			'operation', 'outcome', 'provider', 'reasonCode', 'reconciled',
			'rolloutMode', 'route', 'scenario', 'triggerSource'
		])
			OR jsonb_typeof(item.value) NOT IN (
				'string', 'number', 'boolean', 'null'
			)
			OR (
				jsonb_typeof(item.value) = 'string'
				AND (
					length(item.value #>> '{}') > 240
					OR (item.value #>> '{}') ~* '(https?://|postgres(ql)?://|bearer[[:space:]]|password|secret|token=|api[_-]?key)'
				)
			)
	) THEN
		RAISE EXCEPTION 'Safety incident context is not allowlisted/redacted'
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."evidence" IS NOT NULL AND EXISTS (
		SELECT 1
		FROM jsonb_each(NEW."evidence") AS item(key, value)
		WHERE item.key <> ALL (ARRAY[
			'affectedInterval', 'artifactRef', 'cause', 'contactPath',
			'containmentDecision', 'deliveryChannel', 'deliveryFailureCode',
			'deliveryReceiptId', 'deliveryAttemptId', 'drillScenario', 'followUpRef',
			'operationId', 'reason', 'reentryDecision', 'remediation',
			'residualRisk', 'retryOutcome', 'summary', 'verification'
		])
			OR jsonb_typeof(item.value) NOT IN (
				'string', 'number', 'boolean', 'null'
			)
			OR (
				jsonb_typeof(item.value) = 'string'
				AND (
					length(item.value #>> '{}') > 240
					OR (item.value #>> '{}') ~* '(https?://|postgres(ql)?://|bearer[[:space:]]|password|secret|token=|api[_-]?key)'
				)
			)
	) THEN
		RAISE EXCEPTION 'Safety incident evidence is not allowlisted/redacted'
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW."eventKind" = 'CREATED' THEN
		IF NEW."eventSequence" <> 1 OR NEW."status" <> 'OPEN' THEN
			RAISE EXCEPTION 'Safety incident origin must be sequence 1 and OPEN'
				USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (
			SELECT 1 FROM "krypto"."SafetyIncidentOutbox"
			WHERE "incidentId" = NEW."incidentId"
		) THEN
			RAISE EXCEPTION 'Safety incident origin already exists'
				USING ERRCODE = 'unique_violation';
		END IF;
		RETURN NEW;
	END IF;

	SELECT *
	INTO prior
	FROM "krypto"."SafetyIncidentOutbox"
	WHERE "incidentId" = NEW."incidentId"
	ORDER BY "eventSequence" DESC
	LIMIT 1;

	IF prior."eventId" IS NULL
		OR NEW."eventSequence" <> prior."eventSequence" + 1 THEN
		RAISE EXCEPTION 'Safety incident lifecycle sequence is not contiguous'
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW."incidentType" IS DISTINCT FROM prior."incidentType"
		OR NEW."severity" IS DISTINCT FROM prior."severity"
		OR NEW."dedupKey" IS DISTINCT FROM prior."dedupKey"
		OR NEW."requestId" IS DISTINCT FROM prior."requestId"
		OR NEW."agentRunId" IS DISTINCT FROM prior."agentRunId"
		OR NEW."releaseId" IS DISTINCT FROM prior."releaseId"
		OR NEW."deploymentId" IS DISTINCT FROM prior."deploymentId"
		OR NEW."providerAttemptId" IS DISTINCT FROM prior."providerAttemptId"
		OR NEW."transactionId" IS DISTINCT FROM prior."transactionId"
		OR NEW."redactedContext" IS DISTINCT FROM prior."redactedContext"
		OR NEW."occurredAt" IS DISTINCT FROM prior."occurredAt"
		OR NEW."ownerRole" IS DISTINCT FROM prior."ownerRole"
		OR NEW."backupRole" IS DISTINCT FROM prior."backupRole"
		OR NEW."runbook" IS DISTINCT FROM prior."runbook" THEN
		RAISE EXCEPTION 'Safety incident immutable fields changed'
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."eventKind" IN ('ACKNOWLEDGED', 'ESCALATED', 'RESOLVED')
		AND pg_has_role(current_user, 'krypto_runtime', 'MEMBER')
		AND NOT pg_has_role(
			current_user, 'krypto_schema_owner', 'MEMBER'
		) THEN
		RAISE EXCEPTION 'Runtime identity cannot append human incident lifecycle events'
			USING ERRCODE = 'insufficient_privilege';
	END IF;

	CASE NEW."eventKind"
		WHEN 'DELIVERY_CONFIRMED' THEN
			IF NEW."incidentType" IN (
				'PAPER_TRADE_POST_COMMIT', 'DAILY_DELIVERY_OBLIGATION'
			) THEN
				IF NEW."status" <> 'RESOLVED' OR NEW."resolvedAt" IS NULL THEN
					RAISE EXCEPTION 'Confirmed obligation requires explicit completion evidence'
						USING ERRCODE = 'check_violation';
				END IF;
			ELSIF NEW."status" IS DISTINCT FROM prior."status"
				OR NEW."resolvedAt" IS DISTINCT FROM prior."resolvedAt" THEN
				RAISE EXCEPTION 'Delivery evidence cannot change incident status'
					USING ERRCODE = 'check_violation';
			END IF;
			IF NEW."acknowledgedAt" IS DISTINCT FROM prior."acknowledgedAt"
				OR NEW."escalatedAt" IS DISTINCT FROM prior."escalatedAt" THEN
				RAISE EXCEPTION 'Delivery evidence cannot change responder timestamps'
					USING ERRCODE = 'check_violation';
			END IF;
		WHEN 'DELIVERY_FAILED' THEN
			IF NEW."status" IS DISTINCT FROM prior."status"
				OR NEW."acknowledgedAt" IS DISTINCT FROM prior."acknowledgedAt"
				OR NEW."escalatedAt" IS DISTINCT FROM prior."escalatedAt"
				OR NEW."resolvedAt" IS DISTINCT FROM prior."resolvedAt" THEN
				RAISE EXCEPTION 'Delivery evidence cannot change incident status'
					USING ERRCODE = 'check_violation';
			END IF;
		WHEN 'ACKNOWLEDGED' THEN
			IF prior."status" <> 'OPEN'
				OR NEW."status" <> 'ACKNOWLEDGED'
				OR NEW."acknowledgedAt" IS NULL
				OR NEW."actorId" IS NULL
				OR NEW."actorRole" NOT IN (
					'PRIMARY_ON_CALL', 'BACKUP_ON_CALL', 'RELEASE_OWNER'
				) THEN
				RAISE EXCEPTION 'Invalid safety incident acknowledgment'
					USING ERRCODE = 'check_violation';
			END IF;
		WHEN 'ESCALATED' THEN
			IF prior."status" NOT IN ('OPEN', 'ACKNOWLEDGED')
				OR NEW."status" <> 'ESCALATED'
				OR NEW."escalatedAt" IS NULL
				OR NEW."actorId" IS NULL
				OR NEW."actorRole" NOT IN (
					'PRIMARY_ON_CALL', 'BACKUP_ON_CALL',
					'RELEASE_OWNER', 'SAFETY_APPROVER'
				) THEN
				RAISE EXCEPTION 'Invalid safety incident escalation'
					USING ERRCODE = 'check_violation';
			END IF;
		WHEN 'RESOLVED' THEN
			IF pg_has_role(current_user, 'krypto_runtime', 'MEMBER')
				AND NOT pg_has_role(
					current_user, 'krypto_schema_owner', 'MEMBER'
				) THEN
				RAISE EXCEPTION 'Runtime identity cannot resolve safety incidents'
					USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF prior."status" NOT IN ('ACKNOWLEDGED', 'ESCALATED')
				OR NEW."status" <> 'RESOLVED'
				OR NEW."resolvedAt" IS NULL
				OR NEW."actorId" IS NULL
				OR NEW."actorRole" NOT IN ('RELEASE_OWNER', 'SAFETY_APPROVER')
				OR NOT (
					NEW."evidence" ?& ARRAY[
						'affectedInterval', 'cause', 'containmentDecision',
						'remediation', 'verification', 'followUpRef',
						'residualRisk', 'reentryDecision'
					]
				) THEN
				RAISE EXCEPTION 'Safety incident resolution evidence is incomplete'
					USING ERRCODE = 'check_violation';
			END IF;
			complementary_role := CASE NEW."actorRole"
				WHEN 'RELEASE_OWNER' THEN 'SAFETY_APPROVER'
				ELSE 'RELEASE_OWNER'
			END;
			SELECT count(*)
			INTO complementary_confirmations
			FROM "krypto"."SafetyIncidentOutbox"
			WHERE "incidentId" = NEW."incidentId"
				AND "eventKind" IN ('ACKNOWLEDGED', 'ESCALATED')
				AND "actorRole" = complementary_role
				AND "actorId" IS NOT NULL
				AND "actorId" <> NEW."actorId";
			IF complementary_confirmations = 0 THEN
				RAISE EXCEPTION 'Resolution requires a distinct complementary role'
					USING ERRCODE = 'insufficient_privilege';
			END IF;
		ELSE
			RAISE EXCEPTION 'Unsupported safety incident lifecycle event'
				USING ERRCODE = 'check_violation';
	END CASE;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "SafetyIncidentOutbox_validate_insert"
BEFORE INSERT ON "krypto"."SafetyIncidentOutbox"
FOR EACH ROW
EXECUTE FUNCTION "krypto"."validate_safety_incident_outbox_insert"();
--> statement-breakpoint

-- Even privileged application mistakes cannot rewrite or remove incident
-- evidence. State transitions are represented by additional immutable events.
CREATE FUNCTION "krypto"."reject_safety_incident_outbox_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	RAISE EXCEPTION 'SafetyIncidentOutbox is append-only; % is not permitted', TG_OP
		USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "SafetyIncidentOutbox_append_only"
BEFORE UPDATE OR DELETE ON "krypto"."SafetyIncidentOutbox"
FOR EACH ROW
EXECUTE FUNCTION "krypto"."reject_safety_incident_outbox_mutation"();
--> statement-breakpoint

-- Runtime reads and appends events explicitly. It receives no mutation,
-- table-clearing, trigger-management, reference, or sequence privilege.
REVOKE ALL PRIVILEGES ON TABLE "krypto"."SafetyIncidentOutbox" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "krypto"."SafetyIncidentOutbox" FROM "krypto_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "krypto"."SafetyIncidentOutbox" TO "krypto_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "krypto"."reject_safety_incident_outbox_mutation"()
FROM PUBLIC, "krypto_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "krypto"."validate_safety_incident_outbox_insert"()
FROM PUBLIC, "krypto_runtime";
--> statement-breakpoint

UPDATE "krypto"."RuntimeContract"
SET
	"schemaFingerprint" = '0010_safety_incidents_v1',
	"contractVersion" = 2,
	"updatedAt" = now()
WHERE "id" = 'singleton';
--> statement-breakpoint

DO $$
BEGIN
	IF NOT has_table_privilege(
		'krypto_runtime',
		'krypto."SafetyIncidentOutbox"',
		'SELECT'
	) OR NOT has_table_privilege(
		'krypto_runtime',
		'krypto."SafetyIncidentOutbox"',
		'INSERT'
	) THEN
		RAISE EXCEPTION 'krypto_runtime cannot read and append safety incident events';
	END IF;
	IF has_table_privilege(
		'krypto_runtime',
		'krypto."SafetyIncidentOutbox"',
		'UPDATE, DELETE, TRIGGER, REFERENCES'
	) THEN
		RAISE EXCEPTION 'krypto_runtime has excess SafetyIncidentOutbox privileges';
	END IF;
END
$$;
--> statement-breakpoint
RESET ROLE;