import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Monitor, Moon, Sun } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { queryKeys } from "@/app/query-client/query-keys";
import { applyAppearance, type Appearance } from "@/app/appearance/appearance";
import { setAppearance } from "@/modules/identity/server/account.functions";
import { motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { settings } from "../settings-styles";
import { SettingsSection } from "./settings-section";

const CHOICES: { value: Appearance; label: string; note: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", note: "Matches this device", icon: Monitor },
  { value: "light", label: "Light", note: "Always light", icon: Sun },
  { value: "dark", label: "Dark", note: "Always dark", icon: Moon },
];

const styles = stylex.create({
  legend: { marginBottom: space.s3, padding: 0 },
  group: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    display: "grid",
    // Three in a row, or a list on a phone: auto-fit left "Dark" alone on a second row.
    gridTemplateColumns: { default: "1fr", [bp.sm]: "repeat(3, minmax(0, 1fr))" },
    gap: space.s3,
  },
  choice: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    minHeight: 56,
    paddingInline: space.s4,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: { default: border.subtle, ":has(:checked)": accent.a600 },
    borderRadius: 14,
    cursor: "pointer",
    // The input is invisible, so the card shows where the keyboard is.
    outlineStyle: { default: "none", ":has(:focus-visible)": "solid" },
    outlineWidth: 2,
    outlineOffset: 2,
    outlineColor: accent.a600,
    backgroundColor: {
      default: surface.raised,
      ":has(:checked)": accent.a50,
      [env.hoverable]: { default: surface.raised, ":hover": neutral.n50, ":has(:checked)": accent.a50 },
    },
  },
  // The real control, kept for keyboard and screen readers; the card is what is drawn.
  input: { position: "absolute", opacity: 0, inset: 0, margin: 0, cursor: "pointer" },
  icon: { color: ink.muted, flexShrink: 0 },
  label: { display: "flex", flexDirection: "column", gap: 2 },
  name: { fontSize: text.sm, fontWeight: weight.semibold, color: ink.strong },
  note: { fontSize: "0.8125rem", color: ink.muted },
});

/**
 * Light, dark, or the device's. Applied at once, saved on the account so it
 * follows the person, and kept on this device so the next page paints in it.
 */
export function AppearanceSection({ appearance }: { appearance: Appearance }) {
  const queryClient = useQueryClient();
  const name = useId();

  const mutation = useMutation({
    mutationFn: (next: Appearance) => setAppearance({ data: { appearance: next } }),
    onMutate: async (next) => {
      applyAppearance(next);
      await queryClient.cancelQueries({ queryKey: queryKeys.session() });
      const previousSession = queryClient.getQueryData(queryKeys.session());
      queryClient.setQueryData(queryKeys.session(), (old) => {
        if (!old || typeof old !== "object") return old;
        const session = old as Record<string, unknown>;
        if (!session.user || typeof session.user !== "object") return old;
        return { ...session, user: { ...(session.user as Record<string, unknown>), appearance: next } };
      });
      return { previous: appearance, previousSession };
    },
    onError: (_error, _next, context) => {
      if (!context) return;
      applyAppearance(context.previous);
      if (context.previousSession !== undefined) queryClient.setQueryData(queryKeys.session(), context.previousSession);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.session() }),
  });

  return (
    <SettingsSection title="Appearance">
      <fieldset {...stylex.props(styles.group)}>
        <legend {...stylex.props(settings.itemMeta, styles.legend)}>
          Boards keep their own look, so everyone drawing on one sees the same thing.
        </legend>
        {CHOICES.map(({ value, label, note, icon: Icon }) => (
          <label key={value} {...stylex.props(styles.choice, motion.tint)}>
            <input
              type="radio"
              name={name}
              value={value}
              checked={appearance === value}
              onChange={() => mutation.mutate(value)}
              {...stylex.props(styles.input)}
            />
            <Icon size={18} strokeWidth={1.75} aria-hidden="true" {...stylex.props(styles.icon)} />
            <span {...stylex.props(styles.label)}>
              <span {...stylex.props(styles.name)}>{label}</span>
              <span {...stylex.props(styles.note)}>{note}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mutation.isError ? (
        <p role="alert" {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
          That change didn’t save to your account. Try again.
        </p>
      ) : null}
    </SettingsSection>
  );
}
