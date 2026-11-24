// @effect-diagnostics nodeBuiltinImport:off - the tests give the attach a real state dir.
/**
 * T3O-138: the attach loop over a fake file source, for what a real worker can't easily be made
 * to do: go silent, or offer more bytes than one call may carry.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BoardCardAttachmentId,
  BOARD_CARD_ATTACHMENTS_MAX,
  BoardCardId,
  ProjectId,
  type BoardCard,
  type BoardCardAttachment,
  type BoardCommand,
  type BoardShareableItem,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SHAREABLE_CALL_MAX_BYTES } from "../../../board/shareableFiles.ts";
import { attachSharedFiles, scanPlanFiles, type BoardFileSource } from "./planFiles.ts";

const cardId = BoardCardId.make("card-fake");

const makeCard = (): BoardCard =>
  ({
    id: cardId,
    key: "T3-1",
    projectId: ProjectId.make("project-1"),
    attachments: [],
  }) as unknown as BoardCard;

const fileItem = (path: string, sizeBytes: number): BoardShareableItem => ({
  kind: "file",
  path,
  sourcePath: path,
  name: NodePath.basename(path),
  mimeType: "text/plain",
  sizeBytes,
  contentHash: `hash-${path}`,
});

/** A card held in memory, updated by the attach commands the loop dispatches. */
const harness = (source: BoardFileSource, start: BoardCard = makeCard()) => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-plan-files-unit-"));
  let card = start;
  const reads: Array<string> = [];
  const dispatched: Array<BoardCommand["type"]> = [];
  const tracked: BoardFileSource = {
    inspect: source.inspect,
    read: (sourcePath, mode) => {
      reads.push(sourcePath);
      return source.read(sourcePath, mode);
    },
  };
  return {
    reads,
    dispatched,
    attach: (paths: ReadonlyArray<string>) =>
      attachSharedFiles({
        cardId,
        paths,
        mode: "scan",
        source: tracked,
        stateDir,
        readCard: Effect.sync(() => card),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command.type);
            if (command.type === "board.card.attach") {
              card = { ...card, attachments: [...card.attachments, command.attachment] };
            }
          }),
      }),
    readCard: Effect.sync(() => card),
    [Symbol.dispose]: () => NodeFS.rmSync(stateDir, { recursive: true, force: true }),
  };
};

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe("attachSharedFiles", () => {
  it.effect("reads only what fits the call's byte budget and defers the rest", () =>
    Effect.gen(function* () {
      const half = SHAREABLE_CALL_MAX_BYTES / 2;
      using h = harness({
        inspect: (paths) =>
          Effect.succeed(
            paths.map((path) =>
              fileItem(path, path.endsWith("c") ? 1 : path.endsWith("x") ? half : half - 1),
            ),
          ),
        read: (sourcePath) =>
          Effect.succeed({
            name: NodePath.basename(sourcePath),
            mimeType: "text/plain",
            bytes: new TextEncoder().encode(sourcePath),
            contentHash: `hash-${sourcePath}`,
          }),
      });
      const result = yield* h.attach(["/tmp/s/a", "/tmp/s/b", "/tmp/s/x", "/tmp/s/c"]);
      assert.deepStrictEqual(h.reads, ["/tmp/s/a", "/tmp/s/b", "/tmp/s/c"]);
      assert.deepStrictEqual(
        result.refused.map((refusal) => [refusal.path, refusal.reason]),
        [["/tmp/s/x", "deferred"]],
      );
      assert.include(result.refused[0]?.message, "edits: []");

      // The rerun finds the first three unchanged: no bytes read for them again.
      h.reads.length = 0;
      yield* h.attach(["/tmp/s/a", "/tmp/s/b", "/tmp/s/x", "/tmp/s/c"]);
      assert.deepStrictEqual(h.reads, ["/tmp/s/x"]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("an unreachable worker attaches nothing and says how to retry", () =>
    Effect.gen(function* () {
      using h = harness({
        inspect: () => Effect.fail("The machine this thread runs on couldn't be asked."),
        read: () => Effect.fail("unused"),
      });
      const scan = yield* scanPlanFiles({
        bodies: ["See `/tmp/s/mock.html`."],
        attach: h.attach,
        readCard: h.readCard,
      });
      assert.deepStrictEqual(scan.attachedFiles, []);
      assert.deepStrictEqual(scan.fileWarnings, [
        "The machine this thread runs on couldn't be asked.",
      ]);
      // The body is stored as written, with no footer.
      assert.deepStrictEqual(scan.bodies, ["See `/tmp/s/mock.html`."]);
      assert.deepStrictEqual(h.dispatched, []);
    }).pipe(Effect.provide(services)),
  );

  it.effect("a read that fails after the inspect is a warning, not a lost plan", () =>
    Effect.gen(function* () {
      using h = harness({
        inspect: (paths) => Effect.succeed(paths.map((path) => fileItem(path, 3))),
        read: () => Effect.fail("it vanished"),
      });
      const result = yield* h.attach(["/tmp/s/a"]);
      assert.deepStrictEqual(result.attached, []);
      assert.include(result.refused[0]?.message, "it vanished");
    }).pipe(Effect.provide(services)),
  );
});

const attachment = (name: string, sourcePath?: string): BoardCardAttachment => ({
  id: BoardCardAttachmentId.make(`att-${name}`),
  name,
  type: "file",
  mimeType: "text/plain",
  sizeBytes: 1,
  addedAt: "2026-01-01T00:00:00.000Z",
  ...(sourcePath === undefined ? {} : { sourcePath, contentHash: `old-${sourcePath}` }),
});

/** A source where only `existing` paths are files; any other temp path is gone. */
const sourceOf = (existing: ReadonlyArray<string>): BoardFileSource => ({
  inspect: (paths) =>
    Effect.succeed(
      paths.map((path): BoardShareableItem =>
        existing.includes(path)
          ? fileItem(path, 1)
          : { kind: "refused", path, reason: "missing", message: `'${path}' no longer exists` },
      ),
    ),
  read: (sourcePath) =>
    Effect.succeed({
      name: NodePath.basename(sourcePath),
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(sourcePath),
      contentHash: `hash-${sourcePath}`,
    }),
});

describe("scanPlanFiles", () => {
  it.effect("a command or list in backticks attaches its paths, without a false 'gone'", () =>
    Effect.gen(function* () {
      using h = harness(sourceOf(["/tmp/s/gen.py", "/tmp/s/a.png", "/tmp/s/b.png"]));
      const scan = yield* scanPlanFiles({
        bodies: ["Run `/tmp/s/gen.py --out x`, then see `/tmp/s/a.png and /tmp/s/b.png`."],
        attach: h.attach,
        readCard: h.readCard,
      });
      assert.deepStrictEqual(
        scan.attachedFiles.map((file) => file.name),
        ["gen.py", "a.png", "b.png"],
      );
      assert.deepStrictEqual(scan.fileWarnings, []);
      // When nothing in the span exists, the warning names the path, not the whole command.
      using gone = harness(sourceOf([]));
      const missing = yield* scanPlanFiles({
        bodies: ["Run `/tmp/s/gen.py --out x`."],
        attach: gone.attach,
        readCard: gone.readCard,
      });
      assert.deepStrictEqual(missing.fileWarnings, ["'/tmp/s/gen.py' no longer exists"]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("a file an ancestor still holds keeps its footer line and its silence", () =>
    Effect.gen(function* () {
      using h = harness(sourceOf([]));
      const scan = yield* scanPlanFiles({
        bodies: ["See `/tmp/s/./mock.html`."],
        attach: h.attach,
        readCard: h.readCard,
        ancestors: [{ key: "T3-0", attachments: [attachment("mock.html", "/tmp/s/mock.html")] }],
      });
      assert.deepStrictEqual(scan.fileWarnings, []);
      assert.include(scan.bodies[0], "- `mock.html` (on T3-0) (from `/tmp/s/./mock.html`)");
    }).pipe(Effect.provide(services)),
  );

  it.effect("a changed file on a full card says the old copy stays and why", () =>
    Effect.gen(function* () {
      const full = {
        ...makeCard(),
        attachments: [
          attachment("mock.html", "/tmp/s/mock.html"),
          ...Array.from({ length: BOARD_CARD_ATTACHMENTS_MAX - 1 }, (_, index) =>
            attachment(`human-${index}.txt`),
          ),
        ],
      } as BoardCard;
      using h = harness(sourceOf(["/tmp/s/mock.html"]), full);
      const result = yield* h.attach(["/tmp/s/mock.html"]);
      assert.deepStrictEqual(
        result.attached.map((file) => file.name),
        ["mock.html"],
      );
      assert.include(result.refused[0]?.message, "still holds the old copy");
      assert.notInclude(result.refused[0]?.message, "one directory");
    }).pipe(Effect.provide(services)),
  );
});
