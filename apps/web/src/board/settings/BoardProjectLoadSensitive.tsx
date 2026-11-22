/**
 * T3o (T3O-129): a project's load-sensitive list on its CI tab. Tests that flaked on a busy
 * machine, which CI scripts may defer to the nightly; each expires on its own, and a person
 * can take one off or clear the list.
 */
import {
  BOARD_CI_LOAD_SENSITIVE_MAX,
  boardLiveLoadSensitive,
  boardLoadSensitiveExpiresAtMs,
  type BoardProjectLoadSensitiveEntry,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { useNowMinute } from "../../hooks/useNowMinute";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { useBoardSettingsContext } from "./BoardSettingsLayout";

const DAY_MS = 24 * 60 * 60_000;

export function BoardProjectLoadSensitive(props: {
  readonly projectId: ProjectId;
  /** The full config's list; null while it loads. */
  readonly entries: ReadonlyArray<BoardProjectLoadSensitiveEntry> | null;
}) {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const remove = useAtomCommand(boardEnvironment.removeProjectLoadSensitive, {
    reportFailure: false,
  });
  const [confirmClear, setConfirmClear] = useState(false);
  // Expiry is read on this client's clock, as the board reads it on its own.
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  if (props.entries === null) {
    return <p className="text-xs text-muted-foreground">Loading the list…</p>;
  }
  const live = boardLiveLoadSensitive(props.entries, `${nowMinute}:00.000Z`);
  const send = (input: { readonly keys: ReadonlyArray<string> } | { readonly all: true }) => {
    setConfirmClear(false);
    void remove({ environmentId, input: { projectId: props.projectId, ...input } }).then(
      (result) => {
        if (result._tag !== "Failure") return;
        boardToast({
          title: "Couldn't change the load-sensitive list",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
      },
    );
  };
  if (live.length === 0) {
    return <p className="text-xs text-muted-foreground">No tests are deferred under load.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {live.length} of {BOARD_CI_LOAD_SENSITIVE_MAX}
        </span>
        {live.length >= BOARD_CI_LOAD_SENSITIVE_MAX ? (
          <span>List full: the oldest entry is replaced by each new one.</span>
        ) : null}
        <span className="flex-1" />
        {canWrite && !confirmClear ? (
          <Button size="xs" variant="ghost" onClick={() => setConfirmClear(true)}>
            Clear all
          </Button>
        ) : null}
      </div>
      {confirmClear ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
          <span className="text-foreground">
            Clear the list? Every test runs under load again until it flakes there again.
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="destructive" onClick={() => send({ all: true })}>
            Clear all
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmClear(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
        {live.map((entry, index) => {
          const days = Math.max(
            1,
            Math.ceil((boardLoadSensitiveExpiresAtMs(entry) - nowMs) / DAY_MS),
          );
          return (
            <li
              key={entry.key}
              className={`flex items-center gap-3 px-3 py-2 ${index > 0 ? "border-t border-border" : ""}`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-board-12-5 break-all text-foreground">{entry.key}</span>
                <span className="text-board-11 text-muted-foreground">
                  Last flaked {formatRelativeTimeLabel(entry.lastFlakedAt, nowMs)} on{" "}
                  {entry.cardKey} · {entry.flakes} {entry.flakes === 1 ? "flake" : "flakes"} ·
                  expires in {days} {days === 1 ? "day" : "days"}
                </span>
              </div>
              {canWrite ? (
                <Button size="xs" variant="ghost" onClick={() => send({ keys: [entry.key] })}>
                  Remove
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
