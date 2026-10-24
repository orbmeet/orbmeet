import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

// Most application reads use the SQL-like query builder. Supplying the schema
// here keeps the concise db.query API available for single-table reads without
// maintaining a second, unused relationship graph.
export const relations = defineRelations(schema);
