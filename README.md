# Orb Meet

**Meetings that keep what you worked out.**

Orb Meet is a video meeting app with a shared whiteboard and notes that write
themselves. It runs in the browser at [orbmeet.com](https://orbmeet.com), and
everything that runs it is in this repository, under the MIT license.

- **The board stays.** Every meeting has a whiteboard, named after the meeting
  it was drawn in and ready to pick up next time. Code drawn on it can be run in
  a sandbox.
- **The recap writes itself.** After a meeting: an AI summary, the moments worth
  going back to, and who agreed to do what, with the full transcript and the
  recording beside it.
- **Orb is in the room.** An assistant you can ask to check a step or draw on
  the board. Everything it hears is kept and searchable.
- **Scriptable.** A CLI and a public API schedule meetings and fetch
  transcripts, summaries and recordings as JSON.

## How it fits together

```
                 browser
                    │
        ┌───────────┴─────────────┐
        ▼                         ▼
  Cloudflare Worker        self-hosted nodes (Docker)
  apps/web                 ├─ LiveKit + Egress   video, recordings
  ├─ D1    accounts,       ├─ transcription      speech to text (Deepgram)
  │        meetings        ├─ whiteboard         board sync (tldraw), saved to R2
  ├─ R2    files, boards   └─ Caddy              TLS in front of all of them
  ├─ Durable Objects  one per live meeting
  └─ Workflows        summaries, cleanup
        │
        └─ Cloudflare Container  apps/code-runner  runs board code, no network
```

The Worker owns accounts, meetings, and where each one runs. Media and
whiteboards run on nodes you host yourself; the Worker places each meeting on
the closest healthy node and moves it if that node goes down.

| Path | What it is |
|---|---|
| `apps/web` | The app and its API: TanStack Start on Cloudflare Workers, with D1 (Drizzle), R2, Durable Objects and Workflows |
| `apps/whiteboard-server` | The whiteboard sync server that runs on each node |
| `apps/transcription-agent` | The LiveKit agent that transcribes each participant |
| `apps/code-runner` | The sandbox for code on the board (a Durable Object and its container) |
| `apps/cli` | `@orbmeet/cli`, the command line client |
| `packages/*` | Code the apps share: the database schema and migrations (`db`), the whiteboard (`whiteboard-core`, `whiteboard-client`), UI components (`ui`), node placement (`nodes`), protocols and contracts |
| `infra/ops` | `pnpm ops`: sets up, deploys and checks the self-hosted nodes |

## Run it locally

You need Node 24.22.1 or newer, pnpm 12 (`corepack enable` picks the version
the repo names), and Docker, which runs LiveKit for local development.

```sh
pnpm install

# The Worker's local configuration. Any id works for the local database.
cp apps/web/.dev.vars.example apps/web/.dev.vars
cp apps/web/cloudflare.deploy.json.example apps/web/cloudflare.deploy.json
#   then set "databaseId" in cloudflare.deploy.json, e.g. to the output of `uuidgen`

# Create the local database
cd apps/web
pnpm exec cf d1 migrations apply "$(node -p "require('./cloudflare.deploy.json').databaseId")" --local \
  --dir ../../packages/db/drizzle/migrations \
  --pattern '../../packages/db/drizzle/migrations/*/migration.sql'
cd ../..

# The app on http://localhost:3000, its whiteboard server, and LiveKit in Docker
pnpm dev
```

The whiteboard server creates its own `.env` from its example on first run.
Sign-in with Google, email, AI summaries and stored recordings each need their
keys in `apps/web/.dev.vars`; each one is described there.

For live captions and transcripts, also run the transcription agent. It needs a
Deepgram API key:

```sh
cp apps/transcription-agent/.env.example apps/transcription-agent/.env   # set DEEPGRAM_API_KEY
pnpm --filter @orbmeet/transcription-agent dev
```

## Checks

```sh
pnpm check    # lint, typecheck, knip, the migration check, every test, every build
pnpm test     # every package's tests
pnpm e2e      # browser tests (apps/web/e2e)
```

`pnpm check` is also what a deploy runs first.

## Deploy

**The Worker.** Fill in `apps/web/cloudflare.deploy.json` with your D1
database, domain and public values, set the Worker's secrets (listed in
`apps/web/worker-secrets.example`), then:

```sh
pnpm --filter @orbmeet/web deploy    # checks, applies migrations, deploys
```

**The nodes.** Describe your servers in `infra/ops/inventory.json`, kept out of
git; `infra/ops/src/test-fixtures.ts` shows its shape. Secrets live encrypted in
`infra/ops/secrets.age`. Then:

```sh
pnpm ops deploy [node]   # from a fresh VM to a running node; drains live meetings before restarting media
pnpm ops check           # each node's readiness, and what clients see of it
pnpm ops                 # every command
```

## The CLI

```sh
npm i -g @orbmeet/cli
orbmeet configure        # store an API token (or set ORBMEET_TOKEN)
orbmeet schedules        # upcoming meetings
orbmeet summary --help   # summaries, transcripts, recordings, whiteboard exports
```

Every command prints JSON on success and a JSON error on stderr on failure, so
it can be scripted.

## License

[MIT](LICENSE)
