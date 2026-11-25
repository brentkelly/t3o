/**
 * T3o (T3O-140): Refresh accounts in a worker's … menu. A worker reads its providers' sign-in
 * itself, so the toast names the account it read: a stale one means a login made elsewhere.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_ACCOUNTS_PROTOCOL,
  type BoardWorkerProviderCapacity,
  type BoardWorkerStatus,
} from "@t3tools/contracts";

import { boardQuotaProviderName } from "./boardQuotaBanner.logic";

/** Why Refresh accounts can't run on this worker, or null when it can. */
export function refreshAccountsBlocked(
  workerId: string,
  status: Pick<BoardWorkerStatus, "state" | "protocolVersion">,
): string | null {
  if (workerId === BOARD_LOCAL_WORKER_ID) return null;
  if (status.state !== "online") return "Offline";
  if ((status.protocolVersion ?? 0) < BOARD_WORKER_ACCOUNTS_PROTOCOL) return "Needs a T3o update";
  return null;
}

/** "Claude: dana@acme.io · Weekly 12%", one line per provider the worker read. A driver with
    several instances names each one, so their lines can be told apart. */
export function refreshAccountsLines(
  providers: ReadonlyArray<
    Pick<BoardWorkerProviderCapacity, "instanceId" | "driver" | "account" | "quota">
  >,
): ReadonlyArray<string> {
  return providers.map((provider) => {
    const shared = providers.filter((other) => other.driver === provider.driver).length > 1;
    const name = shared
      ? `${boardQuotaProviderName(provider)} (${provider.instanceId})`
      : boardQuotaProviderName(provider);
    const account =
      provider.account.email ??
      (provider.account.status === "signed-out" ? "signed out" : "account unknown");
    const windows = provider.quota.windows
      .filter((window) => window.gating)
      .map((window) => `${window.label} ${Math.round(window.usedPercent)}%`);
    return [`${name}: ${account}`, ...windows].join(" · ");
  });
}
