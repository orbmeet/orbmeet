/**
 * The per-response script nonce, and how a component gets hold of it.
 *
 * Production HTML is rendered once and the Worker rewrites this marker with a
 * fresh nonce while streaming each *private* application document
 * (`addPrivateHtmlSecurityHeaders`). Prerendered public documents are served
 * from the ASSETS binding without rewriting, so they keep the marker — which
 * is inert there, because their policy carries no `nonce-` source and allows
 * inline content outright.
 */
export const CSP_NONCE_PLACEHOLDER = "__ORBMEET_CSP_NONCE__";

/**
 * The nonce to hand libraries that inject their own `<style>` or `<script>`
 * elements — Base UI, via `CSPProvider`.
 *
 * In practice these are inserted on the client: `@base-ui/react` is replaced by
 * `ssrClientStubs` in the Worker build, so nothing it renders reaches the
 * server. The live case is `Select.Popup`'s stylesheet, which React inserts
 * when a select first opens; `Tabs.Indicator`'s pre-hydration script is the
 * other, and its body is empty in browser bundles. Neither is broken today,
 * because `style-src`/`script-src` still permit inline content on the paths
 * that matter — the nonce is what lets that permission be withdrawn, and it
 * keeps these off the violation report in the meantime.
 *
 * Server and client agree on the value: the server renders the marker, the
 * Worker rewrites it in the stream, and the client reads the result back out of
 * the delivered HTML. Browsers blank the `nonce` *attribute* after parsing so
 * it cannot be exfiltrated through a CSS attribute selector; the IDL property
 * keeps the real value, which is why this reads `.nonce` rather than
 * `getAttribute("nonce")`.
 */
export function resolveCspNonce(): string | undefined {
  if (typeof document === "undefined") return CSP_NONCE_PLACEHOLDER;
  const carrier = document.querySelector<HTMLScriptElement>("script[nonce]");
  return carrier?.nonce || undefined;
}
