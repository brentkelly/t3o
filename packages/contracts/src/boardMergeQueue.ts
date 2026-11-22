/**
 * T3o: the merge queue (T3O-128). Conflict fixes and branch updates on one project + base run one
 * at a time: a fix started while another card's holds that base waits, queued, until that card
 * merges or stops. Derived from the board, never stored apart from each card's `mergeStay`. No I/O.
 */
import {
  boardCardMergeStayCounts,
  boardCardPriorityRank,
  boardCardStepState,
  boardStageWithRole,
  boardThreadLinkWorkerId,
  boardCardEffectivePriority,
  isBoardTerminalStepStatus,
  type BoardCard,
  type BoardState,
} from "./board.ts";
import type { BoardWorkerId } from "./boardWorkers.ts";

/** How many times one stay re-runs a fix because the base moved under the last one. */
export const BOARD_MERGE_QUEUE_FOLLOW_UP_LIMIT = 10;

/** What a queue is keyed by: only cards merging into the same base can stale each other. */
export interface BoardMergeQueueKey {
  readonly projectId: BoardCard["projectId"];
  readonly baseRefName: string;
}

export function boardMergeQueueKeyOf(
  card: Pick<BoardCard, "projectId" | "worktree">,
): BoardMergeQueueKey | null {
  const baseRefName = card.worktree?.baseRefName ?? null;
  return baseRefName === null ? null : { projectId: card.projectId, baseRefName };
}

/** One string per key, for maps. */
export function boardMergeQueueKeyString(key: BoardMergeQueueKey): string {
  return `${key.projectId}\u0000${key.baseRefName}`;
}

/** The live cards sitting in the merge-role stage on this key. */
function cardsOnKey(board: BoardState, key: BoardMergeQueueKey): ReadonlyArray<BoardCard> {
  const mergeStageId = boardStageWithRole(board, "merge")?.stageId ?? null;
  if (mergeStageId === null) return [];
  return board.cards.filter(
    (card) =>
      card.archivedAt === null &&
      card.stage === mergeStageId &&
      card.projectId === key.projectId &&
      card.worktree?.baseRefName === key.baseRefName,
  );
}

/** Step statuses that wait on someone else, so the card lets its base go. */
const RELEASING_STEP_STATUSES = new Set(["awaiting-input", "stalled", "paused"]);

/**
 * The cards holding this key's base: each started a conflict fix or branch update this stay, and
 * has not merged, been hard-held, stopped to wait on a human, or gone offline since.
 */
export function boardMergeQueueHeads(
  board: BoardState,
  key: BoardMergeQueueKey,
  options: {
    /** A step on an unreachable worker lets go of its base. The web leaves it out. */
    readonly workerUnreachable?: (workerId: BoardWorkerId) => boolean;
    /**
     * Whether a card with no live step still waits on its own merge: armed, or a human's merge
     * riding the retry ladder. Absent counts every such card, which is what the web shows.
     */
    readonly mergeStillPending?: (card: BoardCard) => boolean;
  } = {},
): ReadonlyArray<BoardCard> {
  return cardsOnKey(board, key).filter((card) => {
    if (boardCardMergeStayCounts(card).fixBaseTip === null) return false;
    if (card.pullRequest?.state === "merged") return false;
    if (card.autoMergeHold !== null && card.autoMergeHold.retryAt === null) return false;
    const step = boardCardStepState(board, card.id);
    const live = step !== null && !isBoardTerminalStepStatus(step.status);
    if (live) {
      if (RELEASING_STEP_STATUSES.has(step.status)) return false;
      const link =
        step.threadId === null
          ? undefined
          : card.threadLinks.find((candidate) => candidate.threadId === step.threadId);
      if (
        link !== undefined &&
        options.workerUnreachable?.(boardThreadLinkWorkerId(link)) === true
      ) {
        return false;
      }
      return true;
    }
    return options.mergeStillPending?.(card) ?? true;
  });
}

/** The cards queued on this key, in the order they are woken: priority, queued time, then drag
    order. */
export function boardMergeQueueOrder(
  board: BoardState,
  key: BoardMergeQueueKey,
): ReadonlyArray<BoardCard> {
  return [...cardsOnKey(board, key)]
    .filter((card) => boardCardMergeStayCounts(card).queuedAt !== null)
    .sort((a, b) => {
      const priorityDelta =
        boardCardPriorityRank(boardCardEffectivePriority(b)) -
        boardCardPriorityRank(boardCardEffectivePriority(a));
      if (priorityDelta !== 0) return priorityDelta;
      const at = (card: BoardCard) => boardCardMergeStayCounts(card).queuedAt ?? "";
      if (at(a) !== at(b)) return at(a) < at(b) ? -1 : 1;
      return a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0;
    });
}
