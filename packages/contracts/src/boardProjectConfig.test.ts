import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SEED_STAGES,
  BoardClientCommand,
  BoardCommand,
  BoardSettingsClientCommand,
  DEFAULT_BOARD_SETTINGS,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  EMPTY_BOARD_STATE,
  BOARD_CI_LOAD_SENSITIVE_MAX,
  boardCiStepGroups,
  boardCiStepsRefusal,
  boardLiveLoadSensitive,
  boardLoadSensitiveUpsert,
  boardNewStageOrderKey,
  boardProjectConfigVersion,
  boardProjectDeltaNewTexts,
  boardProjectStageConfigShell,
  boardStageOrderViolation,
  normalizeBoardProjectDelta,
  parseBoardCiFailureLine,
  parseBoardCiProgressLine,
  parseBoardCiResultFile,
  ProviderInstanceId,
  type BoardCiStep,
  type BoardSettings,
  type BoardStageDefinition,
} from "./index.ts";

const decodeClientCommandOption = Schema.decodeUnknownOption(BoardClientCommand);
const decodeSettingsCommandOption = Schema.decodeUnknownOption(BoardSettingsClientCommand);
const decodeCommandOption = Schema.decodeUnknownOption(BoardCommand);
const decodeSettingsCommand = Schema.decodeUnknownSync(BoardSettingsClientCommand);

const script = (id: string, parallel = false): BoardCiStep => ({
  kind: "script",
  id,
  name: id,
  parallel,
  command: `run ${id}`,
  timeoutMinutes: 30,
});
const agent = (id: string): BoardCiStep => ({
  kind: "agent",
  id,
  name: id,
  parallel: false,
  prompt: `check ${id}`,
  model: null,
  timeoutMinutes: 30,
});

describe("CI step lists", () => {
  it("groups consecutive parallel scripts and runs every other step alone", () => {
    const groups = boardCiStepGroups([
      script("a"),
      script("b", true),
      script("c", true),
      agent("d"),
      script("e"),
    ]);
    expect(groups.map((group) => group.map((step) => step.id))).toEqual([
      ["a", "b", "c"],
      ["d"],
      ["e"],
    ]);
  });

  it("refuses parallel off a non-script, duplicate ids, too many steps and unsupported kinds", () => {
    expect(boardCiStepsRefusal([script("a"), script("b", true)])).toBeNull();
    expect(boardCiStepsRefusal([agent("a"), script("b", true)])).toContain("can't run in parallel");
    expect(boardCiStepsRefusal([script("a", true)])).toContain("can't run in parallel");
    expect(boardCiStepsRefusal([script("a"), script("a")])).toContain("share the id");
    expect(
      boardCiStepsRefusal(Array.from({ length: 13 }, (_, index) => script(`s${index}`))),
    ).toContain("at most 12");
    expect(boardCiStepsRefusal([agent("a")], { scriptOnly: true })).toContain("only script");
  });
});

describe("stage order", () => {
  const stage = (stageId: string, orderKey: string): BoardStageDefinition => ({
    stageId: stageId as never,
    label: stageId,
    role: null,
    orderKey,
    createdAt: "x",
    updatedAt: "x",
    projectId: null,
  });

  it("refuses a role-less stage between CI and the merge stage", () => {
    expect(boardStageOrderViolation(BOARD_SEED_STAGES)).toBeNull();
    expect(boardStageOrderViolation([...BOARD_SEED_STAGES, stage("late", "mm")])).toContain(
      "between Continuous integration",
    );
  });

  it("places a new stage just before CI", () => {
    const key = boardNewStageOrderKey(EMPTY_BOARD_STATE)!;
    expect(key > "l" && key < "m").toBe(true);
  });
});

describe("normalization and version", () => {
  it("drops switches equal to the default, unswitchable stages and overrides equal to global", () => {
    const normalized = normalizeBoardProjectDelta({
      board: EMPTY_BOARD_STATE,
      settings: DEFAULT_BOARD_SETTINGS,
      delta: {
        stageSwitches: { backlog: true, sprint: false, review: false, ready: false, nope: true },
        overrides: {
          ci: { maxFixAttempts: 5, maxRoundTrips: 5, autoExecute: false },
          building: { prompt: DEFAULT_BOARD_SETTINGS.pipeline.building?.prompt ?? "x" },
          nope: { autoExecute: true },
        },
        ci: { steps: [] },
      },
    });
    expect(normalized.stageSwitches).toEqual({ sprint: false });
    // `maxRoundTrips` is no longer a CI key, so a stored one is dropped.
    expect(normalized.overrides.ci).toEqual({ autoExecute: false });
    // A prompt override is kept even when it matches: it pins the text.
    expect(normalized.overrides.building).toHaveProperty("prompt");
    expect(normalized.overrides).not.toHaveProperty("nope");
  });

  it("keeps a later-rounds review model whole, even when its round matches global", () => {
    const review = DEFAULT_BOARD_SETTINGS.pipeline.review;
    if (review?.kind !== "review") throw new Error("expected the review member");
    const globalLater = {
      afterRound: 2,
      model: { instanceId: ProviderInstanceId.make("codex"), model: "a" },
    };
    const settings = {
      ...DEFAULT_BOARD_SETTINGS,
      pipeline: {
        ...DEFAULT_BOARD_SETTINGS.pipeline,
        review: { ...review, laterReviewModel: globalLater },
      },
    } satisfies BoardSettings;
    const laterReviewModel = {
      afterRound: 2,
      model: { instanceId: ProviderInstanceId.make("codex"), model: "b" },
    };
    const normalized = normalizeBoardProjectDelta({
      board: EMPTY_BOARD_STATE,
      settings,
      delta: { stageSwitches: {}, overrides: { review: { laterReviewModel } }, ci: { steps: [] } },
    });
    expect(normalized.overrides.review).toEqual({ laterReviewModel });
    const same = normalizeBoardProjectDelta({
      board: EMPTY_BOARD_STATE,
      settings,
      delta: {
        stageSwitches: {},
        overrides: { review: { laterReviewModel: globalLater } },
        ci: { steps: [] },
      },
    });
    expect(same.overrides).toEqual({});
  });

  it("hashes the delta only, whatever order its keys were built in", () => {
    const a = boardProjectConfigVersion({
      stageSwitches: { a: true, b: false },
      overrides: {},
      ci: { steps: [] },
    });
    const b = boardProjectConfigVersion({
      stageSwitches: { b: false, a: true },
      overrides: {},
      ci: { steps: [] },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(EMPTY_BOARD_PROJECT_STAGE_CONFIG.version);
  });

  it("strips prompts and step bodies from the shell", () => {
    const shell = boardProjectStageConfigShell({
      ...EMPTY_BOARD_PROJECT_STAGE_CONFIG,
      overrides: { review: { prompt: "secret", rounds: 2, phases: { triage: { prompt: "p" } } } },
      ci: { steps: [script("a")] },
    });
    expect(shell.overrides).toEqual({ review: { rounds: 2, phases: { triage: {} } } });
    expect(shell.ciSteps).toEqual([{ id: "a", name: "a", kind: "script", parallel: false }]);
  });

  it("lists every new command and prompt for the import confirmation", () => {
    const texts = boardProjectDeltaNewTexts(
      { stageSwitches: {}, overrides: {}, ci: { steps: [script("a")] } },
      {
        stageSwitches: {},
        overrides: { building: { prompt: "Build carefully" } },
        ci: { steps: [script("a"), script("b")] },
      },
    );
    expect(texts).toEqual([
      { where: 'CI step "b"', kind: "command", text: "run b" },
      { where: "building", kind: "prompt", text: "Build carefully" },
    ]);
  });

  it("lists the permission settings an import changes", () => {
    const texts = boardProjectDeltaNewTexts(
      { stageSwitches: {}, overrides: { building: { autoExecute: true } }, ci: { steps: [] } },
      {
        stageSwitches: {},
        overrides: {
          building: { autoExecute: true, runtimeMode: "full-access", humanInLoop: false },
          review: { rounds: 2 },
        },
        ci: { steps: [] },
      },
    );
    expect(texts).toEqual([
      { where: "building.runtimeMode", kind: "setting", text: "full-access" },
      { where: "building.humanInLoop", kind: "setting", text: "false" },
    ]);
  });

  it("lists the permission settings an import removes", () => {
    const texts = boardProjectDeltaNewTexts(
      {
        stageSwitches: {},
        overrides: { building: { autoExecute: false, humanInLoop: true } },
        ci: { steps: [] },
      },
      { stageSwitches: {}, overrides: { building: { humanInLoop: true } }, ci: { steps: [] } },
    );
    expect(texts).toEqual([
      { where: "building.autoExecute", kind: "setting", text: "removed (was false)" },
    ]);
  });
});

describe("settings commands", () => {
  const command = {
    type: "board.project.set-stage-switch",
    commandId: "c1",
    projectId: "p1",
    stageId: "sprint",
    on: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("never decode through board.dispatchCommand", () => {
    expect(decodeClientCommandOption(command)._tag).toBe("None");
    expect(decodeSettingsCommandOption(command)._tag).toBe("Some");
    expect(decodeCommandOption(command)._tag).toBe("Some");
    const stageCreate = {
      type: "board.stage.create",
      commandId: "c2",
      stageId: "qa",
      label: "QA",
      orderKey: "k",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decodeClientCommandOption(stageCreate)._tag).toBe("None");
  });

  it("leave the actor for the server to stamp", () => {
    const decoded = decodeSettingsCommand(command);
    expect("actor" in decoded).toBe(false);
  });
});

describe("script reporting", () => {
  it("parses progress lines, and treats anything else as log output", () => {
    expect(
      parseBoardCiProgressLine('::t3o-progress::{"message":"Running","done":3,"total":9}'),
    ).toEqual({ message: "Running", done: 3, total: 9 });
    expect(parseBoardCiProgressLine("::t3o-progress::{nope")).toBeNull();
    expect(parseBoardCiProgressLine("plain output")).toBeNull();
  });

  it("parses a failure line, capped, and treats one without a reason as log output", () => {
    expect(
      parseBoardCiFailureLine(
        '  ::t3o-failure::{"step":" lint ","reason":"No files to lint","machine":false}',
      ),
    ).toEqual({ step: "lint", reason: "No files to lint", machine: false, flaky: null });
    expect(parseBoardCiFailureLine('::t3o-failure::{"reason":"x"}')).toEqual({
      step: null,
      reason: "x",
      machine: null,
      flaky: null,
    });
    expect(parseBoardCiFailureLine('::t3o-failure::{"reason":"x","flaky":true}')?.flaky).toBe(true);
    const long = parseBoardCiFailureLine(
      `::t3o-failure::${JSON.stringify({ step: "s".repeat(200), reason: "r".repeat(900) })}`,
    );
    expect(long?.step).toHaveLength(80);
    expect(long?.reason).toHaveLength(300);
    expect(parseBoardCiFailureLine('::t3o-failure::{"step":"lint"}')).toBeNull();
    expect(parseBoardCiFailureLine("::t3o-failure::{nope")).toBeNull();
  });

  it("keeps a result-file failure's machine flag", () => {
    const parsed = parseBoardCiResultFile(
      JSON.stringify({ failures: [{ title: "browser", machine: true }] }),
    );
    expect(parsed.result?.failures).toEqual([{ title: "browser", machine: true }]);
  });

  it("keeps a result-file failure's flaky flag and repro command (T3O-126)", () => {
    const parsed = parseBoardCiResultFile(
      JSON.stringify({ failures: [{ title: "adds", flaky: true, repro: "vp test a" }] }),
    );
    expect(parsed.result?.failures).toEqual([{ title: "adds", flaky: true, repro: "vp test a" }]);
  });

  it("keeps a failure's load-sensitive mark and the skipped-under-load count (T3O-127)", () => {
    const parsed = parseBoardCiResultFile(
      JSON.stringify({
        skippedUnderLoad: 3,
        failures: [{ title: "slow", flaky: true, loadSensitive: true }],
      }),
    );
    expect(parsed.result).toEqual({
      summary: null,
      skippedUnderLoad: 3,
      failures: [{ title: "slow", flaky: true, loadSensitive: true }],
    });
    // A bad count is ignored, never a failure.
    const bad = parseBoardCiResultFile(JSON.stringify({ skippedUnderLoad: -1, failures: [] }));
    expect(bad.result).toEqual({ summary: null, failures: [] });
    expect(bad.complete).toBe(true);
  });

  it("keeps a step's deferred tests, dropping bad entries (T3O-129)", () => {
    const parsed = parseBoardCiResultFile(
      JSON.stringify({
        failures: [],
        deferred: [{ file: "e2e/a.spec.ts", title: "slow" }, { title: "no file" }, { file: "x" }],
      }),
    );
    expect(parsed.result?.deferred).toEqual([
      { file: "e2e/a.spec.ts", title: "slow" },
      { title: "no file" },
    ]);
    // Deferred tests are no failures: the step's judgement doesn't change.
    expect(parsed.complete).toBe(true);
    const many = Array.from({ length: 80 }, (_, index) => ({ title: `t${index}` }));
    expect(
      parseBoardCiResultFile(JSON.stringify({ failures: [], deferred: many })).result?.deferred,
    ).toHaveLength(50);
  });

  it("clips an over-long failure field rather than dropping the failure (T3O-126)", () => {
    const parsed = parseBoardCiResultFile(
      JSON.stringify({ failures: [{ title: "real", detail: "x".repeat(5_000) }] }),
    );
    expect(parsed.result?.failures[0]?.detail).toHaveLength(4_000);
    expect(parsed.complete).toBe(true);
  });

  it("keeps valid failures of a result file, capped, and warns about the rest", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ title: `f${index}` }));
    const parsed = parseBoardCiResultFile(
      JSON.stringify({ summary: " 2 failed ", failures: [...many, { detail: "no title" }] }),
    );
    expect(parsed.result?.summary).toBe("2 failed");
    expect(parsed.result?.failures).toHaveLength(50);
    expect(parsed.warning).toContain("1 of the step's reported failures");
    expect(parsed.complete).toBe(false);
    expect(parseBoardCiResultFile("[]").result).toBeNull();
    expect(parseBoardCiResultFile("{").warning).toContain("isn't valid JSON");
  });
});

describe("load-sensitive list (T3O-129)", () => {
  const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const flake = (title: string) => ({
    key: `a.spec.ts › ${title}`,
    file: "a.spec.ts",
    title,
    cardKey: "T3O-1",
  });

  it("adds, refreshes once per run, and prunes what expired", () => {
    const first = boardLoadSensitiveUpsert(undefined, [flake("slow")], "run-1", at(1));
    expect(first).toEqual([
      { ...flake("slow"), lastFlakedAt: at(1), flakes: 1, lastRunId: "run-1" },
    ]);
    // The same run filing twice (failed finish, then a flaky resume) counts once.
    const again = boardLoadSensitiveUpsert(first, [flake("slow")], "run-1", at(2));
    expect(again[0]?.flakes).toBe(1);
    expect(again[0]?.lastFlakedAt).toBe(at(2));
    const later = boardLoadSensitiveUpsert(again, [flake("slow"), flake("new")], "run-2", at(3));
    expect(later.map((entry) => [entry.title, entry.flakes])).toEqual([
      ["slow", 2],
      ["new", 1],
    ]);
    // Fourteen days after its last flake an entry is gone, and the next upsert drops it.
    const pruned = boardLoadSensitiveUpsert(later, [flake("fresh")], "run-3", at(17));
    expect(pruned.map((entry) => entry.title)).toEqual(["fresh"]);
  });

  it("evicts the oldest past the cap", () => {
    const full = Array.from(
      { length: BOARD_CI_LOAD_SENSITIVE_MAX },
      (_, index) =>
        boardLoadSensitiveUpsert(
          undefined,
          [flake(`t${index}`)],
          "run",
          at(index === 0 ? 1 : 2),
        )[0]!,
    );
    const next = boardLoadSensitiveUpsert(full, [flake("over")], "run-x", at(3));
    expect(next).toHaveLength(BOARD_CI_LOAD_SENSITIVE_MAX);
    expect(next.some((entry) => entry.title === "t0")).toBe(false);
    expect(next.at(-1)?.title).toBe("over");
  });

  it("reads an entry live until fourteen days after its last flake", () => {
    const [entry] = boardLoadSensitiveUpsert(undefined, [flake("slow")], "run", at(1));
    expect(boardLiveLoadSensitive([entry!], "2026-11-14T23:59:59.999Z")).toHaveLength(1);
    expect(boardLiveLoadSensitive([entry!], at(15))).toHaveLength(0);
    expect(boardLiveLoadSensitive(undefined, at(1))).toEqual([]);
  });

  it("puts only a revision on the shell, and moves it on every change", () => {
    const one = boardLoadSensitiveUpsert(undefined, [flake("a"), flake("b")], "run", at(1));
    const config = { ...EMPTY_BOARD_PROJECT_STAGE_CONFIG, loadSensitive: one };
    const shell = boardProjectStageConfigShell(config);
    expect(shell).not.toHaveProperty("loadSensitive");
    expect(shell.loadSensitiveRevision).toBeDefined();
    const removed = boardProjectStageConfigShell({ ...config, loadSensitive: one.slice(1) });
    expect(removed.loadSensitiveRevision).not.toBe(shell.loadSensitiveRevision);
    expect(boardProjectStageConfigShell(EMPTY_BOARD_PROJECT_STAGE_CONFIG)).not.toHaveProperty(
      "loadSensitiveRevision",
    );
    // The list is the board's record: it never moves the version a human's edit expects.
    expect(boardProjectConfigVersion(config)).toBe(EMPTY_BOARD_PROJECT_STAGE_CONFIG.version);
  });
});
