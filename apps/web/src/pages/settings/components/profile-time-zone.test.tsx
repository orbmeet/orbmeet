import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProfileSection } from "./profile-section";

function markup(timeZone: string | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProfileSection
        user={{ name: "Atiq Rahman", email: "atiq@example.com", timeZone }}
      />
    </QueryClientProvider>,
  );
}

/**
 * A null `timeZone` means "follow whatever device you are on". The picker still
 * has to show a concrete zone, so the only thing separating that from a stored
 * preference is the hint underneath it — which is why it is worth a test.
 */
describe("time zone", () => {
  it("says so when no zone has been saved", () => {
    const html = markup(null);

    expect(html).toContain("Following this device");
    expect(html).toContain("Pick a zone to keep it the same everywhere");
    expect(html).not.toContain("on every device");
  });

  it("describes a saved zone as the fixed default", () => {
    const html = markup("Asia/Dhaka");

    expect(html).toContain("use this zone on every device");
    expect(html).not.toContain("Following this device");
  });

  it("saves as you go: no Save button contradicts the page", () => {
    expect(markup("Asia/Dhaka")).not.toContain("Save changes");
  });
});
