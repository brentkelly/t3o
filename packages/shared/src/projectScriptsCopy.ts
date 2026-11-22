import type { ProjectScript } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
// T3o: T3O-23 — remove scripts read (teardown) in the menu.
import { t3oProjectScriptMenuLabel } from "./t3oProjectScriptLabel.ts";

/** @public */
export function projectScriptMenuLabel(
  script: ProjectScript,
  resolve: MFunctionType = mFallback,
): string {
  if (script.runOnWorktreeRemove === true) return t3oProjectScriptMenuLabel(script); // T3o: T3O-23
  const name = script.name;
  if (script.runOnWorktreeCreate && script.runOnSettle) {
    return resolve(msg("{name} (setup, on settle)", { name }));
  }
  if (script.runOnWorktreeCreate) return resolve(msg("{name} (setup)", { name }));
  if (script.runOnSettle) return resolve(msg("{name} (on settle)", { name }));
  return name;
}
