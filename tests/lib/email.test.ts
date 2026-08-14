const mockPollUntilDone = jest.fn();
const mockBeginSend = jest.fn();
const mockEmailClient = jest.fn().mockImplementation(() => ({
  beginSend: mockBeginSend,
}));

jest.mock("@azure/communication-email", () => ({
  EmailClient: mockEmailClient,
}));

import {
  EmailDeliveryError,
  escapeHtml,
  sendDailySummary,
  sendGuardrailAlert,
} from "@/lib/email";

const connectionString =
  "endpoint=https://test.communication.azure.com/;accesskey=test-key";
const summary = {
  portfolioValueUSD: 200,
  totalPnlUSD: 1,
  tradesExecuted: 1,
  tradesSummary: [
    {
      direction: "BUY<script>",
      asset: "ETH<img>",
      amountUSD: 25,
      pnlUSD: null,
    },
  ],
  journalHighlights: ["Model said <script>alert(1)</script>"],
};
const managedEnvNames = [
  "NODE_ENV",
  "AZURE_COMMUNICATION_CONNECTION_STRING",
  "AZURE_COMMUNICATION_EMAIL_SENDER",
  "ALERT_EMAIL_TO",
  "RESEND_API_KEY",
  "ALERT_EMAIL_FROM",
] as const;
const originalEnv = Object.fromEntries(
  managedEnvNames.map((name) => [name, process.env[name]]),
) as Record<(typeof managedEnvNames)[number], string | undefined>;

function restoreEnvironment(): void {
  for (const name of managedEnvNames) {
    const originalValue = originalEnv[name];
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
}

describe("email delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.AZURE_COMMUNICATION_CONNECTION_STRING = connectionString;
    process.env.AZURE_COMMUNICATION_EMAIL_SENDER =
      "DoNotReply@test.azurecomm.net";
    process.env.ALERT_EMAIL_TO = "operator@example.com";
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_EMAIL_FROM;
    mockBeginSend.mockResolvedValue({ pollUntilDone: mockPollUntilDone });
    mockPollUntilDone.mockResolvedValue({
      id: "operation-1",
      status: "Succeeded",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(restoreEnvironment);

  it("sends escaped daily-summary HTML through ACS and returns its operation ID", async () => {
    await expect(sendDailySummary(summary)).resolves.toEqual({
      status: "sent",
      id: "operation-1",
    });

    expect(mockEmailClient).toHaveBeenCalledWith(connectionString);
    expect(mockBeginSend).toHaveBeenCalledTimes(1);
    const [message, sendOptions] = mockBeginSend.mock.calls[0];
    expect(message).toMatchObject({
      senderAddress: "DoNotReply@test.azurecomm.net",
      recipients: {
        to: [{ address: "operator@example.com" }],
      },
      content: {
        subject: expect.stringContaining("Krypto Daily Summary"),
      },
    });
    expect(sendOptions.abortSignal).toBeInstanceOf(AbortSignal);
    expect(mockPollUntilDone).toHaveBeenCalledWith({
      abortSignal: sendOptions.abortSignal,
    });

    const html = message.content.html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("BUY&lt;script&gt;");
    expect(html).toContain("ETH&lt;img&gt;");
  });

  it("preserves guardrail content while escaping untrusted values", async () => {
    await sendGuardrailAlert("<b>Max Drawdown</b>", {
      portfolioValue: 149.5,
      lastTradeTime: new Date("2026-08-13T12:00:00.000Z"),
      error: `<script>alert("unsafe")</script>`,
    });

    const message = mockBeginSend.mock.calls[0][0];
    expect(message.content.subject).toContain("<b>Max Drawdown</b>");
    expect(message.content.html).toContain("&lt;b&gt;Max Drawdown&lt;/b&gt;");
    expect(message.content.html).toContain("$149.50");
    expect(message.content.html).toContain("2026-08-13T12:00:00.000Z");
    expect(message.content.html).toContain(
      "&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;",
    );
  });

  it("surfaces an ACS terminal failure with provider details", async () => {
    const providerError = {
      code: "InvalidRecipient",
      message: "provider rejected request",
    };
    mockPollUntilDone.mockResolvedValue({
      id: "operation-failed",
      status: "Failed",
      error: providerError,
    });

    await expect(sendDailySummary(summary)).rejects.toMatchObject({
      name: "EmailDeliveryError",
      message: expect.stringContaining(
        "status Failed: InvalidRecipient — provider rejected request",
      ),
      cause: providerError,
    });
  });

  it("wraps SDK request failures as EmailDeliveryError", async () => {
    const sdkError = new Error("network unavailable");
    mockBeginSend.mockRejectedValue(sdkError);

    await expect(sendDailySummary(summary)).rejects.toMatchObject({
      name: "EmailDeliveryError",
      message: "Failed to send daily summary through ACS Email",
      cause: sdkError,
    });
  });

  it("surfaces polling timeouts as EmailDeliveryError", async () => {
    jest.useFakeTimers();
    mockPollUntilDone.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () => {
            reject(new Error("polling aborted"));
          });
        }),
    );

    const delivery = expect(sendDailySummary(summary)).rejects.toMatchObject({
      name: "EmailDeliveryError",
      message:
        "Timed out sending daily summary through ACS Email after 20000ms",
    });
    await jest.advanceTimersByTimeAsync(20_000);
    await delivery;
  });

  it("rejects a succeeded response without an operation ID", async () => {
    mockPollUntilDone.mockResolvedValue({
      id: "",
      status: "Succeeded",
    });

    await expect(sendDailySummary(summary)).rejects.toMatchObject({
      name: "EmailDeliveryError",
      message:
        "ACS email daily summary succeeded without an operation ID",
    });
  });

  it("returns an explicit console-only skip outside production when config is missing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation();
    const log = jest.spyOn(console, "log").mockImplementation();
    delete process.env.AZURE_COMMUNICATION_CONNECTION_STRING;
    process.env.RESEND_API_KEY = "legacy-key-is-ignored";
    process.env.ALERT_EMAIL_FROM = "legacy-sender@example.com";

    await expect(sendDailySummary(summary)).resolves.toEqual({
      status: "skipped",
      reason:
        "Missing ACS email configuration: AZURE_COMMUNICATION_CONNECTION_STRING",
    });
    expect(mockEmailClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("delivery is console-only outside production"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[email no-op]"),
    );
    warn.mockRestore();
    log.mockRestore();
  });

  it("skips malformed connection strings outside production", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation();
    const log = jest.spyOn(console, "log").mockImplementation();
    process.env.AZURE_COMMUNICATION_CONNECTION_STRING =
      "accesskey=missing-endpoint";

    await expect(sendDailySummary(summary)).resolves.toEqual({
      status: "skipped",
      reason:
        "AZURE_COMMUNICATION_CONNECTION_STRING must include a valid HTTPS Endpoint and AccessKey",
    });
    expect(mockEmailClient).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it("fails closed in production when ACS configuration is incomplete", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.AZURE_COMMUNICATION_EMAIL_SENDER;

    await expect(sendDailySummary(summary)).rejects.toMatchObject({
      name: "EmailDeliveryError",
      message:
        "ACS email delivery is not configured for production: Missing ACS email configuration: AZURE_COMMUNICATION_EMAIL_SENDER",
    });
    expect(mockEmailClient).not.toHaveBeenCalled();
  });

  it("fails closed in production when the ACS endpoint is invalid", async () => {
    process.env.NODE_ENV = "production";
    process.env.AZURE_COMMUNICATION_CONNECTION_STRING =
      "endpoint=not-a-url;accesskey=test-key";

    await expect(sendDailySummary(summary)).rejects.toBeInstanceOf(
      EmailDeliveryError,
    );
    expect(mockEmailClient).not.toHaveBeenCalled();
  });
});

describe("escapeHtml", () => {
  afterAll(restoreEnvironment);

  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
