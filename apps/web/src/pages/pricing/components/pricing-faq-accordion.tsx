import { Accordion } from "@base-ui/react/accordion";
import { enter, stagger } from "@orbmeet/ui/styles/animations";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown } from "lucide-react";
import { faq } from "./pricing-faq-styles";

/** Base UI's header is an <h3>; its UA margins would space the grid unevenly. */
const headerReset = stylex.create({ h3: { margin: 0 } });

/** Base UI publishes these while a panel is animating in or out. */
const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

export interface PricingFaq {
  q: string;
  a: string;
}

const styles = stylex.create({
  /**
   * Height animates against the `--accordion-panel-height` Base UI publishes,
   * collapsing to nothing while the panel is entering or leaving.
   */
  panel: {
    height: {
      default: "var(--accordion-panel-height)",
      [STARTING]: "0px",
      [ENDING]: "0px",
    },
    overflow: "hidden",
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    transitionProperty: "height, opacity",
    transitionDuration: { default: "0.3s", [env.reducedMotion]: "0s" },
  },
});

export function PricingFaqAccordion({ faqs }: { faqs: PricingFaq[] }) {
  return (
    <Accordion.Root multiple {...stylex.props(faq.grid)}>
      {faqs.map(({ q, a }, index) => (
        <Accordion.Item
          key={q}
          value={q}
          {...stylex.props(faq.item, enter.fadeUp, stagger.by(600 + index * 100))}
        >
          <Accordion.Header {...stylex.props(headerReset.h3)}>
            <Accordion.Trigger {...stylex.props(faq.trigger, focus.ring, stylex.defaultMarker())}>
              <span {...stylex.props(faq.question, motion.tint)}>{q}</span>
              <ChevronDown aria-hidden {...stylex.props(faq.chevron, motion.move)} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Panel {...stylex.props(styles.panel)}>
            <p {...stylex.props(faq.answer)}>{a}</p>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}
