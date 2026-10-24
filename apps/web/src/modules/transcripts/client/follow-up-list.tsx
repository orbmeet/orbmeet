import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { setFollowUpDone } from "@/modules/transcripts/server/follow-ups.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { useToast } from "@orbmeet/ui/react";
import { focus } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

export interface FollowUpItem {
  id: string;
  text: string;
  done: boolean;
  /** A second line: whose it is, or which meeting it came from. */
  detail?: ReactNode;
}

/** A white tick, drawn into the box when it is checked. */
const TICK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 12.5l4 4L18 8' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

const styles = stylex.create({
  list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" },
  item: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    paddingBlock: space.s3,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: border.subtle,
  },
  /**
   * The box is drawn rather than native, so it matches in both themes. A tick
   * grows into it from the centre when checked, and the box gives a little
   * when pressed — the confirmation is felt as much as seen.
   */
  box: {
    appearance: "none",
    flexShrink: 0,
    width: 20,
    height: 20,
    margin: 0,
    marginTop: 1,
    borderRadius: 6,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: { default: border.strong, ":checked": accent.a600 },
    backgroundColor: { default: "transparent", ":checked": accent.a600 },
    backgroundImage: TICK,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    backgroundSize: { default: "0% 0%", ":checked": "100% 100%" },
    cursor: "pointer",
    transform: { default: "scale(1)", ":active": "scale(0.86)" },
    transitionProperty: { default: "background-color, border-color, background-size, transform", [env.reducedMotion]: "none" },
    transitionDuration: "220ms",
    transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    outlineOffset: 2,
  },
  label: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, cursor: "pointer" },
  text: { fontSize: text.sm, lineHeight: 1.4, color: ink.strong, transitionProperty: "color", transitionDuration: "200ms" },
  textDone: { color: ink.muted, textDecorationLine: "line-through" },
  detail: { fontSize: "0.8125rem", color: ink.muted },
});

/**
 * What people agreed to do, each a checkbox. Ticking one off ticks it off for
 * everyone who can open the meeting: the work is shared, so is its state.
 */
export function FollowUpList({ items, meetingId }: { items: FollowUpItem[]; meetingId?: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const baseId = useId();
  // What each box is being set to, by follow-up, until the lists it appears
  // in have been read again. Kept per item rather than read from the
  // mutation, which only remembers its latest call: ticking a second box
  // would otherwise show the first one unticked until the refetch landed.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const mutation = useMutation({
    mutationFn: (input: { followUpId: string; done: boolean }) => setFollowUpDone({ data: input }),
    onMutate: (input) => setPending((current) => new Map(current).set(input.followUpId, input.done)),
    onError: () =>
      toast.add({ title: "Couldn’t update that follow-up", description: "Try again in a moment.", data: { variant: "error" } }),
    onSettled: async (_data, _error, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.meetings.openFollowUps() }),
        meetingId ? queryClient.invalidateQueries({ queryKey: queryKeys.meetings.summary(meetingId) }) : null,
      ]);
      setPending((current) => {
        const next = new Map(current);
        next.delete(input.followUpId);
        return next;
      });
    },
  });

  return (
    <ul {...stylex.props(styles.list)}>
      {items.map((item) => {
        const pendingDone = pending.get(item.id);
        const done = pendingDone ?? item.done;
        const id = `${baseId}-${item.id}`;
        return (
          <li key={item.id} {...stylex.props(styles.item)}>
            <input
              id={id}
              type="checkbox"
              checked={done}
              disabled={pendingDone !== undefined}
              onChange={(event) => mutation.mutate({ followUpId: item.id, done: event.target.checked })}
              {...stylex.props(styles.box, focus.ring)}
            />
            <label htmlFor={id} {...stylex.props(styles.label)}>
              <span {...stylex.props(styles.text, done && styles.textDone)}>{item.text}</span>
              {item.detail ? <span {...stylex.props(styles.detail)}>{item.detail}</span> : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
