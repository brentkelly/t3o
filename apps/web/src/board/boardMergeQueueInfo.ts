/**
 * T3o: the merge queue's copy (T3O-128): a card whose conflict fix or branch update waits for
 * another card's on the same base. Neutral like every queue wait: the board wakes it on its own.
 */
import type { BoardCardShell } from "@t3tools/contracts";

import type { BoardQueueInfo } from "./boardQueueInfo";

/** The head a queued card most likely waits behind: a live conflict fix in the same project. The
    shell carries no base branch, so on a project with several bases this is a best guess. */
function likelyHead(
  card: Pick<BoardCardShell, "cardId" | "projectId" | "stage">,
  cards: ReadonlyArray<BoardCardShell>,
): string | null {
  return (
    cards.find(
      (other) =>
        other.cardId !== card.cardId &&
        other.projectId === card.projectId &&
        other.stage === card.stage &&
        other.archivedAt === null &&
        other.stepConflictFix,
    )?.key ?? null
  );
}

export function boardMergeQueueInfo(input: {
  readonly card: Pick<BoardCardShell, "cardId" | "projectId" | "stage" | "mergeQueued">;
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly running: number;
  /** The base branch, which only the card modal knows. */
  readonly baseRef?: string | null | undefined;
}): BoardQueueInfo | null {
  if (input.card.mergeQueued !== true) return null;
  const base = input.baseRef == null || input.baseRef === "" ? "its base" : input.baseRef;
  const head = likelyHead(input.card, input.cards);
  return {
    position: 1,
    total: 1,
    ahead: 0,
    running: input.running,
    startsNext: false,
    label: "Queued · merge queue",
    headline: "Waiting in the merge queue",
    detail:
      head === null
        ? `Waiting for another card's conflict fix on ${base}. This card tries its merge again when that one merges, stops, or waits on you.`
        : `Waiting behind ${head}, which is resolving conflicts with ${base}. This card tries its merge again when that one merges, stops, or waits on you.`,
    forceStartHint:
      "Try the merge now and resolve this card's conflicts alongside the card ahead of it.",
  };
}
