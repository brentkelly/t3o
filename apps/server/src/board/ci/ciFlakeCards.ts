/**
 * T3o (T3O-126): every flaky CI test becomes a bug card in its project, auto-planned and
 * auto-built but never auto-merged, so a human comes back to a fix ready to merge. A test is
 * matched by `boardCiFlakeKey` on the card's external ref: one open card per test, and a
 * repeat flake adds a note to it. The only path on which the board turns automation on for a
 * card nobody asked for, so it is bounded: a few new cards per pass, none past a per-project
 * ceiling, and a flake card never files cards of its own.
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
  type BoardCommand,
  type BoardSettings,
  type BoardState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { stampBoardActivityActor } from "../activityActors.ts";
import type { BoardCardCreateInput } from "../createCard.ts";

export const BOARD_CI_FLAKE_REF_SYSTEM = "t3o-flaky";
/** New flake cards one pass may file. */
export const BOARD_CI_FLAKE_CARDS_PER_PASS = 3;
/** Open flake cards a project may hold before flakes are only listed. */
export const BOARD_CI_FLAKE_CARDS_OPEN_MAX = 10;

const REF_ID_MAX = 200;
const DETAIL_MAX = 2_000;

export const BOARD_CI_FLAKE_ACTOR: BoardActivityActor = {
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
}

export interface BoardCiFlakeFilingDeps {
  readonly readBoard: Effect.Effect<BoardState>;
  readonly settings: Effect.Effect<BoardSettings>;
  /** Dispatch; the decider's refusal sentence, or null when it landed. */
  readonly dispatch: (command: BoardCommand) => Effect.Effect<string | null>;
  /** Create a card through `createBoardCard`, as `BOARD_CI_FLAKE_ACTOR`. */
  readonly create: (create: BoardCardCreateInput) => Effect.Effect<string | null>;
  readonly nowIso: Effect.Effect<string>;
}

export interface BoardCiFlakeFiling {
  readonly filed: ReadonlyArray<string>;
  readonly noted: ReadonlyArray<string>;
  /** Flakes over a limit, only listed on the tested card. */
  readonly listed: ReadonlyArray<string>;
}

const refBase = (projectId: string, key: string) => `${projectId}:${key}`.slice(0, REF_ID_MAX);

/** The flake key a flake card exists to fix, or null for any other card. */
export function boardCiFlakeCardTarget(
  card: Pick<BoardCard, "projectId" | "externalRef">,
): string | null {
  const ref = card.externalRef;
  if (ref === null || ref.system !== BOARD_CI_FLAKE_REF_SYSTEM) return null;
  const prefix = `${card.projectId}:`;
  const id = ref.id.replace(/#\d+$/, "");
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

const isFlakeCardFor = (card: BoardCard, base: string) => {
  const ref = card.externalRef;
  return (
    ref !== null &&
    ref.system === BOARD_CI_FLAKE_REF_SYSTEM &&
    (ref.id === base || ref.id.startsWith(`${base}#`))
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

export function boardCiFlakeBrief(input: {
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
  },
) {
  const { card } = input;
  const filed: string[] = [];
  const noted: string[] = [];
  const listed: string[] = [];
  const refusals: string[] = [];
  const seen = new Set<string>();
  const testedIsFlakeCard = boardCiFlakeCardTarget(card) !== null;
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
    const base = refBase(card.projectId, key);
    const seed = `${input.runId}\0${base}`;
    const board = yield* deps.readBoard;
    const matches = board.cards.filter((candidate) => isFlakeCardFor(candidate, base));
    const open = matches.find(isOpen);
    if (open !== undefined) {
      yield* noteOn(open, key, flake, seed);
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
    for (let n = 2; taken.has(refId); n++) refId = `${base.slice(0, REF_ID_MAX - 4)}#${n}`;
    const earlier = matches.findLast((candidate) => candidate.archivedAt === null) ?? null;
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
    const refused = yield* deps.create({
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
      externalRef: { system: BOARD_CI_FLAKE_REF_SYSTEM, id: refId, url: null },
      planReview: {
        ...boardPlanReviewCreationDefaults(
          planExecution?.kind === "simple" ? planExecution : null,
        ),
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
    // Auto-merge off explicitly, so a board- or project-wide Auto-merge can't merge it.
    yield* dispatchAs({
      type: "board.card.set-automation",
      commandId: commandIdFor(seed, "automation"),
      cardId,
      autoPlan: true,
      autoSignOff: true,
      autoBuild: true,
      autoMerge: false,
      createdAt: yield* deps.nowIso,
    });
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

  if (filed.length + noted.length + listed.length + refusals.length > 0) {
    const parts = [
      ...(filed.length === 0 ? [] : [`filed ${filed.join(", ")}`]),
      ...(noted.length === 0 ? [] : [`noted on ${noted.join(", ")}`]),
      ...(listed.length === 0
        ? []
        : [
            `${testedIsFlakeCard ? "not filed (a flake card files none)" : "not filed (over the limit)"}: ${listed.join(", ")}`,
          ]),
      ...(refusals.length === 0 ? [] : [`refused: ${refusals.join("; ")}`]),
    ];
    const inDiff = input.flakes.filter((flake) => flake.inDiff === true);
    yield* dispatchAs({
      type: "board.card.record-note",
      commandId: commandIdFor(`${input.runId}\0${card.id}`, "filed"),
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
  return { filed, noted, listed } satisfies BoardCiFlakeFiling;
});
