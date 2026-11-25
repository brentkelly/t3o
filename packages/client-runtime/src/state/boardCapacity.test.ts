import type { BoardWorkerCapacitySnapshot, BoardWorkerProviderCapacity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type BoardCapacityView, boardQuotaView, EMPTY_BOARD_QUOTA_VIEW } from "./boardCapacity.ts";

const provider = (usedPercent: number, running = 0): BoardWorkerProviderCapacity => ({
  instanceId: "claude" as never,
  driver: "claudeAgent" as never,
  account: { status: "signed-in" },
  quota: {
    exhausted: usedPercent >= 95,
    checkedAt: null,
    resetsAt: null,
    windows: [
      { label: "Session", usedPercent, resetsAt: null, gating: true, nearLimit: usedPercent >= 95 },
    ],
  },
  agents: { running, max: null },
});

const view = (
  usedPercent: number,
  options: { readonly free?: number; readonly running?: number } = {},
): BoardCapacityView =>
  new Map([
    [
      "local",
      {
        at: "2026-01-01T00:00:00.000Z",
        declared: { cpuCores: 8, ramGiB: 32, diskGB: 100 },
        headroom: { cpuCores: options.free ?? 4, ramGiB: 16, diskGB: 50 },
        over: { cpuRam: false, disk: false },
        agents: { running: options.running ?? 0, max: null },
        providers: [provider(usedPercent, options.running)],
        readiness: [],
        heavyCards: [],
      } satisfies BoardWorkerCapacitySnapshot,
    ],
  ]);

describe("boardQuotaView", () => {
  it("is empty while no provider is at its threshold", () => {
    expect(boardQuotaView(view(40), EMPTY_BOARD_QUOTA_VIEW)).toBe(EMPTY_BOARD_QUOTA_VIEW);
  });

  it("keeps its previous value until a quota reading changes", () => {
    const first = boardQuotaView(view(96), EMPTY_BOARD_QUOTA_VIEW);
    expect([...first.keys()]).toEqual(["local"]);
    // Headroom and running agents move all the time; the board need not hear of it.
    expect(boardQuotaView(view(96, { free: 1, running: 3 }), first)).toBe(first);
    const moved = boardQuotaView(view(98), first);
    expect(moved).not.toBe(first);
    expect(moved.get("local")?.providers[0]?.quota.windows[0]?.usedPercent).toBe(98);
    expect(boardQuotaView(view(40), moved)).toBe(EMPTY_BOARD_QUOTA_VIEW);
  });
});
