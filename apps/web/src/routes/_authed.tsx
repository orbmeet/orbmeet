import { createFileRoute } from "@tanstack/react-router";
import { resolveSessionGate } from "@/modules/identity/client/auth-gate";
import { lazy } from "react";

const AuthedLayout = import.meta.env.SSR ? () => null : lazy(() => import("@/app/shell/authed-layout").then((page) => ({ default: page.AuthedLayout })));
const AuthedErrorComponent = import.meta.env.SSR ? () => null : lazy(() => import("@/app/shell/authed-layout").then((page) => ({ default: page.AuthedErrorComponent })));

export const Route = createFileRoute("/_authed")({
  ssr: "data-only",
  beforeLoad: async ({ context, location }) => {
    return resolveSessionGate(context, location);
  },
  component: AuthedLayout,
  errorComponent: AuthedErrorComponent,
});
