import type { ProjectScript } from "@t3tools/contracts";

// T3o: T3O-23 — a remove (teardown) script's menu label. Teardown is fork-only and English-only.
export function t3oProjectScriptMenuLabel(script: ProjectScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? ["setup"] : []),
    ...(script.runOnSettle ? ["on settle"] : []),
    "teardown",
  ];
  return `${script.name} (${roles.join(", ")})`;
}
