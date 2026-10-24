import { useState } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { layout, row, stack, type as typeStyles } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { PERSONAL_ACCESS_TOKEN_SCOPES } from "@orbmeet/domain-model";

import { settings } from "../settings-styles";

const styles = stylex.create({
  heading: { margin: 0 },
  intro: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },

  /**
   * The one-time reveal. Tinted with the accent rather than a warning colour:
   * nothing has gone wrong, there is simply one chance to copy this.
   */
  reveal: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: accent.a200,
    backgroundColor: accent.a50,
    padding: space.s4,
  },
  revealTitle: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: accent.a900,
  },
  revealNote: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: accent.a700,
  },
  revealRow: { marginTop: space.s3, alignItems: "flex-start" },
  secret: {
    minWidth: 0,
    flexGrow: 1,
    // The key has no spaces in it, so it must be allowed to break anywhere or
    // it forces the panel wider than the page.
    overflowWrap: "anywhere",
    borderRadius: radii.field,
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontFamily: fonts.mono,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: neutral.n800,
    boxShadow: `0 1px 2px color-mix(in oklab, ${ink.strong} 5%, transparent)`,
  },

  createRow: { alignItems: "flex-end" },
  createButton: { flexShrink: 0 },
  error: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: danger.d600,
  },

  keyRow: { paddingInline: space.s4, paddingBlock: space.s3, gap: space.s3 },
  keyName: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  keyPrefix: {
    marginTop: space.s0_5,
    marginBottom: 0,
    fontFamily: fonts.mono,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  keyDates: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  revoked: { fontSize: text.xs, fontWeight: weight.medium, color: ink.muted },
  empty: {
    margin: 0,
    paddingInline: space.s4,
    paddingBlock: space.s6,
    textAlign: "center",
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },

  footnote: {
    borderRadius: radii.control,
    backgroundColor: neutral.n50,
    padding: space.s4,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.body,
  },
});

import {
  createPersonalAccessToken,
  revokePersonalAccessToken,
} from "@/modules/developer-api/server/personal-access-tokens.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { queryKeys } from "@/app/query-client/query-keys";
import { personalAccessTokensQueryOptions } from "@/app/query-client/queries/settings";
import { Button } from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import { StepUpDialog, type StepUpCredentialInput } from "./step-up-dialog";

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "Never";
}

export function DeveloperApiSection() {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(personalAccessTokensQueryOptions());
  const [name, setName] = useState("Terminal agent");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A key acts as the account and outlives the session that minted it, so
  // creation carries the same email step-up as the other durable-credential
  // mutations in these settings.
  const [verifying, setVerifying] = useState(false);

  const createMutation = useMutation({
    mutationFn: (credential: StepUpCredentialInput) =>
      createPersonalAccessToken({
        data: {
          name: name.trim(),
          scopes: [...PERSONAL_ACCESS_TOKEN_SCOPES],
          credential,
        },
      }),
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      setVerifying(false);
      setSecret(result.secret);
      setCopied(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.personalAccessTokens() });
    },
    onError: (caught) => setError(getErrorMessage(caught, "Could not create API key.")),
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => revokePersonalAccessToken({ data: { tokenId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.personalAccessTokens() });
    },
    onError: (caught) => setError(getErrorMessage(caught, "Could not revoke API key.")),
  });

  return (
    <div {...stylex.props(stack.x6)}>
      <div>
        <h2 {...stylex.props(typeStyles.sectionTitle, styles.heading)}>Developer API</h2>
        <p {...stylex.props(styles.intro)}>
          Create a key for Codex, Claude Code, or the Orb Meet CLI. Keys act as you and are shown only once.
        </p>
      </div>

      {secret && (
        <div {...stylex.props(styles.reveal)}>
          <p {...stylex.props(styles.revealTitle)}>Copy this key now</p>
          <p {...stylex.props(styles.revealNote)}>
            Orb Meet stores only its hash and cannot show it again.
          </p>
          <div {...stylex.props(row.x2, styles.revealRow)}>
            <code {...stylex.props(styles.secret)}>
              {secret}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(secret)
                  .then(() => setCopied(true))
                  .catch((error) => {
                    setCopied(false);
                    setError(
                      error instanceof Error
                        ? `Could not copy the key: ${error.message}`
                        : "Could not copy the key. Select and copy it manually.",
                    );
                  });
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      <div {...stylex.props(row.x3, styles.createRow)}>
        <Input
          label="Key name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          placeholder="Terminal agent"
        />
        <Button
          loading={createMutation.isPending}
          disabled={!name.trim()}
          onClick={() => setVerifying(true)}
          sx={styles.createButton}
        >
          <Plus size={15} /> Create key
        </Button>
      </div>

      {error && <p {...stylex.props(styles.error)}>{error}</p>}

      <StepUpDialog
        open={verifying}
        action="api_key_create"
        title="Create an API key?"
        description="Verify your identity before minting a credential that acts as your account."
        confirming={createMutation.isPending}
        actionError={createMutation.isError ? getErrorMessage(createMutation.error, "Could not create API key.") : undefined}
        onOpenChange={(open) => {
          if (!open) setVerifying(false);
        }}
        onConfirm={(credential) => createMutation.mutate(credential)}
      />

      <div {...stylex.props(settings.list)}>
        {data.tokens.length === 0 ? (
          <p {...stylex.props(styles.empty)}>No API keys yet.</p>
        ) : (
          data.tokens.map((token, index) => (
            <div
              key={token.id}
              {...stylex.props(
                settings.listRow,
                index === 0 && settings.listRowFirst,
                styles.keyRow,
              )}
            >
              <div {...stylex.props(layout.minZero)}>
                <p {...stylex.props(styles.keyName, layout.truncate)}>{token.name}</p>
                <p {...stylex.props(styles.keyPrefix, layout.truncate)}>{token.tokenPrefix}</p>
                <p {...stylex.props(styles.keyDates)}>
                  Last used {formatDate(token.lastUsedAt)} · Created {formatDate(token.createdAt)}
                </p>
              </div>
              {token.revokedAt ? (
                <span {...stylex.props(styles.revoked)}>Revoked</span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={revokeMutation.isPending && revokeMutation.variables === token.id}
                  onClick={() => revokeMutation.mutate(token.id)}
                  aria-label={`Revoke ${token.name}`}
                >
                  <Trash2 size={14} /> Revoke
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      <div {...stylex.props(styles.footnote)}>
        Store the key in <code>~/.config/orbmeet/config.json</code> with file mode <code>0600</code>.
      </div>
    </div>
  );
}
