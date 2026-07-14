const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn(() => ({
    emails: {
      send: mockSend,
    },
  })),
}));

import {
  EmailDeliveryError,
  escapeHtml,
  sendDailySummary,
} from "@/lib/email";

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

describe("email delivery", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalTo = process.env.ALERT_EMAIL_TO;
  const originalFrom = process.env.ALERT_EMAIL_FROM;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.ALERT_EMAIL_TO = "operator@example.com";
    process.env.ALERT_EMAIL_FROM = "agent@example.com";
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
    if (originalTo === undefined) delete process.env.ALERT_EMAIL_TO;
    else process.env.ALERT_EMAIL_TO = originalTo;
    if (originalFrom === undefined) delete process.env.ALERT_EMAIL_FROM;
    else process.env.ALERT_EMAIL_FROM = originalFrom;
  });

  it("escapes untrusted content before inserting it into HTML", async () => {
    mockSend.mockResolvedValue({ data: { id: "email-1" }, error: null });

    await expect(sendDailySummary(summary)).resolves.toEqual({
      status: "sent",
      id: "email-1",
    });

    const html = mockSend.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("BUY&lt;script&gt;");
    expect(html).toContain("ETH&lt;img&gt;");
  });

  it("throws when Resend returns an error response", async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { message: "provider rejected request" },
    });

    await expect(sendDailySummary(summary)).rejects.toBeInstanceOf(
      EmailDeliveryError,
    );
  });

  it("returns an explicit skipped result when delivery is not configured", async () => {
    delete process.env.RESEND_API_KEY;

    await expect(sendDailySummary(summary)).resolves.toEqual({
      status: "skipped",
      reason: "RESEND_API_KEY is not configured",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("escapeHtml", () => {
  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
