import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { Editor } from "tldraw";
import {
  ASSISTANT_EVENTS,
  audienceKey,
  type AssistantAudience,
  type AssistantAudienceRequest,
  type AssistantEntry,
  type AssistantEvent,
  type AssistantRequest,
  type AssistantRun,
  type AssistantSnapshot,
} from "@orbmeet/whiteboard-core/assistant";
import { WHITEBOARD_SYNC_ROUTES } from "@orbmeet/whiteboard-core/protocol";
import { isRecord } from "@orbmeet/primitives";
import { useCommittedRef } from "@orbmeet/ui/react";
import { whiteboardSyncUrl } from "../sync/service-endpoints";
import type { RoomChannel } from "../sync/room-channel";
import type { PageManager } from "../pages/page-manager";
import { capturePageOutline, capturePromptContext, runCanvasTool } from "./canvas-tools";

const REQUEST_TIMEOUT_MS = 15_000;

export interface UseAssistantOptions {
  /** The room's messages; the assistant reads its own events from them. */
  channel: RoomChannel;
  enabled: boolean;
  whiteboardUrl: string;
  /** Latest whiteboard JWT. */
  tokenRef: RefObject<string>;
  userId: string | null;
  editor: Editor | null;
  pageManagerRef: RefObject<PageManager | null>;
  /** Clearing the conversation is a whiteboard-manager action on the server too. */
  canManageWhiteboard: boolean;
  syncReady: boolean;
  syncOnline: boolean;
  /**
   * The presenter this participant is following and the page they are on,
   * while they follow one. The page sent with a question is that page: a view
   * that drifted (a phone's fit, a scroll) must not change which page the
   * assistant thinks the room is on.
   */
  followingRef?: RefObject<{ presenterName: string; pageNumber: number } | null>;
}

export interface AssistantPromptOptions {
  /** Who sees the question and the answer. Absent: the room. */
  audience?: AssistantAudienceRequest;
  /** What was said in the meeting lately, as "Name: words" lines. */
  said?: string;
}

export interface Assistant {
  panelOpen: boolean;
  openPanel(): void;
  closePanel(): void;
  available: boolean;
  /** Connected, with a model: questions can be sent. */
  live: boolean;
  /** Every conversation this participant is in: the room's and their private ones. */
  entries: AssistantEntry[];
  /** The room's conversation alone. */
  roomEntries: AssistantEntry[];
  /** The room's run. */
  run: AssistantRun | null;
  /** Every run this participant can see, the room's included. */
  runs: AssistantRun[];
  canPrompt: boolean;
  canCancel: boolean;
  canClear: boolean;
  /** Resolves to an error to show, or null once the request is accepted. */
  prompt(text: string, options?: AssistantPromptOptions): Promise<string | null>;
  /** Stops the run named, or the room's. */
  cancel(runId?: string): void;
  /** Whether this participant may stop a run: the asker or a manager in the room, anyone in a private one. */
  mayCancel(run: AssistantRun): boolean;
  clear(): void;
}

/** The conversations and the ways to take part, for a host that shows them itself. */
export type AssistantView = Pick<Assistant, "available" | "live" | "entries" | "runs" | "prompt" | "cancel" | "mayCancel"> & {
  /**
   * Whether Orb may draw for this participant: they can write on the board.
   * Orb answers anyone else in words, so a host that teaches Orb says so.
   */
  canDraw: boolean;
  /** Brings what Orb drew into view on this viewer's board. */
  showShapes(pageId: string, ids: readonly string[]): void;
  /** Takes back what Orb drew; resolves to an error to show, or null. */
  removeShapes(ids: readonly string[]): string | null;
};

/**
 * A host that shows the conversation in its own UI — a meeting's Timeline —
 * instead of the board's panel. The board still keeps the conversation in
 * sync and carries out the canvas tools.
 */
export interface AssistantHost {
  /** Called whenever the conversation changes, and with null when the board goes away. */
  onChange(assistant: AssistantView | null): void;
}

/**
 * The board assistant as one participant sees it. The conversation lives on
 * the sync server; this mirrors it, sends this participant's requests, and
 * carries out the canvas tool calls the server routes to this browser when
 * this participant was the one who asked.
 */
export function useAssistant({
  channel,
  enabled,
  whiteboardUrl,
  tokenRef,
  userId,
  editor,
  pageManagerRef,
  canManageWhiteboard,
  syncReady,
  syncOnline,
  followingRef,
}: UseAssistantOptions): Assistant {
  const [panelOpen, setPanelOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ available: boolean; entries: AssistantEntry[]; runs: AssistantRun[] }>({
    available: false,
    entries: [],
    runs: [],
  });
  const editorRef = useCommittedRef(editor);

  const send = useCallback(
    (request: AssistantRequest) =>
      fetch(whiteboardSyncUrl(whiteboardUrl, WHITEBOARD_SYNC_ROUTES.assistant), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenRef.current}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    [tokenRef, whiteboardUrl],
  );

  // The conversation as of now, on mount and after every reconnect; live
  // events keep it current from there.
  useEffect(() => {
    if (!enabled || !syncReady) return;
    const controller = new AbortController();
    fetch(whiteboardSyncUrl(whiteboardUrl, WHITEBOARD_SYNC_ROUTES.assistant), {
      headers: { Authorization: `Bearer ${tokenRef.current}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (isSnapshot(body)) setSnapshot({ available: body.available, entries: body.entries, runs: snapshotRuns(body) });
      })
      .catch(() => {
        // Live events still arrive; the next reconnect retries.
      });
    return () => controller.abort();
  }, [enabled, syncReady, tokenRef, whiteboardUrl]);

  const handleServerEvent = useCallback(
    (message: AssistantEvent) => {
      if (!enabled) return;
      switch (message.type) {
        case ASSISTANT_EVENTS.SNAPSHOT: {
          // The room's conversation was cleared; private ones are untouched.
          const room = message.snapshot;
          if (!isSnapshot(room)) return;
          setSnapshot((current) => ({
            available: room.available,
            entries: [...current.entries.filter((entry) => !isRoom(entry.audience)), ...room.entries],
            runs: [...current.runs.filter((run) => !isRoom(run.audience)), ...(room.run ? [room.run] : [])],
          }));
          return;
        }
        case ASSISTANT_EVENTS.ENTRY: {
          // Typed by the union, but off the wire: checked before it is kept.
          const entry: AssistantEntry | undefined = message.entry;
          if (!isRecord(entry) || typeof entry.id !== "string") return;
          setSnapshot((current) => ({ ...current, entries: upsert(current.entries, entry) }));
          // Someone asked in the room: show everyone the conversation.
          if (entry.kind === "prompt" && isRoom(entry.audience)) setPanelOpen(true);
          return;
        }
        case ASSISTANT_EVENTS.RUN: {
          const key = audienceKey(message.audience);
          const run = message.run ?? null;
          setSnapshot((current) => ({
            ...current,
            runs: [...current.runs.filter((candidate) => audienceKey(candidate.audience) !== key), ...(run ? [run] : [])],
          }));
          return;
        }
        case ASSISTANT_EVENTS.TOOL_CALL: {
          const { runId, callId, pageId, tool, args }: Record<string, unknown> = message;
          if (typeof runId !== "string" || typeof callId !== "string" || typeof pageId !== "string") return;
          const currentEditor = editorRef.current;
          void (async () => {
            const outcome = currentEditor
              ? await runCanvasTool(currentEditor, pageId, tool, args)
              : { ok: false, text: "The whiteboard is not ready." };
            await send({ type: "tool-result", runId, callId, ...outcome }).catch(() => {
              // The server times the call out and tells the model.
            });
          })();
          return;
        }
      }
    },
    [editorRef, enabled, send],
  );

  useEffect(() => {
    const subscriptions = [
      channel.on(ASSISTANT_EVENTS.SNAPSHOT, handleServerEvent),
      channel.on(ASSISTANT_EVENTS.ENTRY, handleServerEvent),
      channel.on(ASSISTANT_EVENTS.RUN, handleServerEvent),
      channel.on(ASSISTANT_EVENTS.TOOL_CALL, handleServerEvent),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [channel, handleServerEvent]);

  const prompt = useCallback(
    async (text: string, options: AssistantPromptOptions = {}): Promise<string | null> => {
      const currentEditor = editorRef.current;
      const pages = pageManagerRef.current;
      if (!currentEditor || !pages) return "The whiteboard is not ready.";
      const following = followingRef?.current ?? null;
      const pageCount = pages.getPages().length;
      const pageNumber =
        following && following.pageNumber <= pageCount ? following.pageNumber : pages.getCurrentPage();
      const pageId = pages.getPageByNumber(pageNumber)?.id;
      const captured = pageId && (await capturePromptContext(currentEditor, pageId, pageNumber, pageCount));
      if (!captured) return "The whiteboard is not ready.";
      const page = {
        ...captured,
        ...(following ? { following } : {}),
        outline: capturePageOutline(currentEditor, pages.getPages().map((entry) => entry.id)),
      };
      try {
        const response = await send({ type: "prompt", text, page, audience: options.audience, said: options.said });
        if (response.ok) return null;
        if (response.status === 409) {
          const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
          return body?.error === "That person is not on the board"
            ? "They aren't on the board right now, so the assistant can't answer the two of you."
            : "The assistant is busy with another request.";
        }
        if (response.status === 429) return "Too many requests. Try again in a few minutes.";
        if (response.status === 503) return "The assistant is not available on this server.";
        if (response.status === 413) return "This page is too large to send to the assistant.";
        return "The request could not be sent.";
      } catch {
        return "The request could not be sent. Check your connection.";
      }
    },
    [editorRef, followingRef, pageManagerRef, send],
  );

  const cancel = useCallback((runId?: string) => void send({ type: "cancel", runId }).catch(() => {}), [send]);
  const clear = useCallback(() => void send({ type: "clear" }).catch(() => {}), [send]);

  const live = enabled && syncReady && syncOnline && snapshot.available;
  const mayCancel = useCallback(
    (run: AssistantRun) => live && (!isRoom(run.audience) || run.requesterUserId === userId || canManageWhiteboard),
    [canManageWhiteboard, live, userId],
  );
  const roomEntries = useMemo(() => snapshot.entries.filter((entry) => isRoom(entry.audience)), [snapshot.entries]);
  const run = snapshot.runs.find((candidate) => isRoom(candidate.audience)) ?? null;
  return {
    panelOpen: enabled && panelOpen,
    openPanel: useCallback(() => setPanelOpen(true), []),
    closePanel: useCallback(() => setPanelOpen(false), []),
    available: snapshot.available,
    live,
    entries: snapshot.entries,
    roomEntries,
    run,
    runs: snapshot.runs,
    canPrompt: live && run === null,
    canCancel: run !== null && mayCancel(run),
    canClear: live && canManageWhiteboard && run === null && roomEntries.length > 0,
    prompt,
    cancel,
    mayCancel,
    clear,
  };
}

function isRoom(audience: AssistantAudience | undefined): boolean {
  return !audience || audience.kind === "room";
}

/** A server from before private conversations sends the room's run alone. */
function snapshotRuns(snapshot: AssistantSnapshot): AssistantRun[] {
  return snapshot.runs ?? (snapshot.run ? [snapshot.run] : []);
}

function upsert(entries: AssistantEntry[], entry: AssistantEntry): AssistantEntry[] {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

function isSnapshot(value: unknown): value is AssistantSnapshot {
  return isRecord(value) && typeof value.available === "boolean" && Array.isArray(value.entries);
}
