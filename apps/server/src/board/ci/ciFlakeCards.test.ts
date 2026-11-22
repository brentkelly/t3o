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

// T3o (T3O-127): flakes under load.
it.effect("a flake under load files a performance card; a calm one keeps the race brief", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    yield* fileBoardCiFlakes(deps, {
      card: tested,
      runId: "run-1",
      passOrdinal: 2,
      flakes: [flake("slow", { underLoad: true, cpuPressure: 87.4 }), flake("racy")],
      loadThreshold: 50,
    });
    const [slow, racy] = ofType(commands, "board.card.create");
    assert.strictEqual(slow?.title, "Slow under load: src/a.test.ts › slow");
    assert.include(slow?.brief ?? "", "## Slow under load");
    assert.include(slow?.brief ?? "", "CPU pressure 87 % (under-load threshold 50 %)");
    assert.include(slow?.brief ?? "", "Make the test cheaper");
    assert.include(slow?.brief ?? "", "mark it load-sensitive in the same pull request");
    assert.include(slow?.brief ?? "", "Never retry, sleep or loosen timeouts");
    // Same ref system as any flake card, so its own CI still finds its target.
    assert.strictEqual(slow?.externalRef?.system, "t3o-flaky");
    assert.strictEqual(racy?.title, "Flaky test: src/a.test.ts › racy");
    assert.notInclude(racy?.brief ?? "", "Slow under load");
  }),
);

it.effect("a test that already had a performance card, even archived, is only marked", () =>
  Effect.gen(function* () {
    const earlier = flakeCard("t3o-30", "slow", {
      title: "Slow under load: src/a.test.ts › slow",
      stage: BOARD_SEED_STAGE_IDS.done,
      archivedAt: NOW,
    });
    const { deps, commands } = yield* fakeBoard([tested, earlier]);
    yield* file(deps, [flake("slow", { underLoad: true })]);
    const [create] = ofType(commands, "board.card.create");
    assert.strictEqual(create?.externalRef?.id, `${projectId}:src/a.test.ts › slow  #2`);
    assert.include(create?.brief ?? "", "T3O-30 already tried to make this test cheaper");
    assert.include(create?.brief ?? "", "Do not optimise it again");
    assert.notInclude(create?.brief ?? "", "Make the test cheaper");
  }),
);

it.effect("a card archived before Done is no earlier attempt", () =>
  Effect.gen(function* () {
    const abandoned = flakeCard("t3o-30", "slow", {
      title: "Slow under load: src/a.test.ts › slow",
      archivedAt: NOW,
    });
    const { deps, commands } = yield* fakeBoard([tested, abandoned]);
    yield* file(deps, [flake("slow", { underLoad: true })]);
    const [create] = ofType(commands, "board.card.create");
    assert.include(create?.brief ?? "", "Make the test cheaper");
    assert.notInclude(create?.brief ?? "", "T3O-30");
  }),
);

it.effect("a load-sensitive flake under load files nothing and uses none of the caps", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    const marked = Array.from({ length: BOARD_CI_FLAKE_CARDS_PER_PASS }, (_, n) =>
      flake(`marked${n}`, { underLoad: true, loadSensitive: true }),
    );
    const result = yield* file(deps, [...marked, flake("racy")]);
    assert.deepStrictEqual(result.filed, ["T3O-101"]);
    assert.lengthOf(result.loadSensitive, BOARD_CI_FLAKE_CARDS_PER_PASS);
    assert.deepStrictEqual(
      ofType(commands, "board.card.create").map((create) => create.title),
      ["Flaky test: src/a.test.ts › racy"],
    );
    assert.include(
      ofType(commands, "board.card.record-note").at(-1)?.detail ?? "",
      "not filed (marked load-sensitive, ran under load): src/a.test.ts › marked0",
    );
  }),
);

it.effect("a load-sensitive mark is ignored on a calm host and for a test in the change", () =>
  Effect.gen(function* () {
    const { deps, commands } = yield* fakeBoard([tested]);
    const result = yield* file(deps, [
      flake("calm", { loadSensitive: true }),
      flake("changed", { loadSensitive: true, underLoad: true, inDiff: true }),
    ]);
    assert.lengthOf(result.filed, 2);
    assert.deepStrictEqual(result.loadSensitive, []);
    const titles = ofType(commands, "board.card.create").map((create) => create.title);
    assert.deepStrictEqual(titles, [
      "Flaky test: src/a.test.ts › calm",
      "Slow under load: src/a.test.ts › changed",
    ]);
    // A flake card's own target is never excused by its mark.
    const own = flakeCard("t3o-60", "adds", { stage: BOARD_SEED_STAGE_IDS.ci });
    const target = yield* fakeBoard([own]);
    const onOwn = yield* file(
      target.deps,
      [flake("adds", { loadSensitive: true, underLoad: true })],
      own,
    );
    assert.deepStrictEqual(onOwn.loadSensitive, []);
    assert.deepStrictEqual(onOwn.noted, ["T3O-60"]);
  }),
);

it("reads a pass's load: the step's pressure, and a mark only from the script", () => {
  const flakes = boardCiPassFlakes([
    {
      name: "E2E",
      command: "vp e2e",
      status: "passed",
      cpuPressure: 88,
      underLoad: true,
      result: { summary: null, failures: [] },
      flaky: [
        { title: "marked", loadSensitive: true, underLoad: true },
        { title: "ruled", byAgent: true, loadSensitive: true },
      ],
    },
    {
      name: "Unit",
      command: "vp test",
      status: "failed",
      underLoad: true,
      result: {
        summary: null,
        failures: [{ title: "real" }, { title: "flagged", flaky: true, loadSensitive: true }],
      },
    },
  ]);
  assert.deepStrictEqual(
    flakes.map((entry) => [entry.title, entry.underLoad, entry.loadSensitive, entry.cpuPressure]),
    [
      ["marked", true, true, 88],
      ["ruled", true, undefined, 88],
      ["flagged", true, true, undefined],
    ],
  );
});
