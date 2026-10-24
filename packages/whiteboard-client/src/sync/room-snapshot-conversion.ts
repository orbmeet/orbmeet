import type { TLRecord, TLStoreSnapshot } from "tldraw";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";

export interface RoomSnapshotDocument {
  state: Record<string, unknown>;
  lastChangedClock?: number;
}

export interface RoomSnapshotForStoreConversion {
  documents: RoomSnapshotDocument[];
  schema: TLStoreSnapshot["schema"];
}

export function roomSnapshotToStoreSnapshot(
  roomSnapshot: RoomSnapshotForStoreConversion,
): TLStoreSnapshot {
  const entries = roomSnapshot.documents.flatMap((document) => {
    const id = document.state.id;
    return typeof id === "string" && id.length > 0
      ? [[id, document.state] as const]
      : [];
  });
  const store = Object.fromEntries(entries) as unknown as
    TLStoreSnapshot["store"] & Record<string, TLRecord>;
  const migrated = whiteboardTLSchema.migrateStoreSnapshot({
    schema: roomSnapshot.schema,
    store,
  });
  if (migrated.type !== "success") {
    throw new Error(`Whiteboard snapshot schema migration failed: ${migrated.reason}`);
  }

  return {
    schema: whiteboardTLSchema.serialize(),
    store: migrated.value,
  };
}
