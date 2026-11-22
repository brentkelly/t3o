import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { refuseBoardOwnedMerge } from "./prMergeGuard.ts";

const database = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-merge-guard-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const NOW = "2026-11-22T00:00:00.000Z";
const CARD_PR = "https://github.com/acme/app/pull/42";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO boards.board_cards (card_id, project_id, title, created_at, updated_at, pull_request)
    VALUES ('card-1', 'proj', 'Card', ${NOW}, ${NOW}, ${JSON.stringify({ number: 42, url: CARD_PR })})
  `;
  yield* sql`
    INSERT INTO boards.board_card_thread_links (thread_id, card_id, role, linked_at, tombstoned_at)
    VALUES ('card-thread', 'card-1', 'building', ${NOW}, NULL),
           ('retired-thread', 'card-1', 'planning', ${NOW}, ${NOW})
  `;
  yield* sql`
    INSERT INTO boards.board_relayed_threads (thread_id, central_environment_id, created_at)
    VALUES ('relayed-thread', 'central', ${NOW})
  `;
});

const refused = (threadId: string, url: string) =>
  refuseBoardOwnedMerge(threadId, url).pipe(
    Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }),
  );

describe("refuseBoardOwnedMerge", () => {
  it.effect("refuses a card's threads and any thread naming a card's PR", () =>
    Effect.gen(function* () {
      yield* seed;
      const other = "https://github.com/acme/app/pull/7";
      for (const threadId of ["card-thread", "retired-thread", "relayed-thread"]) {
        assert.include(yield* refused(threadId, other), "The board merges");
      }
      assert.include(yield* refused("plain-thread", `${CARD_PR.toUpperCase()}/`), "The board");
      assert.isNull(yield* refused("plain-thread", other));
    }).pipe(Effect.provide(database)),
  );

  it.effect("fails closed when the board cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DETACH DATABASE boards`;
      assert.include(yield* refused("plain-thread", CARD_PR), "Couldn't confirm");
    }).pipe(Effect.provide(database)),
  );

  it.effect("fails closed with no database at all", () =>
    Effect.gen(function* () {
      assert.include(yield* refused("plain-thread", CARD_PR), "Couldn't confirm");
    }),
  );
});
