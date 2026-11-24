/**
 * T3o: the merge queue's copy (T3O-128): a card whose conflict fix or branch update waits for
 * another card's on the same base. Neutral like every queue wait: the board wakes it on its own.
 */
import type { BoardCardShell } from "@t3tools/contracts";

import type { BoardQueueInfo } from "./boardQueueInfo";

export function boardMergeQueueInfo(input: {
  readonly card: Pick<BoardCardShell, "mergeQueued">;
  readonly running: number;
  /** The base branch, which only the card modal knows. */
  readonly baseRef?: string | null | undefined;
}): BoardQueueInfo | null {
  if (input.card.mergeQueued !== true) return null;
  const base = input.baseRef == null || input.baseRef === "" ? "its base" : input.baseRef;
  return {
    position: 1,
    total: 1,
    ahead: 0,
    running: input.running,
    startsNext: false,
    label: "Queued · merge queue",
    headline: "Waiting in the merge queue",
    // The shell carries no base branch or blocker, so the card ahead goes unnamed rather than guessed.
    detail: `Waiting for another card's conflict fix on ${base}. This card tries its merge again when that one merges, stops, or waits on you.`,
    forceStartHint:
      "Try the merge now and resolve this card's conflicts alongside the card ahead of it.",
  };
}
