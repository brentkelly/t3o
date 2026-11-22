// @effect-diagnostics nodeBuiltinImport:off - builds a folder du can only partly read.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardMachine, parseCpuPressure } from "./machine.ts";

it.live("a worktree with an unreadable subfolder still measures, as du's total", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-du-"));
    const locked = NodePath.join(root, "locked");
    NodeFS.mkdirSync(NodePath.join(locked, "inner"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "file"), "x".repeat(64 * 1024));
    NodeFS.chmodSync(locked, 0o000);
    try {
      const bytes = yield* BoardMachine.defaultValue().diskUsageBytes(root);
      assert.isNotNull(bytes);
      assert.isAtLeast(bytes!, 64 * 1024);
    } finally {
      NodeFS.chmodSync(locked, 0o700);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);

it("reads host CPU pressure as the larger of avg10 and avg60, and unknown as null", () => {
  const psi = (some: string) =>
    `some ${some} avg300=1.00 total=123\nfull avg10=99.00 avg60=99.00 avg300=99.00 total=0\n`;
  assert.strictEqual(parseCpuPressure(psi("avg10=12.50 avg60=80.25")), 80.25);
  assert.strictEqual(parseCpuPressure(psi("avg10=91.00 avg60=40.00")), 91);
  assert.strictEqual(parseCpuPressure(psi("avg10=0.00 avg60=0.00")), 0);
  assert.isNull(parseCpuPressure(""));
  assert.isNull(parseCpuPressure("full avg10=50.00 avg60=50.00 avg300=0 total=0\n"));
});
