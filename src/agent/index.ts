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
  TradeResult,
} from "@/lib/types";

type AgentMessage = {
  name?: string;
  content?: unknown;
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  tool_calls?: Array<{
    name?: string;
    args?: Record<string, unknown>;
  }>;
};

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[$,+\s]/g, "");
  if (normalized === "" || normalized.toUpperCase() === "N/A") return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getLineValue(content: string, label: string): string | undefined {
  const line = content
    .split("\n")
    .find((part) => part.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  return line?.slice(label.length + 1).trim();
}

function parseSafeTradeResult(content: string): TradeResult | undefined {
  if (!content) return undefined;

  if (!content.includes("Trade executed successfully.")) {
    if (/^(Error|Trade aborted):/i.test(content.trim())) {
      return { success: false, error: content };
    }
    return undefined;
  }

  const direction = getLineValue(content, "Direction");
  const asset = getLineValue(content, "Asset");
  const amountUSD = parseMoney(getLineValue(content, "Amount"));
  const executionPrice = parseMoney(getLineValue(content, "Execution Price"));
  const amountAssetRaw = getLineValue(content, "Asset Amount")?.split(/\s+/)[0];
  const amountAsset = amountAssetRaw ? Number(amountAssetRaw) : undefined;
  const feesUSD = parseMoney(getLineValue(content, "Fees"));
  const pnlRaw = getLineValue(content, "P&L");
  const pnlUSD = pnlRaw && pnlRaw !== "N/A" ? parseMoney(pnlRaw) : null;

  return {
    success: true,
    tradeId: getLineValue(content, "ID"),
    direction: direction === "BUY" || direction === "SELL" ? direction : undefined,
    asset,
    amountUSD,
    executionPrice,
    amountAsset: Number.isFinite(amountAsset) ? amountAsset : undefined,
    feesUSD,
    pnlUSD: pnlUSD ?? null,
  };
}

function extractSafeTradeResult(messages: AgentMessage[]): TradeResult | undefined {
  let lastResult: TradeResult | undefined;
  let lastSuccess: TradeResult | undefined;

  for (const msg of messages) {
    if (msg.name !== "safe_trade") continue;
    const parsed = parseSafeTradeResult(contentToString(msg.content));
    if (!parsed) continue;

    lastResult = parsed;
    if (parsed.success) {
      lastSuccess = parsed;
    }
  }

  return lastSuccess ?? lastResult;
}

function wasJournalWritten(messages: AgentMessage[]): boolean {
  return messages.some(
    (msg) =>
      msg.name === "write_journal_entry" &&
      contentToString(msg.content).includes("Journal entry recorded"),
  );
}

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

    const messages = (result.messages ?? []) as AgentMessage[];
    const lastMessage = messages[messages.length - 1];
    const reasoning = contentToString(lastMessage?.content);

    // Extract token usage from AI messages
    let tokenUsage: AgentRunResult["tokenUsage"] | undefined;
    for (const msg of messages) {
      const usage = msg.usage_metadata;
      if (usage) {
        tokenUsage = {
          promptTokens: usage.input_tokens ?? 0,
          completionTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        };
      }
    }

    const trade = extractSafeTradeResult(messages);
    const tradeExecuted = trade?.success === true;

    return {
      status: tradeExecuted ? "executed" : "skipped",
      action: tradeExecuted ? "trade" : "hold",
      reasoning,
      trade,
      tokenUsage,
      journalWritten: wasJournalWritten(messages),
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
