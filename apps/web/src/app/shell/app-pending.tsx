import { spinner } from "@orbmeet/ui/styles/animations";
import { layout } from "@orbmeet/ui/styles/atoms";
import { neutral } from "@orbmeet/ui/tokens/colors.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  root: {
    display: "flex",
    minHeight: "100vh",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: neutral.n50,
  },
  ring: { width: 24, height: 24, borderWidth: 2 },
});

/**
 * Stable document-level fallback: what a route that renders on the client
 * shows in the server's document, and again on its first client-side match.
 * The two must stay identical so React hydrates it without replacing it.
 */
export function AppPending() {
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(spinner.ring, spinner.neutral, styles.ring)} />
      <span {...stylex.props(layout.srOnly)}>Loading Orb Meet</span>
    </div>
  );
}
