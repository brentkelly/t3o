// @effect-diagnostics nodeBuiltinImport:off - the tests write real scratch files for the plan to cite.
/**
 * T3O-138: the plan tools attach the temp files a plan cites, through the real handlers, engine
 * and projection, so a builder on any machine can read them as card attachments.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BOARD_CARD_ATTACHMENTS_MAX,
  BoardCardAttachmentId,
  BoardCardId,
  boardPlanId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BoardQueries } from "../../../board/BoardQueries.ts";
import { resolveBoardCardAttachmentPath } from "../../../board/attachments.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  SupervisorReactor,
  type SupervisorReactorShape,
} from "../../../board/supervisorReactor.ts";
import { boardHandlers } from "./handlers.ts";
import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "../../../board/boardStack.testkit.ts";
import * as Path from "effect/Path";

const t0 = "2026-01-01T00:00:00.000Z";
/** A scratchpad two levels under the temp root, like an agent's. */
const scratch = () => {
  const outer = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-plan-files-")),
  );
  const dir = NodePath.join(outer, "scratchpad");
  NodeFS.mkdirSync(dir);
  return {
    dir,
    file: (name: string, content: string) => {
      const target = NodePath.join(dir, name);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, content);
      return target;
    },
    [Symbol.dispose]: () => NodeFS.rmSync(outer, { recursive: true, force: true }),
  };
};

/** One test's card, thread and helpers: the suite shares a database, so ids are per test. */
const fixture = Effect.fn("fixture")(function* (name: string) {
  const projectId = ProjectId.make(`project-${name}`);
  const cardId = BoardCardId.make(`card-${name}`);
  const thread = ThreadId.make(`thread-${name}`);
  const planId = boardPlanId(cardId, "p");
  const scope = (threadId: ThreadId) =>
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-1"),
      requestNamespace: `sess-${threadId}`,
      thread: {
        threadId,
        providerSessionId: `sess-${threadId}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["board" as const]),
      issuedAt: 0,
    });
  const withScope = scope(thread);
  const engine = yield* boardStackEngine;
  const linkThread = Effect.fn("linkThread")(function* (threadId: ThreadId, card: BoardCardId) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${threadId}`),
      threadId,
      projectId,
      title: "Planning thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "board.card.link-thread",
      commandId: CommandId.make(`cmd-link-${threadId}`),
      cardId: card,
      threadId,
      role: "planning",
      createdAt: t0,
    });
  });
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${name}`),
    projectId,
    title: `Files ${name}`,
    workspaceRoot: `/tmp/t3o-plan-files-project-${name}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-card-${name}`),
    cardId,
    projectId,
    title: "Files card",
    orderKey: "m",
    createdAt: t0,
  });
  yield* linkThread(thread, cardId);

  const propose = (body: string) =>
    boardHandlers
      .board_propose_plans({
        plans: [{ key: "p", title: "Plan", summary: "s", dependsOn: [], body }],
      })
      .pipe(withScope);
  const planBody = Effect.gen(function* () {
    const queries = yield* BoardQueries;
    return (yield* queries.boardPlanBody(planId)) ?? "";
  });
  const attachments = boardHandlers.board_get_card_context().pipe(
    withScope,
    Effect.map((context) => context.attachments),
  );
  const onDisk = (fileName: string) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const target = resolveBoardCardAttachmentPath({
        path,
        stateDir: config.stateDir,
        cardId,
        name: fileName,
      });
      return target !== null && NodeFS.existsSync(target)
        ? NodeFS.readFileSync(target, "utf8")
        : null;
    });
  return {
    projectId,
    cardId,
    planId,
    engine,
    scope,
    withScope,
    linkThread,
    propose,
    planBody,
    attachments,
    onDisk,
  };
});

// Size warnings ask the supervisor only when a capacity client exists, and here none does.
const layer = makeBoardStackTestLayer("t3o-plan-files-test-").pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(Layer.succeed(SupervisorReactor, {} as SupervisorReactorShape)),
);

it.layer(layer)("plan files (T3O-138)", (it) => {
  it.effect("a cited temp file is attached, footed, and survives a projection reload", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("attach");
      const mock = pad.file("mock.html", "<p>v1</p>");
      const result = yield* f.propose(`# Plan\n\nBuild what \`${mock}\` shows.\n`);
      assert.deepStrictEqual(result.attachedFiles, [{ name: "mock.html", sourcePath: mock }]);
      assert.isUndefined(result.fileWarnings);

      const body = yield* f.planBody;
      assert.include(body, "## Attached files");
      assert.include(body, `- \`mock.html\` (from \`${mock}\`)`);
      const [entry] = yield* f.attachments;
      assert.deepInclude(entry, { name: "mock.html", sourcePath: mock, type: "file" });
      assert.strictEqual(yield* f.onDisk("mock.html"), "<p>v1</p>");

      // The tables hold the source and hash too, so a restarted server still dedupes.
      const snapshot = yield* boardStackSnapshotQuery;
      const rehydrated = (yield* snapshot.getCommandReadModel()).board?.cards.find(
        (card) => card.id === f.cardId,
      );
      assert.strictEqual(rehydrated?.attachments[0]?.sourcePath, mock);
      assert.isString(rehydrated?.attachments[0]?.contentHash);

      // Re-proposing the stored body (footer included) is a no-op.
      yield* f.propose(body);
      assert.strictEqual((yield* f.attachments).length, 1);
      assert.strictEqual((yield* f.planBody).split("## Attached files").length, 2);
    }),
  );

  it.effect("a changed file replaces its attachment, new bytes in, old file gone", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("replace");
      const mock = pad.file("mock.html", "<p>v1</p>");
      yield* f.propose(`See \`${mock}\`.`);
      pad.file("mock.html", "<p>v2</p>");
      const result = yield* f.propose(`See \`${mock}\`.`);
      // Attached under a free name first, then the old one detached: never a gap.
      assert.deepStrictEqual(result.attachedFiles, [{ name: "mock-2.html", sourcePath: mock }]);
      assert.deepStrictEqual(
        (yield* f.attachments).map((entry) => entry.name),
        ["mock-2.html"],
      );
      assert.strictEqual(yield* f.onDisk("mock-2.html"), "<p>v2</p>");
      assert.isNull(yield* f.onDisk("mock.html"));
      assert.include(yield* f.planBody, "`mock-2.html`");
    }),
  );

  it.effect("a cited directory is one archive, and a file inside it is not attached again", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("directory");
      pad.file("site/index.html", "<p>index</p>");
      pad.file("site/a.css", "p{}");
      const site = NodePath.join(pad.dir, "site");
      const body = `Use \`${site}\`, mainly \`${NodePath.join(site, "index.html")}\`.`;
      const result = yield* f.propose(body);
      assert.deepStrictEqual(result.attachedFiles, [
        { name: "site.tar.gz", sourcePath: site, memberCount: 2 },
      ]);
      assert.include(yield* f.planBody, "2 files; unpack with `tar xzf");
      yield* f.propose(body);
      assert.deepStrictEqual(
        (yield* f.attachments).map((entry) => entry.name),
        ["site.tar.gz"],
      );
    }),
  );

  it.effect("warns about what the builder won't get, and still stores the plan", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("warn");
      const gone = NodePath.join(pad.dir, "gone.html");
      const result = yield* f.propose(
        // `/etc/hosts` exists outside the allowlist; the checkout and an API route are silent.
        `Read \`/etc/hosts\` and \`${gone}\`; edit \`/tmp/t3o-plan-files-project-warn/src/a.ts\`; call \`/api/board\`.`,
      );
      assert.isUndefined(result.attachedFiles);
      assert.strictEqual(result.fileWarnings?.length, 2);
      assert.include(result.fileWarnings?.[0], "/etc/hosts");
      assert.include(result.fileWarnings?.[0], "copy it into your scratchpad");
      assert.include(result.fileWarnings?.[1], "probably wiped");
      assert.include(yield* f.planBody, "/etc/hosts");
      assert.notInclude(yield* f.planBody, "## Attached files");
    }),
  );

  it.effect("edits: [] rescans, and a section edit before the footer keeps it", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("rescan");
      const later = NodePath.join(pad.dir, "later.md");
      const first = yield* f.propose(`# Plan\n\n## Notes\n\nSee \`${later}\`.\n`);
      assert.strictEqual(first.fileWarnings?.length, 1);
      pad.file("later.md", "# later");
      const rescan = yield* boardHandlers
        .board_edit_plan({ planId: f.planId, edits: [] })
        .pipe(f.withScope);
      assert.deepStrictEqual(rescan.attachedFiles, [{ name: "later.md", sourcePath: later }]);

      // The last section runs into the footer; the edit replaces only the section.
      yield* boardHandlers
        .board_edit_plan({
          planId: f.planId,
          edits: [{ section: "## Notes", new_text: `## Notes\n\nStill \`${later}\`.\n` }],
        })
        .pipe(f.withScope);
      const body = yield* f.planBody;
      assert.include(body, "Still");
      assert.include(body, "## Attached files");
      assert.include(body, "<!-- /t3o:attached-files -->");
      assert.strictEqual((yield* f.attachments).length, 1);
    }),
  );

  it.effect("a full card warns instead of attaching", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("full");
      for (let index = 0; index < BOARD_CARD_ATTACHMENTS_MAX; index += 1) {
        yield* f.engine.dispatch({
          type: "board.card.attach",
          commandId: CommandId.make(`cmd-fill-${index}`),
          cardId: f.cardId,
          attachment: {
            id: BoardCardAttachmentId.make(`att-fill-${index}`),
            name: `fill-${index}.txt`,
            type: "file",
            mimeType: "text/plain",
            sizeBytes: 1,
            addedAt: t0,
          },
          createdAt: t0,
        });
      }
      const mock = pad.file("mock.html", "x");
      const result = yield* f.propose(`See \`${mock}\`.`);
      assert.isUndefined(result.attachedFiles);
      assert.include(result.fileWarnings?.[0], "Put the files in one directory");
    }),
  );

  it.effect("board_attach_files refuses outside paths and dedupes a clashing name", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("explicit");
      const one = pad.file("a/notes.md", "one");
      const two = pad.file("b/notes.md", "two");
      const result = yield* boardHandlers
        .board_attach_files({ paths: [one, two, "/etc/hosts"] })
        .pipe(f.withScope);
      assert.deepStrictEqual(
        result.attached.map((item) => item.name),
        ["notes.md", "notes-2.md"],
      );
      assert.deepStrictEqual(
        result.refused.map((item) => item.reason),
        ["outside-allowlist"],
      );
      assert.include(result.refused[0]?.message, "copy it into your scratchpad");
    }),
  );

  it.effect("a split child reads the files its planner attached to the parent", () =>
    Effect.gen(function* () {
      using pad = scratch();
      const f = yield* fixture("split");
      const mock = pad.file("mock.html", "<p>split</p>");
      const result = yield* boardHandlers
        .board_propose_plans({
          plans: [
            { key: "a", title: "A", summary: "s", dependsOn: [], body: `Uses \`${mock}\`.` },
            { key: "b", title: "B", summary: "s", dependsOn: [], body: "No files." },
          ],
          splitRationale: "Two independently reviewable pieces worth their own branch and review.",
        })
        .pipe(f.withScope);
      assert.deepStrictEqual(result.attachedFiles, [{ name: "mock.html", sourcePath: mock }]);
      yield* f.engine.dispatch({
        type: "board.plans.approve",
        commandId: CommandId.make("cmd-approve-split"),
        cardId: f.cardId,
        createdAt: t0,
      });
      const snapshot = yield* boardStackSnapshotQuery;
      const board = (yield* snapshot.getCommandReadModel()).board;
      const parent = board?.cards.find((card) => card.id === f.cardId);
      const child = board?.cards.find(
        (card) => card.parentCardId === f.cardId && card.title === "A",
      );
      assert.isDefined(child);
      const childThread = ThreadId.make("thread-split-child");
      yield* f.linkThread(childThread, child!.id);
      const context = yield* boardHandlers.board_get_card_context().pipe(f.scope(childThread));
      assert.deepStrictEqual(context.attachments, []);
      assert.deepInclude(context.inheritedAttachments[0], {
        name: "mock.html",
        cardKey: parent!.key,
        sourcePath: mock,
      });
    }),
  );
});
