import {
  BOARD_LOCAL_WORKER_ID,
  EnvironmentId,
  type BoardSyncedCard,
  type BoardWorkerId,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerStatus,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { WorkerConnections } from "../workers/WorkerConnections.ts";
import { BoardCapacityClient, BoardCapacityClientLive } from "./BoardCapacityClient.ts";
import { BoardWorkerCapacity } from "./BoardWorkerCapacity.ts";

const W1 = EnvironmentId.make("worker-1");
const listed = (cardId: string) => ({ cardId }) as unknown as BoardSyncedCard;

const snapshotWith = (email: string) =>
  ({
    providers: [{ instanceId: "claude", account: { status: "signed-in", email } }],
  }) as unknown as BoardWorkerCapacitySnapshot;

interface Answers {
  hang: boolean;
  seqs?: Array<number>;
  status?: Partial<BoardWorkerStatus>;
  refreshed?: Array<string>;
  refreshHang?: boolean;
}

const layer = (answers: Answers) =>
  BoardCapacityClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.succeed(BoardWorkerCapacity, {
          subscribe: () => Stream.never,
          refreshAccounts: () =>
            answers.refreshHang
              ? Effect.never
              : Effect.sync(() => {
                  answers.refreshed?.push("local");
                  return snapshotWith("local@example.com");
                }),
        } as never),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-board")),
        } as never),
        Layer.succeed(WorkerConnections, {
          states: Stream.never,
          current: Effect.sync(
            () =>
              new Map([
                [
                  W1,
                  {
                    status: { state: "online", protocolVersion: 7, ...answers.status },
                    snapshot: null,
                  },
                ],
              ]),
          ),
          get: () =>
            Effect.succeed({
              gateway: {
                refreshAccounts: () =>
                  Effect.sync(() => {
                    answers.refreshed?.push("worker-1");
                    return snapshotWith("remote@example.com");
                  }),
                syncCards: (input: { readonly seq: number }) => {
                  answers.seqs?.push(input.seq);
                  return answers.hang ? Effect.never : Effect.void;
                },
              },
            }),
        } as never),
      ),
    ),
  );

it.effect(
  "a sync the worker leaves unanswered reports false, even after an earlier one landed",
  () => {
    const answers = { hang: false };
    return Effect.gen(function* () {
      const client = yield* BoardCapacityClient;
      assert.isTrue(yield* client.syncCards(W1, Effect.succeed([])));
      answers.hang = true;
      const pending = yield* client
        .syncCards(W1, Effect.succeed([listed("a")]))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      assert.isFalse(yield* Fiber.join(pending));
      // The worker still holds the earlier sync's baseline.
      assert.isTrue(yield* client.synced(W1));
    }).pipe(Effect.provide(layer(answers)));
  },
);

it.effect(
  "a sync's seq is taken before it reads the board, so a provision read later outranks it",
  () => {
    const answers = { hang: false, seqs: [] as Array<number> };
    return Effect.gen(function* () {
      const client = yield* BoardCapacityClient;
      let provisionSeq = 0;
      // A provision stamps its claim while the sync is still reading the board.
      const read = Effect.gen(function* () {
        provisionSeq = yield* client.nextSeq(W1);
        return [listed("a")];
      });
      assert.isTrue(yield* client.syncCards(W1, read));
      assert.isBelow(answers.seqs[0]!, provisionSeq);
      // An unchanged read sends nothing, and the seq it skipped never lowers a later one.
      assert.isTrue(yield* client.syncCards(W1, Effect.succeed([listed("a")])));
      assert.strictEqual(answers.seqs.length, 1);
      assert.isAbove(yield* client.nextSeq(W1), provisionSeq + 1);
    }).pipe(Effect.provide(layer(answers)));
  },
);

it.effect("refreshing accounts publishes the worker's fresh snapshot, and refuses what can't", () =>
  Effect.gen(function* () {
    const rows: ReadonlyArray<{
      readonly name: string;
      readonly workerId: BoardWorkerId;
      readonly status?: Partial<BoardWorkerStatus>;
      readonly email?: string;
      readonly error?: string;
    }> = [
      { name: "local", workerId: BOARD_LOCAL_WORKER_ID, email: "local@example.com" },
      { name: "remote", workerId: W1, email: "remote@example.com" },
      { name: "offline", workerId: W1, status: { state: "offline" }, error: "not-online" },
      { name: "old protocol", workerId: W1, status: { protocolVersion: 6 }, error: "invalid" },
      { name: "unknown", workerId: EnvironmentId.make("worker-9"), error: "not-found" },
    ];
    for (const row of rows) {
      const answers: Answers = {
        hang: false,
        refreshed: [],
        ...(row.status ? { status: row.status } : {}),
      };
      yield* Effect.gen(function* () {
        const client = yield* BoardCapacityClient;
        const result = yield* client.refreshAccounts(row.workerId).pipe(Effect.result);
        if (row.error !== undefined) {
          assert.isTrue(result._tag === "Failure", row.name);
          assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, row.error);
          assert.deepStrictEqual(answers.refreshed, [], row.name);
          return;
        }
        assert.isTrue(result._tag === "Success", row.name);
        assert.strictEqual(
          result._tag === "Success" ? result.success[0]?.account.email : null,
          row.email,
        );
        const latest = yield* client.latest(row.workerId);
        assert.strictEqual(latest?.providers[0]?.account.email, row.email, row.name);
      }).pipe(Effect.provide(layer(answers)));
    }
  }),
);

it.effect(
  "a local account refresh that hangs gives up after a minute, as a remote one does",
  () => {
    const answers: Answers = { hang: false, refreshHang: true };
    return Effect.gen(function* () {
      const client = yield* BoardCapacityClient;
      const pending = yield* client
        .refreshAccounts(BOARD_LOCAL_WORKER_ID)
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("60 seconds");
      const result = yield* Fiber.join(pending);
      assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, "internal");
    }).pipe(Effect.provide(layer(answers)));
  },
);
