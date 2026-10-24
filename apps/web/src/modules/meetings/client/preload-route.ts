import type { AnyRoute } from "@tanstack/react-router";

type MeetingRoutePreloader = {
  loadRouteChunk: (route: AnyRoute) => Promise<void> | undefined;
  routesByPath: {
    "/$code"?: AnyRoute;
  };
};

export function preloadMeetingRoute(router: MeetingRoutePreloader) {
  const meetingRoute = router.routesByPath["/$code"];
  if (!meetingRoute) {
    return Promise.resolve();
  }

  const routesToLoad = [meetingRoute.parentRoute, meetingRoute].filter(
    (route): route is AnyRoute => Boolean(route),
  );

  return Promise.all(
    routesToLoad.map((route) => router.loadRouteChunk(route) ?? Promise.resolve()),
  ).then(() => undefined);
}
