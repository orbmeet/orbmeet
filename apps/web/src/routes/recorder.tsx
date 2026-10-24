import { createFileRoute } from "@tanstack/react-router";
import { createPageHead } from "@/lib/seo";
import { lazy } from "react";

const RecorderPage = import.meta.env.SSR ? () => null : lazy(() => import("@/pages/recorder/recorder-page").then((page) => ({ default: page.RecorderPage })));

export const Route = createFileRoute("/recorder")({
  ssr: false,
  head: () =>
    createPageHead({
      title: "Recorder — Orb Meet",
      description: "Internal recording surface for Orb Meet Meetings.",
      noindex: true,
      canonical: false,
    }),
  component: RecorderPage,
});
