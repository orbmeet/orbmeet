type ClientAuthFlowMode = "signup" | "login";

interface ClientAuthFlow {
  flowToken: string;
  email: string;
  mode: ClientAuthFlowMode;
}

function storageKey(flowId: string): string {
  return `orbmeet.auth-flow.${flowId}`;
}

export function saveClientAuthFlow(
  flowId: string,
  flow: ClientAuthFlow,
): void {
  sessionStorage.setItem(storageKey(flowId), JSON.stringify(flow));
}

export function loadClientAuthFlow(flowId: string): ClientAuthFlow | null {
  try {
    const raw = sessionStorage.getItem(storageKey(flowId));
    if (!raw) return null;
    const flow = JSON.parse(raw) as Partial<ClientAuthFlow>;
    if (
      typeof flow.flowToken !== "string"
      || typeof flow.email !== "string"
      || (flow.mode !== "signup" && flow.mode !== "login")
    ) {
      return null;
    }
    return flow as ClientAuthFlow;
  } catch {
    return null;
  }
}

export function clearClientAuthFlow(flowId: string): void {
  sessionStorage.removeItem(storageKey(flowId));
}
