/**
 * T3o (T3O-139): one amber line per worker and provider at its quota threshold, so a stall
 * that holds the whole board isn't hidden in per-card pills. Gone once the reading drops.
 */
import type {
  BoardCardShell,
  BoardWorkerCapacitySnapshot,
  BoardWorkerId,
  BoardWorkersState,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../../components/ui/button";
import { boardEnvironment } from "../../state/board";
import { boardWorkerLabel } from "./cardWorker";
import { boardQuotaBannerEntries, boardQuotaResetClock } from "./boardQuotaBanner.logic";

type BoardQuotaView = ReadonlyMap<string, Pick<BoardWorkerCapacitySnapshot, "providers">>;

/** Each worker's providers at their quota threshold, the board server's included. */
export function useBoardQuotaView(environmentId: EnvironmentId): BoardQuotaView {
  return useAtomValue(boardEnvironment.quotaAtom(environmentId));
}

export function BoardQuotaBanner(props: {
  readonly capacity: BoardQuotaView;
  readonly cards: ReadonlyArray<Pick<BoardCardShell, "workerId" | "queuedBy" | "queuedDetail">>;
  readonly workers: BoardWorkersState;
}) {
  const navigate = useNavigate();
  const entries = boardQuotaBannerEntries(props.capacity, props.cards, props.workers);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-3 pt-2 sm:px-5">
      {entries.map((entry) => {
        const worker = boardWorkerLabel(entry.workerId as BoardWorkerId, props.workers);
        const windows = entry.windows
          .map(
            (window) =>
              `${window.window} at ${window.percent}%${
                window.resetsAt === null ? "" : `, resets ${boardQuotaResetClock(window.resetsAt)}`
              }`,
          )
          .join(" · ");
        return (
          <div
            key={`${entry.workerId}:${entry.providerInstanceId}`}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl border border-warning/30 bg-warning/8 px-4 py-2.5"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-board-13 font-medium text-board-amber-text">
                {`${worker} takes no new ${entry.provider} cards: ${windows}`}
              </span>
              <span className="text-xs text-pretty text-muted-foreground">
                {entry.held === 0
                  ? "No card here is waiting on it."
                  : `${entry.held} card${entry.held === 1 ? "" : "s"} held; each starts by itself after the reset, or now with Start now.`}
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/board/workers" })}
            >
              Workers
            </Button>
          </div>
        );
      })}
    </div>
  );
}
