import { describe, expect, it, vi } from "vitest";
import { checkDisposableEmail } from "./disposable-email";

describe("disposable email policy", () => {
  it("rejects known providers and their subdomains locally", async () => {
    await expect(checkDisposableEmail("person@mailinator.com")).rejects.toMatchObject({
      code: "TEMPORARY_EMAIL",
    });
    await expect(checkDisposableEmail("person@sub.mailinator.com")).rejects.toMatchObject({
      code: "TEMPORARY_EMAIL",
    });
  });

  it("does not send signup addresses to a third party", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(checkDisposableEmail("person@example.com")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
