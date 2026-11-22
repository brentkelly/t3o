/**
 * T3O-126: each flaky CI test files one auto-built bug card per project, matched by its
 * `file › title`; a repeat flake notes the open card, and the volume is bounded.
 */
import {
  BOARD_SEED_LABEL_IDS,
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  type BoardCard,
  type BoardCommand,
  type BoardState,
  DEFAULT_BOARD_SETTINGS,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeBoardCard, NOW, projectId } from "../supervisorHarness.testkit.ts";
import {
  BOARD_CI_FLAKE_CARDS_OPEN_MAX,
  BOARD_CI_FLAKE_CARDS_PER_PASS,
  boardCiFlakeCardTarget,
  boardCiPassFlakes,
  fileBoardCiFlakes,
  noteBoardCiDeferred,
  type BoardCiFlake,
} from "./ciFlakeCards.ts";

const tested = makeBoardCard({ id: "t3o-7", stage: "ci", orderKey: "m" });
const flake = (title: string, extra: Partial<BoardCiFlake> = {}): BoardCiFlake => ({
  title,
  file: "src/a.test.ts",
  detail: "expected 1 to be 2",
  stepName: "Test",
  command: "vp test",
  source: "script",
  ...extra,
});
const flakeCard = (id: string, title: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  ...makeBoardCard({ id, stage: "planning", orderKey: "a" }),
  externalRef: { system: "t3o-flaky", id: `${projectId}:src/a.test.ts › ${title}`, url: null },
  ...extra,
});

/** A board that applies the filing's commands, refusing a create whose ref a live card holds. */
const fakeBoard = (cards: ReadonlyArray<BoardCard>, raceOn?: string, refuseAutomation?: string) =>
  Effect.sync(() => {
    let board: BoardState = { cards, stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
    let next = 100;
    const commands: BoardCommand[] = [];
    const dispatch = (command: BoardCommand) =>
      Effect.sync((): string | null => {
        commands.push(command);
        if (command.type === "board.card.set-automation" && refuseAutomation !== undefined) {
          return refuseAutomation;
        }
        if (command.type === "board.card.create") {
          const ref = command.externalRef;
          if (raceOn !== undefined && ref?.id.endsWith(raceOn)) {
            // Another card's pass got there first.
            board = {
              ...board,
              cards: [...board.cards, flakeCard("raced", raceOn)],
            };
            return "That external item is already tracked.";
          }
          next += 1;
          board = {
            ...board,
            cards: [
              ...board.cards,
              {
                ...makeBoardCard({ id: String(command.cardId), stage: "backlog", orderKey: "z" }),
                key: `T3O-${next}`,
                externalRef: ref ?? null,
              },
            ],
          };
        }
        if (command.type === "board.card.move") {
          board = {
            ...board,
            cards: board.cards.map((card) =>
              card.id === command.cardId ? { ...card, stage: command.toStage } : card,
            ),
          };
        }
        return null;
      });
    return {
      commands,
      deps: {
        readBoard: Effect.sync(() => board),
        settings: Effect.succeed(DEFAULT_BOARD_SETTINGS),
        dispatch,
        nowIso: Effect.succeed(NOW),
      },
    };
  });

const file = (
  deps: Effect.Success<ReturnType<typeof fakeBoard>>["deps"],
  flakes: BoardCiFlake[],
  card = tested,
) => fileBoardCiFlakes(deps, { card, runId: "run-1", passOrdinal: 2, flakes });

const ofType = <T extends BoardCommand["type"]>(commands: ReadonlyArray<BoardCommand>, type: T) =>
  commands.filter(
    (command): command is Extract<BoardCommand, { type: T }> => command.type === type,
  );

it.effect("the first flake files one bug card, auto-built but never auto-merged", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    const result = yield* file(deps, [flake("adds"), flake("adds")]);
    assert.deepStrictEqual(result.filed, ["T3O-101"]);
    const [create] = ofType(commands, "board.card.create");
    assert.deepStrictEqual(create?.labels, [BOARD_SEED_LABEL_IDS.bug]);
    assert.strictEqual(create?.keyPrefix, "T3O");
    assert.strictEqual(create?.priority, "low");
    assert.strictEqual(create?.planReview?.unattended, true);
    assert.deepStrictEqual(create?.externalRef, {
      system: "t3o-flaky",
      id: `${projectId}:src/a.test.ts › adds`,
      url: null,
    });
    assert.include(create?.brief ?? "", "T3O-7 (pass 2");
    assert.include(create?.brief ?? "", "expected 1 to be 2");
    const [automation] = ofType(commands, "board.card.set-automation");
    assert.deepInclude(automation, {
      autoPlan: true,
      autoSignOff: true,
      autoBuild: true,
      autoMerge: false,
    });
    const [move] = ofType(commands, "board.card.move");
    assert.strictEqual(move?.toStage, BOARD_SEED_STAGE_IDS.planning);
    assert.strictEqual(move?.override, true);
    const notes = ofType(commands, "board.card.record-note");
    assert.lengthOf(notes, 1);
    assert.strictEqual(notes[0]?.cardId, tested.id);
    assert.include(notes[0]?.detail ?? "", "filed T3O-101");
    // A resumed pass files again under the same run: its note is a new command, not a replay.
    yield* file(deps, [flake("subtracts")]);
    const second = ofType(commands, "board.card.record-note");
    assert.lengthOf(second, 2);
    assert.notStrictEqual(second[1]?.commandId, second[0]?.commandId);
  }),
);

it.effect("the same test flaking on another card notes the open card and files none", () =>
  Effect.gen(function* () {
    const open = flakeCard("t3o-50", "adds");
    const { deps, commands } = yield* fakeBoard([tested, open]);
    const result = yield* file(deps, [flake("adds")]);
    assert.deepStrictEqual(result.filed, []);
    assert.deepStrictEqual(result.noted, ["T3O-50"]);
    assert.lengthOf(ofType(commands, "board.card.create"), 0);
    const again = ofType(commands, "board.card.record-note").find(
      (note) => note.cardId === open.id,
    );
    assert.strictEqual(again?.kind, "card-ci-flaked-again");
    assert.include(again?.detail ?? "", "flaked again on T3O-7");
  }),
);

it.effect("a create that loses a race to another card's pass becomes a note", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested], "adds");
    const result = yield* file(deps, [flake("adds")]);
    assert.deepStrictEqual(result.noted, ["RACED"]);
    assert.isTrue(
      ofType(commands, "board.card.record-note").some(
        (note) => note.cardId === BoardCardId.make("raced") && note.kind === "card-ci-flaked-again",
      ),
    );
  }),
);

it.effect("a Done card keeps its ref; the flake files a new card on the next suffix", () =>
  Effect.gen(function* () {
    const done = flakeCard("t3o-40", "adds", { stage: BOARD_SEED_STAGE_IDS.done });
    const { deps, commands } = yield* fakeBoard([tested, done]);
    yield* file(deps, [flake("adds")]);
    const [create] = ofType(commands, "board.card.create");
    assert.strictEqual(create?.externalRef?.id, `${projectId}:src/a.test.ts › adds  #2`);
    assert.include(create?.brief ?? "", "T3O-40 fixed this test before");
  }),
);

it.effect(
  "files at most a few cards per pass, none past the open ceiling, and lists the rest",
  () =>
    Effect.gen(function* () {
      const { deps, commands } = yield* fakeBoard([tested]);
      const many = Array.from({ length: BOARD_CI_FLAKE_CARDS_PER_PASS + 1 }, (_, n) =>
        flake(`t${n}`),
      );
      const result = yield* file(deps, many);
      assert.lengthOf(result.filed, BOARD_CI_FLAKE_CARDS_PER_PASS);
      assert.deepStrictEqual(result.listed, [`src/a.test.ts › t${BOARD_CI_FLAKE_CARDS_PER_PASS}`]);
      assert.include(
        ofType(commands, "board.card.record-note").at(-1)?.detail ?? "",
        "not filed (over the limit)",
      );

      const full = Array.from({ length: BOARD_CI_FLAKE_CARDS_OPEN_MAX }, (_, n) =>
        flakeCard(`open-${n}`, `old${n}`),
      );
      const ceiling = yield* fakeBoard([tested, ...full]);
      const capped = yield* file(ceiling.deps, [flake("fresh")]);
      assert.deepStrictEqual(capped.filed, []);
      assert.deepStrictEqual(capped.listed, ["src/a.test.ts › fresh"]);
    }),
);

it.effect("a refused automation leaves the new card in Backlog and says so", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested], undefined, "Auto-merge is locked.");
    const result = yield* file(deps, [flake("adds")]);
    assert.deepStrictEqual(result.filed, []);
    assert.lengthOf(ofType(commands, "board.card.move"), 0);
    assert.include(
      ofType(commands, "board.card.record-note").at(-1)?.detail ?? "",
      "Auto-merge is locked.",
    );
  }),
);

it.effect("a long title or one ending in #digits still reads back as the card's own test", () =>
  Effect.gen(function* () {
    for (const title of [`it ${"x".repeat(400)}`, "retries #2"]) {
      const { deps, commands } = yield* fakeBoard([tested]);
      yield* file(deps, [flake(title)]);
      const ref = ofType(commands, "board.card.create")[0]?.externalRef ?? null;
      const target = boardCiFlakeCardTarget({ projectId, externalRef: ref });
      assert.strictEqual(target, `src/a.test.ts › ${title}`);
      const done = {
        ...makeBoardCard({ id: "d", stage: BOARD_SEED_STAGE_IDS.done, orderKey: "b" }),
        externalRef: ref,
      };
      const again = yield* fakeBoard([tested, done]);
      yield* file(again.deps, [flake(title)]);
      const next = ofType(again.commands, "board.card.create")[0]?.externalRef ?? null;
      assert.strictEqual(boardCiFlakeCardTarget({ projectId, externalRef: next }), target);
    }
  }),
);

it.effect("a flake card files no cards of its own, and its target is never flaky", () =>
  Effect.gen(function* () {
    const own = flakeCard("t3o-60", "adds", { stage: BOARD_SEED_STAGE_IDS.ci });
    assert.strictEqual(boardCiFlakeCardTarget(own), "src/a.test.ts › adds");
    assert.isNull(boardCiFlakeCardTarget(tested));
    const { deps, commands } = yield* fakeBoard([own]);
    const result = yield* file(deps, [flake("other")], own);
    assert.deepStrictEqual(result.filed, []);
    assert.deepStrictEqual(result.listed, ["src/a.test.ts › other"]);
    assert.lengthOf(ofType(commands, "board.card.create"), 0);
  }),
);

it.effect("a test in the card's own change says so on the bug card and the tested card", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    yield* file(deps, [flake("adds", { inDiff: true, source: "agent", repro: "vp test a" })]);
    const [create] = ofType(commands, "board.card.create");
    assert.include(create?.brief ?? "", "in T3O-7's change");
    assert.include(create?.brief ?? "", "vp test a");
    assert.include(create?.brief ?? "", "CI fix agent");
    assert.include(
      ofType(commands, "board.card.record-note").at(-1)?.detail ?? "",
      "the cause may be this card",
    );
  }),
);

it("reads a pass's flakes: passed-over ones with their error, and flagged ones beside a failure", () => {
  const flakes = boardCiPassFlakes([
    {
      name: "Unit",
      command: "vp test",
      status: "passed",
      result: {
        summary: null,
        failures: [{ title: "adds", file: "a.ts", detail: "boom", flaky: true }],
      },
      flaky: [{ title: "adds", file: "a.ts", byAgent: true }],
    },
    {
      name: "E2E",
      command: "vp e2e",
      status: "failed",
      result: {
        summary: null,
        failures: [{ title: "real" }, { title: "slow", repro: "vp e2e slow", flaky: true }],
      },
    },
  ]);
  assert.deepStrictEqual(flakes, [
    {
      stepName: "Unit",
      command: "vp test",
      title: "adds",
      file: "a.ts",
      detail: "boom",
      source: "agent",
    },
    { stepName: "E2E", command: "vp e2e", title: "slow", repro: "vp e2e slow", source: "script" },
  ]);
});

// T3o (T3O-129): a flake on a busy machine goes onto the load-sensitive list, not a card.
it.effect("a busy flake files no card, records the entry and notes the tested card", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    const result = yield* fileBoardCiFlakes(deps, {
      card: tested,
      runId: "run-1",
      passOrdinal: 2,
      flakes: [flake("slow", { underLoad: true }), flake("racy")],
      loadThreshold: 50,
    });
    assert.deepStrictEqual(result.loadSensitive, ["src/a.test.ts › slow"]);
    // The quiet flake still files its race card.
    assert.deepStrictEqual(
      ofType(commands, "board.card.create").map((create) => create.title),
      ["Flaky test: src/a.test.ts › racy"],
    );
    const [record] = ofType(commands, "board.project.record-load-sensitive");
    assert.strictEqual(record?.projectId, tested.projectId);
    assert.strictEqual(record?.runId, "run-1");
    assert.deepStrictEqual(record?.entries, [
      { key: "src/a.test.ts › slow", file: "src/a.test.ts", title: "slow", cardKey: tested.key },
    ]);
    assert.include(
      ofType(commands, "board.card.record-note").at(-1)?.detail ?? "",
      "flaked under load, added to the load-sensitive list: src/a.test.ts › slow",
    );
  }),
);

it.effect("busy flakes use none of the caps, and a script-reported one is listed", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    // Script-reported: no `inDiff` on that path, so the board relies on the script's duty to
    // never report a test in the card's change as flaky under load.
    const busy = Array.from({ length: BOARD_CI_FLAKE_CARDS_PER_PASS + 1 }, (_, n) =>
      flake(`busy${n}`, { underLoad: true }),
    );
    const result = yield* file(deps, [...busy, flake("racy")]);
    assert.deepStrictEqual(result.filed, ["T3O-101"]);
    assert.lengthOf(result.loadSensitive, BOARD_CI_FLAKE_CARDS_PER_PASS + 1);
    assert.lengthOf(
      ofType(commands, "board.project.record-load-sensitive")[0]?.entries ?? [],
      BOARD_CI_FLAKE_CARDS_PER_PASS + 1,
    );
  }),
);

it.effect("a busy flake with no file is only noted", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    const { file: _file, ...stepLevel } = flake("Test", { underLoad: true });
    const result = yield* file(deps, [stepLevel]);
    assert.deepStrictEqual(result.busyUnlisted, ["Test"]);
    assert.lengthOf(ofType(commands, "board.card.create"), 0);
    assert.lengthOf(ofType(commands, "board.project.record-load-sensitive"), 0);
    assert.include(
      ofType(commands, "board.card.record-note").at(-1)?.detail ?? "",
      "flaked under load, not filed: Test",
    );
  }),
);

it.effect("at a threshold of 100 a worker's under-load reading counts as quiet", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    const result = yield* fileBoardCiFlakes(deps, {
      card: tested,
      runId: "run-1",
      passOrdinal: 2,
      flakes: [flake("slow", { underLoad: true })],
      loadThreshold: 100,
    });
    assert.deepStrictEqual(result.loadSensitive, []);
    assert.deepStrictEqual(result.filed, ["T3O-101"]);
    assert.lengthOf(ofType(commands, "board.project.record-load-sensitive"), 0);
  }),
);

it.effect("on a flake card's own CI, another busy test is listed but its target never is", () =>
  Effect.gen(function* () {
    const own = flakeCard("t3o-60", "adds", { stage: BOARD_SEED_STAGE_IDS.ci });
    const { deps, commands } = yield* fakeBoard([own]);
    const result = yield* file(
      deps,
      [flake("adds", { underLoad: true }), flake("other", { underLoad: true })],
      own,
    );
    assert.deepStrictEqual(result.loadSensitive, ["src/a.test.ts › other"]);
    // Its own target goes the ordinary way: noted on itself, never listed.
    assert.deepStrictEqual(result.noted, ["T3O-60"]);
    assert.deepStrictEqual(
      ofType(commands, "board.project.record-load-sensitive")[0]?.entries.map((entry) => entry.key),
      ["src/a.test.ts › other"],
    );
  }),
);

it.effect("a second filing in the same run records the new keys; a repeat is the same command", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    yield* file(deps, [flake("one", { underLoad: true })]);
    yield* file(deps, [flake("one", { underLoad: true }), flake("two", { underLoad: true })]);
    yield* file(deps, [flake("one", { underLoad: true }), flake("two", { underLoad: true })]);
    const records = ofType(commands, "board.project.record-load-sensitive");
    assert.deepStrictEqual(
      records.map((record) => record.entries.map((entry) => entry.title)),
      [["one"], ["one", "two"], ["one", "two"]],
    );
    // The command id dedupes a repeat; a growing flake set gets a new one.
    assert.notStrictEqual(records[0]?.commandId, records[1]?.commandId);
    assert.strictEqual(records[1]?.commandId, records[2]?.commandId);
  }),
);

it("reads a pass's flakes as under load from the step or the entry", () => {
  const flakes = boardCiPassFlakes([
    {
      name: "E2E",
      command: "vp e2e",
      status: "passed",
      underLoad: true,
      result: { summary: null, failures: [] },
      flaky: [{ title: "marked" }, { title: "ruled", byAgent: true }],
    },
    {
      name: "Unit",
      command: "vp test",
      status: "failed",
      result: {
        summary: null,
        failures: [{ title: "real" }, { title: "flagged", flaky: true }],
      },
    },
  ]);
  assert.deepStrictEqual(
    flakes.map((entry) => [entry.title, entry.underLoad]),
    [
      ["marked", true],
      ["ruled", true],
      ["flagged", undefined],
    ],
  );
});

it.effect("a run's deferred tests are noted once, by run, from every step that ran", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    const steps = [
      { status: "passed" as const, deferred: [{ file: "e2e/a.spec.ts", title: "slow" }] },
      // A failed finish, flaky-resumed under the same run: its later step deferred more.
      { status: "passed" as const, deferred: [{ file: "e2e/b.spec.ts", title: "slower" }] },
      { status: "skipped" as const, deferred: [{ title: "vouches for nothing" }] },
    ];
    yield* noteBoardCiDeferred(deps, { card: tested, runId: "run-1", steps });
    yield* noteBoardCiDeferred(deps, { card: tested, runId: "run-1", steps });
    const notes = ofType(commands, "board.card.record-note");
    assert.lengthOf(notes, 2);
    assert.strictEqual(notes[0]?.kind, "card-ci-deferred");
    assert.strictEqual(
      notes[0]?.detail,
      "2 load-sensitive tests deferred to the nightly: e2e/a.spec.ts › slow, e2e/b.spec.ts › slower.",
    );
    // Seeded by the run alone, so every call site lands at most one note.
    assert.strictEqual(notes[0]?.commandId, notes[1]?.commandId);
    yield* noteBoardCiDeferred(deps, {
      card: tested,
      runId: "run-1",
      steps: [{ status: "passed", deferred: [] }],
    });
    assert.lengthOf(ofType(commands, "board.card.record-note"), 2);
  }),
);
