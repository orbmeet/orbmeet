import { env } from "cloudflare:workers";
import { TEST_WHITEBOARD_ENV } from "./fake-sync-server";

/** TEST_WHITEBOARD_ENV with the test's D1 binding, where commands find each board's node. */
export const TEST_WHITEBOARD_D1_ENV = { ...TEST_WHITEBOARD_ENV, DB: env.DB };
