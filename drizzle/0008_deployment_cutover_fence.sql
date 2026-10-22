CREATE TABLE "krypto"."DeploymentFence" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"owner" text NOT NULL,
	"sourceReleaseSha" text NOT NULL,
	"candidateReleaseSha" text NOT NULL,
	"imageDigest" text NOT NULL,
	"targetOrigin" text NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"releasedAt" timestamp (3) with time zone,
	CONSTRAINT "DeploymentFence_singleton" CHECK ("krypto"."DeploymentFence"."id" = 'singleton')
);
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "krypto"."DeploymentFence" FROM PUBLIC, "krypto_runtime";
--> statement-breakpoint
DO $$
DECLARE
	target_role text;
BEGIN
	FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated']
	LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
			EXECUTE format(
				'REVOKE ALL PRIVILEGES ON TABLE krypto."DeploymentFence" FROM %I',
				target_role
			);
		END IF;
	END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON TABLE "krypto"."DeploymentFence" TO "krypto_runtime";
