// The way out of another app's built-in browser; see open-in-browser.html.
//
// The page OrbMeet was opened on arrives as this page's fragment, which is
// never sent to a server: a path can carry a secret, such as an invite token.
// It is read as a path on this origin only, so the page cannot be pointed
// anywhere else.
(function () {
  var target = "/";
  try {
    var asked = decodeURIComponent(location.hash.slice(1));
    if (asked.charAt(0) === "/" && asked.charAt(1) !== "/" && asked.charAt(1) !== "\\") target = asked;
  } catch {}
  var href = location.origin + target;

  var nav = navigator;
  var ua = nav.userAgent || "";
  var android = /Android/i.test(ua);
  // A touch "Macintosh" is an iPad (see src/lib/browser-capabilities.ts).
  var ios = !android && (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1));

  // An intent URL with no package names no app: Android opens the page in
  // the person's default browser, which need not be Chrome, and which every
  // phone has (developer.chrome.com, "Android Intents with Chrome").
  // `x-safari-` is the prefix iOS 17 and later open in Safari. Where the app
  // around this page does not honour either, the hint and the link remain.
  var open = android
    ? "intent://" + location.host + target + "#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end"
    : ios
      ? "x-safari-" + href
      : null;

  var openLink = document.getElementById("open");
  var copyButton = document.getElementById("copy");
  var hint = document.getElementById("hint");

  if (open) {
    openLink.href = open;
    openLink.textContent = android ? "Open in browser" : "Open in Safari";
    openLink.hidden = false;
    hint.textContent = android
      ? "Or open this app’s menu (⋮) and choose “Open in browser”."
      : "Or open this app’s menu (⋯) and choose “Open in Safari”, or paste the link into Safari.";
  }

  copyButton.addEventListener("click", function () {
    function copied() {
      copyButton.textContent = "Link copied";
    }
    function manual() {
      window.prompt("Copy this link:", href);
    }
    if (nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(href).then(copied, manual);
    else manual();
  });

  // How many people meet this page, from which apps (ingested by
  // src/routes/api/diagnostics/client-event.ts). The path stays out of it.
  try {
    fetch("/api/diagnostics/client-event", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "in_app_browser_blocked",
        ts: new Date().toISOString(),
        escape: android ? "android" : ios ? "ios" : "other",
        browser: {
          userAgent: ua.slice(0, 512),
          platform: String(nav.platform || "").slice(0, 100),
          maxTouchPoints: nav.maxTouchPoints || 0,
        },
      }),
    }).catch(function () {});
  } catch {}

  // Nothing opens without a tap. A webview that does not handle intent URLs
  // replaces the page with an error for one, which would take the link and
  // the copy button with it.
})();
