import { control } from "@orbmeet/ui/styles/controls";
import { motion } from "@orbmeet/ui/styles/atoms";
import { ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import * as React from "react";

const styles = stylex.create({
  label: {
    marginBottom: space.s1_5,
    display: "block",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    textTransform: "uppercase",
    letterSpacing: tracking.wide,
    color: ink.muted,
  },
  /** Softer than the Select trigger: pre-join is a calm screen, not a form. */
  trigger: { borderColor: { default: neutral.n200, [env.hoverable]: { default: neutral.n200, ":hover": neutral.n300 } } },
  chevron: { color: neutral.n500 },
  chevronOpen: { transform: "rotate(180deg)" },
  popup: {
    width: "var(--anchor-width)",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    padding: space.s1,
    boxShadow: `0 20px 25px -5px ${scrim.edge}, 0 8px 10px -6px ${scrim.edge}`,
  },
});
import { CaptionLanguagePicker } from "@/modules/meetings/client/components/caption-language-picker";
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from "@orbmeet/ui/react";
import { clientMeetingHintsQueryOptions } from "@/app/query-client/queries/client-meeting-hints";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import {
  DEFAULT_SPEECH_LANGUAGE,
  SPEECH_LANGUAGE_OPTIONS,
  speechLanguageDisplayName,
} from "@/modules/meetings/client/captions/languages";

interface PreJoinCaptionRowProps {
  language: string;
  onLanguageChange: (language: string) => void;
}

export function PreJoinCaptionRow({ language, onLanguageChange }: PreJoinCaptionRowProps) {
  const meetingHintsQuery = useQuery(clientMeetingHintsQueryOptions());
  const cloudflareCountry = meetingHintsQuery.data?.country ?? null;
  const [showPicker, setShowPicker] = React.useState(false);
  const languageControlId = React.useId();

  const selectedLabel = React.useMemo(() => {
    const option = SPEECH_LANGUAGE_OPTIONS.find((o) => o.tag === language);
    return option ? speechLanguageDisplayName(option) : "Select language";
  }, [language]);

  return (
    <div>
      <label
        htmlFor={languageControlId}
        {...stylex.props(styles.label)}
      >
        Spoken language (for captions)
      </label>
      <PopoverRoot open={showPicker} onOpenChange={setShowPicker}>
        <PopoverTrigger
          render={
            <button
              id={languageControlId}
              type="button"
              aria-label={`Spoken language: ${selectedLabel}`}
              {...stylex.props(control.trigger, styles.trigger)}
            />
          }
        >
          <span>{selectedLabel}</span>
          <ChevronDown
            size={16}
            {...stylex.props(styles.chevron, motion.move, showPicker && styles.chevronOpen)}
          />
        </PopoverTrigger>
        <PopoverContent
          title="Select spoken language"
          align="start"
          sx={styles.popup}
        >
          <CaptionLanguagePicker
            country={cloudflareCountry}
            selectedLanguage={language || DEFAULT_SPEECH_LANGUAGE}
            onSelectLanguage={(nextLanguage) => {
              onLanguageChange(nextLanguage);
              setShowPicker(false);
            }}
            autoFocusSearch
            variant="light"
          />
        </PopoverContent>
      </PopoverRoot>
    </div>
  );
}
