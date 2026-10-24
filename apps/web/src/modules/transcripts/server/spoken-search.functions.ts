import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, pageLimitSchema, searchTextSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { searchMySpokenLinesImpl } from "./spoken-search.server";

/**
 * The shortest text worth looking for in what was said. Every search reads
 * each line of every meeting the viewer can open, so a letter or two — which
 * matches nearly every line anyway — is not searched at all.
 */
export const MIN_SPOKEN_SEARCH_LENGTH = 3;

const searchMySpokenLinesSchema = v.object({
  search: v.pipe(searchTextSchema, v.minLength(MIN_SPOKEN_SEARCH_LENGTH)),
  scope: v.optional(v.picklist(["all", "personal", "spaces"]), "all"),
  spaceId: v.optional(idSchema),
  /** Only meetings that started at or after this instant, in epoch milliseconds. */
  since: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  limit: pageLimitSchema(12, 30),
});

/** Lines spoken in the viewer's past meetings that contain the search text. */
export const searchMySpokenLines = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(searchMySpokenLinesSchema))
  .handler(async ({ data, context }) => {
    return searchMySpokenLinesImpl({ data, context });
  });

export type SearchMySpokenLinesInput = v.InferOutput<typeof searchMySpokenLinesSchema>;
