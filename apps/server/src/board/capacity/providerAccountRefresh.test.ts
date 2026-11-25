import type { ServerProvider } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeProviderAccountRefresh } from "./providerAccountRefresh.ts";

it.effect("invalidates the provider's probe cache before re-probing it", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const refresh = yield* makeProviderAccountRefresh({
      getInstance: Option.some((id) =>
        Effect.succeed({
          invalidateCaches: Effect.sync(() => void calls.push(`invalidate ${id}`)),
        }),
      ),
      refreshInstance: Option.some((id) =>
        Effect.sync(() => {
          calls.push(`refresh ${id}`);
          return [] as ReadonlyArray<ServerProvider>;
        }),
      ),
      home: {},
    });
    yield* refresh("claude");
    assert.deepStrictEqual(calls, ["invalidate claude", "refresh claude"]);
  }),
);

it.effect("still re-probes when the instance registry is missing", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const refresh = yield* makeProviderAccountRefresh({
      getInstance: Option.none(),
      refreshInstance: Option.some((id) =>
        Effect.sync(() => {
          calls.push(`refresh ${id}`);
          return [] as ReadonlyArray<ServerProvider>;
        }),
      ),
      home: {},
    });
    yield* refresh("claude");
    assert.deepStrictEqual(calls, ["refresh claude"]);
  }),
);
