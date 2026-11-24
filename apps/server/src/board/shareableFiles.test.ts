// @effect-diagnostics nodeBuiltinImport:off - the tests build real temp trees.
/**
 * T3O-138: which cited paths a plan may share, what the archive of a directory is, and the
 * generated footer.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  extractCitedPaths,
  inspectShareableFiles,
  readShareableItem,
  SHAREABLE_DIRECTORY_MAX_MEMBERS,
  SHAREABLE_ITEM_MAX_BYTES,
  stripAttachedFilesFooter,
  withAttachedFilesFooter,
  writeTarGz,
  type ShareableContext,
} from "./shareableFiles.ts";

/** A private temp root, so the tests never depend on the machine's real /tmp. */
const makeRoot = () => {
  const outer = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-share-")),
  );
  const root = NodePath.join(outer, "root");
  NodeFS.mkdirSync(root);
  return { outer, root, [Symbol.dispose]: () => NodeFS.rmSync(outer, { recursive: true }) };
};

const context = (root: string, overrides: Partial<ShareableContext> = {}): ShareableContext => ({
  mode: "scan",
  checkoutRoot: null,
  attachmentsDir: null,
  tempRoots: [root],
  ...overrides,
});

const write = (file: string, content: string | Uint8Array) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, content);
};

describe("extractCitedPaths", () => {
  const rows: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    ["backticked", "See `/tmp/s/mock.html` for the layout.", ["/tmp/s/mock.html"]],
    ["bare with punctuation", "Open /tmp/s/mock.html.", ["/tmp/s/mock.html"]],
    ["line and column", "Bug at `/tmp/s/a.ts:42:7`.", ["/tmp/s/a.ts"]],
    ["markdown link", "[mock](/tmp/s/mock.html)", ["/tmp/s/mock.html"]],
    ["home path", "Use `~/notes/a.md`", ["~/notes/a.md"]],
    ["windows drive", "Use `C:\\Users\\me\\a.txt`", ["C:\\Users\\me\\a.txt"]],
    ["space inside backticks", "`/tmp/s/my file.txt`", ["/tmp/s/my file.txt", "/tmp/s/my"]],
    [
      "a command span offers its path too",
      "Run `/tmp/s/gen.py --out x`",
      ["/tmp/s/gen.py --out x", "/tmp/s/gen.py"],
    ],
    [
      "a span listing two paths offers each",
      "See `/tmp/s/a.png and /tmp/s/b.png`",
      ["/tmp/s/a.png and /tmp/s/b.png", "/tmp/s/a.png", "/tmp/s/b.png"],
    ],
    ["a glob keeps its pattern", "Shots in `/tmp/s/shots/*.png`.", ["/tmp/s/shots/*.png"]],
    ["emphasis stars are not a glob", "*see /tmp/s/a.md*", ["/tmp/s/a.md"]],
    ["urls and relative paths ignored", "https://x.dev/a and src/a.ts and //cdn", []],
    ["bare root ignored", "the root `/` itself", []],
    ["repeats collapse", "`/tmp/a` then /tmp/a again", ["/tmp/a"]],
  ];
  it.each(rows)("%s", (_name, text, expected) =>
    assert.deepStrictEqual(extractCitedPaths(text), expected),
  );

  it("ignores the generated footer", () => {
    const body = withAttachedFilesFooter("Plan cites `/tmp/s/a.html`.", {
      items: [{ name: "b.html", sourcePath: "/tmp/s/b.html" }],
    });
    assert.include(body, "/tmp/s/b.html");
    assert.deepStrictEqual(extractCitedPaths(body), ["/tmp/s/a.html"]);
  });
});

describe("the footer", () => {
  it("leaves a body alone that only mentions the marker", () => {
    const inline =
      "# Plan\n\nThe footer opens with `<!-- t3o:attached-files -->` in the body.\n\n## Steps\n\n1. do it\n";
    assert.strictEqual(stripAttachedFilesFooter(inline), inline);
    // A footer with plan text after it is no generated footer either.
    const footer = withAttachedFilesFooter("# Plan\n", {
      items: [{ name: "a.html", sourcePath: "/tmp/s/a.html" }],
    });
    const followed = `${footer}\n## More\n`;
    assert.strictEqual(stripAttachedFilesFooter(followed), followed);
  });

  it("round-trips: stripping a rendered footer gives back the plan", () => {
    const plan = "# Plan\n\nBody `/tmp/s/a.html`.\n";
    const body = withAttachedFilesFooter(plan, {
      items: [{ name: "site.tar.gz", sourcePath: "/tmp/s/site", memberCount: 3 }],
      onCardKey: "T3O-1",
    });
    assert.include(body, "`site.tar.gz` (on T3O-1) (from `/tmp/s/site`; 3 files; unpack with");
    assert.strictEqual(stripAttachedFilesFooter(body), plan);
    // Regenerating replaces it rather than stacking a second one.
    const again = withAttachedFilesFooter(body, { items: [{ name: "x", sourcePath: "/tmp/x" }] });
    assert.strictEqual(again.split("## Attached files").length, 2);
    assert.strictEqual(withAttachedFilesFooter(body, { items: [] }), plan);
  });
});

describe("writeTarGz", () => {
  it("is deterministic and uses ustar's prefix for long paths", () => {
    const long = `${"d".repeat(120)}/file.txt`;
    const members = [
      { path: "site/b.txt", bytes: new TextEncoder().encode("b") },
      { path: "site/a.txt", bytes: new TextEncoder().encode("a") },
      { path: long, bytes: new TextEncoder().encode("long") },
    ];
    const first = writeTarGz(members);
    const second = writeTarGz([...members].reverse());
    assert.deepStrictEqual(first.bytes, second.bytes);
    assert.deepStrictEqual(first.dropped, []);
    const tar = NodeZlib.gunzipSync(first.bytes);
    const header = (index: number) => tar.subarray(index * 512, index * 512 + 512);
    const text = (block: Buffer, start: number, length: number) =>
      block
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    // Sorted: the long path's `d…` directory sorts before `site/`.
    assert.strictEqual(text(header(0), 0, 100), "file.txt");
    assert.strictEqual(text(header(0), 345, 155), "d".repeat(120));
    assert.strictEqual(text(header(0), 257, 6), "ustar");
  });

  it("drops a member whose path ustar cannot hold", () => {
    const result = writeTarGz([{ path: "x".repeat(300), bytes: new Uint8Array(1) }]);
    assert.deepStrictEqual(result.dropped, ["x".repeat(300)]);
  });
});

describe("inspectShareableFiles", () => {
  it.effect("shares a temp file and refuses what lies outside the allowlist", () =>
    Effect.gen(function* () {
      using tree = makeRoot();
      write(NodePath.join(tree.root, "s", "mock.html"), "<p>hi</p>");
      // A link inside the root that escapes it is judged by its target.
      write(NodePath.join(tree.outer, "secret.txt"), "secret");
      NodeFS.symlinkSync(
        NodePath.join(tree.outer, "secret.txt"),
        NodePath.join(tree.root, "s", "link.txt"),
      );
      const items = yield* inspectShareableFiles(
        [
          NodePath.join(tree.root, "s", "mock.html"),
          NodePath.join(tree.root, "s", "link.txt"),
          "/etc/hosts",
          NodePath.join(tree.root, "s", "gone.html"),
          "/definitely/not/here",
        ],
        context(tree.root),
      );
      assert.deepInclude(items[0], { kind: "file", name: "mock.html", mimeType: "text/html" });
      assert.deepInclude(items[1], { kind: "refused", reason: "outside-allowlist" });
      assert.deepInclude(items[2], { kind: "refused", reason: "outside-allowlist" });
      assert.deepInclude(items[3], { kind: "refused", reason: "missing" });
      assert.deepInclude(items[4], { kind: "refused", reason: "not-found" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a temp root and a direct child of one as a directory", () =>
    Effect.gen(function* () {
      using tree = makeRoot();
      NodeFS.mkdirSync(NodePath.join(tree.root, "session"));
      const items = yield* inspectShareableFiles(
        [tree.root, NodePath.join(tree.root, "session")],
        context(tree.root),
      );
      assert.deepInclude(items[0], { kind: "refused", reason: "temp-root" });
      assert.deepInclude(items[1], { kind: "refused", reason: "temp-root" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a file another uid owns", () =>
    Effect.gen(function* () {
      // No uids on Windows.
      if (typeof process.getuid !== "function") return;
      using tree = makeRoot();
      write(NodePath.join(tree.root, "s", "a.txt"), "a");
      const items = yield* inspectShareableFiles(
        [NodePath.join(tree.root, "s", "a.txt")],
        context(tree.root, { uid: (process.getuid?.() ?? 0) + 1 }),
      );
      assert.deepInclude(items[0], { kind: "refused", reason: "not-owned" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips paths in the checkout, and the chat dir only for an explicit attach", () =>
    Effect.gen(function* () {
      using tree = makeRoot();
      const checkout = NodePath.join(tree.root, "s", "repo");
      write(NodePath.join(checkout, "src", "a.ts"), "a");
      const chat = NodePath.join(tree.outer, "attachments");
      write(NodePath.join(chat, "t", "shot.png"), "png");
      const paths = [NodePath.join(checkout, "src", "a.ts"), NodePath.join(chat, "t", "shot.png")];
      const scan = yield* inspectShareableFiles(
        paths,
        context(tree.root, { checkoutRoot: checkout, attachmentsDir: chat }),
      );
      assert.deepInclude(scan[0], { kind: "refused", reason: "in-checkout" });
      assert.deepInclude(scan[1], { kind: "refused", reason: "outside-allowlist" });
      const explicit = yield* inspectShareableFiles(
        paths,
        context(tree.root, { mode: "explicit", checkoutRoot: checkout, attachmentsDir: chat }),
      );
      assert.deepInclude(explicit[1], { kind: "file", name: "shot.png" });
      // A linked chat dir still expands a glob in it.
      const linkedChat = NodePath.join(tree.outer, "linked-attachments");
      NodeFS.symlinkSync(chat, linkedChat);
      const glob = NodePath.join(chat, "t", "*.png");
      const globbed = yield* inspectShareableFiles(
        [glob],
        context(tree.root, { mode: "explicit", attachmentsDir: linkedChat }),
      );
      assert.deepInclude(globbed[0], { kind: "file", path: glob, name: "shot.png" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("archives a directory, and a file inside it is not offered on its own", () =>
    Effect.gen(function* () {
      using tree = makeRoot();
      const site = NodePath.join(tree.root, "s", "site");
      write(NodePath.join(site, "index.html"), "<p>index</p>");
      write(NodePath.join(site, "css", "a.css"), "p{}");
      const items = yield* inspectShareableFiles(
        [site, NodePath.join(site, "index.html")],
        context(tree.root),
      );
      assert.deepInclude(items[0], { kind: "directory", name: "site.tar.gz", memberCount: 2 });
      assert.deepInclude(items[1], { kind: "refused", reason: "inside-cited-directory" });

      const read = yield* readShareableItem(site, context(tree.root));
      assert.ok("bytes" in read);
      // Inspect and read agree on the hash, so an unchanged directory is a no-op.
      assert.strictEqual(
        read.contentHash,
        items[0]?.kind === "directory" ? items[0].contentHash : "",
      );
      const again = yield* readShareableItem(site, context(tree.root));
      assert.ok("bytes" in again);
      assert.deepStrictEqual(again.bytes, read.bytes);
      const tar = NodeZlib.gunzipSync(read.bytes);
      assert.include(tar.subarray(0, 100).toString("utf8"), "site/css/a.css");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("expands a glob in the last segment and reports each match under it", () =>
    Effect.gen(function* () {
      using tree = makeRoot();
      const shots = NodePath.join(tree.root, "s", "shots");
      write(NodePath.join(shots, "a.png"), "a");
      write(NodePath.join(shots, "b.png"), "b");
      write(NodePath.join(shots, "notes.txt"), "n");
      const glob = NodePath.join(shots, "*.png");
      const items = yield* inspectShareableFiles(
        [glob, NodePath.join(shots, "*.gif")],
        context(tree.root),
      );
      assert.deepStrictEqual(
        items.map((item) => [item.kind, item.path, "name" in item ? item.name : item.reason]),
        [
          ["file", glob, "a.png"],
          ["file", glob, "b.png"],
          ["refused", NodePath.join(shots, "*.gif"), "not-found"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("names the members an archive can't hold rather than dropping them silently", () =>
    Effect.gen(function* () {
      using tree = makeRoot();
      const site = NodePath.join(tree.root, "s", "site");
      write(NodePath.join(site, "index.html"), "i");
      const long = NodePath.join(site, "x".repeat(120));
      write(long, "l");
      write(NodePath.join(tree.outer, "secret.txt"), "secret");
      const escaping = NodePath.join(site, "y-escape");
      NodeFS.symlinkSync(NodePath.join(tree.outer, "secret.txt"), escaping);
      const broken = NodePath.join(site, "z-broken");
      NodeFS.symlinkSync(NodePath.join(site, "gone"), broken);
      const items = yield* inspectShareableFiles([site], context(tree.root));
      assert.deepInclude(items[0], { kind: "directory", memberCount: 1 });
      assert.deepStrictEqual(
        items.slice(1).map((item) => [item.path, item.kind === "refused" ? item.reason : ""]),
        [
          [long, "not-archivable"],
          [escaping, "not-archivable"],
          [broken, "not-archivable"],
        ],
      );
      const read = yield* readShareableItem(site, context(tree.root));
      assert.ok("bytes" in read);
      assert.strictEqual(
        read.contentHash,
        items[0]?.kind === "directory" ? items[0].contentHash : "",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("enforces the size and member caps", () =>
    Effect.gen(function* () {
      using tree = makeRoot();
      const big = NodePath.join(tree.root, "s", "big.bin");
      write(big, new Uint8Array(SHAREABLE_ITEM_MAX_BYTES + 1));
      const many = NodePath.join(tree.root, "s", "many");
      for (let index = 0; index <= SHAREABLE_DIRECTORY_MAX_MEMBERS; index += 1) {
        write(NodePath.join(many, `f${index}.txt`), "x");
      }
      const items = yield* inspectShareableFiles([big, many], context(tree.root));
      assert.deepInclude(items[0], { kind: "refused", reason: "too-large" });
      assert.deepInclude(items[1], { kind: "refused", reason: "too-many-members" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
