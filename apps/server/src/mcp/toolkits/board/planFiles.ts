/**
 * T3o: the plan tools and board_attach_files put the files a plan cites onto the card (T3O-138).
 * Files are read where the calling thread runs (here, or its worker through the relay), hash
 * first so unchanged ones cost nothing, and stored as ordinary brief attachments, which already
 * reach every builder. Add or replace only: removing a file stays a human's act.
 */
import {
  BOARD_CARD_ATTACHMENTS_MAX,
  BoardCardAttachmentId,
  CommandId,
  type BoardCard,
  type BoardCardId,
  type BoardCommand,
  type BoardShareableFilesMode,
  type BoardShareableItem,
  type BoardShareableRefusalReason,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import {
  claimBoardCardAttachmentBytes,
  deleteBoardCardAttachmentFile,
} from "../../../board/attachments.ts";
import {
  extractCitedPaths,
  inspectShareableFiles,
  readShareableItem,
  SHAREABLE_CALL_MAX_BYTES,
  stripAttachedFilesFooter,
  withAttachedFilesFooter,
  type AttachedFileFooterItem,
} from "../../../board/shareableFiles.ts";
import * as ServerConfig from "../../../config.ts";
import { BoardRelayInvocation } from "./relay.ts";

export interface SharedFileRead {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
  readonly memberCount?: number | undefined;
}

/** Where the calling thread's files are: this machine, or its worker. */
export interface BoardFileSource {
  readonly inspect: (
    paths: ReadonlyArray<string>,
    mode: BoardShareableFilesMode,
  ) => Effect.Effect<ReadonlyArray<BoardShareableItem>, string>;
  readonly read: (
    sourcePath: string,
    mode: BoardShareableFilesMode,
  ) => Effect.Effect<SharedFileRead, string>;
}

const UNREACHABLE =
  "The machine this thread runs on couldn't be asked for its files, so none were attached. Re-run board_edit_plan with `edits: []` to retry (or board_attach_files).";

const describe = (cause: { readonly message: string }): string => cause.message;

/** The calling thread's file source. A relayed call reads on the worker, which enforces its
    own allowlist; anything else reads here. */
export const boardFileSource = Effect.fn("BoardPlanFiles.source")(function* (input: {
  readonly threadId: string;
  readonly checkoutRoot: string | null;
}) {
  const relayed = yield* Effect.serviceOption(BoardRelayInvocation);
  if (Option.isSome(relayed)) {
    const relay = relayed.value;
    return {
      inspect: (paths, mode) =>
        relay
          .inspectFiles({ threadId: input.threadId, paths, mode, checkoutRoot: input.checkoutRoot })
          .pipe(
            Effect.map((result) => result.items),
            Effect.mapError(() => UNREACHABLE),
          ),
      read: (sourcePath, mode) =>
        relay.readFile({ threadId: input.threadId, sourcePath, mode }).pipe(
          Effect.mapError(describe),
          Effect.flatMap((read) => {
            const bytes = Base64.decode(read.contentBase64);
            return Result.isFailure(bytes)
              ? Effect.fail(`'${sourcePath}' came back unreadable.`)
              : Effect.succeed({
                  name: read.name,
                  mimeType: read.mimeType,
                  bytes: bytes.success,
                  contentHash: read.contentHash,
                  memberCount: read.memberCount,
                });
          }),
        ),
    } satisfies BoardFileSource;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const context = (mode: BoardShareableFilesMode) => ({
    mode,
    checkoutRoot: input.checkoutRoot,
    attachmentsDir: config.attachmentsDir,
  });
  return {
    inspect: (paths, mode) =>
      provide(inspectShareableFiles(paths, context(mode))).pipe(Effect.mapError(describe)),
    read: (sourcePath, mode) =>
      provide(readShareableItem(sourcePath, context(mode))).pipe(
        Effect.mapError(describe),
        Effect.flatMap((read) =>
          "bytes" in read ? Effect.succeed<SharedFileRead>(read) : Effect.fail(read.message),
        ),
      ),
  } satisfies BoardFileSource;
});

/** One lock per card, so two calls never race an attach and a replace of the same file. */
const cardLocks = new Map<BoardCardId, Semaphore.Semaphore>();
const cardLock = (cardId: BoardCardId) => {
  let lock = cardLocks.get(cardId);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    cardLocks.set(cardId, lock);
  }
  return lock;
};

export interface AttachedSharedFile {
  readonly name: string;
  readonly sourcePath: string;
  readonly memberCount?: number;
}

export interface AttachSharedFilesResult {
  /** Every shareable item now on the card, whether attached by this call or already there. */
  readonly attached: ReadonlyArray<AttachedSharedFile & { readonly path: string }>;
  readonly refused: ReadonlyArray<{
    readonly path: string;
    readonly reason: BoardShareableRefusalReason | "card-full" | "deferred" | "failed";
    readonly message: string;
  }>;
  /** The whole call failed before any file was looked at. */
  readonly unreachable: string | null;
}

/**
 * Inspect `paths` where the thread runs and put each shareable one on the card: a no-op when
 * the same source path with the same hash is already there, a replace when its hash changed
 * (new first, then the old one detached, so there is never a gap), else an add.
 */
export const attachSharedFiles = Effect.fn("BoardPlanFiles.attach")(function* (input: {
  readonly cardId: BoardCardId;
  readonly paths: ReadonlyArray<string>;
  readonly mode: BoardShareableFilesMode;
  readonly source: BoardFileSource;
  readonly stateDir: string;
  readonly readCard: Effect.Effect<BoardCard | null>;
  readonly dispatch: (command: BoardCommand) => Effect.Effect<unknown, { readonly message: string }>;
}) {
  if (input.paths.length === 0) {
    return { attached: [], refused: [], unreachable: null } satisfies AttachSharedFilesResult;
  }
  const inspected = yield* input.source.inspect(input.paths, input.mode).pipe(Effect.result);
  if (Result.isFailure(inspected)) {
    return {
      attached: [],
      refused: [],
      unreachable: inspected.failure,
    } satisfies AttachSharedFilesResult;
  }
  const crypto = yield* SecureRandom.SecureRandom;
  const mintId = (prefix: string) =>
    crypto.uuidV4().pipe(
      Effect.orDie,
      Effect.map((uuid) => `${prefix}${uuid}`),
    );
  const attached: Array<AttachedSharedFile & { readonly path: string }> = [];
  const refused: Array<AttachSharedFilesResult["refused"][number]> = [];
  let budget = 0;

  yield* cardLock(input.cardId).withPermits(1)(
    Effect.gen(function* () {
      for (const item of inspected.success) {
        if (item.kind === "refused") {
          refused.push({ path: item.path, reason: item.reason, message: item.message });
          continue;
        }
        const memberCount = item.kind === "directory" ? item.memberCount : undefined;
        const card = yield* input.readCard;
        if (card === null) return;
        const existing = card.attachments.find(
          (attachment) => attachment.sourcePath === item.sourcePath,
        );
        const done = (name: string) =>
          attached.push({
            name,
            sourcePath: item.sourcePath,
            path: item.path,
            ...(memberCount === undefined ? {} : { memberCount }),
          });
        if (existing !== undefined && existing.contentHash === item.contentHash) {
          done(existing.name);
          continue;
        }
        if (card.attachments.length >= BOARD_CARD_ATTACHMENTS_MAX) {
          refused.push({
            path: item.path,
            reason: "card-full",
            message: `'${item.path}' was not attached: card ${card.key} already has ${BOARD_CARD_ATTACHMENTS_MAX} attachments. Put the files in one directory and cite that instead.`,
          });
          if (existing !== undefined) done(existing.name);
          continue;
        }
        if (budget + item.sizeBytes > SHAREABLE_CALL_MAX_BYTES) {
          refused.push({
            path: item.path,
            reason: "deferred",
            message: `'${item.path}' was deferred: this call already moved ${Math.round(budget / (1024 * 1024))} MiB. Re-run board_edit_plan with \`edits: []\` (or board_attach_files) to attach it.`,
          });
          if (existing !== undefined) done(existing.name);
          continue;
        }
        budget += item.sizeBytes;
        const read = yield* input.source.read(item.sourcePath, input.mode).pipe(Effect.result);
        if (Result.isFailure(read)) {
          refused.push({
            path: item.path,
            reason: "failed",
            message: `'${item.path}' was not attached: ${read.failure}`,
          });
          if (existing !== undefined) done(existing.name);
          continue;
        }
        // The read may have seen newer bytes than the inspect: equal to what is there, done.
        if (existing !== undefined && existing.contentHash === read.success.contentHash) {
          done(existing.name);
          continue;
        }
        const addedAt = DateTime.formatIso(yield* DateTime.now);
        const record = yield* claimBoardCardAttachmentBytes({
          stateDir: input.stateDir,
          card,
          attachmentId: BoardCardAttachmentId.make(yield* mintId("")),
          name: read.success.name,
          mimeType: read.success.mimeType,
          bytes: read.success.bytes,
          sourcePath: item.sourcePath,
          contentHash: read.success.contentHash,
          addedAt,
        }).pipe(Effect.result);
        if (Result.isFailure(record)) {
          refused.push({
            path: item.path,
            reason: "failed",
            message: `'${item.path}' was not attached: ${record.failure.message}`,
          });
          if (existing !== undefined) done(existing.name);
          continue;
        }
        const added = yield* input
          .dispatch({
            type: "board.card.attach",
            commandId: CommandId.make(yield* mintId("mcp:board-attach:")),
            cardId: card.id,
            attachment: record.success,
            createdAt: addedAt,
          })
          .pipe(Effect.result);
        if (Result.isFailure(added)) {
          yield* deleteBoardCardAttachmentFile({
            stateDir: input.stateDir,
            cardId: card.id,
            name: record.success.name,
          });
          refused.push({
            path: item.path,
            reason: "failed",
            message: `'${item.path}' was not attached: ${added.failure.message}`,
          });
          if (existing !== undefined) done(existing.name);
          continue;
        }
        if (existing !== undefined) {
          const detached = yield* input
            .dispatch({
              type: "board.card.detach",
              commandId: CommandId.make(yield* mintId("mcp:board-detach:")),
              cardId: card.id,
              attachmentId: existing.id,
              createdAt: addedAt,
            })
            .pipe(Effect.result);
          if (Result.isSuccess(detached)) {
            yield* deleteBoardCardAttachmentFile({
              stateDir: input.stateDir,
              cardId: card.id,
              name: existing.name,
            });
          }
        }
        done(record.success.name);
      }
    }),
  );
  return { attached, refused, unreachable: null } satisfies AttachSharedFilesResult;
});

/** Refusals a plan write stays quiet about: the repository's own files, paths that never
    existed (a plan names routes and globs too), and files that travel in a cited archive. */
const SILENT_REASONS: ReadonlySet<string> = new Set([
  "in-checkout",
  "not-found",
  "not-absolute",
  "inside-cited-directory",
]);

export interface PlanFilesScan {
  /** Each body with its footer regenerated, in input order. */
  readonly bodies: ReadonlyArray<string>;
  readonly attachedFiles: ReadonlyArray<AttachedSharedFile>;
  readonly fileWarnings: ReadonlyArray<string>;
}

/**
 * The scan every plan write runs: strip the generated footer, attach the temp-root paths the
 * plans cite, and write a footer listing what carries each one. It never blocks the write.
 */
export const scanPlanFiles = Effect.fn("BoardPlanFiles.scan")(function* <R>(input: {
  readonly bodies: ReadonlyArray<string>;
  /** Set when the plans become other cards (a split), so their footers say whose files. */
  readonly onCardKey?: string | undefined;
  readonly attach: (
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<AttachSharedFilesResult, never, R>;
  readonly readCard: Effect.Effect<BoardCard | null>;
}) {
  const stripped = input.bodies.map(stripAttachedFilesFooter);
  const cited = stripped.map(extractCitedPaths);
  const all = [...new Set(cited.flat())];
  const result = yield* input.attach(all);
  const card = yield* input.readCard;
  const byPath = new Map(result.attached.map((item) => [item.path, item]));
  const fileWarnings = [
    ...(result.unreachable === null ? [] : [result.unreachable]),
    ...result.refused
      .filter((refusal) => !SILENT_REASONS.has(refusal.reason))
      .map((refusal) => refusal.message),
  ];
  const bodies = stripped.map((body, index) => {
    const items: Array<AttachedFileFooterItem> = [];
    for (const path of cited[index] ?? []) {
      const fresh = byPath.get(path);
      // Unreachable this time: an attachment from an earlier call still carries the path.
      const earlier =
        fresh === undefined
          ? card?.attachments.find((attachment) => attachment.sourcePath === path)
          : undefined;
      if (fresh !== undefined) items.push(fresh);
      else if (earlier !== undefined) items.push({ name: earlier.name, sourcePath: path });
    }
    return withAttachedFilesFooter(body, { items, onCardKey: input.onCardKey });
  });
  return {
    bodies,
    attachedFiles: result.attached.map(({ name, sourcePath, memberCount }) => ({
      name,
      sourcePath,
      ...(memberCount === undefined ? {} : { memberCount }),
    })),
    fileWarnings,
  } satisfies PlanFilesScan;
});
