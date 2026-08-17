import {
  EmailClient,
  type EmailMessage,
  type EmailSendResponse,
} from "@azure/communication-email";
import {
  ACS_PROVIDER_BUDGET_MS,
  ProviderBudgetError,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import {
  consumeProviderRequestBudget,
  type ProviderBudgetStore,
} from "@/lib/provider-budgets";

export type EmailDeliveryResult =
  | { status: "sent"; id?: string }
  | { status: "skipped"; reason: string };

export class EmailDeliveryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

// Keep provider polling comfortably inside the 30-second HTTP caller budgets
// used by scheduled-trigger and target smoke.
const EMAIL_SEND_TIMEOUT_MS = 20_000;

interface AcsEmailConfig {
  connectionString: string;
  sender: string;
  recipient: string;
}

export interface EmailSendOptions {
  deadline?: ExecutionDeadline;
  providerDeadlineAt?: Date;
  budgetStore?: ProviderBudgetStore;
}

type AcsEmailConfigResolution =
  | { configured: true; config: AcsEmailConfig }
  | { configured: false; reason: string };

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hasValidAcsConnectionString(connectionString: string): boolean {
  const fields = new Map<string, string>();
  for (const segment of connectionString.split(";")) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex === -1) continue;
    fields.set(
      segment.slice(0, separatorIndex).trim().toLowerCase(),
      segment.slice(separatorIndex + 1).trim(),
    );
  }

  const endpoint = fields.get("endpoint");
  const accessKey = fields.get("accesskey");
  if (!endpoint || !accessKey) return false;

  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function resolveAcsEmailConfig(): AcsEmailConfigResolution {
  const connectionString =
    process.env.AZURE_COMMUNICATION_CONNECTION_STRING?.trim();
  const sender = process.env.AZURE_COMMUNICATION_EMAIL_SENDER?.trim();
  const recipient = process.env.ALERT_EMAIL_TO?.trim();
  const missing = [
    !connectionString && "AZURE_COMMUNICATION_CONNECTION_STRING",
    !sender && "AZURE_COMMUNICATION_EMAIL_SENDER",
    !recipient && "ALERT_EMAIL_TO",
  ].filter((name): name is string => Boolean(name));

  let reason: string | undefined;
  if (missing.length > 0) {
    reason = `Missing ACS email configuration: ${missing.join(", ")}`;
  } else if (!hasValidAcsConnectionString(connectionString!)) {
    reason =
      "AZURE_COMMUNICATION_CONNECTION_STRING must include a valid HTTPS Endpoint and AccessKey";
  }

  if (reason) {
    if (process.env.NODE_ENV === "production") {
      throw new EmailDeliveryError(
        `ACS email delivery is not configured for production: ${reason}`,
      );
    }
    return { configured: false, reason };
  }

  return {
    configured: true,
    config: {
      connectionString: connectionString!,
      sender: sender!,
      recipient: recipient!,
    },
  };
}

function describeProviderError(response: EmailSendResponse): string {
  const details = [response.error?.code, response.error?.message].filter(
    (value): value is string => Boolean(value),
  );
  return details.length > 0 ? `: ${details.join(" — ")}` : "";
}

async function sendEmail(
  subject: string,
  html: string,
  logData: unknown,
  deliveryName: string,
  options: EmailSendOptions = {},
): Promise<EmailDeliveryResult> {
  const resolution = resolveAcsEmailConfig();
  if (!resolution.configured) {
    console.warn(
      `[email no-op] ${resolution.reason} — delivery is console-only outside production`,
    );
    console.log(`[email no-op] ${subject}\n${JSON.stringify(logData)}`);
    return { status: "skipped", reason: resolution.reason };
  }

  const { connectionString, sender, recipient } = resolution.config;
  options.deadline?.assertActive(`ACS ${deliveryName}`);
  if (options.deadline) {
    await consumeProviderRequestBudget("acs", {
      deadline: options.deadline,
      store: options.budgetStore,
    });
  }
  const providerRemainingMs =
    (options.providerDeadlineAt?.getTime() ??
      (options.deadline?.now().getTime() ?? Date.now()) +
        ACS_PROVIDER_BUDGET_MS) -
    (options.deadline?.now().getTime() ?? Date.now());
  if (providerRemainingMs <= 0) {
    throw new ProviderBudgetError("acs", "time");
  }
  const message: EmailMessage = {
    senderAddress: sender,
    recipients: {
      to: [{ address: recipient }],
    },
    content: {
      subject,
      html,
    },
  };

  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, Math.min(EMAIL_SEND_TIMEOUT_MS, providerRemainingMs));
  const abortSignal = options.deadline
    ? AbortSignal.any([
        abortController.signal,
        options.deadline.signalFor("ACS email", providerRemainingMs),
      ])
    : abortController.signal;

  try {
    const client = new EmailClient(connectionString);
    const poller = await client.beginSend(message, {
      abortSignal,
    });
    const response = await poller.pollUntilDone({
      abortSignal,
    });
    options.deadline?.assertActive(`ACS ${deliveryName} response`);

    if (response.status !== "Succeeded") {
      throw new EmailDeliveryError(
        `ACS email ${deliveryName} ended with status ${response.status}${describeProviderError(response)}`,
        response.error ?? response,
      );
    }
    if (!response.id?.trim()) {
      throw new EmailDeliveryError(
        `ACS email ${deliveryName} succeeded without an operation ID`,
        response,
      );
    }
    return { status: "sent", id: response.id };
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    // Preserve the authoritative execution error instead of converting
    // cancellation/deadline exhaustion into a generic provider failure.
    options.deadline?.assertActive(`ACS ${deliveryName}`);
    if (timedOut) {
      throw new EmailDeliveryError(
        `Timed out sending ${deliveryName} through ACS Email after ${EMAIL_SEND_TIMEOUT_MS}ms`,
        error,
      );
    }
    throw new EmailDeliveryError(
      `Failed to send ${deliveryName} through ACS Email`,
      error,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendGuardrailAlert(
  guardrailName: string,
  details: {
    portfolioValue?: number;
    lastTradeTime?: Date;
    error?: string;
  },
  options: EmailSendOptions = {},
): Promise<EmailDeliveryResult> {
  const subject = `🚨 Krypto Alert: ${guardrailName} Triggered`;
  const timestamp = new Date().toISOString();
  const safeGuardrailName = escapeHtml(guardrailName);

  const detailRows = [
    `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Guardrail</td><td style="padding:8px 12px;">${safeGuardrailName}</td></tr>`,
    details.portfolioValue !== undefined
      ? `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Portfolio Value</td><td style="padding:8px 12px;">$${details.portfolioValue.toFixed(2)}</td></tr>`
      : "",
    details.lastTradeTime
      ? `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Last Trade</td><td style="padding:8px 12px;">${details.lastTradeTime.toISOString()}</td></tr>`
      : "",
    details.error
      ? `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Error</td><td style="padding:8px 12px;color:#dc2626;">${escapeHtml(details.error)}</td></tr>`
      : "",
    `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Timestamp</td><td style="padding:8px 12px;">${timestamp}</td></tr>`,
  ]
    .filter(Boolean)
    .join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#dc2626;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:20px;">🚨 Guardrail Alert</h2>
        <p style="margin:4px 0 0;opacity:0.9;font-size:14px;">${safeGuardrailName} has been triggered</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          ${detailRows}
        </table>
        <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Krypto Autonomous Trading Agent</p>
      </div>
    </div>
  `;

  return sendEmail(subject, html, details, "guardrail alert", options);
}

export async function sendDailySummary(
  data: {
    portfolioValueUSD: number;
    totalPnlUSD: number;
    tradesExecuted: number;
    tradesSummary: Array<{
      direction: string;
      asset: string;
      amountUSD: number;
      pnlUSD: number | null;
    }>;
    journalHighlights: string[];
  },
  options: EmailSendOptions = {},
): Promise<EmailDeliveryResult> {
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const subject = `📊 Krypto Daily Summary — ${dateStr}`;

  const pnlColor = data.totalPnlUSD >= 0 ? "#16a34a" : "#dc2626";
  const pnlSign = data.totalPnlUSD >= 0 ? "+" : "";

  const tradeRows = data.tradesSummary
    .map((t) => {
      const direction = escapeHtml(t.direction);
      const asset = escapeHtml(t.asset);
      return `
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:8px 12px;font-weight:600;color:${t.direction === "BUY" ? "#16a34a" : "#dc2626"};">${direction}</td>
        <td style="padding:8px 12px;">${asset}</td>
        <td style="padding:8px 12px;">$${t.amountUSD.toFixed(2)}</td>
        <td style="padding:8px 12px;color:${t.pnlUSD !== null && t.pnlUSD >= 0 ? "#16a34a" : "#dc2626"};">${t.pnlUSD !== null ? `${t.pnlUSD >= 0 ? "+" : ""}$${t.pnlUSD.toFixed(2)}` : "—"}</td>
      </tr>`;
    })
    .join("");

  const journalSection =
    data.journalHighlights.length > 0
      ? `
      <h3 style="margin:24px 0 8px;font-size:16px;color:#374151;">📝 Journal Highlights</h3>
      <ul style="margin:0;padding-left:20px;color:#4b5563;">
        ${data.journalHighlights.map((highlight) => `<li style="margin:4px 0;">${escapeHtml(highlight)}</li>`).join("")}
      </ul>`
      : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1e293b;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:20px;">📊 Daily Summary</h2>
        <p style="margin:4px 0 0;opacity:0.9;font-size:14px;">${dateStr}</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px;">
        <div style="display:flex;gap:24px;margin-bottom:24px;">
          <div style="flex:1;background:#f8fafc;padding:16px;border-radius:8px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-transform:uppercase;">Portfolio Value</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:#1e293b;">$${data.portfolioValueUSD.toFixed(2)}</p>
          </div>
          <div style="flex:1;background:#f8fafc;padding:16px;border-radius:8px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-transform:uppercase;">Total P&L</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:${pnlColor};">${pnlSign}$${data.totalPnlUSD.toFixed(2)}</p>
          </div>
        </div>

        <h3 style="margin:0 0 8px;font-size:16px;color:#374151;">Trades Executed: ${data.tradesExecuted}</h3>
        ${
          data.tradesSummary.length > 0
            ? `
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <thead>
            <tr style="border-bottom:2px solid #e5e7eb;">
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#9ca3af;text-transform:uppercase;">Direction</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#9ca3af;text-transform:uppercase;">Asset</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#9ca3af;text-transform:uppercase;">Amount</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#9ca3af;text-transform:uppercase;">P&L</th>
            </tr>
          </thead>
          <tbody>
            ${tradeRows}
          </tbody>
        </table>`
            : `<p style="color:#9ca3af;font-style:italic;">No trades executed today.</p>`
        }

        ${journalSection}

        <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Krypto Autonomous Trading Agent</p>
      </div>
    </div>
  `;

  return sendEmail(subject, html, data, "daily summary", options);
}
