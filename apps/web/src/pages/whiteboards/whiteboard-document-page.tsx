import { getRouteApi } from "@tanstack/react-router";
import * as React from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, Check, Copy, History, MoreHorizontal, Pencil, PenTool } from "lucide-react";
import { resolveWhiteboardChrome, SyncedWhiteboard } from "@orbmeet/whiteboard-client/react";
import type { WhiteboardToast } from "@orbmeet/whiteboard-client/react";
import {
  addStandaloneWhiteboardPage,
  getStandaloneWhiteboardAccess,
} from "@/modules/whiteboards/server/standalone.functions";
import { standaloneWhiteboardAccessQueryOptions } from "@/app/query-client/queries/whiteboards";
import { archiveWhiteboard, duplicateWhiteboard, renameWhiteboard } from "@/modules/whiteboards/server/api.functions";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@orbmeet/ui/react";
import { WhiteboardHistoryPanel } from "@/modules/whiteboards/client/components/whiteboard-history-panel";
import { WHITEBOARD_ASSET_URLS } from "@/modules/whiteboards/client/surface/whiteboard-canvas";
import { Spinner } from "@orbmeet/ui/react";
import { getErrorMessage } from "@/lib/error-inspection";
import { queryKeys } from "@/app/query-client/query-keys";
import { Button } from "@orbmeet/ui/react";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@orbmeet/ui/react";
import { useToast } from "@orbmeet/ui/react";
import { useWhiteboardDocumentAssets } from "@/modules/whiteboards/client/components/use-whiteboard-document-assets";
import { WhiteboardUploadProgress } from "@/modules/whiteboards/client/components/whiteboard-upload-progress";
import { getWhiteboardClientCapabilities } from "@/lib/browser-capabilities";
import { useResponsive } from "@/lib/hooks/use-responsive";
import { dialogLayout } from "@orbmeet/ui/react";
import { focus, layout, motion, pressable, row } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { bp, env, safeArea } from "@orbmeet/ui/tokens/media.stylex";

const routeApi = getRouteApi("/_authed/whiteboards/$whiteboardId");

const styles = stylex.create({
  /**
   * The editor owns the whole viewport: the shell drops its gutters, phone
   * header and dock on this route, so the board gets every row the device has.
   * Safe-area padding keeps the header clear of the notch and the board clear
   * of the home indicator.
   */
  page: {
    // The board's chrome was drawn around light paper; it stays light until
    // the board has a dark design of its own.
    colorScheme: "light",
    display: "flex",
    height: "100dvh",
    flexDirection: "column",
    backgroundColor: surface.raised,
    paddingTop: safeArea.top,
    paddingBottom: safeArea.bottom,
  },
  header: {
    display: "flex",
    height: { default: 52, [bp.sm]: 56 },
    flexShrink: 0,
    alignItems: "center",
    gap: { default: space.s2, [bp.sm]: space.s3 },
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n200,
    paddingInline: { default: space.s2, [bp.sm]: space.s4 },
  },
  /** Decoration the phone header cannot afford. */
  wideOnly: { display: { default: "none", [bp.sm]: "flex" } },
  wideOnlyInline: { display: { default: "none", [bp.sm]: "inline" } },
  iconButton: {
    borderRadius: radii.field,
    padding: space.s2,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": ink.strong } },
  },
  documentGlyph: {
    display: "flex",
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: accent.a50,
    color: accent.a700,
  },
  titleBlock: { minWidth: 0, flexShrink: 1 },
  titleForm: { gap: space.s2 },
  titleInput: {
    height: 32,
    width: 256,
    maxWidth: "45vw",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n300, ":focus-visible": accent.a400 },
    paddingInline: space.s2,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)` },
  },
  saveTitle: {
    borderRadius: radii.field,
    padding: space.s1,
    color: accent.a700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a50 } },
  },
  titleButton: { maxWidth: { default: "100%", [bp.sm]: "18rem" }, minWidth: 0, gap: space.s2, padding: 0, borderWidth: 0, backgroundColor: "transparent", fontFamily: "inherit" },
  title: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  titleEditGlyph: {
    flexShrink: 0,
    color: neutral.n400,
    opacity: { default: 0, [env.hoverable]: { default: 0, [stylex.when.ancestor(":hover")]: 1 } },
  },
  context: { margin: 0, fontSize: text.xs, lineHeight: leading.xs, color: ink.muted },
  headerActions: { marginLeft: "auto", flexShrink: 0, gap: { default: space.s1, [bp.sm]: space.s2 } },
  duplicateError: { fontSize: text.xs, lineHeight: leading.xs, color: danger.d700 },
  historyButton: {
    gap: space.s1_5,
    borderRadius: radii.field,
    paddingInline: space.s2_5,
    paddingBlock: space.s1_5,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
  },
  historyIdle: {
    color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, ":hover": ink.strong } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  historyActive: { backgroundColor: accent.a50, color: accent.a800 },
  body: { position: "relative", display: "flex", minHeight: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  main: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  centered: { display: "flex", height: "100%", alignItems: "center", justifyContent: "center" },
  accessError: { paddingInline: space.s6, fontSize: text.sm, lineHeight: leading.sm, color: danger.d700 },
  canvas: { position: "relative", width: "100%", height: "100%" },
  archiveError: { marginTop: space.s3, marginBottom: 0, fontSize: text.sm, color: danger.d700 },
});

export function WhiteboardDocumentPage() {
  const document = routeApi.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = React.useState(document.title);
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  // A phone gets the compact board — thumb-sized tools, no page list beside
  // the page — as it does in a meeting. This page is a full editor in either
  // orientation, so never the meeting's upright annotate-only board.
  const { isPhone } = useResponsive();
  const chrome = React.useMemo(() => resolveWhiteboardChrome({ isPhone, isPhonePortrait: false }), [isPhone]);

  const renameMutation = useMutation({
    mutationFn: () => renameWhiteboard({ data: { whiteboardId: document.id, title } }),
    onSuccess: async (result) => {
      setTitle(result.title);
      setEditingTitle(false);
      queryClient.setQueryData(
        queryKeys.whiteboards.detail(document.id),
        (current: typeof document | undefined) => current
          ? { ...current, title: result.title }
          : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.whiteboards.list(),
          refetchType: "none",
        }),
        ...(document.spaceId
          ? [queryClient.invalidateQueries({
              queryKey: queryKeys.spaces.whiteboards(document.spaceId),
              refetchType: "none",
            })]
          : []),
      ]);
      await router.invalidate();
    },
  });

  // Duplicate lives here, on the document, rather than in the in-meeting
  // picker: it is a decision about a document, not about what a class is
  // looking at right now.
  const duplicateMutation = useMutation({
    mutationFn: () => duplicateWhiteboard({ data: { whiteboardId: document.id } }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.whiteboards.list(),
          refetchType: "none",
        }),
        ...(document.spaceId
          ? [queryClient.invalidateQueries({
              queryKey: queryKeys.spaces.whiteboards(document.spaceId),
              refetchType: "none",
            })]
          : []),
      ]);
      await navigate({
        to: "/whiteboards/$whiteboardId",
        params: { whiteboardId: result.whiteboardId },
      });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveWhiteboard({ data: { whiteboardId: document.id } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.whiteboards.list(),
          refetchType: "none",
        }),
        ...(document.spaceId
          ? [queryClient.invalidateQueries({
              queryKey: queryKeys.spaces.whiteboards(document.spaceId),
              refetchType: "none",
            })]
          : []),
      ]);
      await navigate({ to: "/library", search: { type: "boards" } });
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: queryKeys.whiteboards.detail(document.id),
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: queryKeys.whiteboards.standaloneAccess(document.id),
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: queryKeys.whiteboards.snapshots(document.id),
        }),
      ]);
      queryClient.removeQueries({
        queryKey: queryKeys.whiteboards.detail(document.id),
        exact: true,
      });
      queryClient.removeQueries({
        queryKey: queryKeys.whiteboards.standaloneAccess(document.id),
        exact: true,
      });
      queryClient.removeQueries({ queryKey: queryKeys.whiteboards.snapshots(document.id) });
    },
  });

  // A solo editing session: no Meeting, no connection, no surface to present
  // to. Authorization is Space membership alone. The route loader prefetches
  // this same query beside the document; on a cold load the entry is already
  // dehydrated into the client cache, so this rarely re-rolls the server fn.
  const access = useQuery(standaloneWhiteboardAccessQueryOptions(document.id));
  const {
    pdfLibrary,
    resolveAssetUrl,
    uploadFile,
    uploads,
  } = useWhiteboardDocumentAssets({
    whiteboardId: document.id,
  });
  const { add: addAppToast } = useToast();
  const handleWhiteboardToast = React.useCallback((toast: WhiteboardToast) => {
    addAppToast({
      title: toast.title,
      description: toast.description,
      data: { variant: toast.variant ?? "info" },
    });
  }, [addAppToast]);
  const handleAddPage = React.useCallback((target?: { afterPageNumber?: number }) => (
    addStandaloneWhiteboardPage({
      data: {
        whiteboardId: document.id,
        afterPageNumber: target?.afterPageNumber,
      },
    })
  ), [document.id]);

  // The first access request gets the page onto the canvas. Every WebSocket
  // attempt after that mints fresh standalone authority, so a long-lived editor
  // can reconnect after the one-hour JWT expires. Updating the query entry also
  // keeps asset and side-channel authorization aligned with the socket token.
  const getStandaloneWebSocketUri = React.useCallback(async () => {
    const refreshed = await getStandaloneWhiteboardAccess({
      data: { whiteboardId: document.id },
    });
    queryClient.setQueryData(
      queryKeys.whiteboards.standaloneAccess(document.id),
      refreshed,
    );
    const url = new URL("/connect", refreshed.whiteboardUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.hash = new URLSearchParams({ token: refreshed.token }).toString();
    return url.toString();
  }, [document.id, queryClient]);

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <button
          type="button"
          {...stylex.props(pressable.base, motion.tint, focus.ring, styles.iconButton)}
          onClick={() => window.history.back()}
          aria-label="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <span {...stylex.props(styles.documentGlyph, styles.wideOnly)}>
          <PenTool size={15} />
        </span>
        <div {...stylex.props(styles.titleBlock)}>
          {editingTitle ? (
            <form
              {...stylex.props(row.x2, styles.titleForm)}
              onSubmit={(event) => {
                event.preventDefault();
                if (title.trim()) renameMutation.mutate();
              }}
            >
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                {...stylex.props(styles.titleInput)}
              />
              <button type="submit" aria-label="Save title" {...stylex.props(pressable.base, motion.tint, focus.ring, styles.saveTitle)}>
                <Check size={15} />
              </button>
            </form>
          ) : (
            <button {...stylex.props(pressable.base, focus.ring, row.x2, stylex.defaultMarker(), styles.titleButton)} onClick={() => setEditingTitle(true)}>
              <h1 {...stylex.props(layout.truncate, styles.title)}>{title}</h1>
              <Pencil size={12} {...stylex.props(motion.tint, styles.titleEditGlyph)} />
            </button>
          )}
          {/* No label for a personal Space: its absence is what says "mine". */}
          {document.contextName ? (
            <p {...stylex.props(styles.context)}>{document.contextName}</p>
          ) : (
            <p {...stylex.props(styles.context)}>Personal Whiteboard</p>
          )}
        </div>
        <div {...stylex.props(row.x2, styles.headerActions)}>
          {duplicateMutation.error && (
            <span {...stylex.props(styles.duplicateError)} role="alert">
              {getErrorMessage(duplicateMutation.error)}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowHistory((open) => !open)}
            aria-pressed={showHistory}
            aria-label="History"
            {...stylex.props(
              pressable.base,
              motion.tint,
              focus.ring,
              row.x1,
              styles.historyButton,
              showHistory ? styles.historyActive : styles.historyIdle,
            )}
          >
            <History size={15} />
            <span {...stylex.props(styles.wideOnlyInline)}>History</span>
          </button>
          <MenuRoot>
            <MenuTrigger
              aria-label="Whiteboard actions"
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.iconButton)}
            >
              <MoreHorizontal size={18} />
            </MenuTrigger>
            <MenuContent>
              <MenuItem
                disabled={duplicateMutation.isPending}
                onClick={() => duplicateMutation.mutate()}
              >
                <Copy size={15} />
                Duplicate
              </MenuItem>
              {document.canManageLifecycle ? (
                <MenuItem onClick={() => setArchiveOpen(true)}>
                  <Archive size={15} />
                  Archive
                </MenuItem>
              ) : null}
            </MenuContent>
          </MenuRoot>
        </div>
      </header>
      <div {...stylex.props(styles.body)}>
        <main {...stylex.props(styles.main)}>
          {access.error ? (
            <div {...stylex.props(styles.centered, styles.accessError)}>
              {getErrorMessage(access.error)}
            </div>
          ) : !access.data ? (
            <div {...stylex.props(styles.centered)}>
              <Spinner size="lg" brand />
            </div>
          ) : (
            <div {...stylex.props(styles.canvas)}>
              <SyncedWhiteboard
                capabilities={getWhiteboardClientCapabilities()}
                licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
                whiteboardUrl={access.data.whiteboardUrl}
                documentId={document.id}
                token={access.data.token}
                getWebSocketUri={getStandaloneWebSocketUri}
                assetUrls={WHITEBOARD_ASSET_URLS}
                onAddPage={handleAddPage}
                onToast={handleWhiteboardToast}
                pdfLibrary={pdfLibrary}
                resolveAssetUrl={resolveAssetUrl}
                uploadFile={uploadFile}
                surfaceOverlay={<WhiteboardUploadProgress uploads={uploads} />}
                chrome={chrome}
              />
            </div>
          )}
        </main>
        {showHistory ? (
          <WhiteboardHistoryPanel
            whiteboardId={document.id}
            onClose={() => setShowHistory(false)}
          />
        ) : null}
      </div>
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Archive this Whiteboard?</DialogTitle>
            <DialogDescription>
              It will leave active lists and stop counting toward the Space limit. Its Meeting snapshots remain available, and you can restore it later.
            </DialogDescription>
            {archiveMutation.error ? (
              <p {...stylex.props(styles.archiveError)}>{getErrorMessage(archiveMutation.error)}</p>
            ) : null}
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" size="sm" />}>Cancel</DialogClose>
              <Button size="sm" loading={archiveMutation.isPending} onClick={() => archiveMutation.mutate()}>Archive</Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
