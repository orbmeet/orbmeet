import { drizzle } from "drizzle-orm/d1";
import { relations } from "./relations";

export function createDb(d1: Parameters<typeof drizzle>[0]) {
  // Drizzle's JIT mapper uses the Function constructor, which Workers disables.
  return drizzle(d1, { relations });
}

export type Database = ReturnType<typeof createDb>;

export { relations } from "./relations";
export * from "./schema";
