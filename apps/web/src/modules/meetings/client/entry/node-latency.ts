// How far this browser is from each media node, measured from the browser
// itself. Its network path (a VPN, a hotel's Wi-Fi, a phone's carrier) is the
// one its media will take, which a measurement from anywhere else cannot see.
// The join request carries the result, and the meeting's first join places it.

/** A media node and the URL its LiveKit answers at; see `mediaNodeProbes`. */
export interface NodeProbe {
  id: string;
  url: string;
}

/** Milliseconds to each node that answered, by node id. */
export type NodeLatencies = Record<string, number>;

/** Timed requests per node after the one that opens its connection; the fastest counts. */
const SAMPLES = 3;
/** A node slower than this to answer is as good as unreachable for a call. */
const REQUEST_TIMEOUT_MS = 2_000;
/** How long a measurement stands for this browser before the next join measures again. */
const FRESH_MS = 5 * 60_000;

export interface MeasureDeps {
  fetch: (url: string, init: RequestInit) => Promise<unknown>;
  now: () => number;
}

const defaultDeps = (): MeasureDeps => ({
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
});

/**
 * Round-trip time to one node: one request opens the connection (DNS, TCP,
 * TLS), then the fastest of `SAMPLES` requests on it. Undefined when the node
 * did not answer.
 *
 * `no-cors` asks nothing of the node: the answer is opaque, and only its
 * arrival is timed.
 */
async function measureOne(probe: NodeProbe, deps: MeasureDeps): Promise<number | undefined> {
  const request = (sample: number) => deps.fetch(`${probe.url}?probe=${sample}`, {
    mode: "no-cors",
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try {
    await request(0);
    let fastest = Infinity;
    for (let sample = 1; sample <= SAMPLES; sample++) {
      const started = deps.now();
      await request(sample);
      fastest = Math.min(fastest, deps.now() - started);
    }
    return Math.max(1, Math.round(fastest));
  } catch {
    return undefined;
  }
}

/** Every node measured at once; a node that did not answer is left out. */
export async function measureNodeLatencies(
  probes: readonly NodeProbe[],
  deps: MeasureDeps = defaultDeps(),
): Promise<NodeLatencies> {
  const measured = await Promise.all(probes.map(async (probe) => [probe.id, await measureOne(probe, deps)] as const));
  return Object.fromEntries(measured.filter((entry): entry is [string, number] => entry[1] !== undefined));
}

let current: { key: string; startedAt: number; result: Promise<NodeLatencies> } | null = null;

/**
 * Start measuring these nodes unless a fresh measurement of them has already
 * started. The pre-join screen calls this, so the measurement is usually done
 * by the time the user asks to join.
 */
export function prefetchNodeLatencies(probes: readonly NodeProbe[], deps?: MeasureDeps): void {
  if (probes.length === 0) return;
  const key = probes.map((probe) => `${probe.id}=${probe.url}`).sort().join(",");
  const now = Date.now();
  if (current && current.key === key && now - current.startedAt < FRESH_MS) return;
  current = { key, startedAt: now, result: measureNodeLatencies(probes, deps) };
}

/**
 * The latest measurement, if it finishes within `waitMs` and any node
 * answered; otherwise undefined, and the Worker measures from its data centre
 * instead. A join never waits longer than `waitMs` for it.
 */
export async function settledNodeLatencies(waitMs: number): Promise<NodeLatencies | undefined> {
  if (!current) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const latencies = await Promise.race([
    current.result,
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); }),
  ]).finally(() => clearTimeout(timer));
  return latencies && Object.keys(latencies).length > 0 ? latencies : undefined;
}

/** Test hook: forget the last measurement. */
export function resetNodeLatencies(): void {
  current = null;
}
