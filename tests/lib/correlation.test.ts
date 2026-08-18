import {
  LOCAL_DEPLOYMENT_ID,
  LOCAL_RELEASE_ID,
  assertSafeStructuredId,
  deriveProviderAttemptId,
  generateCorrelationId,
  resolveReleaseDeploymentCorrelation,
  resolveRequestId,
} from "@/lib/correlation";

describe("correlation identifiers", () => {
  const uuid = "11111111-1111-4111-a111-111111111111";

  it("accepts only bounded allowlisted request header IDs", () => {
    expect(resolveRequestId("edge.request-42", () => uuid)).toBe(
      "edge.request-42",
    );
    expect(resolveRequestId("https://example.test/?token=secret", () => uuid)).toBe(
      uuid,
    );
    expect(resolveRequestId("line\nbreak", () => uuid)).toBe(uuid);
  });

  it("generates and validates UUID correlation IDs", () => {
    expect(generateCorrelationId(() => uuid)).toBe(uuid);
    expect(() => generateCorrelationId(() => "not-a-uuid")).toThrow(
      "UUID factory returned an invalid correlation ID",
    );
    expect(assertSafeStructuredId("sha256:abc")).toBe("sha256:abc");
    expect(() => assertSafeStructuredId("https://unsafe.test")).toThrow(
      "allowlisted structured identifier",
    );
  });

  it("derives deterministic provider attempt IDs without exposing request IDs", () => {
    const first = deriveProviderAttemptId({
      requestId: "request-safe-42",
      provider: "foundry",
      attempt: 2,
    });
    const second = deriveProviderAttemptId({
      requestId: "request-safe-42",
      provider: "foundry",
      attempt: 2,
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^attempt-foundry-2-[0-9a-f]{20}$/);
    expect(first).not.toContain("request-safe-42");
    expect(() =>
      deriveProviderAttemptId({
        requestId: "request-safe-42",
        provider: "foundry",
        attempt: 0,
      }),
    ).toThrow("provider attempt");
  });

  it("resolves release and deployment provenance with local sentinels", () => {
    expect(
      resolveReleaseDeploymentCorrelation({ NODE_ENV: "test" }),
    ).toEqual({
      releaseId: LOCAL_RELEASE_ID,
      deploymentId: LOCAL_DEPLOYMENT_ID,
    });

    const releaseId = "a".repeat(40);
    const digest = `sha256:${"b".repeat(64)}`;
    expect(
      resolveReleaseDeploymentCorrelation({
        NODE_ENV: "production",
        RELEASE_SHA: releaseId,
        IMAGE_DIGEST: digest,
        CONTAINER_APP_REVISION: "krypto--candidate-42",
      }),
    ).toEqual({
      releaseId,
      deploymentId: `krypto--candidate-42.${"b".repeat(16)}`,
    });
  });

  it("fails closed for malformed or missing production provenance", () => {
    expect(() =>
      resolveReleaseDeploymentCorrelation({
        NODE_ENV: "production",
        RELEASE_SHA: "main",
        IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("RELEASE_SHA");
    expect(() =>
      resolveReleaseDeploymentCorrelation({ NODE_ENV: "production" }),
    ).toThrow("RELEASE_SHA");
  });
});
