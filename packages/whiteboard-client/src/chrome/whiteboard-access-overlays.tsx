import { ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { boardAction, boardActionRow } from "../styles/board";
import { WhiteboardModal } from "./whiteboard-modal";

const styles = stylex.create({
  dropzone: {
    position: "absolute",
    inset: 0,
    zIndex: boardZIndex.dropzone,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // `primary-*` aliased the grey ramp, so this tint was never blue.
    backgroundColor: `color-mix(in oklab, ${neutral.n500} 20%, transparent)`,
    backdropFilter: "blur(4px)",
    // Visual only: tldraw's canvas has to receive the drop.
    pointerEvents: "none",
  },
  dropcard: {
    backgroundColor: surface.raised,
    borderRadius: radii.card,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: neutral.n500,
    paddingInline: space.s8,
    paddingBlock: space.s6,
    boxShadow: shadows.lift3,
  },
  dropTitle: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  dropHint: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n600,
  },

});

interface WhiteboardAccessOverlaysProps {
  isDraggingOver: boolean;
  canDropContent: boolean;
  showClearPageDialog: boolean;
  showDeletePageDialog: boolean;
  /**
   * Which page the delete dialog is about, when it is not the current one.
   *
   * The rail can name any page in the document, so "the page being deleted"
   * and "the page you are standing on" stopped being the same thing.
   */
  deletePageNumber?: number | null;
  currentPage: number;
  onCancelClearPage: () => void;
  onConfirmClearPage: () => void;
  onCancelDeletePage: () => void;
  onConfirmDeletePage: () => void;
}

export function WhiteboardAccessOverlays({
  isDraggingOver,
  canDropContent,
  showClearPageDialog,
  showDeletePageDialog,
  deletePageNumber = null,
  currentPage,
  onCancelClearPage,
  onConfirmClearPage,
  onCancelDeletePage,
  onConfirmDeletePage,
}: WhiteboardAccessOverlaysProps) {
  return (
    <>
      {/* Visual-only drag overlay — pointer-events-none so tldraw's canvas receives the drop */}
      {isDraggingOver && canDropContent && (
        <div {...stylex.props(styles.dropzone)}>
          <div {...stylex.props(styles.dropcard)}>
            <p {...stylex.props(styles.dropTitle)}>Drop image here</p>
            <p {...stylex.props(styles.dropHint)}>Drop an image file or an image URL</p>
          </div>
        </div>
      )}

      {/* A reader asks to edit from the board's controls; managers approve
          through the meeting's permission tray (see use-meeting-whiteboard),
          the one surface for every request type. */}

      {/* Delete page confirmation dialog */}
      {showDeletePageDialog && (
        <WhiteboardModal
          alert
          title={`Delete page ${deletePageNumber ?? currentPage}?`}
          description={
            <>
              This will permanently remove page {deletePageNumber ?? currentPage}{" "}
              and all its content. This cannot be undone for other participants.
            </>
          }
          onDismiss={onCancelDeletePage}
        >
          <div {...stylex.props(boardActionRow.base)}>
            <button
              type="button"
              onClick={onCancelDeletePage}
              {...stylex.props(boardAction.base, boardAction.outline)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmDeletePage}
              {...stylex.props(boardAction.base, boardAction.danger)}
            >
              Delete
            </button>
          </div>
        </WhiteboardModal>
      )}

      {/* Clear page confirmation dialog */}
      {showClearPageDialog && (
        <WhiteboardModal
          alert
          title={`Clear page ${currentPage}?`}
          description={
            <>
              This will remove all drawings on this page and cannot be
              undone for other participants.
            </>
          }
          onDismiss={onCancelClearPage}
        >
          <div {...stylex.props(boardActionRow.base)}>
            <button
              type="button"
              onClick={onCancelClearPage}
              {...stylex.props(boardAction.base, boardAction.outline)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmClearPage}
              {...stylex.props(boardAction.base, boardAction.danger)}
            >
              Clear
            </button>
          </div>
        </WhiteboardModal>
      )}
    </>
  );
}
