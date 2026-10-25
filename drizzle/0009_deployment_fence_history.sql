ALTER TABLE "krypto"."DeploymentFence" DROP CONSTRAINT "DeploymentFence_pkey";
--> statement-breakpoint
ALTER TABLE "krypto"."DeploymentFence" ADD PRIMARY KEY ("owner");
--> statement-breakpoint
CREATE UNIQUE INDEX "DeploymentFence_single_active" ON "krypto"."DeploymentFence" USING btree ("id") WHERE "releasedAt" IS NULL;