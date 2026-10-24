import { describe, expect, it } from "vitest";
import { readRequestBodyText, RequestBodyTimeoutError, RequestBodyTooLargeError } from "./request-body";

describe("request body limits", () => {
  it("reads text bodies within the configured limit", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "ok",
      headers: { "Content-Type": "text/plain" },
    });

    await expect(readRequestBodyText(request, 8)).resolves.toBe("ok");
  });

  it("rejects bodies whose declared content-length exceeds the limit", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "abcdef",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "6",
      },
    });

    await expect(readRequestBodyText(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects streamed bodies that exceed the limit", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "abcdef",
      headers: { "Content-Type": "text/plain" },
    });

    await expect(readRequestBodyText(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects bodies that do not finish before the timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
      },
    });
    const request = new Request("https://example.com", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readRequestBodyText(request, 8, 5)).rejects.toBeInstanceOf(RequestBodyTimeoutError);
  });
});
