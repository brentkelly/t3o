import { BOARD_LOCAL_WORKER_ID, type BoardWorkerProviderCapacity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { refreshAccountsBlocked, refreshAccountsLines } from "./refreshAccounts.logic";

const provider = (
  account: BoardWorkerProviderCapacity["account"],
  windows: BoardWorkerProviderCapacity["quota"]["windows"] = [],
) =>
  ({
    driver: "claudeAgent",
    account,
    quota: { exhausted: false, checkedAt: null, resetsAt: null, windows },
  }) as Pick<BoardWorkerProviderCapacity, "driver" | "account" | "quota">;

describe("refreshAccountsBlocked", () => {
  it.each([
    ["the board server", BOARD_LOCAL_WORKER_ID, "online", null, null],
    ["an online current worker", "w1", "online", 7, null],
    ["an offline worker", "w1", "offline", 7, "Offline"],
    ["an older worker", "w1", "online", 6, "Needs a T3o update"],
    ["a worker that never said", "w1", "online", null, "Needs a T3o update"],
  ] as const)("%s", (_name, workerId, state, protocolVersion, expected) => {
    expect(refreshAccountsBlocked(workerId, { state, protocolVersion })).toBe(expected);
  });
});

describe("refreshAccountsLines", () => {
  it("names the account read and its gating windows", () => {
    expect(
      refreshAccountsLines([
        provider({ status: "signed-in", email: "dana@acme.io" }, [
          { label: "Session", usedPercent: 3.4, resetsAt: null, gating: true },
          { label: "Weekly", usedPercent: 12, resetsAt: null, gating: true },
          { label: "Opus weekly", usedPercent: 90, resetsAt: null, gating: false },
        ]),
        provider({ status: "unknown" }),
        provider({ status: "signed-out" }),
      ]),
    ).toEqual([
      "Claude: dana@acme.io · Session 3% · Weekly 12%",
      "Claude: account unknown",
      "Claude: signed out",
    ]);
  });
});
