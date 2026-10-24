import { Link } from "@tanstack/react-router";
import { PublicNav } from "@/app/shell/public-nav";
import { PublicFooter } from "@/app/shell/public-footer";
import { MAIN_CONTENT_ID } from "@/app/shell/skip-link";
import { enter } from "@orbmeet/ui/styles/animations";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  page: {
    // A column, so the shared footer sinks to the bottom on a short page
    // instead of floating under the last paragraph.
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    // Unified with the app's canvas ground; the old neutral-50 was a one-off.
    backgroundColor: surface.canvas,
  },

  main: {
    marginInline: "auto",
    maxWidth: "48rem",
    paddingInline: space.s6,
    paddingBlock: space.s16,
  },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "2.25rem",
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  updated: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },

  body: {
    marginTop: space.s10,
    display: "flex",
    flexDirection: "column",
    gap: space.s10,
    color: neutral.n700,
    lineHeight: leading.relaxed,
  },
  h2: {
    margin: 0,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  para: { margin: 0, marginTop: space.s3 },
  paraTight: { marginTop: space.s2 },
  list: {
    margin: 0,
    marginTop: space.s2,
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    listStyleType: "disc",
    paddingInlineStart: space.s6,
  },
  link: {
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "underline",
    textDecorationColor: accent.a700,
    textUnderlineOffset: 2,
  },
  copyright: {
    marginTop: space.s4,
    marginBottom: 0,
    fontSize: text.sm,
    color: ink.muted,
  },
});

export function RefundPage() {
  return (
    <div {...stylex.props(styles.page)}>
      <PublicNav />
      <main id={MAIN_CONTENT_ID} {...stylex.props(styles.main, enter.fade)}>
        <h1 {...stylex.props(styles.title)}>Refund Policy</h1>
        <p {...stylex.props(styles.updated)}>
          Last updated: April 23, 2026
        </p>

        <div {...stylex.props(styles.body)}>
          {/* 1. Overview */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              1. Overview
            </h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet offers monthly subscription plans that provide access to
              premium features such as longer meeting durations, higher
              participant limits, cloud recording, AI-powered transcription,
              and collaborative whiteboard sessions. This Refund Policy
              explains how cancellations and refunds are handled.
            </p>
          </section>

          {/* 2. Free Trial & Free Plan */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              2. Free Trial &amp; Free Plan
            </h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet offers a free plan with limited features at no cost. We
              encourage you to try the free plan before upgrading to a paid
              subscription to ensure Orb Meet meets your needs. No payment
              information is required to use the free plan.
            </p>
          </section>

          {/* 3. Cancellation */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              3. Cancellation
            </h2>
            <p {...stylex.props(styles.para)}>
              You may cancel your subscription at any time from your account
              settings. When you cancel:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>
                Your subscription will remain active until the end of your
                current billing period.
              </li>
              <li>
                You will not be charged for the next billing cycle.
              </li>
              <li>
                After the billing period ends, your account will revert to the
                free plan.
              </li>
            </ul>
          </section>

          {/* 4. Refund Eligibility */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              4. Refund Eligibility
            </h2>
            <p {...stylex.props(styles.para)}>
              We want you to be satisfied with Orb Meet. If you are not happy
              with your purchase, you may request a refund under the following
              conditions:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>
                <strong>Within 14 days of purchase</strong> — If you request a
                refund within 14 days of your initial subscription purchase or
                renewal, we will issue a full refund, no questions asked.
              </li>
              <li>
                <strong>After 14 days</strong> — Refund requests made after 14
                days from the purchase or renewal date are evaluated on a
                case-by-case basis. We may offer a prorated refund or credit at
                our discretion.
              </li>
            </ul>
          </section>

          {/* 5. How to Request a Refund */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              5. How to Request a Refund
            </h2>
            <p {...stylex.props(styles.para)}>
              To request a refund, please contact us at{" "}
              <a href="mailto:support@orbmeet.com" {...stylex.props(styles.link)}>
                support@orbmeet.com
              </a>{" "}
              with the following information:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>Your account email address</li>
              <li>Date of purchase</li>
              <li>Reason for the refund request</li>
            </ul>
            <p {...stylex.props(styles.para)}>
              We aim to process all refund requests within 5–10 business days.
              Approved refunds will be returned to your original payment method.
            </p>
          </section>

          {/* 6. Plan Changes */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              6. Plan Changes
            </h2>
            <p {...stylex.props(styles.para)}>
              If you upgrade your plan, the new pricing takes effect
              immediately and you will be charged a prorated amount for the
              remainder of your billing period. If you downgrade, the change
              takes effect at the start of your next billing cycle.
            </p>
          </section>

          {/* 7. Exceptions */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              7. Exceptions
            </h2>
            <p {...stylex.props(styles.para)}>
              Refunds will not be issued in the following cases:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>
                Accounts terminated for violation of our{" "}
                <Link to="/terms" {...stylex.props(styles.link)}>
                  Terms of Service
                </Link>
              </li>
              <li>
                Failure to cancel before an automatic renewal (though you may
                still request a refund within 14 days of the renewal)
              </li>
            </ul>
          </section>

          {/* 8. Changes to This Policy */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              8. Changes to This Policy
            </h2>
            <p {...stylex.props(styles.para)}>
              We may update this Refund Policy from time to time. When we make
              changes, we will update the &quot;Last updated&quot; date at the
              top of this page. Your continued use of Orb Meet after any changes
              constitutes your acceptance of the updated policy.
            </p>
          </section>

          {/* 9. Contact Us */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              9. Contact Us
            </h2>
            <p {...stylex.props(styles.para)}>
              If you have any questions about this Refund Policy, please
              contact us at:
            </p>
            <p {...stylex.props(styles.paraTight)}>
              <a href="mailto:support@orbmeet.com" {...stylex.props(styles.link)}>
                support@orbmeet.com
              </a>
            </p>
            <p {...stylex.props(styles.copyright)}>
              &copy; 2026 Orb Meet Contributors. Orb Meet is open-source software
              licensed under the MIT License.
            </p>
          </section>
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}
