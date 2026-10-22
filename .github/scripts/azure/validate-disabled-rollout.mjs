import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function disabledContainer(template, expectedImage) {
  assert(Array.isArray(template?.containers) && template.containers.length === 1,
    "Expected exactly one runtime container.");
  const container = template.containers[0];
  assert.equal(container.image, expectedImage, "The runtime image changed.");
  assert(Array.isArray(container.env), "Runtime environment is missing.");
  const mode = container.env.filter((entry) => entry.name === "ROLLOUT_MODE");
  assert.equal(mode.length, 1, "Expected exactly one rollout mode.");
  assert.equal(mode[0].value, "disabled", "The runtime is not disabled.");
}

export function validateDisabledRollout(snapshot, expectedImage) {
  assert(/^[a-z0-9.-]+\/krypto-web@sha256:[0-9a-f]{64}$/.test(expectedImage),
    "An exact web image reference is required.");
  const web = snapshot.web?.properties;
  assert.equal(web?.provisioningState, "Succeeded", "Web provisioning is incomplete.");
  assert.equal(web?.configuration?.activeRevisionsMode, "Single",
    "Production must use single revision mode.");
  assert(typeof web.latestRevisionName === "string" && web.latestRevisionName.length > 0,
    "The latest revision is unknown.");
  assert.equal(web.latestReadyRevisionName, web.latestRevisionName,
    "The desired disabled revision is not ready.");
  disabledContainer(web.template, expectedImage);

  assert(Array.isArray(snapshot.revisions) && snapshot.revisions.length > 0,
    "Revision inventory is missing.");
  assert(snapshot.revisions.every((revision) => typeof revision.properties?.active === "boolean"),
    "Revision activation state is unknown.");
  const active = snapshot.revisions.filter((revision) => revision.properties.active);
  assert.equal(active.length, 1, "An old revision is still active.");
  assert.equal(active[0].name, web.latestReadyRevisionName,
    "The active revision is not the desired ready revision.");
  assert.equal(active[0].properties.provisioningState, "Provisioned",
    "The disabled revision is not fully provisioned.");
  assert.equal(active[0].properties.healthState, "Healthy",
    "The disabled revision is not healthy.");
  disabledContainer(active[0].properties.template, expectedImage);
  for (const revision of snapshot.revisions.filter((entry) => !entry.properties.active)) {
    assert.equal(revision.properties.replicas, 0,
      "An inactive revision still has running pods or an unknown replica count.");
    assert.notEqual(revision.properties.provisioningState, "Deprovisioning",
      "An old revision is still deprovisioning.");
  }

  for (const name of ["hourly", "daily"]) {
    const job = snapshot[name]?.properties;
    assert.equal(job?.provisioningState, "Succeeded", "Scheduler provisioning is incomplete.");
    assert.equal(job?.configuration?.triggerType, "Manual", "A scheduler is not Manual.");
    assert(job.configuration.scheduleTriggerConfig == null, "A scheduler still has a schedule.");
    assert(job.configuration.eventTriggerConfig == null, "A scheduler still has an event trigger.");
    disabledContainer(job.template, expectedImage);
    const executions = snapshot[`${name}Executions`];
    assert(Array.isArray(executions), "Scheduler execution inventory is missing.");
    assert(executions.every((execution) =>
      ["Succeeded", "Failed", "Stopped"].includes(execution.properties?.status ?? execution.status)),
    "A scheduler execution is still active or has unknown state.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , snapshotPath, expectedImage] = process.argv;
    validateDisabledRollout(JSON.parse(readFileSync(snapshotPath, "utf8")), expectedImage);
    process.stdout.write("Verified exact disabled revision, Manual schedulers, and terminal executions.\n");
  } catch (error) {
    process.stderr.write(`Disabled rollout is not verified: ${error.message}\n`);
    process.exitCode = 1;
  }
}
