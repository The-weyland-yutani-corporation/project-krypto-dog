import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { getLLM } from "./llm";
import {
  getSystemPrompt,
  formatPortfolioState,
  formatJournalEntries,
  formatMarketData,
} from "./prompts/system-prompt";
import type {
  PortfolioState,
  MarketData,
  JournalEntry,
  AgentRunResult,
} from "@/lib/types";

export async function runAgent(
  tools: StructuredToolInterface[],
  portfolioState: PortfolioState,
  journalEntries: JournalEntry[],
  marketData: MarketData,
): Promise<AgentRunResult> {
  const startTime = Date.now();

  try {
    const llm = getLLM();

    const systemPromptText = getSystemPrompt(
      formatPortfolioState(portfolioState),
      formatJournalEntries(journalEntries),
      formatMarketData(marketData),
    );

    const agent = createReactAgent({
      llm,
      tools,
      prompt: new SystemMessage(systemPromptText),
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "Analyze the current market conditions and portfolio state. Decide whether to trade or hold, then write a journal entry explaining your reasoning.",
        },
      ],
    });

    const messages = result.messages ?? [];
    const lastMessage = messages[messages.length - 1];
    const reasoning =
      typeof lastMessage?.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content);

    // Extract token usage from AI messages
    let tokenUsage: AgentRunResult["tokenUsage"] | undefined;
    for (const msg of messages) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usage = (msg as any).usage_metadata;
      if (usage) {
        tokenUsage = {
          promptTokens: usage.input_tokens ?? 0,
          completionTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        };
      }
    }

    // Detect whether a trade was executed by checking tool calls
    const tradeExecuted = messages.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any) =>
        msg.name === "safe_trade" ||
        (Array.isArray(msg.tool_calls) &&
          msg.tool_calls.some(
            (tc: Record<string, unknown>) => tc.name === "safe_trade",
          )),
    );

    return {
      status: tradeExecuted ? "executed" : "skipped",
      action: tradeExecuted ? "trade" : "hold",
      reasoning,
      tokenUsage,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown agent error";
    return {
      status: "error",
      error: message,
      durationMs: Date.now() - startTime,
    };
  }
}
