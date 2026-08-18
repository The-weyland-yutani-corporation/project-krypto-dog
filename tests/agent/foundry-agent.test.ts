import {
  createOpenAIResponseTransport,
  createFoundryDecisionInvoker,
  safeBindingLabel,
  type FoundryResponseRequest,
  type FoundryResponseTransport,
} from "@/agent/foundry-agent";
import { AgentBindingMismatchError } from "@/trading/errors";
import type OpenAI from "openai";

const config = {
  projectEndpoint:
    "https://test.services.ai.azure.com/api/projects/krypto-dev-agents",
  agentName: "krypto-dev-decision",
  agentVersion: "7",
};

function completedResponse() {
  return {
    status: "completed",
    outputText: JSON.stringify({
      action: "HOLD",
      notionalUSD: null,
      reasoning: "No eligible trade.",
    }),
    agentReference: {
      type: "agent_reference" as const,
      name: config.agentName,
      version: config.agentVersion,
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
  };
}

describe("Foundry decision agent", () => {
  it("bounds and sanitizes binding labels before persistence or telemetry", () => {
    const label = safeBindingLabel({
      name: `bad\nname${"x".repeat(200)}`,
      version: `7\r<script>${"y".repeat(100)}`,
    });

    expect(label).not.toMatch(/[\r\n<>]/);
    expect(label.length).toBeLessThanOrEqual(193);
    expect(label).toMatch(/^bad\?name/);
  });

  it("preserves a timeout abort reason across the OpenAI SDK wrapper", async () => {
    const sdkAbort = Object.assign(new Error("Request was aborted."), {
      name: "APIUserAbortError",
    });
    const client = {
      responses: {
        create: jest.fn(async () => {
          throw sdkAbort;
        }),
      },
    } as unknown as OpenAI;
    const controller = new AbortController();
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(
      createOpenAIResponseTransport(client)({
        input: "decision input",
        agentReference: {
          type: "agent_reference",
          name: config.agentName,
          version: config.agentVersion,
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("does not turn caller cancellation into a retryable timeout", async () => {
    const sdkAbort = Object.assign(new Error("Request was aborted."), {
      name: "APIUserAbortError",
    });
    const client = {
      responses: {
        create: jest.fn(async () => {
          throw sdkAbort;
        }),
      },
    } as unknown as OpenAI;
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));

    await expect(
      createOpenAIResponseTransport(client)({
        input: "decision input",
        agentReference: {
          type: "agent_reference",
          name: config.agentName,
          version: config.agentVersion,
        },
        signal: controller.signal,
      }),
    ).rejects.toBe(sdkAbort);
  });

  it("pins and verifies the immutable agent version before accepting output", async () => {
    let request: FoundryResponseRequest | undefined;
    const transport: FoundryResponseTransport = jest.fn(async (value) => {
      request = value;
      return completedResponse();
    });
    const invoke = createFoundryDecisionInvoker(transport, config);

    const result = await invoke("decision input", AbortSignal.timeout(1_000));

    expect(request).toMatchObject({
      input: "decision input",
      agentReference: {
        type: "agent_reference",
        name: "krypto-dev-decision",
        version: "7",
      },
    });
    expect(result).toEqual({
      decision: {
        action: "HOLD",
        notionalUSD: null,
        reasoning: "No eligible trade.",
      },
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
  });

  it("rejects a response attributed to another agent version", async () => {
    const transport: FoundryResponseTransport = jest.fn(async () => ({
      ...completedResponse(),
      agentReference: {
        type: "agent_reference" as const,
        name: config.agentName,
        version: "8",
      },
    }));

    await expect(
      createFoundryDecisionInvoker(transport, config)(
        "decision input",
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toMatchObject<Partial<AgentBindingMismatchError>>({
      errorType: "LLM_BINDING",
      expectedBinding: "krypto-dev-decision@7",
      actualBinding: "krypto-dev-decision@8",
      retryable: false,
    });
  });

  it("applies the full local decision contract after remote JSON parsing", async () => {
    const transport: FoundryResponseTransport = jest.fn(async () => ({
      ...completedResponse(),
      outputText: JSON.stringify({
        action: "BUY",
        notionalUSD: -10,
        reasoning: "Invalid",
      }),
    }));

    await expect(
      createFoundryDecisionInvoker(transport, config)(
        "decision input",
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toThrow();
  });
});
