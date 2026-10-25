import {
  assertFreshWorkflowObservation,
  canonicalObservationJson,
  verifyWorkflowObservation,
  workflowObservationAudience,
  workflowObservationTrustFromEnv,
  WORKFLOW_OBSERVATION_MAX_AGE_MS,
} from "@/deployment/workflow-observation";
import { OBSERVATION_NOW as NOW, signedCutoverFixture, verifiedCutoverFixture } from "./workflow-observation-fixture";

describe("purpose-bound GitHub workflow observations", () => {
  it("verifies a real RSA signature and exposes only nonsecret immutable provenance", async () => {
    const fixture = await signedCutoverFixture();
    const result = await verifyWorkflowObservation(fixture.proof, fixture.expected, { keys: fixture.keys, now: NOW });
    expect(result.observation).toEqual(fixture.observation);
    expect(result.receipt).toMatchObject({
      purpose: "cutover-release", repositoryId: "1234", workflowSha: "b".repeat(40),
      runId: "9876", runAttempt: 1,
      observationDigest: workflowObservationAudience(fixture.observation).split(":").at(-1),
    });
    expect(JSON.stringify(result)).not.toContain(fixture.token);
    expect(Object.isFrozen(result.observation.workflow)).toBe(true);
    expect(() => assertFreshWorkflowObservation({ ...result }, NOW)).toThrow(/cryptographically verified/);
    expect(() => assertFreshWorkflowObservation(result, new Date(NOW.getTime() + 121_000))).toThrow(/expired/);
  });

  it.each([
    { iss: "https://issuer.example.com" },
    { aud: "api://AzureADTokenExchange" },
    { aud: ["extra-audience"] },
    { sub: "repo:example/project-krypto:environment:production-deploy" },
    { repository: "fork/project-krypto" },
    { repository_id: "9999" },
    { repository_owner_id: "9999" },
    { ref: "refs/pull/1/merge" },
    { ref_type: "tag" },
    { workflow_ref: "example/project-krypto/.github/workflows/other.yml@refs/heads/main" },
    { workflow_sha: "f".repeat(40) },
    { run_id: "9999" },
    { run_attempt: "2" },
    { environment: "development" },
    { event_name: "pull_request" },
    { jti: undefined },
    { exp: Math.floor(NOW.getTime() / 1000) },
    { nbf: Math.floor(NOW.getTime() / 1000) + 1 },
    { iat: Math.floor(NOW.getTime() / 1000) - 5 },
    { exp: Math.floor(NOW.getTime() / 1000) + 601 },
  ])("rejects a correctly signed but unauthorized token: %j", async (claims) => {
    const fixture = await signedCutoverFixture({}, NOW, claims);
    await expect(verifyWorkflowObservation(fixture.proof, fixture.expected, {
      keys: fixture.keys, now: NOW,
    })).rejects.toThrow();
  });

  it("rejects payload tampering, signature tampering and audience arrays", async () => {
    const fixture = await signedCutoverFixture();
    const altered = JSON.stringify({
      observation: { ...fixture.observation, targetOrigin: "https://elsewhere.example.com" },
      token: fixture.token,
    });
    await expect(verifyWorkflowObservation(altered, fixture.expected, { keys: fixture.keys, now: NOW })).rejects.toThrow();
    const parts = fixture.token.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    await expect(verifyWorkflowObservation(JSON.stringify({
      observation: fixture.observation, token: parts.join("."),
    }), fixture.expected, { keys: fixture.keys, now: NOW })).rejects.toThrow();
    const arrayAudience = await signedCutoverFixture({}, NOW, {
      aud: [workflowObservationAudience(fixture.observation), "extra"],
    });
    await expect(verifyWorkflowObservation(arrayAudience.proof, arrayAudience.expected, {
      keys: arrayAudience.keys, now: NOW,
    })).rejects.toThrow(/identity/);
  });

  it.each([
    { observedAt: new Date(NOW.getTime() + 1).toISOString() },
    { completedAt: new Date(NOW.getTime() + 1).toISOString() },
    { observedAt: new Date(NOW.getTime() - WORKFLOW_OBSERVATION_MAX_AGE_MS - 1).toISOString() },
    { observedAt: new Date(NOW.getTime() - 92_000).toISOString() },
  ])("rejects stale, reversed or future Azure readback: %j", async (overrides) => {
    const fixture = await signedCutoverFixture(overrides);
    await expect(verifyWorkflowObservation(fixture.proof, fixture.expected, {
      keys: fixture.keys, now: NOW,
    })).rejects.toThrow();
  });

  it("binds verification to the intended ops invocation and workflow source", async () => {
    const fixture = await signedCutoverFixture();
    for (const mismatch of [
      { operationExecutionId: "another-execution" },
      { workflowSha: "c".repeat(40) },
      { repositoryId: "9999" },
    ]) {
      await expect(verifyWorkflowObservation(fixture.proof, { ...fixture.expected, ...mismatch }, {
        keys: fixture.keys, now: NOW,
      })).rejects.toThrow();
    }
  });

  it("rechecks age and expiry when a database lock has delayed consumption", async () => {
    const evidence = await verifiedCutoverFixture();
    expect(() => assertFreshWorkflowObservation(evidence, NOW)).not.toThrow();
    expect(() => assertFreshWorkflowObservation(evidence, new Date(NOW.getTime() + 180_001))).toThrow();
  });

  it("uses a closed bounded proof schema and canonical JSON", async () => {
    const fixture = await signedCutoverFixture();
    for (const input of [
      "", "not-json", "x".repeat(16_385),
      JSON.stringify({ observation: fixture.observation }),
      JSON.stringify({ observation: { ...fixture.observation, untrusted: true }, token: fixture.token }),
      JSON.stringify({ observation: fixture.observation, token: fixture.token, keys: [] }),
    ]) {
      await expect(verifyWorkflowObservation(input, fixture.expected, { keys: fixture.keys, now: NOW })).rejects.toThrow();
    }
    expect(canonicalObservationJson({ b: [true, null, 1], a: "a" })).toBe('{"a":"a","b":[true,null,1]}');
    for (const invalid of [undefined, NaN, Infinity, new Date()]) {
      expect(() => canonicalObservationJson(invalid)).toThrow();
    }
    expect(() => workflowObservationTrustFromEnv({})).toThrow();
  });
});
