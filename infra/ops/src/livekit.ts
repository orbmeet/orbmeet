import { EgressClient, RoomServiceClient } from "livekit-server-sdk";
import { rtcHost, type Inventory } from "./inventory.ts";
import { signingKey, type Secrets } from "./secrets.ts";

/** A node's LiveKit API at its public name, with the key the Worker signs with. */
export function liveKitApi(inv: Inventory, c: Secrets, name: string) {
  const [key, secret] = signingKey(c, name);
  const host = `https://${rtcHost(inv, name)}`;
  return { rooms: new RoomServiceClient(host, key, secret), egress: new EgressClient(host, key, secret) };
}

export interface Activity {
  rooms: number;
  recording: boolean;
}

/** What replacing the node's media services would interrupt: its live rooms and any recording. */
export async function activity(inv: Inventory, c: Secrets, name: string): Promise<Activity> {
  const api = liveKitApi(inv, c, name);
  const [rooms, active] = await Promise.all([api.rooms.listRooms(), api.egress.listEgress({ active: true })]);
  return { rooms: rooms.length, recording: active.length > 0 };
}
