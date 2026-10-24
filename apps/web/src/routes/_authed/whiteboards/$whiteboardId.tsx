import { createFileRoute, isNotFound, isRedirect, notFound } from "@tanstack/react-router";
import { getServerErrorCode } from "@/lib/error-inspection";
import { createPageHead } from "@/lib/seo";
import {
  standaloneWhiteboardAccessQueryOptions,
  whiteboardQueryOptions,
} from "@/app/query-client/queries/whiteboards";
import { lazy } from "react";

const WhiteboardDocumentPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/whiteboards/whiteboard-document-page").then((page) => ({ default: page.WhiteboardDocumentPage })));

export const Route = createFileRoute("/_authed/whiteboards/$whiteboardId")({
  // Goes through the QueryClient like every other loader in the app: the router
  // is configured with `defaultPreloadStaleTime: 0`, so Query's staleTime is the
  // only thing standing between a hover and a round trip.
  loader: async ({ context, params }) => {
    if (!params.whiteboardId.trim()) throw notFound();
    try {
      // The access token authorizes the board's first asset and upload, so it
      // is fetched beside the document rather than serially after first paint.
      // `prefetchQuery` swallows its own errors: only the document fetch owns
      // this route's 404/error semantics, and the component's `useQuery` keeps
      // surfacing access failures in place exactly as before.
      const [document] = await Promise.all([
        context.queryClient.fetchQuery(
          whiteboardQueryOptions(params.whiteboardId),
        ),
        context.queryClient.prefetchQuery(
          standaloneWhiteboardAccessQueryOptions(params.whiteboardId),
        ),
      ]);
      return document;
    } catch (error) {
      // Only absence (and FORBIDDEN, which is deliberately indistinguishable
      // from absence so the route is not an existence oracle) becomes a 404.
      // The query is `retry: false`, so catching everything would render
      // "Page not found" for an expired session or a transient 5xx — telling
      // the user the Whiteboard does not exist, with no retry affordance.
      // Everything else goes to the error boundary, like meetings/$meetingId.
      if (isRedirect(error) || isNotFound(error)) throw error;
      const code = getServerErrorCode(error);
      if (code === "NOT_FOUND" || code === "FORBIDDEN") throw notFound();
      throw error;
    }
  },
  head: ({ loaderData }) => createPageHead({
    title: `${loaderData?.title ?? "Whiteboard"} — Orb Meet`,
    description: "Open and edit this Whiteboard.",
    noindex: true,
    canonical: false,
  }),
  // The route stays active when only the path param changes, and TanStack
  // Router preserves active component instances by default. A Whiteboard owns
  // document-scoped React state and a tldraw sync store, so carrying that
  // instance across ids can attach the previous document's local store to the
  // next document's credentials.
  remountDeps: ({ params }) => params.whiteboardId,
  component: WhiteboardDocumentPage,
});
