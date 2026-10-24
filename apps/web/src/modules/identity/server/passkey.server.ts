/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import { getRequest } from "@tanstack/react-start/server";
import { createDb } from "@orbmeet/db";
import { passkeys, verifications } from "@orbmeet/db/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationExtensionsClientInputs,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { Errors, createValidationError } from "@/lib/app-errors";
import {
  SESSION_ABSOLUTE_EXPIRY_MS,
  SESSION_EXPIRY_MS,
  SESSION_EXPIRY_SECONDS,
} from "@/modules/identity/contract/auth/constants";
import { generateId } from "@/lib/ids";
import { appendCookies, createCookieString } from "@/platform/http/cookies.server";
import { getClientIP } from "@/platform/http/client-ip.server";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import { getEnv } from "@/platform/runtime/server-runtime.server";
import { rememberDevice, sanitizeUser, enforceSessionCapStatement } from "./session";
import {
  generateSessionToken,
  hashSessionToken,
} from "@/platform/crypto/tokens.server";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import {
  consumePasskeyChallenge,
  PASSKEY_USER_VERIFICATION,
  REQUIRE_PASSKEY_USER_VERIFICATION,
} from "./passkey-policy";
import {
  authorizeSensitiveAction,
  parseStepUpFlowToken,
  prepareStepUpCredentialConsumption,
} from "./step-up.server";
import { preparePasskeyRegistrationGrantConsumption } from "./passkey-registration-grant";
import {
  insertActiveAccountSessionStatement,
  insertDeletionResumeSessionStatement,
  DELETION_RECOVERY_SESSION_TTL_SECONDS,
} from "./session-issuance";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type {
  DeletePasskeyInput,
  FinishPasskeyAuthenticationInput,
  FinishPasskeyRegistrationInput,
  StartPasskeyRegistrationInput,
} from "./passkey.functions";
import { timingSafeEqual } from "@orbmeet/primitives";

const PASSKEY_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const RP_NAME = "Orb Meet";
const MAX_PASSKEYS_PER_USER = 10;
export const MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES = 10_000;
/**
 * How many live challenges one source address may hold at once.
 *
 * The global cap alone is a shared, exhaustible resource: passkey sign-in has
 * to be startable before anyone is authenticated, so the only cost of a start
 * is a request, and per-IP rate limits bound the *rate* without bounding the
 * standing pool. Roughly seventeen fully utilised sources could fill all ten
 * thousand slots inside the ten-minute TTL and deny passkey sign-in to
 * everyone.
 *
 * Partitioning by source turns "fill the pool" into "control hundreds of
 * addresses" without invalidating anything: oldest-first eviction would have
 * bounded the pool too, and handed an attacker the power to cancel legitimate
 * in-flight challenges instead. The number is generous because a shared office
 * or campus NAT is one address to us and many people to itself.
 */
export const MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES_PER_SOURCE = 200;

/**
 * A stable, non-reversible bucket for the requester's address.
 *
 * Stored beside the challenge only to partition the pool — never read back for
 * authentication, and deliberately not the address itself, since these rows
 * outlive the request by the challenge TTL.
 */
async function passkeyChallengeSourceBucket(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`passkey-auth-source:${getClientIP()}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function getRpConfig(env: Env): { rpID: string; origin: string } {
  const appUrl = new URL(env.APP_URL);
  return { rpID: appUrl.hostname, origin: appUrl.origin };
}

const PASSKEY_TRANSPORTS: readonly AuthenticatorTransport[] = [
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "usb",
];

/**
 * Transports stored before WebAuthn L3 settled the enum. "cable" was renamed
 * to "hybrid" for the same transport, so it maps rather than being dropped;
 * "smart-card" has no equivalent here and falls away with other unknowns.
 */
const LEGACY_TRANSPORT_ALIASES: Readonly<Record<string, AuthenticatorTransport>> = {
  cable: "hybrid",
};

/**
 * Transports are only a hint the browser uses to prioritise authenticators, so
 * a value we no longer model is dropped instead of failing the request.
 */
function parseTransports(raw: string[] | null): AuthenticatorTransport[] | undefined {
  if (!raw) return undefined;
  const transports: AuthenticatorTransport[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const transport =
      LEGACY_TRANSPORT_ALIASES[value] ?? PASSKEY_TRANSPORTS.find((known) => known === value);
    if (transport && !transports.includes(transport)) transports.push(transport);
  }
  return transports;
}

/**
 * The extension inputs we request. @simplewebauthn v14 widened `extensions` to
 * the full DOM shape, whose `prf` inputs carry `BufferSource` values: not JSON,
 * and never something these endpoints send. TanStack Start validates that a
 * server function's return type is serialisable and rejects the DOM shape, so
 * the wire contract names the one extension we actually use.
 */
interface PasskeyExtensionInputs {
  credProps?: boolean;
}

type RegistrationOptionsPayload = Omit<PublicKeyCredentialCreationOptionsJSON, "extensions"> & {
  extensions?: PasskeyExtensionInputs;
};

type AuthenticationOptionsPayload = Omit<PublicKeyCredentialRequestOptionsJSON, "extensions"> & {
  extensions?: PasskeyExtensionInputs;
};

/** Rebuild the extensions from the keys we request, dropping everything else. */
function toPasskeyExtensions(
  extensions: AuthenticationExtensionsClientInputs | undefined,
): PasskeyExtensionInputs | undefined {
  if (!extensions || extensions.credProps === undefined) return undefined;
  return { credProps: extensions.credProps };
}

export async function startPasskeyRegistrationImpl({
  data,
  context: { user, authSessionId, env, db },
}: {
  data: StartPasskeyRegistrationInput;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "passkey-register-start");
  await enforceRateLimit(env, `passkey-register-start:${user.id}`, true);

  const { rpID } = getRpConfig(env);
  const existing = await db.query.passkeys.findMany({
    where: { userId: user.id },
    columns: { credentialId: true, transports: true },
  });
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw Errors.VALIDATION(
      `Remove an existing passkey before adding another (maximum ${MAX_PASSKEYS_PER_USER}).`,
    );
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: PASSKEY_USER_VERIFICATION,
    },
    extensions: {
      credProps: true,
    },
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: parseTransports(p.transports),
    })),
  });

  let authorization: { id: string; value: string };
  if (data.signupGrant) {
    authorization = await preparePasskeyRegistrationGrantConsumption(db, data.signupGrant, {
      userId: user.id,
      authSessionId,
    });
  } else {
    if (!data.credential) {
      throw createValidationError("Security verification required.");
    }
    const prepared = await prepareStepUpCredentialConsumption(db, env, {
      credential: data.credential,
      userId: user.id,
      authSessionId,
      action: "passkey_register",
    });
    authorization = {
      id: prepared.verificationId,
      value: prepared.verificationValue,
    };
  }

  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const registrationId = crypto.randomUUID();
  const registrationSecret = generateSessionToken();
  const registrationSecretHash = await hashSessionToken(registrationSecret);
  const registrationData = JSON.stringify({
    version: 1,
    secretHash: registrationSecretHash,
    userId: user.id,
    authSessionId,
  });
  const authorizationExists = sql`exists (
      select 1 from ${verifications}
      where ${verifications.id} = ${authorization.id}
        and ${verifications.value} = ${authorization.value}
    )`;
  const insertChallenge = db.insert(verifications).select(
    db
      .select({
        id: sql`${registrationId}`.as("id"),
        type: sql`'passkey_register'`.as("type"),
        identifier: sql`${`passkey-register:${registrationId}`}`.as("identifier"),
        value: sql`${options.challenge}`.as("value"),
        data: sql`${registrationData}`.as("data"),
        expiresAt: sql`${Math.floor((now.getTime() + PASSKEY_CHALLENGE_TTL_MS) / 1000)}`.as(
          "expires_at",
        ),
        createdAt: sql`${nowSeconds}`.as("created_at"),
        updatedAt: sql`${nowSeconds}`.as("updated_at"),
      })
      .from(sql`(select 1)`)
      .where(authorizationExists),
  );
  const consumeAuthorization = db
    .delete(verifications)
    .where(
      and(eq(verifications.id, authorization.id), eq(verifications.value, authorization.value)),
    );
  try {
    const [challengeResult, authorizationResult] = await db.batch([
      insertChallenge,
      consumeAuthorization,
    ]);
    if (getRunChanges(challengeResult) !== 1 || getRunChanges(authorizationResult) !== 1) {
      await db
        .delete(verifications)
        .where(eq(verifications.id, registrationId))
        .catch(() => undefined);
      throw createValidationError("Passkey registration authorization expired.");
    }
  } catch (error) {
    // If D1 committed the atomic batch but its response was lost, the unique
    // challenge id proves that this exact request consumed the credential.
    const committed = await db.query.verifications
      .findFirst({
        where: { id: registrationId },
        columns: { value: true, data: true },
      })
      .catch(() => undefined);
    if (committed?.value !== options.challenge || committed.data !== registrationData) throw error;
  }

  const optionsPayload: RegistrationOptionsPayload = {
    ...options,
    extensions: toPasskeyExtensions(options.extensions),
  };

  return {
    options: optionsPayload,
    registrationToken: `${registrationId}.${registrationSecret}`,
  };
}

export async function finishPasskeyRegistrationImpl({
  data,
  context: { user, authSessionId, env, db },
}: {
  data: FinishPasskeyRegistrationInput;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "passkey-register-finish");
  await enforceRateLimit(env, `passkey-register-finish:${user.id}`, true);

  const registrationToken = parseStepUpFlowToken(data.registrationToken);
  if (!registrationToken) throw Errors.VALIDATION("Passkey registration expired");
  const pending = await db.query.verifications.findFirst({
    where: {
      RAW: (row) =>
        and(
          eq(row.id, registrationToken.id),
          eq(row.type, "passkey_register"),
          eq(row.identifier, `passkey-register:${registrationToken.id}`),
          gte(row.expiresAt, new Date()),
        )!,
    },
  });
  let pendingData: {
    version: 1;
    secretHash: string;
    userId: string;
    authSessionId: string;
  } | null = null;
  try {
    pendingData = pending?.data ? JSON.parse(pending.data) : null;
  } catch {
    pendingData = null;
  }
  const providedSecretHash = await hashSessionToken(registrationToken.secret);
  if (
    !pending ||
    !pendingData ||
    pendingData.version !== 1 ||
    typeof pendingData.secretHash !== "string" ||
    pendingData.userId !== user.id ||
    pendingData.authSessionId !== authSessionId ||
    !await timingSafeEqual(pendingData.secretHash, providedSecretHash)
  ) {
    throw Errors.VALIDATION("Passkey registration expired");
  }
  const challengeRow = await consumePasskeyChallenge(
    db,
    "passkey_register",
    `passkey-register:${registrationToken.id}`,
  );
  if (!challengeRow) throw Errors.VALIDATION("Passkey registration expired");

  const { rpID, origin } = getRpConfig(env);
  const verification = await verifyRegistrationResponse({
    response: data.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
    expectedChallenge: challengeRow.value,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: REQUIRE_PASSKEY_USER_VERIFICATION,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw Errors.VALIDATION("Passkey registration failed");
  }

  const registrationInfo = verification.registrationInfo;
  const now = new Date();
  const passkeyName = data.name || null;
  const transports = registrationInfo.credential.transports
    ? JSON.stringify(registrationInfo.credential.transports)
    : null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const insertResult = await db.run(sql`
      insert into ${passkeys} (
        id, user_id, credential_id, public_key, counter, device_type,
        backed_up, transports, name, created_at, last_used_at
      )
      select
        ${generateId("PASSKEY")},
        ${user.id},
        ${registrationInfo.credential.id},
        ${isoBase64URL.fromBuffer(registrationInfo.credential.publicKey)},
        ${registrationInfo.credential.counter},
        ${registrationInfo.credentialDeviceType},
        ${registrationInfo.credentialBackedUp ? 1 : 0},
        ${transports},
        ${passkeyName},
        ${nowSeconds},
        ${nowSeconds}
      where (
        select count(*) from ${passkeys}
        where ${passkeys.userId} = ${user.id}
      ) < ${MAX_PASSKEYS_PER_USER}
      on conflict(credential_id) do nothing
    `);

  if (getRunChanges(insertResult) === 0) {
    const existing = await db.query.passkeys.findFirst({
      where: { credentialId: registrationInfo.credential.id },
      columns: { userId: true },
    });
    if (existing?.userId === user.id) {
      throw Errors.CONFLICT("This passkey is already registered to your account.");
    }
    const atCapacity = await db.query.passkeys.findMany({
      where: { userId: user.id },
      columns: { id: true },
      limit: MAX_PASSKEYS_PER_USER,
    });
    if (atCapacity.length >= MAX_PASSKEYS_PER_USER) {
      throw Errors.VALIDATION(
        `Remove an existing passkey before adding another (maximum ${MAX_PASSKEYS_PER_USER}).`,
      );
    }
    throw Errors.CONFLICT("This passkey is already registered to another account.");
  }

  return { success: true };
}

export async function startPasskeyAuthenticationImpl() {
  const env = await getEnv();
  const db = createDb(env.DB);
  await enforceIpRateLimit(env, "passkey-auth-start");
  await enforceRateLimit(env, `passkey-auth-start:${getClientIP()}`, true);

  const { rpID } = getRpConfig(env);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: PASSKEY_USER_VERIFICATION,
  });

  const challengeId = crypto.randomUUID();
  const now = new Date();
  await withD1Retry(
    () =>
      db
        .delete(verifications)
        .where(and(eq(verifications.type, "passkey_auth"), lte(verifications.expiresAt, now))),
    { idempotent: true },
  );
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = Math.floor((now.getTime() + PASSKEY_CHALLENGE_TTL_MS) / 1000);
  const sourceBucket = await passkeyChallengeSourceBucket();
  const inserted = await withD1Retry(
    () =>
      db.run(sql`
      insert into ${verifications} (
        id, type, identifier, value, data, expires_at, created_at, updated_at
      )
      select
        ${challengeId},
        'passkey_auth',
        ${`passkey-auth:${challengeId}`},
        ${options.challenge},
        ${JSON.stringify({ source: sourceBucket })},
        ${expiresAtSeconds},
        ${nowSeconds},
        ${nowSeconds}
      where (
        select count(*)
        from ${verifications}
        where ${verifications.type} = 'passkey_auth'
          and ${verifications.expiresAt} > ${nowSeconds}
      ) < ${MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES}
      and (
        select count(*)
        from ${verifications}
        where ${verifications.type} = 'passkey_auth'
          and ${verifications.expiresAt} > ${nowSeconds}
          and json_extract(${verifications.data}, '$.source') = ${sourceBucket}
      ) < ${MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES_PER_SOURCE}
    `),
    { idempotent: true },
  );
  if (getRunChanges(inserted) !== 1) throw Errors.RATE_LIMITED();

  const optionsPayload: AuthenticationOptionsPayload = {
    ...options,
    extensions: toPasskeyExtensions(options.extensions),
  };

  return { challengeId, options: optionsPayload };
}

export async function finishPasskeyAuthenticationImpl({
  data,
}: {
  data: FinishPasskeyAuthenticationInput;
}) {
  const request = getRequest();
  const env = await getEnv();
  const db = createDb(env.DB);

  await enforceIpRateLimit(env, "passkey-auth-finish");
  await enforceRateLimit(env, `passkey-auth-finish:${getClientIP()}`, true);

  const challengeRow = await consumePasskeyChallenge(
    db,
    "passkey_auth",
    `passkey-auth:${data.challengeId}`,
  );
  if (!challengeRow) throw Errors.UNAUTHORIZED();

  const credentialId = data.response.id;
  const stored = await db.query.passkeys.findFirst({
    where: { credentialId: credentialId },
  });
  if (!stored) throw Errors.UNAUTHORIZED();

  const credential: WebAuthnCredential = {
    id: stored.credentialId,
    publicKey: isoBase64URL.toBuffer(stored.publicKey),
    counter: stored.counter,
    transports: parseTransports(stored.transports),
  };

  const { rpID, origin } = getRpConfig(env);
  const verification = await verifyAuthenticationResponse({
    response: data.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
    expectedChallenge: challengeRow.value,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: REQUIRE_PASSKEY_USER_VERIFICATION,
  });

  if (!verification.verified) {
    throw Errors.UNAUTHORIZED();
  }

  const authInfo = verification.authenticationInfo;
  const now = new Date();
  // CAS on counter to detect concurrent assertion replays. When newCounter is
  // 0 the authenticator doesn't support counters (both reads stay 0), so the
  // condition still passes — replay detection is then the authenticator's
  // responsibility. For non-zero counters a race means one of the two requests
  // will see the wrong stored counter and be rejected.
  const updateResult = await db
    .update(passkeys)
    .set({
      counter: authInfo.newCounter,
      lastUsedAt: now,
      backedUp: authInfo.credentialBackedUp ?? stored.backedUp,
    })
    .where(and(eq(passkeys.id, stored.id), eq(passkeys.counter, stored.counter)));
  if (getRunChanges(updateResult) === 0) throw Errors.UNAUTHORIZED();

  const user = await db.query.users.findFirst({ where: { id: stored.userId } });
  if (!user) throw Errors.UNAUTHORIZED();

  // Same deletion-gate detection as the OTP login path: without it the
  // fenced insert below inserts zero rows and the sign-in fails forever
  // even though the person just proved possession of a passkey.
  const deletionPending = user.deletionStartedAt !== null;

  const passkeySessionId = generateId("SESSION");
  const sessionToken = generateSessionToken();
  const sessionTokenHash = await hashSessionToken(sessionToken);
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const recoveryTtlSeconds = deletionPending ? DELETION_RECOVERY_SESSION_TTL_SECONDS : undefined;
  const insertSession = deletionPending
    ? insertDeletionResumeSessionStatement(db, {
        id: passkeySessionId,
        tokenHash: sessionTokenHash,
        userId: user.id,
        expiresAtSeconds: nowSeconds + recoveryTtlSeconds!,
        absoluteExpiresAtSeconds: nowSeconds + recoveryTtlSeconds!,
        ipAddress: getClientIP(),
        userAgent: request.headers.get("User-Agent")?.slice(0, 500) ?? null,
        createdAtSeconds: nowSeconds,
      })
    : insertActiveAccountSessionStatement(db, {
        id: passkeySessionId,
        tokenHash: sessionTokenHash,
        userId: user.id,
        expiresAtSeconds: Math.floor((nowMs + SESSION_EXPIRY_MS) / 1000),
        absoluteExpiresAtSeconds: Math.floor((nowMs + SESSION_ABSOLUTE_EXPIRY_MS) / 1000),
        ipAddress: getClientIP(),
        userAgent: request.headers.get("User-Agent")?.slice(0, 500) ?? null,
        createdAtSeconds: nowSeconds,
      });
  const [insertResult] = await db.batch([insertSession, enforceSessionCapStatement(db, user.id)]);
  if (getRunChanges(insertResult) !== 1) throw Errors.UNAUTHORIZED();
  if (!deletionPending) {
    // A remembered-device cookie cannot resolve a deletion-gated account
    // (the lookup excludes gated users), so do not mint a dead row.
    await rememberDevice(db, env, user.id, passkeySessionId).catch(() => {});
  }

  appendCookies([
    createCookieString("session", sessionToken, SESSION_EXPIRY_SECONDS, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);

  return { user: sanitizeUser(user), deletionPending };
}

export async function listPasskeysImpl({ context: { user, db } }: { context: AuthFnContext }) {
  const rows = await db.query.passkeys.findMany({
    where: { userId: user.id },
    columns: {
      id: true,
      name: true,
      deviceType: true,
      backedUp: true,
      createdAt: true,
      lastUsedAt: true,
    },
    orderBy: (p, { desc }) => [desc(p.lastUsedAt), desc(p.createdAt)],
  });
  return rows;
}

export async function deletePasskeyImpl({
  data,
  context: { user, authSessionId, db, env },
}: {
  data: DeletePasskeyInput;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "passkey-delete");
  await enforceRateLimit(env, `passkey-delete:${user.id}`, true);

  const found = await db.query.passkeys.findFirst({
    where: { RAW: (row) => and(eq(row.id, data.passkeyId), eq(row.userId, user.id))! },
    columns: { id: true },
  });
  if (!found) throw Errors.NOT_FOUND("Passkey");
  await authorizeSensitiveAction(db, env, {
    credential: data.credential,
    userId: user.id,
    authSessionId,
    action: "passkey_delete",
    targetId: data.passkeyId,
  });

  await db.delete(passkeys).where(eq(passkeys.id, found.id));
  return { success: true };
}
