import { layout, motion, pressable, stack } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Check, Search } from "lucide-react";
import * as React from "react";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";

/**
 * The picker stands on two different grounds — a light popover on pre-join, and
 * the dark chrome of a live room — so every colour here comes in a pair. It is
 * one component either way: the same list, the same keyboard handling, the same
 * "the selected language always shows even when filtered out" rule.
 */
const styles = stylex.create({
  field: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    paddingInline: space.s3,
    paddingBlock: space.s2,
  },
  fieldLight: { borderColor: neutral.n200, backgroundColor: surface.raised },
  fieldDark: {
    borderColor: glass.veil,
    backgroundColor: `color-mix(in oklab, ${surface.raised} 5%, transparent)`,
  },
  fieldFocus: {
    boxShadow: {
      default: "none",
      ":focus-within": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    },
  },
  glyphLight: { color: neutral.n500 },
  glyphDark: { color: `color-mix(in oklab, ${surface.raised} 45%, transparent)` },

  input: {
    width: "100%",
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    outlineStyle: "none",
  },
  inputLight: { color: ink.strong, "::placeholder": { color: neutral.n500 } },
  inputDark: {
    color: ink.onDark,
    "::placeholder": { color: `color-mix(in oklab, ${ink.onDark} 35%, transparent)` },
  },

  list: {
    margin: 0,
    maxHeight: 288,
    overflowY: "auto",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    padding: space.s1,
    listStyleType: "none",
  },

  option: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderRadius: radii.field,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    textAlign: "start",
    fontFamily: "inherit",
    fontSize: text.sm,
  },
  optionLight: {
    color: { default: neutral.n800, [env.hoverable]: { default: neutral.n800, ":hover": neutral.n950 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  optionDark: {
    color: { default: `color-mix(in oklab, ${ink.onDark} 80%, transparent)`, [env.hoverable]: { default: `color-mix(in oklab, ${ink.onDark} 80%, transparent)`, ":hover": `${ink.onDark}` } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": `color-mix(in oklab, ${surface.raised} 8%, transparent)` } },
  },
  /**
   * The selected row restates its own hover step rather than inheriting
   * `optionLight`'s. StyleX merges every conditional variant of a property as
   * one unit, so a flat `backgroundColor` here would replace the base *and*
   * the hover underneath it — leaving the selected language the one row in the
   * list that does not answer to the pointer.
   */
  optionActiveLight: {
    backgroundColor: {
      default: accent.a50,
      [env.hoverable]: { default: accent.a50, ":hover": accent.a100 },
    },
    color: neutral.n950,
    boxShadow: `0 0 0 1px ${accent.a200}`,
  },
  optionActiveDark: {
    backgroundColor: {
      default: `color-mix(in oklab, ${accent.a500} 20%, transparent)`,
      [env.hoverable]: {
        default: `color-mix(in oklab, ${accent.a500} 20%, transparent)`,
        ":hover": `color-mix(in oklab, ${accent.a500} 30%, transparent)`,
      },
    },
    color: ink.onDark,
    boxShadow: `0 0 0 1px color-mix(in oklab, ${accent.a500} 40%, transparent)`,
  },

  trailing: { display: "flex", flexShrink: 0, alignItems: "center", gap: space.s2 },
  checkLight: { color: accent.a700 },
  checkDark: { color: accent.a300 },
  /** The BCP-47 tag, so two dialects of one language are distinguishable. */
  tag: { fontVariantNumeric: "tabular-nums", fontSize: text.xs2 },
  tagLight: { color: neutral.n500 },
  tagDark: { color: `color-mix(in oklab, ${surface.raised} 35%, transparent)` },

  empty: { paddingInline: space.s3, paddingBlock: space.s2, fontSize: text.sm },
  emptyLight: { color: neutral.n600 },
  emptyDark: { color: `color-mix(in oklab, ${surface.raised} 45%, transparent)` },
});
import {
  orderSpeechLanguagesForCountry,
  speechLanguageDisplayName,
  speechLanguageMatchesQuery,
  type SpeechLanguageOption,
} from "@/modules/meetings/client/captions/languages";

interface CaptionLanguagePickerProps {
  country?: string | null;
  selectedLanguage: string;
  onSelectLanguage: (language: string) => void;
  sx?: StyleXStyles;
  autoFocusSearch?: boolean;
  variant?: "dark" | "light";
}

export function CaptionLanguagePicker({
  country,
  selectedLanguage,
  onSelectLanguage,
  sx,
  autoFocusSearch = false,
  variant = "dark",
}: CaptionLanguagePickerProps) {
  const isLight = variant === "light";
  const [query, setQuery] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  React.useEffect(() => {
    if (!autoFocusSearch) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusSearch]);

  const options = React.useMemo(() => {
    const ordered = orderSpeechLanguagesForCountry(country);
    const filtered = query.trim()
      ? ordered.filter((option) => speechLanguageMatchesQuery(option, query))
      : ordered;

    const selected = ordered.find((option) => option.tag === selectedLanguage);
    if (selected && !filtered.some((option) => option.tag === selected.tag)) {
      return [selected, ...filtered];
    }
    return filtered;
  }, [country, query, selectedLanguage]);

  const focusOption = React.useCallback((index: number) => {
    const boundedIndex = Math.max(0, Math.min(index, options.length - 1));
    optionRefs.current[boundedIndex]?.focus();
  }, [options.length]);

  const handleOptionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1);
    }
  };

  return (
    <div {...stylex.props(stack.x2, sx)}>
      <div
        {...stylex.props(
          styles.field,
          isLight ? styles.fieldLight : styles.fieldDark,
          styles.fieldFocus,
        )}
      >
        <Search size={16} {...stylex.props(isLight ? styles.glyphLight : styles.glyphDark)} />
        <input
          ref={searchInputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && options.length > 0) {
              event.preventDefault();
              focusOption(0);
            }
          }}
          aria-label="Search languages"
          placeholder="Search languages"
          {...stylex.props(styles.input, isLight ? styles.inputLight : styles.inputDark)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <ul
        aria-label="Languages"
        {...stylex.props(styles.list, isLight ? styles.fieldLight : styles.fieldDark)}
      >
        {options.map((option: SpeechLanguageOption, index) => {
          const active = option.tag === selectedLanguage;
          return (
            <li key={option.tag}>
              <button
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onSelectLanguage(option.tag)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
                {...stylex.props(
                  pressable.base,
                  motion.tint,
                  styles.option,
                  isLight ? styles.optionLight : styles.optionDark,
                  active && (isLight ? styles.optionActiveLight : styles.optionActiveDark),
                )}
              >
                <span {...stylex.props(layout.truncate, layout.minZero)}>
                  {speechLanguageDisplayName(option)}
                </span>
                <span {...stylex.props(styles.trailing)}>
                  {active && (
                    <Check size={16} {...stylex.props(isLight ? styles.checkLight : styles.checkDark)} />
                  )}
                  <span {...stylex.props(styles.tag, isLight ? styles.tagLight : styles.tagDark)}>
                    {option.tag}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {options.length === 0 && (
          <li {...stylex.props(styles.empty, isLight ? styles.emptyLight : styles.emptyDark)}>
            No matching language
          </li>
        )}
      </ul>
    </div>
  );
}
