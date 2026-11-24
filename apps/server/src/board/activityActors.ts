/**
 * Who caused a board event, stamped at the dispatch boundary and read by the
 * projector a fiber later, so it rides an in-process side channel keyed by
 * `commandId`. Best-effort: an unknown or post-restart stamp reads as
 * `BOARD_SYSTEM_ACTOR`, never an invented human.
 */
import {
  BOARD_SYSTEM_ACTOR,
  type BoardActivityActor,
  type BoardCardActivityPayload,
  type BoardCardId,
  type BoardWorkerId,
  type CommandId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";

/** Enough for any realistic in-flight burst; the map is a hand-off, not a
    store. Oldest entries are evicted first. */
const MAX_STAMPS = 512;

const stamps = new Map<string, BoardActivityActor>();

/**
 * Where an agent's write to other cards came from (T3O-114). Server-only: the projector turns
 * it into the actor's `sourceCardKey` / `sourceWorkerId` on the TARGET cards' rows only, so a
 * cascade onto descendants or ancestors, and the caller's own card, carry no source.
 */
export interface BoardActivitySource {
  /** The caller's own card; null for a schedule run, whose source therefore reaches a row
      only through `sourceWorkerId`, i.e. only on a cross-worker target. */
  readonly sourceCardId: BoardCardId | null;
  readonly sourceCardKey: string | null;
  readonly sourceWorkerId: BoardWorkerId;
  /** The cards the command names. */
  readonly targetCardIds: ReadonlyArray<BoardCardId>;
  /** The targets placed on a different worker than the caller. */
  readonly crossWorkerCardIds: ReadonlyArray<BoardCardId>;
  /** What a cross-worker write that records no row of its own is shown as. */
  readonly editKind?: NonNullable<BoardCardActivityPayload["editKind"]>;
}

const sources = new Map<string, BoardActivitySource>();

const remember = <V>(map: Map<string, V>, key: string, value: V) => {
  // Re-stamping moves the entry to the back of the FIFO, so a retried command
  // is not evicted while its first attempt's neighbours age out.
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_STAMPS) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
};

/** Record who is dispatching `commandId`. Called by a dispatch boundary
    immediately before `engine.dispatch`, so the stamp is present by the time the
    projector runs. */
export function stampBoardActivityActor(commandId: CommandId, actor: BoardActivityActor): void {
  remember(stamps, String(commandId), actor);
}

/** Record where an agent's write to other cards came from; see `BoardActivitySource`. */
export function stampBoardActivitySource(commandId: CommandId, source: BoardActivitySource): void {
  remember(sources, String(commandId), source);
}

/** The source stamped for an event's `commandId`, or null. */
function boardActivitySourceFor(
  commandId: CommandId | string | null | undefined,
): BoardActivitySource | null {
  if (commandId === null || commandId === undefined) return null;
  return sources.get(String(commandId)) ?? null;
}

/** The actor as a row for `cardId` shows it: the source fields only on a target that is not
    the caller's own card, and the worker only when that target is on another worker. */
export function boardActivityActorForCard(
  commandId: CommandId | string | null | undefined,
  cardId: BoardCardId,
): BoardActivityActor {
  const actor = boardActivityActorFor(commandId);
  const source = boardActivitySourceFor(commandId);
  if (source === null || source.sourceCardId === cardId || !source.targetCardIds.includes(cardId)) {
    return actor;
  }
  const crossWorker = source.crossWorkerCardIds.includes(cardId);
  return {
    ...actor,
    ...(source.sourceCardKey === null ? {} : { sourceCardKey: source.sourceCardKey }),
    ...(crossWorker ? { sourceWorkerId: source.sourceWorkerId } : {}),
  };
}

/** The actor for an event's `commandId`, or the system actor. Never evicts: one
    command may land several events, and all of them share its actor. */
export function boardActivityActorFor(
  commandId: CommandId | string | null | undefined,
): BoardActivityActor {
  if (commandId === null || commandId === undefined) return BOARD_SYSTEM_ACTOR;
  return stamps.get(String(commandId)) ?? BOARD_SYSTEM_ACTOR;
}

/** The agent actor for an MCP tool call. The display name and accent are
    resolved client-side from the provider instance, so a renamed instance
    relabels its own history rather than freezing a stale label on the row. */
export function boardAgentActor(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}): BoardActivityActor {
  return {
    kind: "agent",
    name: null,
    providerInstanceId: input.providerInstanceId,
    threadId: input.threadId,
  };
}

/** The human actor. `name` is frozen on the row at write time, so it stays
    correct after the project's git config changes. */
export function boardHumanActor(name: string): BoardActivityActor {
  return {
    kind: "human",
    name: name.trim().length > 0 ? name.trim() : BOARD_HUMAN_ACTOR_FALLBACK_NAME,
    providerInstanceId: null,
    threadId: null,
  };
}

/**
 * What a human is called when git has no identity. There is no user identity
 * anywhere in t3code — it is a single-user local server — so this is the whole
 * fallback ladder: the card's project git `user.name`, then this.
 */
export const BOARD_HUMAN_ACTOR_FALLBACK_NAME = "You";

/** Test hook: forget every stamp. Production never calls it. */
export function resetBoardActivityActors(): void {
  stamps.clear();
  sources.clear();
}

/** The kind a cross-worker write to `cardId` shows as on the rail when it records no row of
    its own, or null when the write is not cross-worker for that card. */
export function boardActivityCrossWorkerEditKind(
  commandId: CommandId | string | null | undefined,
  cardId: BoardCardId,
): NonNullable<BoardCardActivityPayload["editKind"]> | null {
  const source = boardActivitySourceFor(commandId);
  if (source?.editKind === undefined || source.sourceCardId === cardId) return null;
  return source.crossWorkerCardIds.includes(cardId) ? source.editKind : null;
}
