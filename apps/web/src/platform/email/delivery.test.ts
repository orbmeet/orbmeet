import { describe, expect, it, vi } from "vitest";
import {
  buildOtpEmail,
  deliverEmail,
  parseFromAddress,
  sanitizeSubject,
  sendEmail,
  type EmailSendBinding,
} from "./delivery";

function stubBinding(impl?: Partial<EmailSendBinding>): EmailSendBinding & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(impl?.send ?? (async () => ({ messageId: "msg_1" }))) };
}

const input = { to: "person@example.com", subject: "Meeting", html: "<p>Meeting</p>" };

describe("parseFromAddress", () => {
  it("parses a named address into the structured form", () => {
    expect(parseFromAddress("Orb Meet <noreply@orbmeet.com>")).toEqual({
      email: "noreply@orbmeet.com",
      name: "Orb Meet",
    });
  });

  it("accepts a bare address and keeps the default display name", () => {
    expect(parseFromAddress("noreply@orbmeet.com")).toEqual({
      email: "noreply@orbmeet.com",
      name: "Orb Meet",
    });
  });

  it("falls back to the default sender when unset or blank", () => {
    expect(parseFromAddress(undefined)).toEqual({ email: "noreply@orbmeet.com", name: "Orb Meet" });
    expect(parseFromAddress("   ")).toEqual({ email: "noreply@orbmeet.com", name: "Orb Meet" });
  });
});

describe("deliverEmail", () => {
  it("sends through the binding with a structured sender and text body", async () => {
    const binding = stubBinding();

    await expect(deliverEmail(binding, { ...input, text: "Meeting" })).resolves.toMatchObject({
      accepted: true,
      retryable: false,
      error: null,
    });
    expect(binding.send).toHaveBeenCalledWith({
      to: "person@example.com",
      from: { email: "noreply@orbmeet.com", name: "Orb Meet" },
      subject: "Meeting",
      html: "<p>Meeting</p>",
      text: "Meeting",
    });
  });

  it("reports a missing binding as a terminal configuration failure", async () => {
    await expect(deliverEmail(undefined, input)).resolves.toMatchObject({
      accepted: false,
      retryable: false,
    });
    await expect(sendEmail(null, input)).resolves.toBe(false);
  });

  it("retries only the provider-capacity failures", async () => {
    for (const code of ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR"]) {
      const binding = stubBinding({
        send: async () => { throw Object.assign(new Error(code), { code }); },
      });
      await expect(deliverEmail(binding, input)).resolves.toMatchObject({
        accepted: false,
        retryable: true,
        failure: "transient",
        suppression: null,
        code,
        error: `Email provider rejected the message (${code})`,
      });
    }
  });

  it("classifies validation, sender, and content errors as terminal", async () => {
    const expected = {
      E_VALIDATION_ERROR: "content",
      E_CONTENT_TOO_LARGE: "content",
      E_HEADER_VALUE_INVALID: "content",
      E_SENDER_NOT_VERIFIED: "configuration",
      E_SENDER_DOMAIN_NOT_AVAILABLE: "configuration",
      E_RECIPIENT_NOT_ALLOWED: "configuration",
    } as const;
    for (const [code, failure] of Object.entries(expected)) {
      const binding = stubBinding({
        send: async () => { throw Object.assign(new Error(code), { code }); },
      });
      await expect(deliverEmail(binding, input)).resolves.toMatchObject({
        accepted: false,
        retryable: false,
        failure,
        suppression: null,
      });
    }
  });

  // Cloudflare runs its own soft-bounce retries and never retries a hard
  // bounce, so a delivery failure that reaches us is settled, not pending.
  // Resending would send nothing and add to the hard-bounce rate.
  it("treats a delivery failure as terminal and suppresses the address", async () => {
    const binding = stubBinding({
      send: async () => {
        throw Object.assign(new Error("nope"), { code: "E_DELIVERY_FAILED" });
      },
    });
    await expect(deliverEmail(binding, input)).resolves.toMatchObject({
      accepted: false,
      retryable: false,
      failure: "recipient",
      suppression: "bounced",
      code: "E_DELIVERY_FAILED",
    });
  });

  it("records an already-suppressed recipient without guessing why", async () => {
    const binding = stubBinding({
      send: async () => {
        throw Object.assign(new Error("nope"), { code: "E_RECIPIENT_SUPPRESSED" });
      },
    });
    await expect(deliverEmail(binding, input)).resolves.toMatchObject({
      accepted: false,
      retryable: false,
      failure: "recipient",
      suppression: "provider_suppressed",
    });
  });

  it("keeps the recipient and message out of the log on an unrecognized error", async () => {
    const binding = stubBinding({
      send: async () => { throw new Error("smtp said person@example.com is bad"); },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deliverEmail(binding, input)).resolves.toMatchObject({
      accepted: false,
      retryable: true,
      failure: "transient",
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("person@example.com");
    errorSpy.mockRestore();
  });

  it("passes reply-to and allowlisted headers through", async () => {
    const binding = stubBinding();
    await deliverEmail(binding, {
      ...input,
      replyTo: "Organizer <organizer@example.com>",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    expect(binding.send).toHaveBeenCalledWith(expect.objectContaining({
      replyTo: { email: "organizer@example.com", name: "Organizer" },
      headers: { "Auto-Submitted": "auto-generated" },
    }));
  });

  it("preserves structured reply-to names without reparsing user text", async () => {
    const binding = stubBinding();
    await deliverEmail(binding, {
      ...input,
      replyTo: { email: "organizer@example.com", name: 'Ann "Ops" <3' },
    });
    expect(binding.send).toHaveBeenCalledWith(expect.objectContaining({
      replyTo: { email: "organizer@example.com", name: 'Ann "Ops" <3' },
    }));
  });

  it("omits empty header and reply-to fields rather than sending blanks", async () => {
    const binding = stubBinding();
    await deliverEmail(binding, { ...input, replyTo: null, headers: {} });
    const [message] = binding.send.mock.calls[0] as [Record<string, unknown>];
    expect(message).not.toHaveProperty("replyTo");
    expect(message).not.toHaveProperty("headers");
  });

  it("flattens a subject that carries line breaks", async () => {
    const binding = stubBinding();
    await deliverEmail(binding, { ...input, subject: "Standup\r\nBcc: evil@example.com" });
    expect(binding.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: "Standup Bcc: evil@example.com",
    }));
  });

  it("treats errors without a code as retryable", async () => {
    const binding = stubBinding({
      send: async () => { throw new Error("boom"); },
    });
    await expect(deliverEmail(binding, input)).resolves.toMatchObject({
      accepted: false,
      retryable: true,
    });
  });
});

describe("sanitizeSubject", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeSubject("  Weekly\r\n sync\u0000  ")).toBe("Weekly sync");
  });

  it("clamps to the RFC 5322 subject limit", () => {
    expect(sanitizeSubject("a".repeat(1200))).toHaveLength(998);
  });
});

describe("buildOtpEmail", () => {
  it("renders the code in both html and text bodies", () => {
    const email = buildOtpEmail("123456", "login");
    expect(email.html).toContain("123456");
    expect(email.text).toContain("123456");
    expect(email.text).not.toContain("<");
  });
});
