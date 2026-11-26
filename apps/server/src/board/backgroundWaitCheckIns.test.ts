/**
 * An agent waiting on its own background work is checked on, not nudged: at
 * +30 minutes, then every 60. The first two are free; later ones
 * spend the recovery budget and the one crossing a ceiling escalates. Each step
 * advances the TestClock and runs one sweep pass.
 */
import {
  BoardCardId,
  boardCardStepState,
  type BoardState,
  type ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  buildingCard,
  codexStep,
  movedToBuilding,
  settingsWith,
  turnCompleted,
  withGovernor,
  type Harness,
  type HarnessCommand,
} from "./supervisorHarness.testkit.ts";
import { fakeThreadState, type FakeThreadInput } from "./threadGateway.testkit.ts";

const CARD = "waiting";

type TodoRow = { readonly advancedAt: string | null };

const fixture = (threadTodos?: Map<string, TodoRow>) => ({
  board: { cards: [buildingCard(CARD, "m")], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
  ...(threadTodos === undefined ? {} : { threadTodos }),
});

/** The thread with no turn live — or mid-turn — and whatever background work
    the liveness registry reports. */
const shellOf = (
  threadId: ThreadId,
  backgroundWork: "working" | "monitoring" | null,
  sessionStatus: "idle" | "running" = "idle",
  extra: FakeThreadInput = {},
) => fakeThreadState(String(threadId), { sessionStatus, backgroundWork, ...extra });

const setShell = (
  shells: Harness["shells"],
  threadId: ThreadId,
  backgroundWork: "working" | "monitoring" | null,
  sessionStatus: "idle" | "running" = "idle",
) =>
  Ref.update(
    shells,
    (current) =>
      new Map([...current, [String(threadId), shellOf(threadId, backgroundWork, sessionStatus)]]),
  );

const stateOf = (board: BoardState) => boardCardStepState(board, BoardCardId.make(CARD));

/** Every turn the board drove into a thread — the spawn's first turn and
    every send after it. */
const turnTexts = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.spawn" || command.type === "thread.send" ? [command.text] : [],
  );
const checkInsOf = (commands: ReadonlyArray<HarnessCommand>) =>
  turnTexts(commands).filter((text) => text.includes("scheduled check-in")).length;
const stallNudgesOf = (commands: ReadonlyArray<HarnessCommand>) =>
  turnTexts(commands).filter((text) => text.includes("without calling board_complete_step")).length;
const recoveriesOf = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.filter((command) => command.type === "board.card.recover-step").length;

/** Start the card building and end its first turn with a monitor running. */
const startWaiting = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToBuilding(buildingCard(CARD, "m"), 1));
    const threadId = stateOf(yield* h.board)!.threadId!;
    yield* setShell(h.shells, threadId, "monitoring");
    yield* h.pumpRuntime(turnCompleted(threadId));
    return threadId;
  });

/** Advance the clock and run one sweep pass. */
const after = (h: Harness, minutes: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.minutes(minutes));
    yield* h.reactor.sweep;
    yield* h.reactor.drain;
  });

it.effect("check-ins go out at +30 and +90 free, then +150 charged", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* startWaiting(h);

      yield* after(h, 29);
      assert.strictEqual(checkInsOf(yield* h.commands), 0, "nothing before +30");

      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "+30");
      assert.include(turnTexts(yield* h.commands).at(-1)!, "the wait began about 30 minutes ago");
      yield* after(h, 59);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "nothing before +90");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 2, "+90");
      assert.include(turnTexts(yield* h.commands).at(-1)!, "the wait began about 90 minutes ago");

      const free = stateOf(yield* h.board);
      assert.strictEqual(free?.status, "running");
      assert.strictEqual(free?.stallCount, 0);
      assert.strictEqual(free?.attempt, 1);
      assert.strictEqual(free?.stageEntryRecoveries, 0);

      yield* after(h, 59);
      assert.strictEqual(checkInsOf(yield* h.commands), 2, "nothing before +150");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 3, "+150");

      const charged = stateOf(yield* h.board);
      assert.strictEqual(charged?.status, "running");
      assert.strictEqual(charged?.stallCount, 1);
      assert.strictEqual(charged?.attempt, 2);
      assert.strictEqual(charged?.stageEntryRecoveries, 1);

      const commands = yield* h.commands;
      assert.strictEqual(recoveriesOf(commands), 0);
      assert.strictEqual(stallNudgesOf(commands), 0, "the stall nudge never goes out");
    }),
  ),
);

it.effect("a check-in turn that ends still waiting keeps the schedule", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 30);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);

      // The agent checked, its monitor is still running, and it ended its turn.
      yield* h.pumpRuntime(turnCompleted(threadId));

      // The second check-in is still due at +90 from the START of the wait.
      yield* after(h, 60);
      assert.strictEqual(checkInsOf(yield* h.commands), 2);
      assert.strictEqual(recoveriesOf(yield* h.commands), 0);
    }),
  ),
);

it.effect("a wait that never ends escalates to a human once the ladder is spent", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* startWaiting(h);
      const maxAttempts = stateOf(yield* h.board)!.maxAttempts;
      // Two free check-ins, then one charged per hour until the next
      // would reach `maxAttempts` consecutive stalls.
      yield* after(h, 30);
      yield* after(h, 60);
      for (let charged = 1; charged < maxAttempts; charged++) {
        yield* after(h, 60);
        assert.strictEqual(stateOf(yield* h.board)?.status, "running");
        assert.strictEqual(stateOf(yield* h.board)?.stallCount, charged);
      }
      const sent = 2 + maxAttempts - 1;
      assert.strictEqual(checkInsOf(yield* h.commands), sent);

      yield* after(h, 60);
      const escalated = stateOf(yield* h.board);
      assert.strictEqual(escalated?.status, "stalled");
      assert.strictEqual(escalated?.stalledReason, "gave-up");
      assert.strictEqual(escalated?.slotHeld, false);
      assert.strictEqual(checkInsOf(yield* h.commands), sent, "no check-in past it");
      assert.strictEqual(stallNudgesOf(yield* h.commands), 0);
    }),
  ),
);

it.effect("a subagent awaiting approval holds every check-in, charge and escalation", () => {
  const held = new Set<string>();
  return withGovernor({ ...fixture(), subagentsAwaitingApproval: held }, (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      held.add(String(threadId));
      const maxAttempts = stateOf(yield* h.board)!.maxAttempts;
      // Far past every free check-in and the ceiling that would escalate.
      for (let sweep = 0; sweep < 2 + maxAttempts + 2; sweep++) yield* after(h, 60);
      const waiting = stateOf(yield* h.board);
      assert.strictEqual(waiting?.status, "running");
      assert.strictEqual(waiting?.stallCount, 0);
      assert.strictEqual(waiting?.stageEntryRecoveries, 0);
      assert.strictEqual(checkInsOf(yield* h.commands), 0);
      assert.strictEqual(stallNudgesOf(yield* h.commands), 0);

      // Answered: the wait restarts, so the first check-in is +30 from now.
      held.delete(String(threadId));
      yield* after(h, 1);
      yield* after(h, 29);
      assert.strictEqual(checkInsOf(yield* h.commands), 0, "nothing before +30 after the answer");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);
      assert.strictEqual(stateOf(yield* h.board)?.stallCount, 0);
    }),
  );
});

it.effect("a subagent approval answered before a check-in is due restarts the wait", () => {
  const held = new Set<string>();
  return withGovernor({ ...fixture(), subagentsAwaitingApproval: held }, (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      held.add(String(threadId));
      yield* after(h, 2);
      held.delete(String(threadId));
      yield* after(h, 2);
      yield* after(h, 27);
      assert.strictEqual(checkInsOf(yield* h.commands), 0, "the wait restarted at +4");
      yield* after(h, 3);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);
    }),
  );
});

it.effect("a hold released after charged check-ins resumes one interval out", () => {
  const held = new Set<string>();
  return withGovernor({ ...fixture(), subagentsAwaitingApproval: held }, (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 30);
      yield* after(h, 60);
      yield* after(h, 60);
      assert.strictEqual(checkInsOf(yield* h.commands), 3);

      held.add(String(threadId));
      yield* after(h, 60);
      yield* after(h, 60);
      held.delete(String(threadId));
      yield* after(h, 1);
      yield* after(h, 59);
      assert.strictEqual(checkInsOf(yield* h.commands), 3, "nothing before one interval");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 4, "one interval after the release");
      // The wording counts from when the wait really began, hold included.
      assert.include(turnTexts(yield* h.commands).at(-1), "the wait began about 331 minutes ago");
    }),
  );
});

it.effect("a commit mid-wait restarts the schedule and the stall streak", () => {
  // The branch's newest commit, read lazily so the agent can commit mid-test.
  let committedAt = "";
  const input = {
    ...fixture(),
    get latestBranchCommitIso() {
      return committedAt;
    },
  };
  return withGovernor(input, (h) =>
    Effect.gen(function* () {
      yield* startWaiting(h);
      yield* after(h, 30);
      yield* after(h, 60);
      yield* after(h, 60);
      assert.strictEqual(checkInsOf(yield* h.commands), 3);
      assert.strictEqual(stateOf(yield* h.board)?.stallCount, 1, "one charged check-in");

      // The agent commits real work while its job runs: a new wait.
      committedAt = DateTime.formatIso(yield* DateTime.now);
      yield* after(h, 1);
      yield* after(h, 29);
      assert.strictEqual(checkInsOf(yield* h.commands), 3, "nothing before the new wait's +30");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 4, "the new wait's first check");

      const reset = stateOf(yield* h.board);
      assert.strictEqual(reset?.stallCount, 0, "progress zeroes the streak");
      assert.strictEqual(reset?.attempt, 1);
      assert.strictEqual(reset?.stageEntryRecoveries, 1, "the stage ceiling is never reset");
    }),
  );
});

it.effect("a commit made during a woken turn resets the stall streak", () => {
  let committedAt = "";
  const input = {
    ...fixture(),
    get latestBranchCommitIso() {
      return committedAt;
    },
  };
  return withGovernor(input, (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 30);
      yield* after(h, 60);
      yield* after(h, 60);
      // The agent answers the charged check-in, still waiting.
      yield* h.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(stateOf(yield* h.board)?.stallCount, 1, "one charged check-in");

      // The provider wakes the agent; it commits and ends still waiting, with
      // no sweep in between to see the commit against the old wait.
      yield* after(h, 1);
      committedAt = DateTime.formatIso(yield* DateTime.now);
      yield* h.pumpRuntime(turnCompleted(threadId));

      yield* after(h, 30);
      assert.strictEqual(checkInsOf(yield* h.commands), 4, "the new wait's first check");
      const reset = stateOf(yield* h.board);
      assert.strictEqual(reset?.stallCount, 0, "the woken turn's commit zeroes the streak");
      assert.strictEqual(reset?.attempt, 1);
    }),
  );
});

it.effect(
  "a step awaiting input whose agent starts a monitor goes back to running and is checked in on",
  () =>
    withGovernor(fixture(), (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(movedToBuilding(buildingCard(CARD, "m"), 1));
        const threadId = stateOf(yield* h.board)!.threadId!;
        // The agent raised a structured question and the step parked on it.
        yield* Ref.update(
          h.shells,
          (current) =>
            new Map([
              ...current,
              [String(threadId), shellOf(threadId, null, "idle", { awaitingUserInput: true })],
            ]),
        );
        yield* h.pumpRuntime(turnCompleted(threadId));
        assert.strictEqual(stateOf(yield* h.board)?.status, "awaiting-input");

        // Answered, the agent starts a monitor and ends its turn.
        yield* setShell(h.shells, threadId, "monitoring");
        yield* h.pumpRuntime(turnCompleted(threadId));
        assert.strictEqual(stateOf(yield* h.board)?.status, "running", "not left violet");

        // Back on running, the wait is one the sweep checks in on.
        yield* after(h, 30);
        const commands = yield* h.commands;
        assert.strictEqual(checkInsOf(commands), 1);
        assert.strictEqual(recoveriesOf(commands), 0);
        assert.strictEqual(stallNudgesOf(commands), 0);
      }),
    ),
);

it.effect("a todo edit while answering a check-in does not restart the schedule", () => {
  const todos = new Map<string, TodoRow>();
  return withGovernor(fixture(todos), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 30);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);

      // The agent answers the check-in — its todo list advances — and ends the
      // turn with the monitor still running.
      todos.set(String(threadId), {
        advancedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* h.pumpRuntime(turnCompleted(threadId));

      // Nothing new at +30 from the reply; the second is still due at +90 from
      // the start of the wait.
      yield* after(h, 59);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "the reply did not restart the wait");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 2);
      yield* after(h, 60);
      assert.strictEqual(checkInsOf(yield* h.commands), 3);
    }),
  );
});

it.effect("a turn the board did not start restarts the schedule", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 30);
      yield* h.pumpRuntime(turnCompleted(threadId));
      yield* after(h, 60);
      yield* h.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(checkInsOf(yield* h.commands), 2);

      // The provider woke the agent (a subagent finished); it ended its turn
      // still waiting on the others. That is a new wait.
      yield* after(h, 1);
      yield* h.pumpRuntime(turnCompleted(threadId));

      // The new wait's first check is 30 minutes out — not the old +150.
      yield* after(h, 29);
      assert.strictEqual(checkInsOf(yield* h.commands), 2);
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 3);
    }),
  ),
);

it.effect("a quiet thread with background work is put on the schedule without a turn end", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(movedToBuilding(buildingCard(CARD, "m"), 1));
      const threadId = stateOf(yield* h.board)!.threadId!;
      // The turn ended with a monitor running, but its completion never
      // reached the reactor.
      yield* setShell(h.shells, threadId, "monitoring");

      // Long before the step's timeout, the sweep begins the wait...
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 0);
      // ...and its first check-in goes out 30 minutes later.
      yield* after(h, 30);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);
      assert.strictEqual(recoveriesOf(yield* h.commands), 0);
    }),
  ),
);

it.effect("a turn that ends with the background work gone ends the wait", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 30);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);

      // The job finished; the agent ended its turn without completing.
      yield* setShell(h.shells, threadId, null);
      yield* h.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(recoveriesOf(yield* h.commands), 1, "ordinary recovery applies");

      yield* after(h, 60);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "no check-in after the wait ended");
    }),
  ),
);

it.effect("a live turn is not checked in on, and keeps its wait", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      // The provider woke the agent and it is mid-turn: a live turn reads no background work.
      yield* setShell(h.shells, threadId, null, "running");
      yield* after(h, 30);
      assert.strictEqual(checkInsOf(yield* h.commands), 0);

      // Back between turns with its monitor running, and the turn end missed: the
      // original wait is still there, so its overdue check-in goes out now.
      yield* setShell(h.shells, threadId, "monitoring");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);
    }),
  ),
);

/** Advance past a backoff rung and fire the due retries. */
const retryAfter = (h: Harness, minutes: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.minutes(minutes));
    yield* h.reactor.fireRetries;
    yield* h.reactor.drain;
  });

/** Answer the latest check-in: a live reply turn the sweep sees, then its end
    with the background work still pending. */
const answerCheckIn = (h: Harness, threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* setShell(h.shells, threadId, null, "running");
    yield* after(h, 1);
    yield* setShell(h.shells, threadId, "monitoring");
    yield* h.pumpRuntime(turnCompleted(threadId));
  });

it.effect("a sweep during a check-in reply keeps the wait, so the ladder climbs", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 30);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);
      yield* answerCheckIn(h, threadId);

      // Not 30 minutes after the reply: the second rung, +90 from the start.
      yield* after(h, 58);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "nothing before +90");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 2, "+90");
      assert.strictEqual(stateOf(yield* h.board)?.stallCount, 0);
      yield* answerCheckIn(h, threadId);

      yield* after(h, 59);
      assert.strictEqual(checkInsOf(yield* h.commands), 3, "+150");
      assert.strictEqual(stateOf(yield* h.board)?.stallCount, 1, "the third is charged");
      assert.strictEqual(stallNudgesOf(yield* h.commands), 0);
    }),
  ),
);

it.effect("a step already charged for a stall escalates after fewer charged check-ins", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(movedToBuilding(buildingCard(CARD, "m"), 1));
      const threadId = stateOf(yield* h.board)!.threadId!;
      // A real stall: the turn ended with nothing running.
      yield* setShell(h.shells, threadId, null);
      yield* h.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(stateOf(yield* h.board)?.stalledReason, "waiting-retry");
      // The backoff rung (2 min ±1) re-admits it with the stall nudge.
      yield* retryAfter(h, 4);
      assert.strictEqual(stallNudgesOf(yield* h.commands), 1);
      assert.strictEqual(stateOf(yield* h.board)?.stallCount, 1);

      // The agent then waits on a monitor.
      yield* setShell(h.shells, threadId, "monitoring");
      yield* h.pumpRuntime(turnCompleted(threadId));
      const maxAttempts = stateOf(yield* h.board)!.maxAttempts;
      yield* after(h, 30);
      yield* after(h, 60);
      for (let stalls = 2; stalls < maxAttempts; stalls++) {
        yield* after(h, 60);
        assert.strictEqual(stateOf(yield* h.board)?.status, "running");
        assert.strictEqual(stateOf(yield* h.board)?.stallCount, stalls);
      }
      yield* after(h, 60);
      assert.strictEqual(stateOf(yield* h.board)?.stalledReason, "gave-up");
      assert.strictEqual(checkInsOf(yield* h.commands), 2 + maxAttempts - 2);
    }),
  ),
);

it.effect("a stall retry that finds the thread waiting on background work starts a wait", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(movedToBuilding(buildingCard(CARD, "m"), 1));
      const threadId = stateOf(yield* h.board)!.threadId!;
      // The turn end read no background work, so the step parked for a retry...
      yield* setShell(h.shells, threadId, null);
      yield* h.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(stateOf(yield* h.board)?.stalledReason, "waiting-retry");
      // ...but by the retry the thread reads as waiting on its subagents.
      yield* setShell(h.shells, threadId, "working");
      yield* retryAfter(h, 4);

      const resumed = stateOf(yield* h.board);
      assert.strictEqual(resumed?.status, "running");
      assert.strictEqual(stallNudgesOf(yield* h.commands), 0, "no stall nudge");
      // The misread stall is refunded, so the ceilings count only real stalls.
      assert.strictEqual(resumed?.stallCount, 0);
      assert.strictEqual(resumed?.attempt, 1);
      assert.strictEqual(resumed?.stageEntryRecoveries, 0);

      // The check-in ladder supervises it from the retry.
      yield* after(h, 29);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);
    }),
  ),
);
