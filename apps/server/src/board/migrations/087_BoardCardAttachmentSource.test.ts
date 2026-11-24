/**
 * Board migration 087: attachments gain a nullable source path and content hash; an older
 * row reads both as NULL, and re-running changes nothing (T3O-138).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 87;

it.effect("adds nullable source_path and content_hash to attachments", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id >= MIGRATION_ID) break;
      yield* migration;
    }
    yield* sql`
      INSERT INTO board_card_attachments
        (attachment_id, card_id, name, type, mime_type, size_bytes, added_at)
      VALUES ('a1', 'c1', 'mock.html', 'file', 'text/html', 3, '2026-01-01T00:00:00.000Z')
    `;
    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 087 is registered in the lineage");
    yield* migration[2];
    const rows = yield* sql<{ readonly sourcePath: string | null; readonly hash: string | null }>`
      SELECT source_path AS "sourcePath", content_hash AS "hash" FROM board_card_attachments
    `;
    assert.deepStrictEqual(rows, [{ sourcePath: null, hash: null }]);
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
