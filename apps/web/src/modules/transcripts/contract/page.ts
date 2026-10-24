/**
 * Shared transcript paging primitives. The transcript queries, their server
 * implementations, and the RPC validators all page with the same cursor, so
 * the shapes live in the contract layer.
 */
import * as v from "valibot";
import { integerSchema } from "@orbmeet/public-api-contract/fields";

export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 200;
export const MAX_TRANSCRIPT_PAGE_SIZE = 500;

export const transcriptCursorSchema = v.object({
  startedAt: integerSchema(1),
  id: v.pipe(v.string(), v.nonEmpty(), v.maxLength(80)),
});
