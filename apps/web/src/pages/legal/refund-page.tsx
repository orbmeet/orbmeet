import { Link } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { LegalLayout, legalStyles as styles } from "./legal-layout";

export function RefundPage() {
  return (
    <LegalLayout title="Refund Policy" lastUpdated="April 23, 2026">
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
    </LegalLayout>
  );
}
