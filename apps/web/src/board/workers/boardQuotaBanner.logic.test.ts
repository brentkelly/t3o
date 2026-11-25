import { BOARD_LOCAL_WORKER_ID, type BoardWorkerProviderCapacity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardQuotaBannerEntries } from "./boardQuotaBanner.logic";

const LATER = "2026-01-07T18:00:00.000Z";
const SOONER = "2026-01-01T05:00:00.000Z";

type Window = BoardWorkerProviderCapacity["quota"]["windows"][number];
const window = (label: string, usedPercent: number, resetsAt: string | null, near = true) =>
  ({ label, usedPercent, resetsAt, gating: true, nearLimit: near }) satisfies Window;

const provider = (
  instanceId: string,
  windows: ReadonlyArray<Window>,
  exhausted = windows.some((entry) => entry.gating && entry.nearLimit === true),
): BoardWorkerProviderCapacity => ({
  instanceId: instanceId as never,
  driver: "claudeAgent" as never,
  account: { status: "signed-in" },
  quota: { exhausted, checkedAt: null, resetsAt: null, windows },
  agents: { running: 0, max: null },
});

const held = (workerId: string | undefined, providerInstanceId?: string) => ({
  queuedBy: "quota" as const,
  queuedDetail: {
    ...(workerId === undefined ? {} : { workerId: workerId as never }),
    ...(providerInstanceId === undefined
      ? {}
      : { providerInstanceId: providerInstanceId as never }),
  },
});

describe("boardQuotaBannerEntries", () => {
  it("lists nothing when no worker is at its threshold", () => {
    const capacity = new Map([
      [
        BOARD_LOCAL_WORKER_ID as string,
        { providers: [provider("claude", [window("Weekly", 60, LATER, false)])] },
      ],
    ]);
    expect(boardQuotaBannerEntries(capacity, [held(BOARD_LOCAL_WORKER_ID, "claude")])).toEqual([]);
    expect(boardQuotaBannerEntries(new Map(), [])).toEqual([]);
  });

  it("lists the board server and a remote worker, with their held cards", () => {
    const capacity = new Map([
      [
        BOARD_LOCAL_WORKER_ID as string,
        {
          providers: [
            provider("claude", [window("Session", 97, SOONER), window("Weekly", 100, LATER)]),
            provider("codex", [window("Weekly", 20, LATER, false)]),
          ],
        },
      ],
      ["build-01", { providers: [provider("claude", [window("Session", 96, SOONER)])] }],
    ]);
    const cards = [
      held(undefined, "claude"), // no worker named: the board server
      held(BOARD_LOCAL_WORKER_ID, "claude"),
      held(BOARD_LOCAL_WORKER_ID, "codex"),
      held("build-01"), // an older hold with no provider still counts
      {
        queuedBy: "capacity" as const,
        queuedDetail: { workerId: "build-01" as never },
      },
    ];
    expect(boardQuotaBannerEntries(capacity, cards)).toEqual([
      {
        workerId: BOARD_LOCAL_WORKER_ID,
        providerInstanceId: "claude",
        provider: "Claude",
        // The latest reset first: the hold lasts until the last window clears.
        windows: [
          { window: "weekly", percent: 100, resetsAt: LATER },
          { window: "session", percent: 97, resetsAt: SOONER },
        ],
        held: 2,
      },
      {
        workerId: "build-01",
        providerInstanceId: "claude",
        provider: "Claude",
        windows: [{ window: "session", percent: 96, resetsAt: SOONER }],
        held: 1,
      },
    ]);
  });

  it("shows a restricted worker with no card held there", () => {
    const capacity = new Map([
      ["build-01", { providers: [provider("claude", [window("Weekly", 100, null)])] }],
    ]);
    expect(boardQuotaBannerEntries(capacity, [])).toMatchObject([
      { workerId: "build-01", held: 0 },
    ]);
  });

  it("ignores a per-model window, which never gates", () => {
    const opus = { ...window("Weekly · Opus", 100, LATER, false), gating: false };
    const capacity = new Map([["build-01", { providers: [provider("claude", [opus], false)] }]]);
    expect(boardQuotaBannerEntries(capacity, [held("build-01", "claude")])).toEqual([]);
  });
});
