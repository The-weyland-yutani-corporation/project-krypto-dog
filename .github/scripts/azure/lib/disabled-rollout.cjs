const assert = require("node:assert/strict");

function validateRuntimeContainer(template, expectedImage, mode) {
  assert(Array.isArray(template?.containers) && template.containers.length === 1,
    "Expected exactly one runtime container.");
  const container = template.containers[0];
  assert.equal(container.image, expectedImage, "The runtime image changed.");
  assert(Array.isArray(container.env), "Runtime environment is missing.");
  const configured = container.env.filter((entry) => entry.name === "ROLLOUT_MODE");
  assert.equal(configured.length, 1, "Expected exactly one rollout mode.");
  assert.equal(configured[0].value, mode, `The runtime is not ${mode}.`);
}

function validateWebRollout(snapshot, expectedImage, mode) {
  assert(["disabled", "shadow", "paper"].includes(mode), "Unknown rollout mode.");
  assert(/^[a-z0-9.-]+\/krypto-web@sha256:[0-9a-f]{64}$/.test(expectedImage),
    "An exact web image reference is required.");
  const web = snapshot.web?.properties;
  assert.equal(web?.provisioningState, "Succeeded", "Web provisioning is incomplete.");
  assert.equal(web?.configuration?.activeRevisionsMode, "Single",
    "Production must use single revision mode.");
  assert(typeof web.latestRevisionName === "string" && web.latestRevisionName.length > 0,
    "The latest revision is unknown.");
  assert.equal(web.latestReadyRevisionName, web.latestRevisionName,
    `The desired ${mode} revision is not ready.`);
  validateRuntimeContainer(web.template, expectedImage, mode);

  assert(Array.isArray(snapshot.revisions) && snapshot.revisions.length > 0,
    "Revision inventory is missing.");
  assert(snapshot.revisions.every((revision) => typeof revision.properties?.active === "boolean"),
    "Revision activation state is unknown.");
  const active = snapshot.revisions.filter((revision) => revision.properties.active);
  assert.equal(active.length, 1, "An old revision is still active.");
  assert.equal(active[0].name, web.latestReadyRevisionName,
    "The active revision is not the desired ready revision.");
  assert.equal(active[0].properties.provisioningState, "Provisioned",
    `The ${mode} revision is not fully provisioned.`);
  assert.equal(active[0].properties.healthState, "Healthy",
    `The ${mode} revision is not healthy.`);
  validateRuntimeContainer(active[0].properties.template, expectedImage, mode);
  for (const revision of snapshot.revisions.filter((entry) => !entry.properties.active)) {
    assert.equal(revision.properties.replicas, 0,
      "An inactive revision still has running pods or an unknown replica count.");
    assert.notEqual(revision.properties.provisioningState, "Deprovisioning",
      "An old revision is still deprovisioning.");
  }
}

function validateDisabledRollout(snapshot, expectedImage) {
  validateWebRollout(snapshot, expectedImage, "disabled");
  for (const name of ["hourly", "daily"]) {
    const job = snapshot[name]?.properties;
    assert.equal(job?.provisioningState, "Succeeded", "Scheduler provisioning is incomplete.");
    assert.equal(job?.configuration?.triggerType, "Manual", "A scheduler is not Manual.");
    assert(job.configuration.scheduleTriggerConfig == null, "A scheduler still has a schedule.");
    assert(job.configuration.eventTriggerConfig == null, "A scheduler still has an event trigger.");
    validateRuntimeContainer(job.template, expectedImage, "disabled");
    const executions = snapshot[`${name}Executions`];
    assert(Array.isArray(executions), "Scheduler execution inventory is missing.");
    assert(executions.every((execution) =>
      ["Succeeded", "Failed", "Stopped"].includes(execution.properties?.status ?? execution.status)),
    "A scheduler execution is still active or has unknown state.");
  }
}

module.exports = { validateDisabledRollout, validateWebRollout, validateRuntimeContainer };
