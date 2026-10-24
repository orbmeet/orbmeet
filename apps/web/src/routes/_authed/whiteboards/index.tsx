import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Whiteboards used to be a page of its own. Boards now live in the Library
 * beside the meetings they came from; an old link lands on its boards. A
 * board's own address, `/whiteboards/$whiteboardId`, is unchanged.
 */
export const Route = createFileRoute("/_authed/whiteboards/")({
  beforeLoad: () => {
    throw redirect({ to: "/library", search: { type: "boards" }, replace: true });
  },
});
