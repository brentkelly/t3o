// T3o: an agent-attached file records the path it came from and the hash of what was read, so a
// re-proposed plan replaces it rather than adding a copy (T3O-138). NULL on human uploads.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_card_attachments)`;
  if (!columns.some((column) => column.name === "source_path")) {
    yield* sql`ALTER TABLE board_card_attachments ADD COLUMN source_path TEXT`;
  }
  if (!columns.some((column) => column.name === "content_hash")) {
    yield* sql`ALTER TABLE board_card_attachments ADD COLUMN content_hash TEXT`;
  }
});
