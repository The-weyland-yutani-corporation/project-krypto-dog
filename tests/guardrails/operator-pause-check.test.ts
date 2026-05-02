import { mockDb } from "../setup";
import { checkOperatorPaused } from "@/guardrails/operator-pause-check";

describe("Guardrail – Operator Pause", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.from.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.where.mockReturnValue(mockDb._selectChain);
    mockDb._selectChain.limit.mockResolvedValue([]);
  });

  it("returns true when the singleton row reports paused=true", async () => {
    mockDb._selectChain.limit.mockResolvedValueOnce([{ paused: true }]);
    expect(await checkOperatorPaused()).toBe(true);
  });

  it("returns false when the singleton row reports paused=false", async () => {
    mockDb._selectChain.limit.mockResolvedValueOnce([{ paused: false }]);
    expect(await checkOperatorPaused()).toBe(false);
  });

  it("returns false when no singleton row exists (defensive)", async () => {
    mockDb._selectChain.limit.mockResolvedValueOnce([]);
    expect(await checkOperatorPaused()).toBe(false);
  });

  it("returns false when the singleton row returns an undefined value", async () => {
    mockDb._selectChain.limit.mockResolvedValueOnce([{ paused: undefined }]);
    expect(await checkOperatorPaused()).toBe(false);
  });
});
