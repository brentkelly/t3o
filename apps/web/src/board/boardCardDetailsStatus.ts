/**
 * T3o (T3O-134): the status a phone's Details-sheet button carries, so a card waiting on a
 * human is never hidden behind a closed sheet. Read off `boardCardAttention`'s tone, the
 * card face's own rule: violet needs you, amber blocked, a pause neutral
 * (docs/t3o/status-colours.md).
 */
import type { BoardCardAttention } from "@t3tools/contracts";

export type BoardCardDetailsStatus = "attention" | "blocked" | "paused";

export function boardCardDetailsStatus(
  attention: Pick<BoardCardAttention, "reason" | "tone"> | null,
  blocked: boolean,
): BoardCardDetailsStatus | null {
  if (attention?.tone === "attention") return "attention";
  if (attention?.tone === "warning" || blocked) return "blocked";
  if (attention?.reason === "paused") return "paused";
  return null;
}

export const BOARD_CARD_DETAILS_STATUS_LABEL: Record<BoardCardDetailsStatus, string> = {
  attention: "Needs you",
  blocked: "Blocked",
  paused: "Paused",
};
