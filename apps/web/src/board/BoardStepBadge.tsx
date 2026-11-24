/**
 * The numbered step badge shared by CI and Code review, and a running step's
 * shimmer. Colours per `docs/t3o/status-colours.md`: green tick done, blue
 * running or being fixed, amber failure (an amber tick: passed over flakes).
 */
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";

import { ActivityShimmerOverlay } from "../components/chat/TimelineRowParts";
import { observeVisibleAnimation } from "../lib/visibleAnimation";
import { cn } from "../lib/utils";
import type { BoardStepBadgeState } from "./boardCi";

const STATE_LABEL: Record<BoardStepBadgeState, string> = {
  pending: "Pending",
  running: "Running",
  passed: "Done",
  failed: "Failed",
  fixing: "Failed, being fixed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  flaky: "Passed over flaky tests",
};

export function BoardStepBadge({
  index,
  state,
}: {
  readonly index: number;
  readonly state: BoardStepBadgeState;
}) {
  const mark =
    state === "passed"
      ? { className: "bg-success", icon: <CheckIcon className="size-[7px]" strokeWidth={4} /> }
      : state === "failed"
        ? { className: "bg-warning", icon: <XIcon className="size-[7px]" strokeWidth={4} /> }
        : state === "flaky"
          ? { className: "bg-warning", icon: <CheckIcon className="size-[7px]" strokeWidth={4} /> }
          : state === "fixing"
            ? { className: "bg-info", icon: <XIcon className="size-[7px]" strokeWidth={4} /> }
            : state === "cancelled" || state === "skipped"
              ? {
                  className: "bg-muted-foreground",
                  icon: <MinusIcon className="size-[7px]" strokeWidth={4} />,
                }
              : null;
  return (
    <span
      aria-label={`Step ${index}: ${STATE_LABEL[state]}`}
      role="img"
      className="relative inline-flex shrink-0"
      data-step-state={state}
    >
      <span
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full text-board-10 font-semibold",
          state === "running"
            ? "bg-info text-white"
            : state === "pending"
              ? "text-muted-foreground/70 shadow-board-inset-border"
              : "bg-foreground/8 text-foreground",
        )}
      >
        {index}
      </span>
      {mark === null ? null : (
        <span
          className={cn(
            "absolute -bottom-[3px] -left-[3px] inline-flex size-[11px] items-center justify-center rounded-full text-white shadow-board-badge-cutout",
            mark.className,
          )}
        >
          {mark.icon}
        </span>
      )}
    </span>
  );
}

/** A running step's name with the shared activity shimmer. The shimmer runs
    only while on screen, and not at all under reduced motion or forced
    colours (`live-activity-focus` in index.css). */
export function BoardShimmerText({
  text,
  active,
  className,
}: {
  readonly text: string;
  readonly active: boolean;
  readonly className?: string | undefined;
}) {
  return (
    <span
      ref={active ? observeVisibleAnimation : undefined}
      className={cn("relative min-w-0 overflow-hidden", className)}
    >
      {text}
      {active ? <ActivityShimmerOverlay>{text}</ActivityShimmerOverlay> : null}
    </span>
  );
}
