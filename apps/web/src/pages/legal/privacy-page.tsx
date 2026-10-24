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
  h3: {
    margin: 0,
    marginTop: space.s4,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  para: { margin: 0, marginTop: space.s3 },
  /** A paragraph that follows its own h3 rather than an h2. */
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
  /** A list whose entries are whole paragraphs, not single lines. */
  listSpaced: { gap: space.s3 },
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

export function PrivacyPage() {
  return (
    <div {...stylex.props(styles.page)}>
      <PublicNav />
      <main id={MAIN_CONTENT_ID} {...stylex.props(styles.main, enter.fade)}>
        <h1 {...stylex.props(styles.title)}>Privacy Policy</h1>
        <p {...stylex.props(styles.updated)}>
          Last updated: October 15, 2026
        </p>

        <div {...stylex.props(styles.body)}>
          {/* 1. Introduction */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              1. Introduction
            </h2>
            <p {...stylex.props(styles.para)}>
              Welcome to Orb Meet (&quot;we,&quot; &quot;us,&quot; or
              &quot;our&quot;). Orb Meet is an open-source visual meeting workspace
              available at{" "}
              <a href="https://orbmeet.com" {...stylex.props(styles.link)}>
                orbmeet.com
              </a>
              . This Privacy Policy explains how we collect, use, store, and
              protect your personal information when you use our services. By
              using Orb Meet, you agree to the practices described in this policy.
            </p>
          </section>

          {/* 2. Information We Collect */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              2. Information We Collect
            </h2>

            <h3 {...stylex.props(styles.h3)}>
              2.1 Account Information
            </h3>
            <p {...stylex.props(styles.paraTight)}>
              When you create or use an account, we collect the information
              needed for the authentication method you choose:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>Email address</li>
              <li>Display name</li>
              <li>Google account identifier and profile picture URL when you use Google OAuth</li>
              <li>Passkey public-key credential metadata when you register a passkey; Orb Meet never receives your biometric data</li>
            </ul>

            <h3 {...stylex.props(styles.h3)}>
              2.2 Meeting Data
            </h3>
            <p {...stylex.props(styles.paraTight)}>
              Your meeting media is yours. We do not monitor your calls in real
              time and we do not manually review your audio, video, recordings,
              Transcripts, Whiteboard content, or uploaded files.
            </p>
            <p {...stylex.props(styles.paraTight)}>
              <strong>Transcription and summaries.</strong> While your microphone is
              on, Orb Meet automatically transcribes your speech using your
              published LiveKit audio track and Deepgram&apos;s speech-to-text
              service. Deepgram processes that audio on its servers to produce
              text. Orb Meet stores the resulting transcript and may generate a concise
              AI meeting summary from it
              using Google Gemini. Transcripts and summaries are visible to
              participants who can access the meeting. You can show or hide the
              live caption overlay at any time; hiding it does not stop transcript
              processing or storage. Recordings are started only when a host chooses
              to record.
            </p>
            <p {...stylex.props(styles.paraTight)}>
              We do collect meeting <strong>metadata</strong> to operate the
              service, such as:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>Meeting titles, personal and Space meeting links, and Meeting codes</li>
              <li>Space membership and participant counts</li>
              <li>Meeting start and end times</li>
              <li>Storage usage per account</li>
            </ul>

            <h3 {...stylex.props(styles.h3)}>
              2.3 Technical Data
            </h3>
            <p {...stylex.props(styles.paraTight)}>
              We automatically collect certain technical information to maintain
              security and improve the service:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>IP address</li>
              <li>User agent (browser and operating system information)</li>
              <li>Sign-in timestamps and expiry information</li>
            </ul>

            <h3 {...stylex.props(styles.h3)}>
              2.4 Cookies
            </h3>
            <p {...stylex.props(styles.paraTight)}>Orb Meet uses the following cookies:</p>
            <ul {...stylex.props(styles.list)}>
              <li>
                <strong>__Host-session</strong> — An HttpOnly authentication
                cookie used to keep you signed in.
              </li>
              <li>
                <strong>__Host-device</strong> — Remembers a device you signed
                in on, so it can offer to sign you back in. Removed when you
                sign out.
              </li>
              <li>
                <strong>__Host-oauth_state_*</strong> — A temporary cookie used
                during the Google OAuth sign-in flow for PKCE state
                verification. Deleted after authentication completes.
              </li>
              <li>
                <strong>__Host-guest_*</strong> — Temporary cookies that grant
                guests access to a specific meeting without requiring an
                account.
              </li>
              <li>
                <strong>__Secure-wb_asset_*</strong> — Short-lived cookies that
                let your browser load the images on a Whiteboard you have
                access to.
              </li>
            </ul>
            <p {...stylex.props(styles.paraTight)}>
              We do not use any third-party analytics cookies, advertising
              trackers, or tracking pixels.
            </p>
          </section>

          {/* 3. How We Use Your Information */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              3. How We Use Your Information
            </h2>
            <p {...stylex.props(styles.para)}>
              We use the information we collect for the following purposes:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>Authenticating your identity and managing your account</li>
              <li>
                Operating the meeting infrastructure and delivering real-time
                audio, video, and collaboration features
              </li>
              <li>
                Managing Spaces, meeting links, and participant access within your
                organization
              </li>
              <li>
                Processing billing and subscription management through our
                payment provider
              </li>
              <li>
                Maintaining security, preventing abuse, and debugging technical
                issues
              </li>
            </ul>
          </section>

          {/* 4. Data Storage & Security */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              4. Data Storage &amp; Security
            </h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet is deployed on Cloudflare&apos;s infrastructure. Your data
              is stored as follows:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>
                <strong>Structured data</strong> (users, login sessions, Spaces,
                meeting links, meetings, transcripts) is stored in Cloudflare D1, a
                globally distributed SQLite database.
              </li>
              <li>
                <strong>Files</strong> (recordings, Whiteboard versions,
                uploaded PDFs) are stored in Cloudflare R2 object storage.
              </li>
              <li>
                <strong>Sign-in tokens</strong> are stored as cryptographic
                hashes — we never store your raw session token.
              </li>
            </ul>
            <p {...stylex.props(styles.para)}>
              All connections to Orb Meet are encrypted in transit via TLS. We
              follow industry-standard security practices to protect your data,
              including encrypted session storage, scoped access controls, and
              automatic session expiry. While no system can guarantee absolute
              security, we are committed to protecting your information.
            </p>
          </section>

          {/* 5. Third-Party Services */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              5. Third-Party Services
            </h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet integrates with the following third-party services to
              provide its functionality:
            </p>
            <ul {...stylex.props(styles.list, styles.listSpaced)}>
              <li>
                <strong>Google OAuth</strong> — Used for authentication. When
                you sign in, Google shares your basic profile information with
                us. Google&apos;s use of your data is governed by{" "}
                <a
                  href="https://policies.google.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  {...stylex.props(styles.link)}
                >
                  Google&apos;s Privacy Policy
                </a>
                .
              </li>
              <li>
                <strong>Deepgram</strong> — While your microphone is published,
                Deepgram processes its audio to produce live captions and the
                stored Transcript. See Deepgram&apos;s{" "}
                <a
                  href="https://deepgram.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  {...stylex.props(styles.link)}
                >
                  Privacy Policy
                </a>
                .
              </li>
              <li>
                <strong>Google Gemini AI</strong> — When Orb Meet generates a
                Meeting summary, the relevant transcript text is sent to
                Google&apos;s Gemini API. When someone uses the in-meeting
                Whiteboard AI assistant, the prompt and relevant Whiteboard
                context, which may include a Whiteboard screenshot and shape data,
                are sent to Gemini for processing. Transcription itself is
                performed by Deepgram, not Gemini. This data is handled
                according to{" "}
                <a
                  href="https://ai.google.dev/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  {...stylex.props(styles.link)}
                >
                  Google&apos;s AI Terms of Service
                </a>
                .
              </li>
              <li>
                <strong>LiveKit (self-hosted)</strong> — We run our own LiveKit
                instance on dedicated infrastructure to provide real-time
                WebRTC audio, video, and screen sharing. Media streams are
                routed through our servers during Meetings. LiveKit does not
                permanently store your media. When your microphone is
                published, its audio is additionally sent to Deepgram for the
                transcription described above; a host may also explicitly
                start recording or external live streaming.
              </li>
              <li>
                <strong>Cloudflare</strong> — Provides our compute (Workers),
                database (D1), object storage (R2), and content delivery
                infrastructure. Data may be processed at Cloudflare edge
                locations worldwide. See{" "}
                <a
                  href="https://www.cloudflare.com/privacypolicy/"
                  target="_blank"
                  rel="noopener noreferrer"
                  {...stylex.props(styles.link)}
                >
                  Cloudflare&apos;s Privacy Policy
                </a>
                .
              </li>
              <li>
                <strong>Paddle</strong> — Handles subscription billing
                and payment processing. We do not store your credit card
                information directly; it is managed by Paddle. See{" "}
                <a
                  href="https://www.paddle.com/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  {...stylex.props(styles.link)}
                >
                  Paddle&apos;s Privacy Policy
                </a>
                .
              </li>
            </ul>
          </section>

          {/* 6. Data Retention */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              6. Data Retention
            </h2>
            <p {...stylex.props(styles.para)}>
              An ended Meeting&apos;s history and Meeting-scoped outputs, such
              as its transcript, summary, chat, recordings, and Whiteboard PDF
              capture, remain available without a scheduled age-based expiry.
              Stored Meeting outputs count toward the applicable account or
              Organization storage allowance.
            </p>
            <p {...stylex.props(styles.para)}>
              Editable Whiteboards and uploaded Files belong to their Space and have a
              separate lifecycle. A Whiteboard version captured at a Meeting
              boundary remains in that Whiteboard&apos;s history.
              Archived Whiteboards stop consuming an active-document plan slot.
              An unused archived Whiteboard may be permanently deleted, while a
              Meeting-used Whiteboard retains its archived identity until the
              owning Space is deleted so its Meeting captures remain coherent.
            </p>
            <p {...stylex.props(styles.para)}>
              Past Meetings in a shared Space belong to that Space: its current
              members can open them. A person who leaves the Space or is removed
              from it loses access to all of its past Meetings, including ones they
              attended. In a personal Space, the owner and every signed-in person who
              actually joined a Meeting can open that Meeting; asking to join without
              connecting does not count. Guest handoffs are specific to one Meeting
              and do not grant durable access to the Space&apos;s history.
            </p>
            <p {...stylex.props(styles.para)}>
              Your account information is retained for as long as your account
              exists. Deleting your account removes your personal storage area and its
              content. Content in shared Spaces may remain under that
              Space&apos;s ownership. We do not automatically purge Meeting
              history merely because it has reached a particular age.
            </p>
          </section>

          {/* 7. Your Rights */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              7. Your Rights
            </h2>
            <p {...stylex.props(styles.para)}>
              You have the following rights regarding your personal data:
            </p>
            <ul {...stylex.props(styles.list)}>
              <li>
                <strong>Access</strong> — You can view your account information
                and meeting data through your Orb Meet dashboard at any time.
              </li>
              <li>
                <strong>Deletion</strong> — You can delete your account from
                your account settings. This will remove your profile and
                personal workspace and data. Content owned by shared Spaces
                remains with those Spaces. You must transfer or delete any
                shared Space or Organization you own before deleting your account.
              </li>
              <li>
                <strong>Export</strong> — You can download your recordings,
                transcripts, and other files directly from the meeting interface.
              </li>
              <li>
                <strong>Correction</strong> — Google-derived profile details
                follow your Google profile. For other account-data corrections,
                contact support.
              </li>
            </ul>
            <p {...stylex.props(styles.para)}>
              To exercise any of these rights or if you have questions, contact
              us at{" "}
              <a href="mailto:support@orbmeet.com" {...stylex.props(styles.link)}>
                support@orbmeet.com
              </a>
              .
            </p>
          </section>

          {/* 8. Children's Privacy */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              8. Children&apos;s Privacy
            </h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet is not intended for use by children under the age of 13.
              We do not knowingly collect personal information from children
              under 13. If we become aware that we have collected personal data
              from a child under 13, we will take steps to delete that
              information promptly. If you believe a child under 13 has provided
              us with personal information, please contact us at{" "}
              <a href="mailto:support@orbmeet.com" {...stylex.props(styles.link)}>
                support@orbmeet.com
              </a>
              .
            </p>
          </section>

          {/* 9. International Data Transfers */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              9. International Data Transfers
            </h2>
            <p {...stylex.props(styles.para)}>
              Orb Meet operates on Cloudflare&apos;s global edge network. Your
              data may be processed and stored in data centers located in
              various countries around the world. By using Orb Meet, you
              acknowledge that your information may be transferred to and
              processed in jurisdictions other than your own. We rely on
              Cloudflare&apos;s infrastructure, which maintains appropriate
              safeguards for international data transfers, including compliance
              with applicable data protection frameworks.
            </p>
          </section>

          {/* 10. Changes to This Policy */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              10. Changes to This Policy
            </h2>
            <p {...stylex.props(styles.para)}>
              We may update this Privacy Policy from time to time to reflect
              changes in our practices, technology, or legal requirements. When
              we make material changes, we will update the &quot;Last
              updated&quot; date at the top of this page. We encourage you to
              review this policy periodically. Your continued use of Orb Meet
              after any changes constitutes your acceptance of the updated
              policy.
            </p>
          </section>

          {/* 11. Contact Us */}
          <section>
            <h2 {...stylex.props(styles.h2)}>
              11. Contact Us
            </h2>
            <p {...stylex.props(styles.para)}>
              If you have any questions, concerns, or requests regarding this
              Privacy Policy or our data practices, please contact us at:
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
