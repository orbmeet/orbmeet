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
  list: {
    margin: 0,
    marginTop: space.s3,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    listStyleType: "disc",
    paddingInlineStart: space.s6,
  },
  link: {
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "underline",
    textDecorationColor: accent.a700,
    textUnderlineOffset: 2,
  },
  /** The sign-off line, closed off from the numbered sections above. */
  colophon: {
    marginTop: 0,
    paddingTop: space.s6,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n200,
    fontSize: text.sm,
    color: ink.muted,
  },
});

export function TermsPage() {
  return (
    <div {...stylex.props(styles.page)}>
      <PublicNav />
      <main id={MAIN_CONTENT_ID} {...stylex.props(styles.main, enter.fade)}>
        <h1 {...stylex.props(styles.title)}>Terms of Service</h1>
        <p {...stylex.props(styles.updated)}>Last updated: October 15, 2026</p>

        <div {...stylex.props(styles.body)}>
          {/* 1. Acceptance of Terms */}
          <section>
            <h2 {...stylex.props(styles.h2)}>1. Acceptance of Terms</h2>
            <p {...stylex.props(styles.para)}>
              By accessing or using Orb Meet (<a href="https://orbmeet.com" {...stylex.props(styles.link)}>orbmeet.com</a>), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to all of these Terms, you may not access or use the Service. You must be at least 13 years of age to use Orb Meet. If you are under 18, you represent that your parent or legal guardian has reviewed and agreed to these Terms on your behalf.
            </p>
          </section>

          {/* 2. Description of Service */}
          <section>
            <h2 {...stylex.props(styles.h2)}>2. Description of Service</h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet is an open-source visual meeting workspace that provides real-time video conferencing, text chat, collaborative Whiteboards, Spaces, cloud recording, transcription, AI-assisted Meeting features, and PDF export. The platform is built on open-source technologies and its source code is available under the MIT license. Real-time media infrastructure (audio, video, screen sharing) is self-hosted on our own dedicated servers.
            </p>
          </section>

          {/* 3. Account Registration */}
          <section>
            <h2 {...stylex.props(styles.h2)}>3. Account Registration</h2>
            <p {...stylex.props(styles.para)}>
              To access certain features, you must create an account using Google OAuth or an email verification code. You may also register a passkey for later sign-in. When you use Google, you authorize Orb Meet to receive your Google account identifier, name, email address, and profile picture. You are responsible for protecting your email account, passkeys, remembered devices, and any other credentials used to access Orb Meet. You agree to notify us immediately of unauthorized account use.
            </p>
          </section>

          {/* 4. Subscription Plans & Billing */}
          <section>
            <h2 {...stylex.props(styles.h2)}>4. Subscription Plans &amp; Billing</h2>
            <p {...stylex.props(styles.para)}>Orb Meet offers three subscription tiers:</p>
            <ul {...stylex.props(styles.list)}>
              <li>
                <strong>Free ($0/month)</strong> — One permanent server-assigned personal meeting link, one Space with up to 25 members, up to 100 participants per Meeting, a 90-minute Meeting duration limit, and 1 GB cloud storage.
              </li>
              <li>
                <strong>Pro ($5/user/month)</strong> — A customizable personal meeting link, unlimited Spaces with up to 200 members each, up to 500 participants per Meeting, unlimited Meeting duration, and 50 GB cloud storage.
              </li>
              <li>
                <strong>Organization ($10/license/month)</strong> — Up to 25 licensed users, shared billing, Organization roles, centrally funded Spaces, unlimited participants, unlimited Meeting duration, and unlimited cloud storage. A license permits assignment to Organization-funded Spaces; direct Space membership still controls content access.
              </li>
            </ul>
            <p {...stylex.props(styles.para)}>
              Paid subscriptions are billed on a recurring monthly basis through our payment processor, Paddle. By subscribing to a paid plan, you authorize recurring charges to your chosen payment method. You may cancel your subscription at any time; cancellation takes effect at the end of the current billing cycle. Refunds are handled in accordance with our refund policy and Paddle&apos;s terms. We reserve the right to modify pricing with at least 30 days&apos; prior notice.
            </p>
          </section>

          {/* 5. Acceptable Use */}
          <section>
            <h2 {...stylex.props(styles.h2)}>5. Acceptable Use</h2>
            <p {...stylex.props(styles.para)}>You agree not to use Orb Meet to:</p>
            <ul {...stylex.props(styles.list)}>
              <li>Violate any applicable law, regulation, or third-party rights.</li>
              <li>Transmit content that is unlawful, harmful, threatening, abusive, harassing, defamatory, obscene, or otherwise objectionable.</li>
              <li>Distribute malware, viruses, or any other malicious code.</li>
              <li>Attempt to gain unauthorized access to the Service, other accounts, or any related systems or networks.</li>
              <li>Interfere with or disrupt the integrity or performance of the Service.</li>
              <li>Use unauthorized automation or scraping that bypasses the documented Developer API, the official Orb Meet CLI, access controls, or rate limits.</li>
              <li>Record participants without their knowledge or consent where required by law.</li>
            </ul>
            <p {...stylex.props(styles.para)}>
              We reserve the right to suspend or terminate accounts that violate these rules, with or without notice.
            </p>
          </section>

          {/* 6. Intellectual Property */}
          <section>
            <h2 {...stylex.props(styles.h2)}>6. Intellectual Property</h2>
            <p {...stylex.props(styles.para)}>
              The Orb Meet platform source code is released under the MIT license. You are free to use, modify, and distribute the code in accordance with that license. The Orb Meet name, logo, and branding are trademarks of Orb Meet Contributors and may not be used without prior written permission.
            </p>
            <p {...stylex.props(styles.para)}>
              You retain full ownership of all content you create, upload, or share through the Service, including recordings, Transcripts, Whiteboard content, chat messages, and exported documents.
            </p>
          </section>

          {/* 7. User Content & Data */}
          <section>
            <h2 {...stylex.props(styles.h2)}>7. User Content &amp; Data</h2>
            <p {...stylex.props(styles.para)}>
              You are solely responsible for the content you create and share through the Service. Orb Meet does not manually monitor or review Meeting content as a routine practice. The Service and its disclosed processors automatically handle audio, Transcripts, Whiteboard data, recordings, and related content when needed to provide features you use. We may access content when you request support and authorize that access, when necessary to investigate abuse or protect the Service, or when required by law. See the Privacy Policy for the processors and data involved.
            </p>
            <p {...stylex.props(styles.para)}>
              Ended Meeting history and outputs remain available without a scheduled age-based expiry and count toward the applicable storage allowance. Editable Whiteboards and uploaded Files belong to their Space and have a separate lifecycle. Archived Whiteboards stop consuming an active-Whiteboard plan slot. A Whiteboard that has never appeared in a Meeting may be permanently deleted; a Meeting-used Whiteboard retains its archived identity so the Meeting record remains intelligible until the owning Space is deleted.
            </p>
            <p {...stylex.props(styles.para)}>
              While you are a member of a shared Space, you may open its past Meetings. If you leave or are removed, your access to all of them ends, including Meetings you attended. In a personal Space, the owner and every signed-in person who actually joined a Meeting may open that Meeting. Guest access is limited to the specific handoff provided for that Meeting and does not create durable Space-history access.
            </p>
          </section>

          {/* 8. Privacy */}
          <section>
            <h2 {...stylex.props(styles.h2)}>8. Privacy</h2>
            <p {...stylex.props(styles.para)}>
              Your use of Orb Meet is also governed by our{" "}
              <Link to="/privacy" {...stylex.props(styles.link)}>
                Privacy Policy
              </Link>
              , which describes how we collect, use, and protect your personal information. By using the Service, you consent to the data practices described in the Privacy Policy.
            </p>
          </section>

          {/* 9. Service Availability & Disclaimers */}
          <section>
            <h2 {...stylex.props(styles.h2)}>9. Service Availability &amp; Disclaimers</h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet is provided on an &quot;as is&quot; and &quot;as available&quot; basis without warranties of any kind, whether express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or secure, or that any defects will be corrected.
            </p>
            <p {...stylex.props(styles.para)}>
              We may perform scheduled or unscheduled maintenance that may temporarily affect availability. We will make reasonable efforts to provide advance notice of planned downtime.
            </p>
          </section>

          {/* 10. Limitation of Liability */}
          <section>
            <h2 {...stylex.props(styles.h2)}>10. Limitation of Liability</h2>
            <p {...stylex.props(styles.para)}>
              To the maximum extent permitted by applicable law, Orb Meet Contributors and their affiliates, officers, employees, agents, and licensors shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits, revenue, data, or goodwill, whether caused by tort (including negligence), breach of contract, or otherwise, arising out of or in connection with your use of the Service — even if advised of the possibility of such damages.
            </p>
            <p {...stylex.props(styles.para)}>
              Our total aggregate liability for any claims arising under these Terms shall not exceed the amount you have paid to Orb Meet in the twelve (12) months preceding the claim.
            </p>
          </section>

          {/* 11. Termination */}
          <section>
            <h2 {...stylex.props(styles.h2)}>11. Termination</h2>
            <p {...stylex.props(styles.para)}>
              You may terminate your account at any time by contacting us or through your account settings. We may suspend or terminate your access to the Service at any time, with or without cause, and with or without notice. Upon termination, your right to use the Service ceases immediately. Provisions of these Terms that by their nature should survive termination — including intellectual property, limitation of liability, and governing law — shall survive.
            </p>
          </section>

          {/* 12. Changes to Terms */}
          <section>
            <h2 {...stylex.props(styles.h2)}>12. Changes to Terms</h2>
            <p {...stylex.props(styles.para)}>
              We reserve the right to modify these Terms at any time. When we make material changes, we will update the &quot;Last updated&quot; date at the top of this page and, where practicable, notify you via email or through the Service. Your continued use of Orb Meet after changes take effect constitutes acceptance of the revised Terms.
            </p>
          </section>

          {/* 13. Governing Law */}
          <section>
            <h2 {...stylex.props(styles.h2)}>13. Governing Law</h2>
            <p {...stylex.props(styles.para)}>
              These Terms shall be governed by and construed in accordance with the laws of Singapore, without regard to its conflict-of-law principles. Any disputes arising from these Terms or the Service shall be resolved exclusively in the courts of Singapore.
            </p>
          </section>

          {/* 14. Contact Information */}
          <section>
            <h2 {...stylex.props(styles.h2)}>14. Contact Information</h2>
            <p {...stylex.props(styles.para)}>
              If you have any questions about these Terms, please contact us at{" "}
              <a href="mailto:support@orbmeet.com" {...stylex.props(styles.link)}>
                support@orbmeet.com
              </a>
              .
            </p>
          </section>

          <p {...stylex.props(styles.colophon)}>
            © 2026 Orb Meet Contributors. The Orb Meet source code is available under the MIT license.
          </p>
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}
