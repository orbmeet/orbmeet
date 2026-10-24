// The Worker's configuration: every binding, var, trigger and export it runs
// with. Deployment-specific values (database id, domains, public ids) live in
// the gitignored cloudflare.deploy.json and are merged in
// build/config/worker-target.ts, which this file builds its bindings from;
// a fresh clone without that file still typechecks, builds and runs locally
// against the placeholders.
//
// `cf` and the Vite plugin read this file directly. The entrypoint import
// carries the real module types (so Durable Object RPC surfaces flow into
// generated types) without loading the module: the `{ type: "cf-worker" }`
// attribute is cf's contract for a type-only entry reference.
//
// Nothing else here may come from src/. The Vite plugin adds this file and
// everything it imports to the dev server's `fs.deny`, and that list also
// stops the Worker loading those modules in `vite dev` — a shared constant
// imported here breaks the dev Worker wherever the app imports it too. The
// values the app also needs are written out below instead, and
// build/config/cloudflare.test.ts pins them to the app's own.
import * as entrypoint from "./src/worker-entry.ts" with { type: "cf-worker" };
import {
	bindings,
	defineConfig,
	exports,
	triggers,
} from "@cloudflare/config";
import {
	compatibilityDate,
	compatibilityFlags,
	databaseId,
	deployVars as vars,
	domains,
	workerName,
} from "./build/config/worker-target.ts";

export default defineConfig({
	worker: {
		name: workerName,
		compatibilityDate,
		compatibilityFlags: [...compatibilityFlags],
		entrypoint,
		// Deliberately run near the caller. This application mixes D1 with realtime
		// Singapore services; benchmark placement against your own traffic before
		// enabling a placement hint or Smart Placement.
		// placement: { mode: "smart" },
		observability: {
			enabled: true,
			// Errors grouped by cause, with stacks mapped to the source: what
			// throws, fails an invocation, answers 5xx or logs an error.
			issues: { enabled: true },
			// What the application logs, unsampled: a sampled error is one
			// nobody sees. Not Cloudflare's own line for every invocation, nor
			// traces: they grow with every request, and what goes wrong is
			// already logged, with its request id (src/worker-entry.ts). Kept in
			// Cloudflare, which Issues reads, and sent to Axiom (the account's
			// axiom-logs destination), where infra/ops/src/monitors.ts alerts.
			logs: {
				enabled: true,
				invocationLogs: false,
				headSamplingRate: 1,
				destinations: ["axiom-logs"],
			},
			traces: { enabled: false },
		},
		assets: {
			// Serve prerendered `foo/index.html` at `/foo` directly instead of
			// 301ing `/foo` -> `/foo/`. Matches our slash-less canonical URLs and
			// TanStack Router `trailingSlash: 'never'`.
			htmlHandling: "drop-trailing-slash",
			runWorkerFirst: ["/api/*", "/_serverFn/*", "/llms.txt"],
		},
		// Apex only. `www` is an external redirect rule, not a second domain.
		domains,
		triggers: [
			// Every minute: media node health, cleanup, schedule notifications and
			// a check on quiet meetings. Daily: authentication cleanup, Paddle
			// reconciliation, webhook receipt pruning, and recordings the queue
			// below never registered. Anything with steps and retries of its own
			// runs as a job (JOBS), not here. Dispatch lives in
			// src/app/bootstrap/scheduled.server.ts, which matches these against
			// src/app/bootstrap/cron-schedules.ts.
			triggers.scheduled({ schedule: "* * * * *" }),
			triggers.scheduled({ schedule: "0 3 * * *" }),
			// R2's event notifications for uploaded recordings: they are what
			// registers a recording. The queue and the bucket's notification
			// rule are created once; see
			// src/modules/meetings/server/media/recordings-queue.ts.
			triggers.queue({
				name: "orbmeet-recordings",
				maxRetries: 23,
			}),
		],
		// Replaces Wrangler's `migrations` list. MeetingRoom shipped as a v1
		// `new_sqlite_classes`; the storage declaration here is the same
		// statement, not a new migration.
		exports: {
			// MEETING_ROOM: each open meeting's single writer — its live state,
			// timers and provider calls
			// (src/modules/meetings/server/runtime/meeting-room.ts).
			MeetingRoom: exports.durableObject({ storage: "sqlite" }),
			// SERIAL_SCOPES: one queue per Organization, user, Whiteboard or
			// Meeting for work that must not overlap
			// (src/app/serial/tasks.ts). Holds nothing in storage.
			SerialScope: exports.durableObject({ storage: "sqlite" }),
			// Durable background jobs: meeting follow-up, summaries, account
			// cleanup. See src/platform/jobs/jobs.ts.
			DurableJobWorkflow: exports.workflow({ name: "orbmeet-jobs" }),
		},
		env: {
			APP_NAME: bindings.text(vars.APP_NAME),
			APP_URL: bindings.text(vars.APP_URL),
			ENVIRONMENT: bindings.text(vars.ENVIRONMENT),
			EMAIL_FROM_ADDRESS: bindings.text(vars.EMAIL_FROM_ADDRESS),
			R2_BUCKET_NAME: bindings.text(vars.R2_BUCKET_NAME),
			AI_MODEL: bindings.text(vars.AI_MODEL),
			AI_MODEL_FALLBACK: bindings.text(vars.AI_MODEL_FALLBACK),
			MATHINK_ORIGIN_URL: bindings.text(vars.MATHINK_ORIGIN_URL),
			UPTIMEROBOT_MONITOR_LIVEKIT_ID: bindings.text(
				vars.UPTIMEROBOT_MONITOR_LIVEKIT_ID,
			),
			UPTIMEROBOT_MONITOR_WHITEBOARD_ID: bindings.text(
				vars.UPTIMEROBOT_MONITOR_WHITEBOARD_ID,
			),
			VITE_PADDLE_CLIENT_TOKEN: bindings.text(vars.VITE_PADDLE_CLIENT_TOKEN),
			PADDLE_PRICE_ID_PRO: bindings.text(vars.PADDLE_PRICE_ID_PRO),
			PADDLE_PRICE_ID_ORG_SEAT: bindings.text(vars.PADDLE_PRICE_ID_ORG_SEAT),
			// D1 Database — create with: cf d1 create orbmeet-db, and put its id
			// in cloudflare.deploy.json.
			DB: bindings.d1({ name: "orbmeet-db", id: databaseId }),
			// R2 Object Storage — create with: cf r2 buckets create orbmeet-storage
			R2_BUCKET: bindings.r2({ name: vars.R2_BUCKET_NAME }),
			// Cloudflare Email Service — transactional email (OTP, scheduling).
			// Onboard the sending domain under Email Service > Email Sending in
			// the dashboard; the domain must use Cloudflare DNS. Local dev
			// simulates sends (logged, not delivered).
			EMAIL: bindings.sendEmail(),
			// Whiteboard code execution. The container, its toolchain image and
			// the Sandbox Durable Object all live in the separate
			// orbmeet-code-runner Worker (apps/code-runner), so deploying this
			// Worker never needs Docker. Authorization stays here: the runner
			// holds no user identity.
			CODE_RUNNER: bindings.worker({ worker: "orbmeet-code-runner" }),
			MEETING_ROOM: bindings.durableObject({
				worker: workerName,
				exportName: "MeetingRoom",
			}),
			SERIAL_SCOPES: bindings.durableObject({
				worker: workerName,
				exportName: "SerialScope",
			}),
			// Durable background jobs (src/platform/jobs/jobs.ts).
			JOBS: bindings.workflow({
				name: "orbmeet-jobs",
				worker: workerName,
				exportName: "DurableJobWorkflow",
			}),
			CF_VERSION_METADATA: bindings.versionMetadata(),
			RATE_LIMITER: bindings.rateLimit({
				namespace: "1001",
				simple: { limit: 100, period: 60 },
			}),
			AUTH_RATE_LIMITER: bindings.rateLimit({
				namespace: "1002",
				simple: { limit: 60, period: 60 },
			}),
			MATHINK_RATE_LIMITER: bindings.rateLimit({
				namespace: "1003",
				simple: { limit: 20, period: 60 },
			}),
			AUTOMATION_IP_RATE_LIMITER: bindings.rateLimit({
				namespace: "1004",
				simple: { limit: 600, period: 60 },
			}),
			// Pre-authentication ceiling for the transcription agent's ingest
			// calls. One shared IP carries every meeting that host is
			// transcribing, so the 60/min auth limiter throttled meetings against
			// each other long before any of them reached its own 100/min
			// per-meeting budget. Scoped for the aggregate producer instead:
			// ~12 concurrent meetings at their full per-meeting rate, while still
			// bounding an unauthenticated flood.
			TRANSCRIPT_INGEST_RATE_LIMITER: bindings.rateLimit({
				namespace: "1005",
				simple: { limit: 1200, period: 60 },
			}),
			// Pre-authentication ceiling for LiveKit's webhook receiver. Every
			// webhook for the whole fleet arrives from LiveKit's addresses, so
			// the 60/min auth budget would throttle real participant and egress
			// events; this bounds the body read and JWT verification an
			// unauthenticated sender can spend without capping legitimate fleet
			// volume.
			LIVEKIT_WEBHOOK_RATE_LIMITER: bindings.rateLimit({
				namespace: "1006",
				simple: { limit: 1200, period: 60 },
			}),
			// Whiteboard asset reads and the PDF-import control endpoints. Sized
			// for a browser, not a human: opening one board fetches every image
			// on it at once, so the 100/min general budget would throttle
			// ordinary use. This bounds what an unauthenticated caller can spend
			// on the authorization work each read performs — token verification
			// plus registry lookups.
			ASSET_RATE_LIMITER: bindings.rateLimit({
				namespace: "1007",
				simple: { limit: 1200, period: 60 },
			}),
			// Whiteboard code-cell runs. Far tighter than the general budget
			// because each run costs container seconds, not just a Worker
			// invocation. Keyed per participant rather than per IP — everyone in
			// one meeting room can share a NAT.
			CODE_RUN_RATE_LIMITER: bindings.rateLimit({
				namespace: "1008",
				simple: { limit: 20, period: 60 },
			}),
			// Paddle delivery and retries are independent of LiveKit. Keep its
			// pre-authentication verification capacity in a separate namespace.
			PADDLE_WEBHOOK_RATE_LIMITER: bindings.rateLimit({
				namespace: "1009",
				simple: { limit: 1200, period: 60 },
			}),
			ASSETS: bindings.assets(),

			// ── Required secrets ──────────────────────────────────────────────
			// Set each on an existing Worker with:
			// cf workers secrets update <KEY> --worker <worker-name>. Declaring them
			// here keeps them in generated types; `cf deploy` preserves their
			// existing remote values when no replacement value is supplied.
			//
			// - AUTH_SECRET
			// - NODES  (the self-hosted nodes and their keys; `pnpm ops deploy` publishes it)
			// - TRANSCRIPTION_INTERNAL_KEYS  (JSON key-id -> secret map; `pnpm ops deploy`)
			// - R2_ACCESS_KEY_ID
			// - R2_SECRET_ACCESS_KEY
			// - R2_ACCOUNT_ID
			AUTH_SECRET: bindings.secret(),
			NODES: bindings.secret(),
			TRANSCRIPTION_INTERNAL_KEYS: bindings.secret(),
			R2_ACCESS_KEY_ID: bindings.secret(),
			R2_SECRET_ACCESS_KEY: bindings.secret(),
			R2_ACCOUNT_ID: bindings.secret(),
			// Optional secrets (AI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
			// UPTIMEROBOT_API_KEY, PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET,
			// MATHINK_ORIGIN_SECRET, CODE_RUNNER_SECRET) are intentionally not
			// declared: a fresh clone must deploy without them. They are typed in
			// src/env.d.ts instead.
		},
	},
});
