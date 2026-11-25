import { BOARD_LOCAL_WORKER_ID, EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { resolveBoardWorkerRef } from "./BoardWorkers.ts";

const W1 = EnvironmentId.make("worker-1");
const state = {
  localLabel: "Studio",
  workers: [{ id: W1, label: "mesh-worker-01" }],
} as unknown as Parameters<typeof resolveBoardWorkerRef>[0];

it("resolves a worker by id, label or the board server's own name", () => {
  const rows: ReadonlyArray<readonly [string, string | null]> = [
    ["worker-1", W1],
    ["Mesh-Worker-01", W1],
    ["local", BOARD_LOCAL_WORKER_ID],
    ["studio", BOARD_LOCAL_WORKER_ID],
    ["nope", null],
  ];
  for (const [ref, expected] of rows) {
    const resolved = resolveBoardWorkerRef(state, ref);
    if (expected === null) {
      assert.include(resolved.found ? "" : resolved.message, "mesh-worker-01 (worker-1)", ref);
    } else {
      assert.strictEqual(resolved.found ? resolved.workerId : null, expected, ref);
    }
  }
});
