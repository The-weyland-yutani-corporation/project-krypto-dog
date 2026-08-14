import { idempotencyReplayMatchesMode } from "@/agent/run-flow";

describe("idempotency replay mode binding", () => {
  it.each([
    ["DISABLED", "disabled"],
    ["SHADOW", "shadow"],
    ["PAPER", "paper"],
  ] as const)("accepts %s only in %s mode", (persisted, current) => {
    expect(idempotencyReplayMatchesMode(persisted, current)).toBe(true);
  });

  it.each([
    ["SHADOW", "paper"],
    ["PAPER", "shadow"],
    ["DISABLED", "shadow"],
  ] as const)("rejects replaying %s in %s mode", (persisted, current) => {
    expect(idempotencyReplayMatchesMode(persisted, current)).toBe(false);
  });
});
