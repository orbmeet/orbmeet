import { useState, useRef, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateProfile } from "@/modules/identity/server/account.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { Input } from "@orbmeet/ui/react";
import { TimeZoneSelect } from "@orbmeet/ui/react";
import { Avatar } from "@orbmeet/ui/react";
import { Alert } from "@orbmeet/ui/react";
import { row, stack } from "@orbmeet/ui/styles/atoms";
import { ink, success } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Check } from "lucide-react";

import { settings } from "../settings-styles";
import { SettingsSection } from "./settings-section";
import { deviceTimeZone } from "@/lib/time-zone";

const styles = stylex.create({
  identity: { marginBottom: space.s6 },
  status: { margin: 0, minHeight: 20, fontSize: text.sm, lineHeight: leading.sm, color: ink.muted },
  saved: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: success.s600,
  },
});

export function ProfileSection({
  user,
}: {
  user: { name: string; email: string; image?: string | null; timeZone: string | null };
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name || "");
  // A null `user.timeZone` is a real state, not a missing value: schedules then
  // follow whatever device you are on. The picker still has to show a concrete
  // zone, so it shows the one actually in effect — and `saved` below is what
  // keeps that from reading as a stored preference it is not.
  const savedTimeZone = user.timeZone;
  const [timeZone, setTimeZone] = useState(savedTimeZone ?? deviceTimeZone());
  const [success, setSuccess] = useState(false);
  // The name last sent, so Enter then leaving the field saves it once: the
  // session that `user` comes from updates only after the save is under way.
  const sentNameRef = useRef(user.name);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(successTimerRef.current), []);

  const mutation = useMutation({
    mutationFn: (profile: { name: string; timeZone?: string }) =>
      updateProfile({ data: profile }),
    onMutate: async (profile) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.session() });
      const previousSession = queryClient.getQueryData(queryKeys.session());
      queryClient.setQueryData(queryKeys.session(), (old) => {
        if (!old || typeof old !== "object") return old;
        const session = old as Record<string, unknown>;
        if (!session.user || typeof session.user !== "object") return old;
        return {
          ...session,
          user: {
            ...(session.user as Record<string, unknown>),
            name: profile.name,
            ...(profile.timeZone === undefined ? {} : { timeZone: profile.timeZone }),
          },
        };
      });
      return { previousSession };
    },
    onError: (_err, _vars, ctx) => {
      sentNameRef.current = user.name;
      if (ctx?.previousSession !== undefined) {
        queryClient.setQueryData(queryKeys.session(), ctx.previousSession);
      }
    },
    onSuccess: async () => {
      setSuccess(true);
      clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setSuccess(false), 3000);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    },
  });

  // The page promises that changes save as you make them, so there is no Save
  // button: a name is saved when you leave the field (or press Enter), a time
  // zone the moment you pick it. An empty name is never saved; the field puts
  // the saved one back. Saving a name leaves the zone alone: someone following
  // their device must not find it pinned because they fixed a typo.
  const save = (next: { timeZone?: string }) => {
    const nextName = name.trim();
    if (!nextName) {
      setName(user.name || "");
      return;
    }
    if (next.timeZone === undefined) {
      if (nextName !== sentNameRef.current) {
        sentNameRef.current = nextName;
        mutation.mutate({ name: nextName });
      }
      return;
    }
    if (nextName === sentNameRef.current && next.timeZone === savedTimeZone) return;
    sentNameRef.current = nextName;
    mutation.mutate({ name: nextName, timeZone: next.timeZone });
  };

  return (
    <SettingsSection title="Profile">
      <div {...stylex.props(row.x4, styles.identity)}>
        <Avatar name={user.name || "User"} image={user.image} size="xl" />
        <div>
          <p {...stylex.props(settings.itemName)}>{user.name}</p>
          <p {...stylex.props(settings.itemMeta)}>{user.email}</p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save({});
        }}
        {...stylex.props(stack.x4)}
      >
        <Input
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => save({})}
        />
        <div>
          <Input label="Email" value={user.email || ""} disabled />
          <p {...stylex.props(settings.hint)}>Email cannot be changed.</p>
        </div>
        <div>
          <TimeZoneSelect
            label="Time zone"
            value={timeZone}
            onChange={(zone) => {
              setTimeZone(zone);
              save({ timeZone: zone });
            }}
          />
          {/* The unsaved branch used to open "Not saved yet — …", which reads
              as a warning about an edit in progress on a form nobody has
              touched. The condition is right — there genuinely is no saved zone
              — so the fix is to describe the state it is in rather than the one
              it is missing, and to name the zone it is actually using. */}
          <p {...stylex.props(settings.hint)}>
            {savedTimeZone
              ? "Your schedules and the Orb Meet CLI use this zone on every device. A meeting can still set its own."
              : `Following this device (${deviceTimeZone()}). Pick a zone to keep it the same everywhere, even when you travel.`}
          </p>
        </div>
        {/* Pressing Enter in the name field saves it, as leaving it does. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <p role="status" {...stylex.props(styles.status)}>
          {mutation.isPending ? (
            "Saving…"
          ) : success ? (
            <span {...stylex.props(styles.saved)}>
              <Check size={14} aria-hidden="true" />
              Saved
            </span>
          ) : null}
        </p>
        {mutation.isError && (
          <Alert variant="error">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to update profile."}
          </Alert>
        )}
      </form>
    </SettingsSection>
  );
}
