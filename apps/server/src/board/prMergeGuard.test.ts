import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { boardMergeTarget, refuseBoardOwnedMerge } from "./prMergeGuard.ts";

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
    VALUES ('card-1', 'proj', 'Card', ${NOW}, ${NOW}, ${JSON.stringify({ number: 42, url: CARD_PR, headBranch: "board/card-1" })})
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

const unread = Effect.die("a URL match must not read the head branch");
const refused = (
  threadId: string,
  url: string,
  headBranch: Effect.Effect<string, unknown> = unread,
) =>
  refuseBoardOwnedMerge(threadId, [
    boardMergeTarget(url, Number(/(\d+)\/*$/.exec(url)?.[1]), headBranch),
  ]).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }));

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

  it.effect("a renamed repository's other name is matched by host, number and head branch", () =>
    Effect.gen(function* () {
      yield* seed;
      const renamed = "https://github.com/acme/renamed-app/pull/42";
      assert.include(
        yield* refused("plain-thread", renamed, Effect.succeed("board/card-1")),
        "The board merges",
      );
      assert.isNull(yield* refused("plain-thread", renamed, Effect.succeed("feature/other")));
      assert.isNull(yield* refused("plain-thread", "https://gitlab.com/acme/app/pull/42"));
      assert.isNull(yield* refused("plain-thread", "https://github.com/acme/renamed-app/pull/43"));
      assert.include(
        yield* refused("plain-thread", renamed, Effect.fail("forge down")),
        "Couldn't confirm",
      );
    }).pipe(Effect.provide(database)),
  );

  it.effect("checks every target, so a stack's lower card layer refuses", () =>
    Effect.gen(function* () {
      yield* seed;
      const top = "https://github.com/acme/app/pull/43";
      const layers = [43, 42].map((number) => boardMergeTarget(top, number, unread));
      const exit = yield* refuseBoardOwnedMerge("plain-thread", layers).pipe(Effect.flip);
      assert.include(exit.message, "The board merges");
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
