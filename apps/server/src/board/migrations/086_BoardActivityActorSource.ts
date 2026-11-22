// T3o: an agent's write to another card records the card it came from and, across workers, the
// worker it ran on (T3O-114). NULL on every older row and on every row not written that way.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_card_activity)`;
  if (!columns.some((column) => column.name === "actor_source_card_key")) {
    yield* sql`ALTER TABLE board_card_activity ADD COLUMN actor_source_card_key TEXT`;
  }
  if (!columns.some((column) => column.name === "actor_source_worker_id")) {
    yield* sql`ALTER TABLE board_card_activity ADD COLUMN actor_source_worker_id TEXT`;
  }
});
