/**
 * What a CI record does to the card and its pass rows. Pure: the
 * decider calls it for `board.card.record-ci` and folds the result into one
 * `board.card-ci-recorded` event.
 */
import {
  BOARD_CI_LAST_STEP_SKIP_REFUSAL,
  BOARD_CI_MAX_STEPS,
  BOARD_SEED_STAGE_IDS,
  boardCardCiSteps,
  boardCiMergeFlakyTitles,
  boardCiPassStepsFromSnapshot,
  boardCiShellFinding,
  isBoardCiStepFailure,
  isBoardCiPassSettledPhase,
  isBoardCiStepSkipped,
  type BoardCard,
  type BoardCardCi,
  type BoardCardCiRecordedPayload,
  type BoardCardRecordCiCommand,
  type BoardCiPassSettle,
} from "@t3tools/contracts";

export type BoardCiRecordResult =
  | { readonly ok: true; readonly payload: Omit<BoardCardCiRecordedPayload, "cardId" | "action"> }
  | { readonly ok: false; readonly refusal: string };

/** A held pass's reason rides every card shell, so it stays short. */
export const BOARD_CI_HOLD_REASON_CHARS = 400;

const refuse = (refusal: string): BoardCiRecordResult => ({ ok: false, refusal });

export function decideBoardCiRecord(
  card: BoardCard,
  command: BoardCardRecordCiCommand,
): BoardCiRecordResult {
  const at = command.createdAt;
  const action = command.action;
  const current = card.ci;
  const done = (
    next: Pick<BoardCard, "ci" | "ciLastOutcome"> & Partial<Pick<BoardCard, "ciRoundTrips">>,
    rest: Partial<Omit<BoardCardCiRecordedPayload, "cardId" | "action" | "card">> = {},
  ): BoardCiRecordResult => ({
    ok: true,
    payload: {
      card: { ...card, ...next, updatedAt: at },
      started: rest.started ?? null,
      settled: rest.settled ?? [],
      ...(rest.stepRow === undefined ? {} : { stepRow: rest.stepRow }),
      activity: rest.activity ?? null,
    },
  });

  switch (action.kind) {
    case "start-pass": {
      if (card.stage !== BOARD_SEED_STAGE_IDS.ci) {
        return refuse(`Card '${card.key}' is not in CI, so no CI pass can start.`);
      }
      if (action.steps.length === 0) return refuse("A CI pass needs at least one step.");
      // A fix's re-run only follows a pass still being fixed; one a
      // human stopped or restarted meanwhile stays as they left it.
      if (action.fixThreadId !== null && current?.phase !== "fixing") {
        return refuse(
          `Card '${card.key}' is no longer being fixed, so its fix's re-run can't start.`,
        );
      }
      const settled: BoardCiPassSettle[] = [];
      let activity: BoardCardCiRecordedPayload["activity"] = null;
      if (current !== null && current.runId !== action.runId) {
        // Only a fix agent's re-run is fixed in place; a human restart while
        // fixing replaces the pass like any other.
        if (current.phase === "fixing" && action.fixThreadId !== null) {
          settled.push({
            runId: current.runId,
            outcome: "fixed-in-place",
            finishedAt: at,
            fixThreadId: action.fixThreadId,
          });
          activity = { kind: "card-ci-pass-finished", ciOutcome: "fixed-in-place" };
        } else if (!isBoardCiPassSettledPhase(current.phase)) {
          settled.push({ runId: current.runId, outcome: "interrupted", finishedAt: at });
        }
      }
      const steps = boardCiPassStepsFromSnapshot(action.steps);
      const sameEntry = current !== null && current.entry === action.entry;
      // Round trips survive a send-back on the last outcome, and a human's
      // Retry CI starts them again.
      const roundTrips = action.fresh === true ? 0 : card.ciRoundTrips;
      // T3o (T3O-126): an entry's flaky checks and flaky tests carry across its passes.
      const carry = sameEntry && action.fresh !== true;
      const flakyChecks = carry ? (current.flakyChecks ?? 0) : 0;
      // T3o (T3O-130): a human's step skips last the whole entry.
      const skippedSteps = carry ? (current.skippedSteps ?? []) : [];
      // A ruling holds only while the code it was ruled on is unchanged.
      const flakyTitles =
        action.flakyRulingsStale === true
          ? []
          : boardCiMergeFlakyTitles(
              carry ? current.flakyTitles : undefined,
              action.flakyTitles ?? [],
            );
      const ci: BoardCardCi = {
        runId: action.runId,
        entry: action.entry,
        fixAttempts: sameEntry && action.fresh !== true ? current.fixAttempts : 0,
        maxFixAttempts: action.maxFixAttempts,
        phase: action.queued ? "queued" : "running",
        steps: boardCardCiSteps(steps),
        ...(roundTrips === 0 ? {} : { roundTrips }),
        ...(action.continueOnFailure === true ? { continueOnFailure: true } : {}),
        ...(flakyChecks === 0 ? {} : { flakyChecks }),
        ...(flakyTitles.length === 0 ? {} : { flakyTitles }),
        ...(skippedSteps.length === 0 ? {} : { skippedSteps }),
      };
      return done(
        { ci, ciLastOutcome: null, ciRoundTrips: roundTrips },
        {
          started: {
            runId: action.runId,
            cardId: card.id,
            entry: action.entry,
            ordinal: action.ordinal,
            startedAt: at,
            finishedAt: null,
            outcome: null,
            steps,
            logDir: action.logDir,
            fixThreadId: null,
            snapshot: action.steps,
            configVersion: action.configVersion ?? null,
          },
          settled,
          activity,
        },
      );
    }

    case "step": {
      if (
        current === null ||
        current.runId !== action.runId ||
        isBoardCiPassSettledPhase(current.phase)
      ) {
        // A late report from a pass already superseded, held or stopped:
        // its row still takes the step, the card does not.
        return done(
          { ci: current, ciLastOutcome: card.ciLastOutcome },
          { stepRow: { runId: action.runId, index: action.index, step: action.step } },
        );
      }
      const live = current.steps[action.index];
      if (live === undefined) {
        return refuse(`CI step ${action.index} does not exist on pass ${action.runId}.`);
      }
      // T3o (T3O-130): a skipped row is final. A late report from a cancelled runner, an
      // agent that lost the race, or a stale forge reading never brings it back.
      if (live.status === "skipped") {
        if (action.step.status !== "skipped") {
          return refuse(`CI step '${live.name}' was skipped, so it takes no more reports.`);
        }
        return done(
          { ci: current, ciLastOutcome: card.ciLastOutcome },
          {
            stepRow: {
              runId: action.runId,
              index: action.index,
              patch: { status: "skipped", finishedAt: live.finishedAt },
            },
          },
        );
      }
      const settledAlready = live.status !== "pending" && live.status !== "running";
      if (action.step.status === "skipped" && settledAlready) {
        return refuse(`CI step '${live.name}' has already finished, so it can't be skipped.`);
      }
      const terminal = action.step.status !== "pending" && action.step.status !== "running";
      // A marked step that started before its restart landed still ends skipped.
      const asSkipped =
        action.step.status === "skipped" || (terminal && isBoardCiStepSkipped(current, live));
      const { headline: _dropped, ...unheaded } = action.step;
      const row = {
        ...(asSkipped ? unheaded : action.step),
        ...(live.id === undefined ? {} : { id: live.id }),
        ...(asSkipped
          ? {
              status: "skipped" as const,
              finishedAt: action.step.finishedAt ?? at,
              note: action.step.note ?? "Skipped",
            }
          : {}),
      };
      const steps = current.steps.map((step, index) =>
        index === action.index ? boardCardCiSteps([row])[0]! : step,
      );
      // The card heads with its pass's first failing step.
      const headline = current.headline ?? (asSkipped ? undefined : action.step.headline);
      return done(
        {
          ci: {
            ...current,
            steps,
            phase: current.phase === "queued" && !asSkipped ? "running" : current.phase,
            ...(headline === undefined ? {} : { headline }),
          },
          ciLastOutcome: card.ciLastOutcome,
        },
        { stepRow: { runId: action.runId, index: action.index, step: row } },
      );
    }

    case "set-step-skip": {
      if (
        current === null ||
        current.runId !== action.runId ||
        (current.phase !== "queued" && current.phase !== "running")
      ) {
        return refuse(`Pass ${action.runId} is not running, so its steps can't be skipped.`);
      }
      const live = current.steps[action.index];
      if (live === undefined || live.id !== action.stepId) {
        return refuse(`CI step ${action.index} of pass ${action.runId} is not '${action.stepId}'.`);
      }
      const marks = current.skippedSteps ?? [];
      const marked = marks.includes(action.stepId);
      if (!action.skip) {
        if (live.status !== "pending" || !marked) {
          return refuse(`CI step '${live.name}' is not marked to skip.`);
        }
        const skippedSteps = marks.filter((id) => id !== action.stepId);
        const { skippedSteps: _marks, ...rest } = current;
        return done(
          {
            ci: skippedSteps.length === 0 ? rest : { ...current, skippedSteps },
            ciLastOutcome: card.ciLastOutcome,
          },
          {
            activity: { kind: "card-ci-step-skip", ciStepName: live.name, ciStepSkip: false },
          },
        );
      }
      if (live.status !== "running" && live.status !== "pending") {
        return refuse(`CI step '${live.name}' has already finished, so it can't be skipped.`);
      }
      const skippedSteps = marked
        ? marks
        : [...marks, action.stepId].slice(-BOARD_CI_MAX_STEPS);
      const running = live.status === "running";
      const steps = running
        ? current.steps.map((step, index) => {
            if (index !== action.index) return step;
            const { progress: _progress, silentSince: _silent, ...rest } = step;
            return { ...rest, status: "skipped" as const, finishedAt: at };
          })
        : current.steps;
      const next = { ...current, steps, skippedSteps };
      if (next.steps.every((step) => isBoardCiStepSkipped(next, step))) {
        return refuse(BOARD_CI_LAST_STEP_SKIP_REFUSAL);
      }
      return done(
        { ci: next, ciLastOutcome: card.ciLastOutcome },
        {
          ...(running
            ? {
                stepRow: {
                  runId: action.runId,
                  index: action.index,
                  patch: { status: "skipped", finishedAt: at, note: `Skipped by ${action.actor}` },
                },
              }
            : {}),
          activity: { kind: "card-ci-step-skip", ciStepName: live.name, ciStepSkip: true },
        },
      );
    }

    case "finish-pass": {
      const live = current !== null && current.runId === action.runId;
      // Stop CI and Retry run beside the serial worker, so a finish can
      // arrive for a pass already settled or replaced. Its row settles; the
      // card's pass is left alone.
      const settledAlready = live && isBoardCiPassSettledPhase(current.phase);
      const inCi = card.stage === BOARD_SEED_STAGE_IDS.ci && card.archivedAt === null;
      if (action.result === "passed") {
        if (!live) return refuse(`Pass ${action.runId} is not this card's current CI pass.`);
        if (settledAlready) {
          return done(
            { ci: current, ciLastOutcome: card.ciLastOutcome },
            { settled: [{ runId: action.runId, outcome: "passed", finishedAt: at }] },
          );
        }
        return done(
          { ci: { ...current, phase: "passed" }, ciLastOutcome: null },
          {
            settled: [{ runId: action.runId, outcome: "passed", finishedAt: at }],
            activity: { kind: "card-ci-pass-finished", ciOutcome: "passed" },
          },
        );
      }
      if (action.result === "failed") {
        return done(
          { ci: current, ciLastOutcome: card.ciLastOutcome },
          { settled: [{ runId: action.runId, finishedAt: at }] },
        );
      }
      // Interrupted (the pass could not run) or cancelled (the card left CI or
      // was archived): the row is settled. A card still live in CI is held,
      // its unfinished steps cancelled, until a human restarts or skips it.
      const outcome = action.result;
      if (inCi && (!live || settledAlready)) {
        return done(
          { ci: current, ciLastOutcome: card.ciLastOutcome },
          { settled: [{ runId: action.runId, outcome, finishedAt: at }] },
        );
      }
      const held =
        live && inCi
          ? {
              ...current,
              phase: "held" as const,
              steps: current.steps.map((step) =>
                step.status === "running" || step.status === "pending"
                  ? { ...step, status: "cancelled" as const }
                  : step,
              ),
              ...(action.reason === undefined
                ? {}
                : { stopReason: action.reason.slice(0, BOARD_CI_HOLD_REASON_CHARS).trimEnd() }),
              ...(action.machine === true ? { machine: true as const } : {}),
              ...(current.headline === undefined && action.headline !== undefined
                ? { headline: action.headline }
                : {}),
            }
          : null;
      return done(
        { ci: held, ciLastOutcome: card.ciLastOutcome },
        { settled: [{ runId: action.runId, outcome, finishedAt: at }] },
      );
    }

    case "begin-fix": {
      if (current === null || current.runId !== action.runId) {
        return refuse(`Pass ${action.runId} is not this card's current CI pass.`);
      }
      // A late failure of a pass already held or stopped starts no fix.
      if (current.phase !== "running") {
        return refuse(`Pass ${action.runId} is ${current.phase}, so no fix can start on it.`);
      }
      // T3o (T3O-126): a flaky-only check is uncounted, so it may run past the limit.
      if (action.triage === true) {
        return done({
          ci: {
            ...current,
            phase: "fixing",
            fixTriage: true,
            ...(action.fixIssues === undefined ? {} : { fixIssues: action.fixIssues }),
          },
          ciLastOutcome: card.ciLastOutcome,
        });
      }
      if (current.fixAttempts >= current.maxFixAttempts) {
        return refuse(`Card '${card.key}' has used all ${current.maxFixAttempts} CI fixes.`);
      }
      const { fixTriage: _counted, ...rest } = current;
      return done({
        ci: {
          ...rest,
          phase: "fixing",
          fixAttempts: current.fixAttempts + 1,
          ...(action.fixIssues === undefined ? {} : { fixIssues: action.fixIssues }),
        },
        ciLastOutcome: card.ciLastOutcome,
      });
    }

    case "flaky-resume": {
      // A human's Stop or Retry that landed first wins.
      if (current === null || current.runId !== action.runId || current.phase !== "fixing") {
        return refuse(`Pass ${action.runId} is not being fixed, so it can't carry on.`);
      }
      const {
        fixTriage,
        headline: _headline,
        fixIssues: _fixIssues,
        stopReason: _stopReason,
        ...rest
      } = current;
      return done(
        {
          ci: {
            ...rest,
            phase: "running",
            fixAttempts:
              fixTriage === true ? current.fixAttempts : Math.max(0, current.fixAttempts - 1),
            // Counts the fix agent's own rulings only; runner-reported flakes, under load
            // or load-sensitive (T3O-127), never feed the storm guard.
            flakyChecks: (current.flakyChecks ?? 0) + 1,
            flakyTitles: boardCiMergeFlakyTitles(current.flakyTitles, action.titles),
          },
          ciLastOutcome: card.ciLastOutcome,
        },
        { settled: [{ runId: action.runId, reopen: true }] },
      );
    }

    case "send-back": {
      const failed =
        action.stepName ??
        current?.steps.find((step) => isBoardCiStepFailure(step.status))?.name ??
        null;
      const fixAttemptsUsed = current?.fixAttempts ?? 0;
      const roundTrips = action.byHuman === true ? 0 : card.ciRoundTrips + 1;
      return done(
        {
          ci: null,
          ciLastOutcome: {
            kind: "sent-back",
            ...(failed === null ? {} : { stepName: failed }),
            fixAttemptsUsed,
            finding: boardCiShellFinding(action.finding),
            round: action.round,
          },
          ciRoundTrips: roundTrips,
        },
        {
          settled:
            action.runId === null
              ? []
              : [
                  {
                    runId: action.runId,
                    outcome: "sent-back",
                    finishedAt: at,
                    ...(action.fixThreadId === null ? {} : { fixThreadId: action.fixThreadId }),
                  },
                ],
          activity: {
            kind: "card-ci-sent-back",
            ...(failed === null ? {} : { ciStepName: failed }),
            ciFixAttempts: fixAttemptsUsed,
          },
        },
      );
    }

    case "stop": {
      if (current === null || card.stage !== BOARD_SEED_STAGE_IDS.ci) {
        return refuse(`Card '${card.key}' has no CI pass to stop.`);
      }
      const { fixTriage: _triage, ...stopped } = current;
      return done(
        {
          ci: { ...stopped, phase: "stopped", stopReason: boardCiShellFinding(action.reason) },
          ciLastOutcome: card.ciLastOutcome,
        },
        {
          settled:
            action.runId === null
              ? []
              : [
                  {
                    runId: action.runId,
                    outcome: "stopped",
                    finishedAt: at,
                    ...(action.fixThreadId === undefined
                      ? {}
                      : { fixThreadId: action.fixThreadId }),
                  },
                ],
          activity: { kind: "card-ci-stopped" },
        },
      );
    }

    case "skip": {
      if (card.stage !== BOARD_SEED_STAGE_IDS.ci) {
        return refuse(`Card '${card.key}' is not in CI, so there is nothing to skip.`);
      }
      return done(
        { ci: null, ciLastOutcome: { kind: "skipped", actor: action.actor } },
        {
          settled:
            current === null || isBoardCiPassSettledPhase(current.phase)
              ? []
              : [{ runId: current.runId, outcome: "skipped", finishedAt: at }],
          activity: { kind: "card-ci-skipped" },
        },
      );
    }
  }
}
