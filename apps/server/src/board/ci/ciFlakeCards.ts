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
  type BoardLoadSensitiveFlake,
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
  /** T3o (T3O-127): the step it flaked in ran under load. */
  readonly underLoad?: boolean;
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
  /** T3o (T3O-129): flaked on a busy machine, so onto the load-sensitive list: no card, no cap. */
  readonly loadSensitive: ReadonlyArray<string>;
  /** Flaked on a busy machine with no file to list it by: only noted. */
  readonly busyUnlisted: ReadonlyArray<string>;
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
}): string {
  const { flake } = input;
  const repro =
    flake.repro ??
    (flake.command === undefined
      ? `Re-run \`${input.key}\` with the project's test runner.`
      : `\`${flake.command}\`, then look for \`${input.key}\``);
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
    /** T3o (T3O-129): the project's resolved under-load threshold. At 100 nothing is busy,
        whatever an older worker reported. Absent counts as below 100. */
    readonly loadThreshold?: number;
  },
) {
  const { card } = input;
  const filed: string[] = [];
  const noted: string[] = [];
  const listed: string[] = [];
  const loadSensitive: string[] = [];
  const toList: BoardLoadSensitiveFlake[] = [];
  const busyUnlisted: string[] = [];
  const refusals: string[] = [];
  const loadCountsAsBusy = (input.loadThreshold ?? 0) < 100;
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
    // T3o (T3O-129): a flake on a busy machine says nothing a card could act on. It goes onto
    // the load-sensitive list, which the nightly covers. A flake card's own target never does.
    if (loadCountsAsBusy && flake.underLoad === true && key !== testedTarget) {
      if (flake.file === undefined) busyUnlisted.push(key);
      else {
        loadSensitive.push(key);
        toList.push({ key, file: flake.file, title: flake.title, cardKey: card.key });
      }
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
      title: clip(`Flaky test: ${key}`, 200),
      brief: boardCiFlakeBrief({
        key,
        flake,
        testedKey: card.key,
        passOrdinal: input.passOrdinal,
        earlierKey: earlier?.key ?? null,
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

  if (toList.length > 0) {
    const sortedKeys = toList.map((entry) => entry.key).sort();
    const refused = yield* dispatchAs({
      type: "board.project.record-load-sensitive",
      // Seeded by the keys too: a resumed pass records more under the same run.
      commandId: commandIdFor(
        `${input.runId}\0${card.projectId}\0${sortedKeys.join("\0")}`,
        "load-sensitive",
      ),
      projectId: card.projectId,
      runId: input.runId,
      entries: toList,
      createdAt: yield* deps.nowIso,
    });
    if (refused !== null) refusals.push(`the load-sensitive list: ${refused}`);
  }

  if (
    filed.length +
      noted.length +
      listed.length +
      loadSensitive.length +
      busyUnlisted.length +
      refusals.length >
    0
  ) {
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
        : [`flaked under load, added to the load-sensitive list: ${loadSensitive.join(", ")}`]),
      ...(busyUnlisted.length === 0
        ? []
        : [`flaked under load, not filed: ${busyUnlisted.join(", ")}`]),
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
  return { filed, noted, listed, loadSensitive, busyUnlisted } satisfies BoardCiFlakeFiling;
});

/** A pass row's flakes: every flaky test of a step that passed over them, and the
    script-flagged flakes beside a real failure. */
export function boardCiPassFlakes(
  steps: ReadonlyArray<
    Pick<
      BoardCiPassStep,
      "name" | "command" | "status" | "result" | "flaky" | "kind" | "underLoad"
    >
  >,
): ReadonlyArray<BoardCiFlake> {
  return steps.flatMap((step) => {
    const failures = step.result?.failures ?? [];
    const command = step.kind === undefined || step.kind === "script" ? step.command : undefined;
    const base = {
      stepName: step.name,
      ...(command === undefined ? {} : { command }),
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
              source: "script",
            },
          ]
        : [],
    );
  });
}

/** T3o (T3O-129): every test a pass's steps deferred to the nightly, by key, once each. A
    skipped step vouches for nothing, its deferrals included. */
export function boardCiPassDeferred(
  steps: ReadonlyArray<Pick<BoardCiPassStep, "status" | "deferred">>,
): ReadonlyArray<string> {
  const keys = new Set<string>();
  for (const step of steps) {
    if (step.status === "skipped") continue;
    for (const test of step.deferred ?? []) keys.add(boardCiFlakeKey(test.file, test.title));
  }
  return [...keys];
}

/** T3o (T3O-129): note on the tested card the tests its pass deferred to the nightly. Once per
    run, at the run's real end: the command id is seeded by the run alone. */
export const noteBoardCiDeferred = Effect.fn("BoardCiFlakeCards.noteDeferred")(function* (
  deps: Pick<BoardCiFlakeFilingDeps, "dispatch" | "nowIso">,
  input: {
    readonly card: Pick<BoardCard, "id">;
    readonly runId: string;
    readonly steps: ReadonlyArray<Pick<BoardCiPassStep, "status" | "deferred">>;
  },
) {
  const deferred = boardCiPassDeferred(input.steps);
  if (deferred.length === 0) return;
  const command: BoardCommand = {
    type: "board.card.record-note",
    commandId: commandIdFor(`${input.runId}\0${input.card.id}`, "deferred"),
    cardId: input.card.id,
    kind: "card-ci-deferred",
    detail: clip(
      `${deferred.length} load-sensitive ${deferred.length === 1 ? "test" : "tests"} deferred to the nightly: ${deferred.join(", ")}.`,
      2_000,
    ),
    createdAt: yield* deps.nowIso,
  };
  stampBoardActivityActor(command.commandId, { ...BOARD_CI_FLAKE_ACTOR, name: "CI: deferred tests" });
  yield* deps.dispatch(command);
});
