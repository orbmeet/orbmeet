import { useState } from "react";
import type { ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Dices } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { getPlanLimits, type SubscriptionTier } from "@/modules/billing/contract/plan-limits";
import { MEETING_CODE_REGEX as CODE_REGEX } from "@/modules/meetings/contract/constants";
import { generateMeetingCode } from "@/modules/meetings/contract/code-generation";
import { createMeetingLink } from "@/modules/meetings/server/lifecycle/create.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { formatCode } from "@/modules/meetings/client/format-code";
import { queryKeys } from "@/app/query-client/query-keys";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { reusableLinkCreationInput } from "./reusable-link-input";
import { Button } from "@orbmeet/ui/react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@orbmeet/ui/react";
import { control } from "@orbmeet/ui/styles/controls";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    paddingBlock: space.s4,
  },
  /** The composite code field: host prefix, the input, and the shuffle button. */
  codeField: {
    display: "flex",
    alignItems: "center",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
  },
  /**
   * Focus is signalled by the *field*, not the input inside it, because the
   * host prefix and shuffle button are part of what is being edited.
   */
  codeFieldOk: {
    borderColor: { default: neutral.n300, ":focus-within": accent.a500 },
    boxShadow: {
      default: "none",
      ":focus-within": `0 0 0 2px color-mix(in oklab, ${accent.a500} 30%, transparent)`,
    },
  },
  codeFieldInvalid: {
    borderColor: { default: danger.d300, ":focus-within": danger.d500 },
    boxShadow: {
      default: "none",
      ":focus-within": `0 0 0 2px color-mix(in oklab, ${danger.d500} 20%, transparent)`,
    },
  },
  host: {
    userSelect: "none",
    paddingLeft: space.s3,
    fontFamily: fonts.mono,
    fontSize: text.sm,
    color: neutral.n400,
  },
  codeInput: {
    height: 40,
    minWidth: 0,
    flexGrow: 1,
    backgroundColor: "transparent",
    borderWidth: 0,
    paddingInline: space.s1,
    fontFamily: fonts.mono,
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    letterSpacing: tracking.wider,
    color: neutral.n900,
    outlineStyle: "none",
  },
  shuffle: {
    display: "flex",
    height: 32,
    width: 32,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    marginRight: space.s1,
    borderRadius: radii.field,
    color: { default: neutral.n400, [env.hoverable]: { default: neutral.n400, ":hover": accent.a700 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  hint: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: neutral.n500,
  },
  hintInvalid: { color: danger.d600 },
  /** Free plans: the link is assigned, so this is prose, not a field. */
  assigned: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: neutral.n50,
    paddingInline: space.s3,
    paddingBlock: space.s3,
  },
  note: {
    margin: 0,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: neutral.n500,
  },
  assignedTitle: {
    margin: 0,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n800,
  },
  assignedNote: { marginTop: space.s1 },
  spaceLink: {
    fontWeight: weight.medium,
    color: accent.a700,
    textDecorationLine: "underline",
    textUnderlineOffset: 2,
  },
  error: {
    margin: 0,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: danger.d600,
  },
});

interface CreatePersonalMeetingLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreatePersonalMeetingLinkDialog({ open, onOpenChange }: CreatePersonalMeetingLinkDialogProps) {
  const { data: sessionData } = useQuery(sessionQueryOptions());
  const plan: SubscriptionTier = sessionData?.user?.plan ?? "free";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <CreatePersonalMeetingLinkForm
          plan={plan}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function validateCode(value: string): string {
  if (!value) return "Type a code, or shuffle for a new one.";
  if (!CODE_REGEX.test(value)) return "Codes look like abc-defg-hij — letters only.";
  return "";
}

function CreatePersonalMeetingLinkForm({ plan, onOpenChange }: {
  plan: SubscriptionTier;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  // Paid plans may choose a code; otherwise the server assigns one.
  const [code, setCode] = useState(() => generateMeetingCode());
  const [codeError, setCodeError] = useState("");
  const [error, setError] = useState<string | null>(null);
  const host = typeof window === "undefined" ? "" : window.location.host;
  const canCustomizeCode = getPlanLimits(plan).customPersonalMeetingCode;

  function handleCodeChange(e: ChangeEvent<HTMLInputElement>) {
    const value = formatCode(e.target.value.toLowerCase());
    setCode(value);
    setCodeError(validateCode(value));
  }

  function shuffleCode() {
    setCode(generateMeetingCode());
    setCodeError("");
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createMeetingLink({ data: reusableLinkCreationInput(plan, code) }),
    onMutate: () => {
      setError(null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.threads() });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(getErrorMessage(err, "Failed to create the link. Please try again."));
    },
  });

  function handleCreate() {
    const nextError = validateCode(code);
    if (canCustomizeCode && nextError) {
      setCodeError(nextError);
      return;
    }
    createMutation.mutate();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create your permanent meeting link</DialogTitle>
        <DialogDescription>
          One address you share once. It starts your next personal Meeting or joins the active one.
        </DialogDescription>
      </DialogHeader>

      <DialogBody sx={styles.body}>
        {canCustomizeCode ? <div>
          <label
            htmlFor="personal-meeting-link-code"
            {...stylex.props(control.label)}
          >
            Your link
          </label>
          <div
            {...stylex.props(
              styles.codeField,
              motion.all,
              codeError ? styles.codeFieldInvalid : styles.codeFieldOk,
            )}
          >
            {host && (
              <span {...stylex.props(styles.host)}>{host}/</span>
            )}
            <input
              id="personal-meeting-link-code"
              value={code}
              onChange={handleCodeChange}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              {...stylex.props(styles.codeInput)}
              maxLength={12}
            />
            <button
              type="button"
              onClick={shuffleCode}
              title="Pick another code"
              aria-label="Pick another code"
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.shuffle)}
            >
              <Dices size={16} />
            </button>
          </div>
          <p {...stylex.props(styles.hint)}>
            {codeError ? (
              <span {...stylex.props(styles.hintInvalid)}>{codeError}</span>
            ) : (
              "This is your link's address — keep ours, or type your own."
            )}
          </p>
        </div> : (
          <div {...stylex.props(styles.assigned)}>
            <p {...stylex.props(styles.assignedTitle)}>Your permanent meeting link</p>
            <p {...stylex.props(styles.note, styles.assignedNote)}>
              Orb Meet will assign a secure address when you create it. Custom addresses are available on Pro.
            </p>
          </div>
        )}

        <p {...stylex.props(styles.note)}>
          You can change entry approval and the default Meeting title from Home.
        </p>
        <p {...stylex.props(styles.note)}>
          Meeting with the same people regularly? A <Link to="/spaces" {...stylex.props(styles.spaceLink)}>Space</Link> keeps its members, Meetings, Whiteboards, and Files together.
        </p>

        {error && <p role="alert" {...stylex.props(styles.error)}>{error}</p>}
      </DialogBody>

      <DialogFooter>
        <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
        <Button
          variant="primary"
          size="sm"
          loading={createMutation.isPending}
          disabled={canCustomizeCode && Boolean(codeError)}
          onClick={handleCreate}
        >
          Create link
        </Button>
      </DialogFooter>
    </>
  );
}
