import { Resend } from "resend";

export type EmailDeliveryResult =
  | { status: "sent"; id?: string }
  | { status: "skipped"; reason: string };

export class EmailDeliveryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ RESEND_API_KEY not set — emails will be logged to console");
    return null;
  }
  return new Resend(apiKey);
}

function getEmailAddresses(): { to: string; from: string } | null {
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM;
  if (!to || !from) {
    console.warn(
      "⚠️ ALERT_EMAIL_TO or ALERT_EMAIL_FROM not set — emails will be logged to console"
    );
    return null;
  }
  return { to, from };
}

export async function sendGuardrailAlert(
  guardrailName: string,
  details: {
    portfolioValue?: number;
    lastTradeTime?: Date;
    error?: string;
  }
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

  const resend = getResendClient();
  const addresses = getEmailAddresses();

  if (!resend || !addresses) {
    const reason = !resend
      ? "RESEND_API_KEY is not configured"
      : "ALERT_EMAIL_TO or ALERT_EMAIL_FROM is not configured";
    console.log(`[email no-op] ${subject}\n${JSON.stringify(details)}`);
    return { status: "skipped", reason };
  }

  try {
    const response = await resend.emails.send({
      from: addresses.from,
      to: addresses.to,
      subject,
      html,
    });
    if (response.error) {
      throw new EmailDeliveryError(
        `Resend rejected guardrail alert: ${response.error.message}`,
        response.error,
      );
    }
    return response.data?.id
      ? { status: "sent", id: response.data.id }
      : { status: "sent" };
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    throw new EmailDeliveryError("Failed to send guardrail alert", error);
  }
}

export async function sendDailySummary(data: {
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
}): Promise<EmailDeliveryResult> {
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

  const resend = getResendClient();
  const addresses = getEmailAddresses();

  if (!resend || !addresses) {
    const reason = !resend
      ? "RESEND_API_KEY is not configured"
      : "ALERT_EMAIL_TO or ALERT_EMAIL_FROM is not configured";
    console.log(`[email no-op] ${subject}\n${JSON.stringify(data)}`);
    return { status: "skipped", reason };
  }

  try {
    const response = await resend.emails.send({
      from: addresses.from,
      to: addresses.to,
      subject,
      html,
    });
    if (response.error) {
      throw new EmailDeliveryError(
        `Resend rejected daily summary: ${response.error.message}`,
        response.error,
      );
    }
    return response.data?.id
      ? { status: "sent", id: response.data.id }
      : { status: "sent" };
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    throw new EmailDeliveryError("Failed to send daily summary", error);
  }
}
