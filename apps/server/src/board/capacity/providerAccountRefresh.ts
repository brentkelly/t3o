import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { WorkerCapacityPorts } from "./BoardWorkerCapacity.ts";

interface ProviderAccountRefreshDeps {
  readonly refreshInstance: Option.Option<
    (instanceId: ProviderInstanceId) => Effect.Effect<ReadonlyArray<ServerProvider>>
  >;
  readonly getInstance: Option.Option<
    (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<{ readonly invalidateCaches?: Effect.Effect<void> } | undefined>
  >;
  /** Logged beside the account so a login made as another user or home diagnoses itself. */
  readonly home: Readonly<Record<string, string | null>>;
}

/** Invalidating first is what makes a re-login show: Claude's probe cache outlives it. */
export const makeProviderAccountRefresh = Effect.fn("BoardWorkerCapacity.makeAccountRefresh")(
  function* (deps: ProviderAccountRefreshDeps) {
    if (Option.isSome(deps.refreshInstance) && Option.isNone(deps.getInstance)) {
      yield* Effect.logWarning(
        "board worker has no provider instance registry: account refreshes reuse cached probes",
      );
    }
    /** The account each provider last read, so the log names it only when it changes. */
    let accountsRead = new Map<string, string>();
    const refresh: WorkerCapacityPorts["refreshProviderAccount"] = (instanceId, options) =>
      Option.match(deps.refreshInstance, {
        onNone: () => Effect.void,
        onSome: Effect.fn("BoardWorkerCapacity.refreshProviderAccount")(
          function* (refreshInstance) {
            const id = instanceId as ProviderInstanceId;
            const instance = Option.isSome(deps.getInstance)
              ? yield* deps.getInstance.value(id)
              : undefined;
            yield* instance?.invalidateCaches ?? Effect.void;
            const providers = yield* refreshInstance(id);
            const provider = providers.find((candidate) => candidate.instanceId === instanceId);
            const account = provider?.auth.email ?? `auth ${provider?.auth.status ?? "missing"}`;
            if (options?.manual !== true && accountsRead.get(instanceId) === account) return;
            accountsRead = new Map(accountsRead).set(instanceId, account);
            yield* Effect.logInfo("board worker read provider account", {
              instanceId,
              account,
              ...deps.home,
            });
          },
        ),
      });
    return refresh;
  },
);
