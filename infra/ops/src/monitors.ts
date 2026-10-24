import { AXIOM_DATASET } from "./catalog.ts";
import { OpsError } from "./shell.ts";

/*
 * The Axiom monitors that alert on what the Worker and the nodes log, kept
 * here so a change to them is reviewed like any other. `pnpm ops monitors`
 * makes the account's monitors named `Orb Meet: …` exactly these, through
 * the notifier named NOTIFIER.
 *
 * The Worker's lines arrive through Cloudflare's OpenTelemetry export
 * (severity_*, body); the nodes' through ship-logs.sh (source "node", level).
 * A field a query names must exist in the dataset, or Axiom refuses the
 * query: column_ifexists covers a node field before a node has sent it.
 */

const PREFIX = "Orb Meet: ";
export const NOTIFIER = "Orb Meet email";
const DATASET = `['${AXIOM_DATASET}']`;

export interface Monitor {
  name: string;
  description: string;
  type: "MatchEvent" | "Threshold";
  aplQuery: string;
  intervalMinutes: number;
  rangeMinutes: number;
  /** Threshold monitors only. */
  operator?: "Above" | "AboveOrEqual" | "Below" | "BelowOrEqual";
  threshold?: number;
  /** Threshold monitors only: alert for each row (node) rather than once. */
  notifyByGroup?: boolean;
}

export const MONITORS: Monitor[] = [
  {
    // One alert for each thing going wrong, not for each line saying so: an
    // error repeated within the range keeps its alert open rather than
    // sending another. A Worker line's message is a fixed label, its details
    // apart; a node's is its whole text, so it is cut short. A failed cron
    // rethrows its tasks' errors together (scheduled.server.ts), each already
    // logged as its own: the sum is left out.
    name: `${PREFIX}error`,
    description: "An error the Worker logged (a browser's report included), or one a node logged.",
    type: "Threshold",
    aplQuery: `${DATASET} | where severity_number >= 17 or (source == "node" and column_ifexists("level", "") == "error") `
      + "| extend what = iff(source == \"node\", "
      + "strcat(column_ifexists(\"node\", \"\"), \" \", column_ifexists(\"service\", \"\"), \": \", substring(column_ifexists(\"msg\", \"\"), 0, 100)), "
      + "coalesce(tostring(parse_json(tostring(body)).msg), substring(tostring(body), 0, 100))) "
      + "| where not(what startswith \"Scheduled maintenance completed with failures\") "
      + "| summarize errors = count() by what",
    intervalMinutes: 1,
    rangeMinutes: 10,
    operator: "AboveOrEqual",
    threshold: 1,
    notifyByGroup: true,
  },
  {
    // Every node sends a heartbeat every five minutes (ship-logs.sh), so a
    // node heard from within the hour that has since gone quiet has stopped,
    // or stopped shipping.
    name: `${PREFIX}node silent`,
    description: "A node that sent logs in the last hour has sent none for 15 minutes.",
    type: "Threshold",
    aplQuery: `${DATASET} | where source == "node" `
      + "| summarize silent_minutes = datetime_diff(\"minute\", now(), todatetime(max(_time))) by node",
    intervalMinutes: 5,
    rangeMinutes: 60,
    operator: "AboveOrEqual",
    threshold: 15,
    notifyByGroup: true,
  },
  {
    name: `${PREFIX}joins failing`,
    description: "Participants failing to connect to meetings, or refused for want of a media node.",
    type: "Threshold",
    aplQuery: `${DATASET} | where severity_text == "warn" | extend entry = parse_json(tostring(body)) `
      + "| where (entry.msg == \"[client-diagnostic]\" "
      + "and entry.event in (\"livekit_error\", \"livekit_connect_timeout\", \"join_rpc_timeout\")) "
      + "or entry.msg == \"[serverFn] MEDIA_UNAVAILABLE\" "
      + "| summarize failures = count()",
    intervalMinutes: 5,
    rangeMinutes: 15,
    operator: "AboveOrEqual",
    threshold: 3,
  },
];

interface Remote {
  id: string;
  name: string;
}

export interface AxiomApi {
  get(path: string): Promise<unknown>;
  send(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<void>;
}

/** Make the account's `Orb Meet: …` monitors these, reporting each change. */
export async function applyMonitors(api: AxiomApi, log: (line: string) => void): Promise<void> {
  const notifier = (await api.get("/v2/notifiers") as Remote[]).find((n) => n.name === NOTIFIER);
  if (!notifier) throw new OpsError(`No Axiom notifier named "${NOTIFIER}"; create it first`);
  const ours = (await api.get("/v2/monitors") as Remote[]).filter((m) => m.name.startsWith(PREFIX));

  // First, because a plan caps how many monitors an account may have.
  for (const stale of ours.filter((m) => !MONITORS.some((monitor) => monitor.name === m.name))) {
    await api.send("DELETE", `/v2/monitors/${stale.id}`);
    log(`deleted ${stale.name}`);
  }
  for (const monitor of MONITORS) {
    const body = { ...monitor, notifierIds: [notifier.id] };
    const existing = ours.find((m) => m.name === monitor.name);
    if (existing) await api.send("PUT", `/v2/monitors/${existing.id}`, body);
    else await api.send("POST", "/v2/monitors", body);
    log(`${existing ? "updated" : "created"} ${monitor.name}`);
  }
}

/**
 * Axiom's API with a token allowed to manage monitors: AXIOM_API_TOKEN, and
 * AXIOM_ORG_ID for a personal token. Never the nodes' ingest token.
 */
export function axiomApi(env: NodeJS.ProcessEnv = process.env): AxiomApi {
  const token = env.AXIOM_API_TOKEN;
  if (!token) throw new OpsError("Set AXIOM_API_TOKEN to an Axiom token that may manage monitors");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(env.AXIOM_ORG_ID ? { "X-Axiom-Org-Id": env.AXIOM_ORG_ID } : {}),
  };
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`https://api.axiom.co${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new OpsError(`Axiom answered ${method} ${path} with ${response.status}: ${await response.text()}`);
    return response;
  };
  return {
    get: async (path) => (await request("GET", path)).json(),
    send: async (method, path, body) => {
      await request(method, path, body);
    },
  };
}
