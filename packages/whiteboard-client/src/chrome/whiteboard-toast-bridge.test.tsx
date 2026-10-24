import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const tldrawAddToast = vi.fn();

// Only the toast channel is swapped — the overlays module graph needs the rest
// of tldraw's real exports (atoms, editor hooks) just to load.
vi.mock("tldraw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tldraw")>();
  return { ...actual, useToasts: () => ({ addToast: tldrawAddToast }) };
});

const { useWhiteboardToast } = await import("./use-whiteboard-toast");
const { WhiteboardToolbarContext } = await import("../toolbar/whiteboard-toolbar-context");
type ToolbarValue = React.ContextType<typeof WhiteboardToolbarContext>;

function renderWithToaster(
  onToast: ToolbarValue["onToast"],
  toast: Parameters<ReturnType<typeof useWhiteboardToast>>[0],
) {
  function Probe() {
    useWhiteboardToast()(toast);
    return null;
  }
  const value = {
    pageManager: null,
    currentPage: 1,
    pages: [],
    canEditWhiteboard: true,
    onToast,
  } as unknown as ToolbarValue;
  renderToStaticMarkup(
    <WhiteboardToolbarContext.Provider value={value}>
      <Probe />
    </WhiteboardToolbarContext.Provider>,
  );
}

describe("whiteboard toast bridge", () => {
  it("routes notifications to the host toaster, not tldraw's", () => {
    // The meeting mounts <Tldraw hideUi>, which removes the component that
    // renders tldraw's toasts. Anything left on that channel is invisible —
    // which is how a failed PDF import came to look like nothing happening.
    tldrawAddToast.mockClear();
    const hostToasts: unknown[] = [];

    renderWithToaster((toast) => hostToasts.push(toast), {
      title: "Import failed",
      description: "Failed to persist rendered PDF pages",
      variant: "error",
    });

    expect(hostToasts).toEqual([{
      title: "Import failed",
      description: "Failed to persist rendered PDF pages",
      variant: "error",
    }]);
    expect(tldrawAddToast).not.toHaveBeenCalled();
  });

  it("falls back to tldraw's toasts when no host toaster is injected", () => {
    // Consumers that render tldraw's default chrome have a working toast
    // renderer, so the fallback stays useful rather than dropping the message.
    tldrawAddToast.mockClear();

    renderWithToaster(undefined, {
      title: "Image imported",
      description: "Added photo.png to whiteboard",
      variant: "success",
    });

    expect(tldrawAddToast).toHaveBeenCalledWith({
      title: "Image imported",
      description: "Added photo.png to whiteboard",
    });
  });
});
