-- Immutable named-operator authentication and mutation provenance (issue #129).
SET ROLE "krypto_schema_owner";
--> statement-breakpoint
CREATE TABLE "krypto"."OperatorAuditEvent" (
	"eventId" text PRIMARY KEY NOT NULL,
	"requestId" text NOT NULL,
	"releaseId" text NOT NULL,
	"deploymentId" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"operatorId" text NOT NULL,
	"operatorName" text NOT NULL,
	"subjectId" text NOT NULL,
	"operatorRole" text NOT NULL,
	"authenticationMethod" text NOT NULL,
	"authenticationContext" text NOT NULL,
	"mfaEvidence" text NOT NULL,
	"authenticatedAt" timestamp (3) with time zone NOT NULL,
	"tokenIssuedAt" timestamp (3) with time zone NOT NULL,
	"sessionIdHash" text NOT NULL,
	"policyVersion" text NOT NULL,
	"occurredAt" timestamp (3) with time zone NOT NULL,
	"persistedAt" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "OperatorAuditEvent_action_check" CHECK ("krypto"."OperatorAuditEvent"."action" IN ('READ_ADMIN', 'RUN_AGENT', 'PAUSE_AGENT', 'RESUME_AGENT', 'UNLOCK_AGENT', 'RECOVER_RUN_LEASE', 'READ_SAFETY_INCIDENTS', 'TEST_FIRE_SAFETY_INCIDENT', 'CHANGE_SAFETY_INCIDENT')),
	CONSTRAINT "OperatorAuditEvent_outcome_check" CHECK ("krypto"."OperatorAuditEvent"."outcome" IN ('REQUESTED', 'APPLIED', 'NO_CHANGE')),
	CONSTRAINT "OperatorAuditEvent_operatorRole_check" CHECK ("krypto"."OperatorAuditEvent"."operatorRole" IN ('OPERATOR', 'RELEASE_OWNER', 'SAFETY_APPROVER')),
	CONSTRAINT "OperatorAuditEvent_authenticationMethod_check" CHECK ("krypto"."OperatorAuditEvent"."authenticationMethod" = 'ENTRA_MFA'),
	CONSTRAINT "OperatorAuditEvent_sessionIdHash_check" CHECK ("krypto"."OperatorAuditEvent"."sessionIdHash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "OperatorAuditEvent_timestamp_check" CHECK ("krypto"."OperatorAuditEvent"."persistedAt" + interval '60 seconds' >= "krypto"."OperatorAuditEvent"."occurredAt"
        AND "krypto"."OperatorAuditEvent"."occurredAt" + interval '60 seconds' >= "krypto"."OperatorAuditEvent"."persistedAt"
        AND "krypto"."OperatorAuditEvent"."occurredAt" + interval '60 seconds' >= "krypto"."OperatorAuditEvent"."authenticatedAt"
        AND "krypto"."OperatorAuditEvent"."occurredAt" + interval '60 seconds' >= "krypto"."OperatorAuditEvent"."tokenIssuedAt")
);
--> statement-breakpoint
CREATE INDEX "OperatorAuditEvent_requestId_idx" ON "krypto"."OperatorAuditEvent" USING btree ("requestId");--> statement-breakpoint
CREATE INDEX "OperatorAuditEvent_operatorId_occurredAt_idx" ON "krypto"."OperatorAuditEvent" USING btree ("operatorId","occurredAt");--> statement-breakpoint
CREATE INDEX "OperatorAuditEvent_action_occurredAt_idx" ON "krypto"."OperatorAuditEvent" USING btree ("action","occurredAt");
--> statement-breakpoint

CREATE FUNCTION "krypto"."reject_operator_audit_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	RAISE EXCEPTION 'OperatorAuditEvent is append-only; % is not permitted', TG_OP
		USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "OperatorAuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "krypto"."OperatorAuditEvent"
FOR EACH ROW
EXECUTE FUNCTION "krypto"."reject_operator_audit_event_mutation"();
--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE "krypto"."OperatorAuditEvent" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "krypto"."OperatorAuditEvent" FROM "krypto_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "krypto"."OperatorAuditEvent" TO "krypto_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "krypto"."reject_operator_audit_event_mutation"()
FROM PUBLIC, "krypto_runtime";
--> statement-breakpoint

UPDATE "krypto"."RuntimeContract"
SET
	"schemaFingerprint" = '0012_operator_admin_identity_v1',
	"contractVersion" = 4,
	"updatedAt" = now()
WHERE "id" = 'singleton';
--> statement-breakpoint

DO $$
BEGIN
	IF NOT has_table_privilege(
		'krypto_runtime',
		'krypto."OperatorAuditEvent"',
		'SELECT, INSERT'
	) THEN
		RAISE EXCEPTION 'krypto_runtime cannot read and append operator audit events';
	END IF;
	IF has_table_privilege(
		'krypto_runtime',
		'krypto."OperatorAuditEvent"',
		'UPDATE, DELETE, TRIGGER, REFERENCES'
	) THEN
		RAISE EXCEPTION 'krypto_runtime has excess OperatorAuditEvent privileges';
	END IF;
END
$$;
--> statement-breakpoint
RESET ROLE;