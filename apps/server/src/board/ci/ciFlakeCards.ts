// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3o (T3O-126): each flaky CI test becomes an auto-built, never auto-merged bug card, one open
 * card per `boardCiFlakeKey`. The only path that turns automation on for a card nobody asked
 * for, so it is bounded; `docs/t3o/automation.md` has the contract.
 */
import * as NodeCrypto from "node:crypto";

import {
  BOARD_SEED_LABEL_IDS,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  CommandId,
  boardCiFlakeKey,
  boardLabelCatalogue,
  boardPlanReviewCreationDefaults,
  boardProjectStageConfig,
  boardStageWithRole,
  resolveBoardStageExecution,
  type BoardActivityActor,
  type BoardCard,
  type BoardCiPassStep,
  type BoardCommand,
  type BoardSettings,
  type BoardState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { stampBoardActivityActor } from "../activityActors.ts";

const BOARD_CI_FLAKE_REF_SYSTEM = "t3o-flaky";
/** New flake cards one pass may file. */
export const BOARD_CI_FLAKE_CARDS_PER_PASS = 3;
/** Open flake cards a project may hold before flakes are only listed. */
export const BOARD_CI_FLAKE_CARDS_OPEN_MAX = 10;

/** Between a ref and a Done card's successor's number. A flake key collapses whitespace, so
    a double space never appears in one and the suffix can't be read off a test's title. */
const REF_SUFFIX = "  #";
const DETAIL_MAX = 2_000;

const BOARD_CI_FLAKE_ACTOR: BoardActivityActor = {
  kind: "system",
  name: "CI: flaky test",
  providerInstanceId: null,
  threadId: null,
};

/** One flaky test as CI saw it. */
export interface BoardCiFlake {
  readonly title: string;
  readonly file?: string;
  readonly detail?: string;
  readonly repro?: string;
  /** The test is in the tested card's own change. */
  readonly inDiff?: boolean;
  readonly stepName: string;
  /** The step's command, for a repro when nobody gave one. */
  readonly command?: string;
  /** Who said it passed alone: the script, or the fix agent. */
  readonly source: "script" | "agent";
  /** T3o (T3O-127): the step it flaked in ran under load, at this CPU pressure. */
  readonly underLoad?: boolean;
  readonly cpuPressure?: number;
  /** The runner says the project marked the test load-sensitive. Never from the fix agent. */
  readonly loadSensitive?: boolean;
}

/** T3o (T3O-127): a performance card's title prefix; how a later flake knows the test
    already had its one optimisation attempt. */
const SLOW_UNDER_LOAD_PREFIX = "Slow under load: ";

const isPerformanceCard = (card: Pick<BoardCard, "title">) =>
  card.title.startsWith(SLOW_UNDER_LOAD_PREFIX);

/** A load-sensitive mark covers load only, and never a flake card's own test, which must
    really pass. Running the tests a card changed is the script's job. */
function isHonouredLoadSensitiveFlake(
  flake: Pick<BoardCiFlake, "loadSensitive" | "underLoad" | "file" | "title">,
  target: string | null,
): boolean {
  return (
    flake.loadSensitive === true &&
    flake.underLoad === true &&
    boardCiFlakeKey(flake.file, flake.title) !== target
  );
}

export interface BoardCiFlakeFilingDeps {
  readonly readBoard: Effect.Effect<BoardState>;
  readonly settings: Effect.Effect<BoardSettings>;
  /** Dispatch; the decider's refusal sentence, or null when it landed. */
  readonly dispatch: (command: BoardCommand) => Effect.Effect<string | null>;
  readonly nowIso: Effect.Effect<string>;
}

export interface BoardCiFlakeFiling {
  readonly filed: ReadonlyArray<string>;
  readonly noted: ReadonlyArray<string>;
  /** Flakes over a limit, only listed on the tested card. */
  readonly listed: ReadonlyArray<string>;
  /** T3o (T3O-127): marked load-sensitive and flaked under load: no card, no cap used. */
  readonly loadSensitive: ReadonlyArray<string>;
}

// The whole key, never clipped: a flake card's CI reads its own test back off the ref.
const refBase = (projectId: string, key: string) => `${projectId}:${key}`;

/** The flake key a flake card exists to fix, or null for any other card. */
export function boardCiFlakeCardTarget(
  card: Pick<BoardCard, "projectId" | "externalRef">,
): string | null {
  const ref = card.externalRef;
  if (ref === null || ref.system !== BOARD_CI_FLAKE_REF_SYSTEM) return null;
  const prefix = `${card.projectId}:`;
  const at = ref.id.lastIndexOf(REF_SUFFIX);
  const id =
    at >= 0 && /^\d+$/.test(ref.id.slice(at + REF_SUFFIX.length)) ? ref.id.slice(0, at) : ref.id;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

const isFlakeCardFor = (card: BoardCard, base: string) => {
  const ref = card.externalRef;
  return (
    ref !== null &&
    ref.system === BOARD_CI_FLAKE_REF_SYSTEM &&
    (ref.id === base || ref.id.startsWith(`${base}${REF_SUFFIX}`))
  );
};

const isOpen = (card: BoardCard) =>
  card.archivedAt === null && card.stage !== BOARD_SEED_STAGE_IDS.done;

const digest = (text: string) => NodeCrypto.createHash("sha1").update(text).digest("hex");

/** A card id derived from the run and the test, so a replay files no second card. */
const flakeCardId = (seed: string) => {
  const hex = digest(seed);
  return BoardCardId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
};

const commandIdFor = (seed: string, step: string) =>
  CommandId.make(`server:board-ci-flake:${digest(seed).slice(0, 24)}:${step}`);

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

function boardCiFlakeBrief(input: {
  readonly key: string;
  readonly flake: BoardCiFlake;
  readonly testedKey: string;
  readonly passOrdinal: number;
  readonly earlierKey: string | null;
  /** T3o (T3O-127): an earlier performance card already had the one optimisation attempt. */
  readonly earlierPerformanceKey?: string | null;
  readonly loadThreshold?: number;
}): string {
  const { flake } = input;
  const repro =
    flake.repro ??
    (flake.command === undefined
      ? `Re-run \`${input.key}\` with the project's test runner.`
      : `\`${flake.command}\`, then look for \`${input.key}\``);
  if (flake.underLoad === true) return boardCiSlowUnderLoadBrief(input, repro);
  return [
    "## Problem",
    `The test \`${input.key}\` failed in CI on ${input.testedKey} (pass ${input.passOrdinal}, step "${flake.stepName}") and then passed when re-run alone, as the ${flake.source === "agent" ? "CI fix agent" : "CI script"} found. CI let ${input.testedKey} through; this card makes the test reliable.`,
    ...(flake.inDiff === true
      ? [
          "",
          `This test is in ${input.testedKey}'s change, so the cause may be that card rather than the test.`,
        ]
      : []),
    ...(input.earlierKey === null
      ? []
      : ["", `${input.earlierKey} fixed this test before; it has flaked again since.`]),
    "",
    "## Repro",
    repro,
    "",
    "## Error",
    "```",
    clip(flake.detail?.trim() || "(no error text was reported)", DETAIL_MAX),
    "```",
    "",
    "## What to build",
    "Find why the test fails only sometimes (shared state, ordering, timing, load) and fix the cause. Never skip, retry or loosen the test to hide it.",
  ].join("\n");
}

/** T3o (T3O-127): the brief of a flake that happened under load: make the test cheaper, or
    mark it load-sensitive, never hide it. */
function boardCiSlowUnderLoadBrief(
  input: Parameters<typeof boardCiFlakeBrief>[0],
  repro: string,
): string {
  const { flake } = input;
  const pressure =
    flake.cpuPressure === undefined ? "" : ` at CPU pressure ${Math.round(flake.cpuPressure)} %`;
  const threshold =
    input.loadThreshold === undefined ? "" : ` (under-load threshold ${input.loadThreshold} %)`;
  const earlier = input.earlierPerformanceKey ?? null;
  return [
    "## Slow under load",
    `The test \`${input.key}\` failed in CI on ${input.testedKey} (pass ${input.passOrdinal}, step "${flake.stepName}") while the host was under load${pressure}${threshold}, and then passed when re-run alone, as the ${flake.source === "agent" ? "CI fix agent" : "CI script"} found. CI let ${input.testedKey} through; this card makes the test cheap enough to pass on a busy host, or marks it so it doesn't run there.`,
    ...(flake.inDiff === true
      ? [
          "",
          `This test is in ${input.testedKey}'s change, so the cause may be that card rather than the test.`,
        ]
      : []),
    "",
    "## Repro",
    repro,
    "",
    "## Error",
    "```",
    clip(flake.detail?.trim() || "(no error text was reported)", DETAIL_MAX),
    "```",
    "",
    "## What to build",
    ...(earlier === null
      ? [
          "Make the test cheaper: less setup, wait on the right state rather than a fixed time, fewer page loads, lighter fixtures. Check it for a race while you are there. Re-measure it under the host's current load (read `/proc/pressure/cpu`) and put the timings in the pull request.",
          "",
          "If it still can't reliably pass under load, mark it load-sensitive in the same pull request using the project's convention (its AGENTS.md; else the test runner's own tag, marker or group; else an in-test skip when `T3O_UNDER_LOAD` is set), and say why in the pull request. A human merges it.",
        ]
      : [
          `${earlier} already tried to make this test cheaper. Do not optimise it again: mark it load-sensitive using the project's convention (its AGENTS.md; else the test runner's own tag, marker or group; else an in-test skip when \`T3O_UNDER_LOAD\` is set), and say why in the pull request. Fix an obvious race if you find one.`,
        ]),
    "",
    "Never retry, sleep or loosen timeouts to hide it.",
  ].join("\n");
}

/**
 * File a pass's flakes. Runs after the tested card has been recorded and moved on, and never
 * fails: the caller logs a fault, and the tested card is not touched by one.
 */
export const fileBoardCiFlakes = Effect.fn("BoardCiFlakeCards.file")(function* (
  deps: BoardCiFlakeFilingDeps,
  input: {
    readonly card: BoardCard;
    readonly runId: string;
    readonly passOrdinal: number;
    readonly flakes: ReadonlyArray<BoardCiFlake>;
    /** T3o (T3O-127): the project's under-load threshold, for a performance brief. */
    readonly loadThreshold?: number;
  },
) {
  const { card } = input;
  const filed: string[] = [];
  const noted: string[] = [];
  const listed: string[] = [];
  const loadSensitive: string[] = [];
  const refusals: string[] = [];
  const seen = new Set<string>();
  const testedTarget = boardCiFlakeCardTarget(card);
  const testedIsFlakeCard = testedTarget !== null;
  const dispatchAs = (command: BoardCommand) => {
    stampBoardActivityActor(command.commandId, BOARD_CI_FLAKE_ACTOR);
    return deps.dispatch(command);
  };
  const noteOn = Effect.fn("BoardCiFlakeCards.noteOn")(function* (
    target: BoardCard,
    key: string,
    flake: BoardCiFlake,
    seed: string,
  ) {
    const error = flake.detail?.trim().split("\n")[0];
    yield* dispatchAs({
      type: "board.card.record-note",
      commandId: commandIdFor(seed, `note:${target.id}`),
      cardId: target.id,
      kind: "card-ci-flaked-again",
      detail: clip(
        `\`${key}\` flaked again on ${card.key} (pass ${input.passOrdinal}, ${flake.source === "agent" ? "the fix agent" : "the script"} saw it pass alone)${error === undefined || error.length === 0 ? "" : `: ${error}`}`,
        1_000,
      ),
      createdAt: yield* deps.nowIso,
    });
    noted.push(target.key);
  });

  for (const flake of input.flakes) {
    const key = boardCiFlakeKey(flake.file, flake.title);
    if (seen.has(key)) continue;
    seen.add(key);
    // T3o (T3O-127): the project already judged this test optimised; under load it files nothing.
    if (isHonouredLoadSensitiveFlake(flake, testedTarget)) {
      loadSensitive.push(key);
      continue;
    }
    const base = refBase(card.projectId, key);
    const seed = `${input.runId}\0${base}`;
    const board = yield* deps.readBoard;
    const matches = board.cards.filter((candidate) => isFlakeCardFor(candidate, base));
    const open = matches.find(isOpen);
    if (open !== undefined) {
      // This pass already filed it from another call site: nothing more to say.
      if (open.id !== flakeCardId(seed)) yield* noteOn(open, key, flake, seed);
      else filed.push(open.key);
      continue;
    }
    const openInProject = board.cards.filter(
      (candidate) =>
        candidate.projectId === card.projectId &&
        candidate.externalRef?.system === BOARD_CI_FLAKE_REF_SYSTEM &&
        isOpen(candidate),
    ).length;
    if (
      testedIsFlakeCard ||
      filed.length >= BOARD_CI_FLAKE_CARDS_PER_PASS ||
      openInProject >= BOARD_CI_FLAKE_CARDS_OPEN_MAX
    ) {
      listed.push(key);
      continue;
    }
    // A Done card still holding the ref keeps it; the new card takes the next free suffix.
    const taken = new Set(matches.map((candidate) => candidate.externalRef?.id));
    let refId = base;
    for (let n = 2; taken.has(refId); n++) refId = `${base}${REF_SUFFIX}${n}`;
    // T3o (T3O-127): a card that reached Done counts even archived; one archived unworked does not.
    const worked = matches.filter((candidate) => candidate.stage === BOARD_SEED_STAGE_IDS.done);
    const earlier = worked.at(-1) ?? null;
    const earlierPerformance = worked.findLast(isPerformanceCard) ?? null;
    const cardId = flakeCardId(seed);
    const settings = yield* deps.settings;
    const planStage = boardStageWithRole(board, "plan");
    const planExecution =
      planStage === null
        ? null
        : resolveBoardStageExecution(
            settings,
            planStage.stageId,
            boardProjectStageConfig(board, card.projectId),
          );
    const bugLabelLive = boardLabelCatalogue(board).some(
      (label) => label.labelId === BOARD_SEED_LABEL_IDS.bug && label.deletedAt === null,
    );
    // Same project as the tested card, so the same key prefix: no prefix to assign.
    const refused = yield* dispatchAs({
      type: "board.card.create",
      keyPrefix: card.key.replace(/-\d+$/, ""),
      commandId: commandIdFor(seed, "create"),
      cardId,
      projectId: card.projectId,
      title: clip(
        `${flake.underLoad === true ? SLOW_UNDER_LOAD_PREFIX : "Flaky test: "}${key}`,
        200,
      ),
      brief: boardCiFlakeBrief({
        key,
        flake,
        testedKey: card.key,
        passOrdinal: input.passOrdinal,
        earlierKey: earlier?.key ?? null,
        earlierPerformanceKey: earlierPerformance?.key ?? null,
        ...(input.loadThreshold === undefined ? {} : { loadThreshold: input.loadThreshold }),
      }),
      ...(bugLabelLive ? { labels: [BOARD_SEED_LABEL_IDS.bug] } : {}),
      // Low, so a flake fix never queues ahead of the work it let through.
      priority: "low",
      externalRef: { system: BOARD_CI_FLAKE_REF_SYSTEM, id: refId, url: null },
      planReview: {
        ...boardPlanReviewCreationDefaults(planExecution?.kind === "simple" ? planExecution : null),
        unattended: true,
      },
      createdAt: yield* deps.nowIso,
    });
    if (refused !== null) {
      // Another card's pass filed the same test first: note it there instead.
      const raced = (yield* deps.readBoard).cards.find(
        (candidate) => isFlakeCardFor(candidate, base) && isOpen(candidate),
      );
      if (raced !== undefined) yield* noteOn(raced, key, flake, seed);
      else refusals.push(`${key}: ${refused}`);
      continue;
    }
    // Auto-merge off explicitly, so a group's Auto-merge can't merge it.
    const automationRefused = yield* dispatchAs({
      type: "board.card.set-automation",
      commandId: commandIdFor(seed, "automation"),
      cardId,
      autoPlan: true,
      autoSignOff: true,
      autoBuild: true,
      autoMerge: false,
      createdAt: yield* deps.nowIso,
    });
    if (automationRefused !== null) {
      // Without its toggles it's an ordinary Backlog card: left there for a human.
      refusals.push(
        `${key}: its automation was refused, so it stayed in Backlog: ${automationRefused}`,
      );
      continue;
    }
    const after = yield* deps.readBoard;
    const created = after.cards.find((candidate) => candidate.id === cardId);
    const createdKey = created?.key ?? refId;
    if (planStage !== null && created !== undefined && created.stage !== planStage.stageId) {
      const moveRefused = yield* dispatchAs({
        type: "board.card.move",
        commandId: commandIdFor(seed, "move"),
        cardId,
        toStage: planStage.stageId,
        override: true,
        createdAt: yield* deps.nowIso,
      });
      if (moveRefused !== null) refusals.push(`${createdKey} stayed put: ${moveRefused}`);
    }
    filed.push(createdKey);
  }

  if (filed.length + noted.length + listed.length + loadSensitive.length + refusals.length > 0) {
    const parts = [
      ...(filed.length === 0 ? [] : [`filed ${filed.join(", ")}`]),
      ...(noted.length === 0 ? [] : [`noted on ${noted.join(", ")}`]),
      ...(listed.length === 0
        ? []
        : [
            `${testedIsFlakeCard ? "not filed (a flake card files none)" : "not filed (over the limit)"}: ${listed.join(", ")}`,
          ]),
      ...(loadSensitive.length === 0
        ? []
        : [`not filed (marked load-sensitive, ran under load): ${loadSensitive.join(", ")}`]),
      ...(refusals.length === 0 ? [] : [`refused: ${refusals.join("; ")}`]),
    ];
    const inDiff = input.flakes.filter((flake) => flake.inDiff === true);
    yield* dispatchAs({
      type: "board.card.record-note",
      // Seeded by the flakes too: a resumed pass files again under the same run.
      commandId: commandIdFor(
        `${input.runId}\0${card.id}\0${[...seen].sort().join("\0")}`,
        "filed",
      ),
      cardId: card.id,
      kind: "card-ci-flakes-filed",
      detail: clip(
        [
          `CI passed over ${seen.size} flaky ${seen.size === 1 ? "test" : "tests"}: ${parts.join("; ")}.`,
          ...(inDiff.length === 0
            ? []
            : [
                `In this card's change, so the cause may be this card: ${inDiff
                  .map((flake) => boardCiFlakeKey(flake.file, flake.title))
                  .join(", ")}.`,
              ]),
        ].join(" "),
        2_000,
      ),
      createdAt: yield* deps.nowIso,
    });
  }
  return { filed, noted, listed, loadSensitive } satisfies BoardCiFlakeFiling;
});

/** A pass row's flakes: every flaky test of a step that passed over them, and the
    script-flagged flakes beside a real failure. */
export function boardCiPassFlakes(
  steps: ReadonlyArray<
    Pick<
      BoardCiPassStep,
      "name" | "command" | "status" | "result" | "flaky" | "kind" | "underLoad" | "cpuPressure"
    >
  >,
): ReadonlyArray<BoardCiFlake> {
  return steps.flatMap((step) => {
    const failures = step.result?.failures ?? [];
    const command = step.kind === undefined || step.kind === "script" ? step.command : undefined;
    const base = {
      stepName: step.name,
      ...(command === undefined ? {} : { command }),
      ...(step.cpuPressure === undefined ? {} : { cpuPressure: step.cpuPressure }),
    };
    // T3o (T3O-130): a skipped step's output vouches for nothing, flakes included.
    if (step.status === "skipped") return [];
    if (step.status === "passed") {
      return (step.flaky ?? []).map((entry): BoardCiFlake => {
        const reported = failures.find(
          (failure) => failure.title === entry.title && failure.file === entry.file,
        );
        const repro = entry.repro ?? reported?.repro;
        return {
          ...base,
          title: entry.title,
          ...(entry.file === undefined ? {} : { file: entry.file }),
          ...(reported?.detail === undefined ? {} : { detail: reported.detail }),
          ...(repro === undefined ? {} : { repro }),
          ...(entry.inDiff === true ? { inDiff: true } : {}),
          ...(entry.underLoad === true || step.underLoad === true ? { underLoad: true } : {}),
          ...(entry.loadSensitive === true && entry.byAgent !== true
            ? { loadSensitive: true }
            : {}),
          source: entry.byAgent === true ? "agent" : "script",
        };
      });
    }
    return failures.flatMap((failure): ReadonlyArray<BoardCiFlake> =>
      failure.flaky === true
        ? [
            {
              ...base,
              title: failure.title,
              ...(failure.file === undefined ? {} : { file: failure.file }),
              ...(failure.detail === undefined ? {} : { detail: failure.detail }),
              ...(failure.repro === undefined ? {} : { repro: failure.repro }),
              ...(step.underLoad === true ? { underLoad: true } : {}),
              ...(failure.loadSensitive === true ? { loadSensitive: true } : {}),
              source: "script",
            },
          ]
        : [],
    );
  });
}
