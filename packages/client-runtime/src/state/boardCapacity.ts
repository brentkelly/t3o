/**
 * T3o: what each worker offers this board (T3O-86), from `board.workers.subscribeCapacity`.
 * Opened by the Workers page, the pin picker, the Resources tab, a queued card's detail and
 * the board itself, which reads only the quota slice (`boardQuotaView`) for its banner. Never
 * read per card: capacity changes far more often than the board does.
 */
import {
  BOARD_WORKERS_WS_METHODS,
  type BoardResourceProfile,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerProviderCapacity,
  type BoardWorkersCapacityActionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { request, subscribeDynamic } from "../rpc/client.ts";

/** A worker's snapshot, with what this board's own cards hold there when the board knows. */
export type BoardWorkerCapacityView = BoardWorkerCapacitySnapshot & {
  readonly held?: BoardResourceProfile;
};

export type BoardCapacityView = ReadonlyMap<string, BoardWorkerCapacityView>;

const EMPTY_BOARD_CAPACITY_VIEW: BoardCapacityView = new Map();

/** Every worker's latest snapshot, folded from the stream. */
export const boardCapacityViewStream = () =>
  subscribeDynamic(BOARD_WORKERS_WS_METHODS.subscribeCapacity, () => Effect.succeed({})).pipe(
    Stream.scan(
      (): BoardCapacityView => EMPTY_BOARD_CAPACITY_VIEW,
      (view, item): BoardCapacityView =>
        new Map(view).set(
          item.workerId,
          item.held === undefined ? item.snapshot : { ...item.snapshot, held: item.held },
        ),
    ),
  );

/** T3o (T3O-139): per worker, only its providers at their quota threshold. */
export type BoardQuotaView = ReadonlyMap<
  string,
  { readonly providers: ReadonlyArray<BoardWorkerProviderCapacity> }
>;

export const EMPTY_BOARD_QUOTA_VIEW: BoardQuotaView = new Map();

/**
 * The quota slice of the capacity view, `previous` itself while that slice is unchanged:
 * the board reads it, and a snapshot's headroom moves far more often than its quota.
 */
export function boardQuotaView(view: BoardCapacityView, previous: BoardQuotaView): BoardQuotaView {
  const next = new Map<
    string,
    { readonly providers: ReadonlyArray<BoardWorkerProviderCapacity> }
  >();
  for (const [workerId, snapshot] of view) {
    const providers = snapshot.providers
      .filter((provider) => provider.quota.exhausted)
      // `agents` ticks with every turn; nothing quota copy reads.
      .map((provider) => ({ ...provider, agents: { running: 0, max: null } }));
    if (providers.length > 0) next.set(workerId, { providers });
  }
  if (next.size === 0) return EMPTY_BOARD_QUOTA_VIEW;
  return JSON.stringify([...next]) === JSON.stringify([...previous]) ? previous : next;
}

/** Re-check readiness, or read a readiness or setup log. */
export const boardCapacityAction = (input: BoardWorkersCapacityActionInput) =>
  request(BOARD_WORKERS_WS_METHODS.capacityAction, input);
