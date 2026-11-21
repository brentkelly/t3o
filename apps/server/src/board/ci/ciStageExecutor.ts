/**
 * The CI stage's executor. CI never sends a card back to review by itself: a
 * failed pass gets a fix agent while fixes are left, else stops for a human; a
 * `fixed` re-runs every step from the top, so a pass means the whole list
 * passed on one commit.
 */
import {
  BOARD_CI_MAX_FLAKY_CHECKS,
  BOARD_CI_SHELL_FINDING_MAX,
  boardCiFixStepId,
  boardCiShellFinding,
  boardCiHeadlineLead,
  boardModelSelectionOfOverride,
  composeBoardCiFixPrompt,
  decodeBoardCiAgentStepPayload,
  decodeBoardCiFixPayload,
  isBoardCiStageExecution,
  parseBoardCiAgentStepId,
  parseBoardCiFixStepId,
  type BoardCardCi,
  type BoardCiFixPayload,
} from "@t3tools/contracts";

import { boardCiFlakeCardTarget } from "./ciFlakeCards.ts";
import type {
  BoardCiFailure,
  BoardStageExecutor,
  BoardStagePlan,
  BoardStagePlanInput,
} from "../stageExecutor.ts";

/** How much of a failing step's output a send-back finding quotes. */
const FINDING_TAIL_LINES = 40;

function boardCiFailureFinding(failure: BoardCiFailure, tailLines: number): string {
  const ended =
    failure.status === "timed-out"
      ? "timed out"
      : `exited with code ${failure.exitCode ?? "unknown"}`;
  const tail = tailLines <= 0 ? "" : failure.tail.split("\n").slice(-tailLines).join("\n").trim();
  return [
    ...(failure.headline == null ? [] : [boardCiHeadlineLead(failure.headline)]),
    `CI step "${failure.stepName}" (\`${failure.command}\`) ${ended}.`,
    ...(tail.length === 0 ? [] : ["Last lines of its output:", "```", tail, "```"]),
  ].join("\n");
}

/**
 * A human's "Send back to review anyway" finding: a line naming
 * every failed step, then each failure with as much of its tail as lets the
 * whole fit `BOARD_CI_SHELL_FINDING_MAX`.
 */
export function boardCiSendBackFinding(failures: ReadonlyArray<BoardCiFailure>): string {
  const names = [...new Set(failures.map((failure) => failure.stepName))];
  const head = `CI failed at ${names.join(", ")}.`;
  const compose = (tailLines: number) =>
    [head, ...failures.map((failure) => boardCiFailureFinding(failure, tailLines))].join("\n\n");
  for (let lines = FINDING_TAIL_LINES; lines > 0; lines = Math.floor(lines / 2)) {
    const finding = compose(lines);
    if (finding.length <= BOARD_CI_SHELL_FINDING_MAX) return finding;
  }
  return boardCiShellFinding(compose(0));
}

/** The step an issue id (`s<index>` or `s<index>-<n>`) belongs to. */
function issueStepName(ci: BoardCardCi | null, issueId: string): string | null {
  const match = /^s(\d+)(?:-\d+)?$/.exec(issueId);
  if (match === null || ci === null) return null;
  return ci.steps[Number(match[1])]?.name ?? null;
}

function cannotFixStop(ci: BoardCardCi | null, verdict: BoardCiFixPayload): BoardStagePlan {
  const issue = verdict.issues?.find((entry) => entry.status === "cannot-fix");
  const stepName = issue === undefined ? null : issueStepName(ci, issue.id);
  const finding = verdict.finding.trim().replace(/\.$/, "");
  const why = finding.length > 0 ? finding : issue?.note?.trim().replace(/\.$/, "") || "";
  const what = stepName === null ? "something" : stepName;
  return {
    kind: "ci-stop",
    stepName,
    reason:
      why.length > 0
        ? `The fix agent couldn't fix ${what}: ${why}.`
        : `The fix agent couldn't fix ${what}.`,
  };
}

/** The step kind an issue id names, from the card's CI steps; null when unknown. */
function issueStepKind(ci: BoardCardCi | null, issueId: string) {
  const match = /^s(\d+)(?:-\d+)?$/.exec(issueId);
  if (match === null || ci === null) return null;
  return ci.steps[Number(match[1])]?.kind ?? "script";
}

/** T3o (T3O-126): a `flaky` verdict counts only when every issue is flaky, on a script step. */
function isAllFlaky(ci: BoardCardCi | null, verdict: BoardCiFixPayload): boolean {
  const issues = verdict.issues ?? [];
  return (
    issues.length > 0 &&
    issues.every(
      (issue) =>
        issue.status === "flaky" &&
        (issue.id === "more" || issueStepKind(ci, issue.id) === "script"),
    )
  );
}

function flakeStormReason(ci: BoardCardCi): string {
  return `Flake storm: ${ci.flakyTitles?.length ?? ci.flakyChecks ?? 0} tests flaked in one CI entry, past the ${BOARD_CI_MAX_FLAKY_CHECKS} flaky checks it allows.`;
}

function exhaustedReason(failures: ReadonlyArray<BoardCiFailure>, used: number): string {
  const names = [...new Set(failures.map((failure) => failure.stepName))].join(", ");
  if (used === 0) return `CI failed: ${names}.`;
  return `CI still failing after ${used} ${used === 1 ? "fix" : "fixes"}: ${names}.`;
}

export const CiStageExecutor: BoardStageExecutor = {
  planNext(input: BoardStagePlanInput): BoardStagePlan {
    const { card, config, runState } = input;
    const agentStep =
      runState.settledStepId === null ? null : parseBoardCiAgentStepId(runState.settledStepId);
    if (agentStep !== null) {
      const completion = input.completions.findLast(
        (candidate) => candidate.stepId === runState.settledStepId,
      );
      return {
        kind: "ci-agent-done",
        runId: agentStep.runId,
        index: agentStep.index,
        verdict:
          completion?.outcome === "succeeded"
            ? decodeBoardCiAgentStepPayload(completion.payload)
            : null,
      };
    }
    const settled =
      runState.settledStepId === null ? null : parseBoardCiFixStepId(runState.settledStepId);
    if (settled !== null) {
      const completion = input.completions.findLast(
        (candidate) => candidate.stepId === runState.settledStepId,
      );
      const verdict = decodeBoardCiFixPayload(completion?.payload ?? null);
      const flakyIssues = (verdict?.issues ?? []).filter((issue) => issue.status === "flaky");
      const triage = card.ci?.fixTriage === true;
      if (verdict !== null && verdict.verdict === "flaky" && isAllFlaky(card.ci, verdict)) {
        if (card.ci !== null && (card.ci.flakyChecks ?? 0) >= BOARD_CI_MAX_FLAKY_CHECKS) {
          return { kind: "ci-stop", stepName: null, reason: flakeStormReason(card.ci) };
        }
        return { kind: "ci-pass", flaky: true, flakyIssues };
      }
      // A flaky check can't fix: anything but an all-flaky verdict there needs a human.
      if (triage && (verdict?.verdict === "fixed" || verdict?.verdict === "flaky")) {
        return {
          kind: "ci-stop",
          stepName: null,
          reason: `CI still failing after ${card.ci?.fixAttempts ?? 0} fixes, and the flaky check found a real failure.`,
        };
      }
      if (verdict?.verdict === "fixed" || verdict?.verdict === "flaky") {
        return flakyIssues.length === 0 ? { kind: "ci-pass" } : { kind: "ci-pass", flakyIssues };
      }
      if (verdict === null) {
        return {
          kind: "ci-stop",
          stepName: null,
          reason: "The CI fix agent finished without a readable verdict.",
        };
      }
      return cannotFixStop(card.ci, verdict);
    }

    const failures = runState.ciFailures ?? null;
    if (failures === null || failures.length === 0) return { kind: "ci-pass" };

    const ci = card.ci;
    const exec = config.execution;
    const maxFixAttempts =
      ci?.maxFixAttempts ?? (isBoardCiStageExecution(exec) ? exec.maxFixAttempts : 0);
    const used = ci?.fixAttempts ?? 0;
    const flakyChecks = ci?.flakyChecks ?? 0;
    // T3o (T3O-126): past the fix limit, one uncounted flaky check still runs, so a flake on
    // the last pass never stops the card; agent and forge steps can't be flaky.
    const triage =
      ci !== null &&
      used >= maxFixAttempts &&
      flakyChecks < BOARD_CI_MAX_FLAKY_CHECKS &&
      failures.some(
        (failure) => failure.command !== "agent step" && failure.command !== "forge checks",
      );
    if (ci === null || (used >= maxFixAttempts && !triage)) {
      return {
        kind: "ci-stop",
        stepName: failures[0]!.stepName,
        reason:
          ci !== null && flakyChecks >= BOARD_CI_MAX_FLAKY_CHECKS
            ? flakeStormReason(ci)
            : exhaustedReason(failures, used),
      };
    }
    const attempt = used + 1;
    const notFlakyTitle = boardCiFlakeCardTarget(card);
    return {
      kind: "run",
      round: runState.round,
      // Unique across refunds and flaky checks: completions are never cleared.
      stepId: boardCiFixStepId(ci.entry, used + flakyChecks + 1),
      stepLabel: triage ? "CI flaky check" : `CI fix ${attempt} of ${maxFixAttempts}`,
      ...(triage ? { ciTriage: true as const } : {}),
      prompt: composeBoardCiFixPrompt({
        prompt: config.prompt,
        attempt,
        maxAttempts: maxFixAttempts,
        failures,
        issues: runState.ciIssues ?? [],
        ...(triage ? { triage: true } : {}),
        ...(notFlakyTitle === null ? {} : { notFlakyTitle }),
      }),
      model:
        config.cardOverride === null
          ? config.model
          : boardModelSelectionOfOverride(config.cardOverride),
      runtimeMode: config.cardOverride?.runtimeMode ?? config.runtimeMode,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      recordBaseTip: false,
    };
  },
};
