import * as React from "react";
import { buttonStyles } from "@orbmeet/ui/react";
import { ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { logError } from "@/lib/logger";
import { reportBoundaryError } from "@/lib/telemetry/client-errors";

/**
 * Keeps a crash in the meeting's view from ending the call.
 *
 * Without it a render error anywhere in the room reaches the route's error
 * page, which unmounts `MeetingConnection` and with it the LiveKit room: one
 * broken panel hangs everyone up on this participant. Placed inside the
 * connection and around the view only, so the room, its audio and the
 * published microphone keep going while the view offers to rebuild itself.
 */
export class MeetingViewBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; generation: number }
> {
  state: { error: Error | null; generation: number } = { error: null, generation: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logError("[Meeting] Meeting view crashed", error, info.componentStack);
    reportBoundaryError("meeting-view", error, info.componentStack);
  }

  private readonly rebuild = () => {
    this.setState(({ generation }) => ({ error: null, generation: generation + 1 }));
  };

  render() {
    if (!this.state.error) {
      return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
    }
    return (
      <div role="alert" {...stylex.props(styles.screen)}>
        <h1 {...stylex.props(styles.title)}>The meeting view stopped working</h1>
        <p {...stylex.props(styles.copy)}>
          You are still in the call, and people can still hear you.
        </p>
        <button type="button" onClick={this.rebuild} {...stylex.props(...buttonStyles(), styles.action)}>
          Reload view
        </button>
      </div>
    );
  }
}

const styles = stylex.create({
  screen: {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    paddingInline: space.s6,
    backgroundColor: neutral.n50,
  },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: text.xl,
    lineHeight: leading.xl,
    fontWeight: weight.bold,
    color: ink.strong,
  },
  copy: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  action: { marginTop: space.s6 },
});
