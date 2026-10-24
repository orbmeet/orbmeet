import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { ArrowRight } from "lucide-react";
import { focus, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text } from "@orbmeet/ui/tokens/typography.stylex";
import { EXAMPLE_MEETING_CODE } from "@/modules/meetings/contract/constants";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { readCodeInput } from "@/modules/meetings/client/format-code";
import { isMeetingCode } from "@/modules/meetings/contract/meeting-path";

const styles = stylex.create({
  form: {
    display: "flex",
    gap: space.s2,
    marginTop: space.s5,
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    height: 40,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.base,
    borderRadius: radii.control,
    backgroundColor: surface.raised,
    color: ink.strong,
    paddingInline: space.s3,
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
  },
  submit: {
    width: 40,
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    color: ink.onAccent,
    cursor: "pointer",
    opacity: { default: 1, ":disabled": 0.45 },
  },
  error: {
    marginTop: space.s2,
    marginBottom: 0,
    color: ink.muted,
    fontSize: text.xs,
    textAlign: "left",
  },
});

/** Public retry path: it works for guests and signed-in users alike. */
export function MeetingCodeRetryForm() {
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isMeetingCode(code)) {
      setError(`Enter a code like ${EXAMPLE_MEETING_CODE}`);
      return;
    }
    beginMeetingEntryFlow({ source: "meeting-not-found-retry", code });
    window.location.assign(`/${code}`);
  };

  return (
    <>
      <form onSubmit={submit} {...stylex.props(styles.form)}>
        <input
          value={code}
          onChange={(event) => {
            setError("");
            setCode(readCodeInput(event.target.value));
          }}
          placeholder="Enter another meeting code"
          aria-label="Meeting code"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "meeting-code-retry-error" : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          {...stylex.props(styles.input, focus.ring)}
        />
        <button
          type="submit"
          disabled={!code}
          aria-label="Try meeting code"
          {...stylex.props(pressable.base, focus.ring, styles.submit)}
        >
          <ArrowRight size={17} />
        </button>
      </form>
      {error ? <p id="meeting-code-retry-error" {...stylex.props(styles.error)}>{error}</p> : null}
    </>
  );
}
