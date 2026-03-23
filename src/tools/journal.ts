import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { db } from "@/db";
import { agentJournal } from "@/db/schema";

async function fetchMarketSnapshot() {
  const res = await fetch(
    "https://api.coinbase.com/v2/prices/ETH-USD/spot"
  );
  const json = (await res.json()) as { data: { amount: string } };
  const ethPrice = parseFloat(json.data.amount);

  return {
    ethPrice,
    timestamp: new Date().toISOString(),
  };
}

export const writeJournalEntryTool = new DynamicStructuredTool({
  name: "write_journal_entry",
  description:
    "Write a journal entry recording the agent's reasoning, observations, and market conditions.",
  schema: z.object({
    entryText: z
      .string()
      .describe("The agent's reasoning and observations to record"),
    tradeExecutionId: z
      .string()
      .optional()
      .describe("Optional trade execution ID to link this entry to"),
  }),
  func: async ({ entryText, tradeExecutionId }) => {
    try {
      const market = await fetchMarketSnapshot();

      const [entry] = await db
        .insert(agentJournal)
        .values({
          entryText,
          marketConditions: market,
          ...(tradeExecutionId ? { tradeExecutionId } : {}),
        })
        .returning();

      return `Journal entry recorded (ID: ${entry.id}). ETH price at time of entry: $${market.ethPrice.toFixed(2)}.`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `Error writing journal entry: ${msg}`;
    }
  },
});
