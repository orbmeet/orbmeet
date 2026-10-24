# Reshaping tables on D1

How to drop a column, change a CHECK, or otherwise rebuild a table without
losing rows. Two tests guard it:

- `apps/web/src/test/d1-migration-contract.d1.test.ts` replays every migration
  and fails if one drops a table another table still references. It also
  requires every migration to end with `PRAGMA optimize` and checks the result
  against the Drizzle schema.
- `apps/web/src/platform/database/d1-table-rebuild.d1.test.ts` pins the D1
  behaviour the procedure below relies on. If it fails, stop and re-read this
  before shipping a migration.

## The hazard

SQLite's documented rebuild — create `t_new`, copy, `DROP TABLE t`, rename — is
**not safe on D1 for any table another table references.** `DROP TABLE` runs an
implicit `DELETE FROM t`, and that fires `ON DELETE CASCADE` in every child,
recursively. D1 gives no way to switch this off inside a migration:

| Tried | Result on D1 |
|---|---|
| `PRAGMA defer_foreign_keys = on` | Defers constraint *checks*, not *actions*. Children are still deleted. |
| `PRAGMA foreign_keys = off` | Ignored inside a migration batch. Children are deleted. |
| `PRAGMA legacy_alter_table = on` | Ignored. Renaming the parent rewrites children to point at the old name. |

drizzle-kit's generated rebuild for SQLite uses exactly this pattern, and the
migration contract test rejects it for a referenced table. Generated SQL also
needs two fixes before it ships: it omits `NOT NULL` on text primary keys
(SQLite would then allow a NULL key), and it does not end with
`PRAGMA optimize`.

## Deploy order

`pnpm deploy` runs `check`, then `migrate`, then deploys the Worker, so every
migration runs while the **previous** code is still serving. A migration should
therefore work under that code:

- **Expand, then contract.** Add a column or table and switch the code to it
  in one release; drop what the old code used in a later one. Board edit
  grants moved this way: `meeting_authority` adds the admission column, and
  `whiteboard_edit_grants` is dropped by the next Meeting-table rebuild.
- **When that is not worth it, say so in the migration.** A change that breaks
  the old code for the seconds between `migrate` and the Worker deploy may be
  accepted when the failures are rare and retryable. Name what fails.
  `meeting_authority` does this: during that window, old code that writes an
  `owner` membership (creating a Space or a personal Space, transferring
  ownership) is refused by the new CHECK and succeeds on retry.

## Choose the cheapest safe operation

1. **Add a column, add an index, create a table:** plain `ALTER TABLE … ADD
   COLUMN` / `CREATE …`. Nothing is rebuilt.
2. **Drop a column that no table-level CHECK, index, foreign key or trigger
   names:** `ALTER TABLE t DROP COLUMN c` (drop any index on it first). Rows and
   children are untouched. Drizzle writes CHECKs as table-level constraints, so
   a column with a `check(...)` in the schema does **not** qualify.
3. **A table nothing references** (`SELECT` its dependents below; e.g.
   `space_members`): the standard rebuild is safe — create `t_new`, copy, drop
   `t`, rename, recreate indexes and triggers.
4. **Anything else:** rebuild the table **with its whole dependent subtree**
   (next section).

To list a table's dependents, walk the foreign keys in the latest
`drizzle/migrations/*/snapshot.json`. At the time of writing:

| Table | Tables that must be rebuilt with it |
|---|---|
| `space_members` | none |
| `meeting_whiteboards` | 2 |
| `meeting_admissions` | 4 (includes `transcripts`) |
| `whiteboards` | 9 |
| `meetings` | 16 (includes `transcripts`) |
| `meeting_links` | 18 |
| `spaces` | 26 |

Because a subtree rebuild copies every dependent table, **batch every reshape
of one table into a single rebuild.** Never ship two migrations that each
rebuild `meetings`.

## Subtree rebuild

One migration file, in this order:

1. `PRAGMA defer_foreign_keys = on;` so rows may reference tables that are
   mid-copy.
2. `CREATE TABLE x_new (…)` for the target and every dependent, with each
   foreign key pointing at the **`_new`** name of its parent.
3. `INSERT INTO x_new (cols…) SELECT cols… FROM x;` parents first. Always name
   columns; never `SELECT *`.
4. `DROP TABLE` the originals **leaves first**, so no drop has anything left to
   cascade into. Dropping a table also drops its indexes and triggers.
5. `ALTER TABLE x_new RENAME TO x;` for each. A rename rewrites the references
   other `_new` tables hold, so the foreign keys end up pointing at the final
   names.
6. Recreate every index (same names) and every trigger
   (`packages/db/src/triggers.ts`) on the renamed tables.

At commit, D1 checks every deferred foreign key. An orphan makes it reject the
whole batch and roll the database back to its last good state, so a wrong
rebuild fails loudly instead of committing broken data (pinned by the test).

## Proving it before production

1. Export production to a local file (`wrangler d1 export`). It contains user
   data: keep it on an encrypted disk, delete it afterwards.
2. Import it into a local D1, record `SELECT count(*)` for every table.
3. Apply the migration. Compare counts table by table (only intended changes
   may differ), run `PRAGMA foreign_key_check`, and time the migration.
4. If the copy of the largest table is too slow for one migration, plan a
   maintenance window: D1 serialises writes, so the app's writes wait or fail
   and retry while the migration runs.
