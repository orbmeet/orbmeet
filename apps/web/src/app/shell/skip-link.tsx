import { focus } from "@orbmeet/ui/styles/atoms";
import { accent, ink } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

/** The `id` every page's `<main>` carries, and the link's target. */
export const MAIN_CONTENT_ID = "main-content";

const styles = stylex.create({
  /**
   * Off-screen until focused, then pinned over the top-left of the page.
   *
   * Not `layout.srOnly`: that one is permanent, and this element's whole job is
   * to become visible. Positioned rather than `display: none` so it stays in
   * the tab order, which is the only reason it exists.
   */
  link: {
    position: "fixed",
    top: { default: "auto", ":focus-visible": space.s4 },
    left: { default: "auto", ":focus-visible": space.s4 },
    width: { default: 1, ":focus-visible": "auto" },
    height: { default: 1, ":focus-visible": "auto" },
    overflow: { default: "hidden", ":focus-visible": "visible" },
    clipPath: { default: "inset(50%)", ":focus-visible": "none" },
    whiteSpace: "nowrap",
    // Above everything: `PublicNav` floats its bar at `zIndex.popover`, and a
    // skip link that lands underneath the nav it is skipping is no use.
    zIndex: zIndex.tooltip,
    borderRadius: radii.control,
    backgroundColor: accent.a700,
    paddingInline: space.s4,
    paddingBlock: space.s2_5,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.onDark,
    textDecorationLine: "none",
  },
});

/**
 * "Skip to content", the first thing in the tab order.
 *
 * Without it a keyboard user re-tabs the brand and five nav links on every
 * page before reaching anything they came for. A plain `<a href="#…">` rather
 * than a router `Link`: this must move focus in the current document, not
 * navigate.
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      // The href alone scrolls but does not reliably move focus — `<main>` is
      // not focusable, and browsers disagree about whether a fragment target
      // becomes one. Rather than make all six `<main>`s carry `tabIndex={-1}`
      // for a detail that belongs to this link, make the target focusable just
      // long enough to receive focus. The attribute comes off on blur, not
      // immediately: removing it in the same tick un-focuses the element we
      // just focused, and focus falls back to `<body>`.
      onClick={(event) => {
        const target = document.getElementById(MAIN_CONTENT_ID);
        if (!target) return;
        event.preventDefault();
        target.setAttribute("tabindex", "-1");
        target.addEventListener(
          "blur",
          () => {
            target.removeAttribute("tabindex");
          },
          { once: true },
        );
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start" });
      }}
      {...stylex.props(styles.link, focus.ring)}
    >
      Skip to content
    </a>
  );
}
