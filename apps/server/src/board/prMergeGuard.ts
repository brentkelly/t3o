// The board owns every card's merge (Ready for merge, Auto-merge). Upstream's
// `pull_request_merge` MCP tool would let an agent merge past those gates, so its handler calls
// this through one `T3o:` seam. Plain SQL like `upstreamGuards.ts`: the board's tables sit on the
// same connection, central or worker.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

const REFUSAL =
  "The board merges this card's pull request (Ready for merge, or Auto-merge). Leave the merge to the board; do not merge it with a tool or `gh pr merge`.";

const normalizedUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

/** Why the board refuses this merge, or null when it is not the board's to make. */
const refusalReason = (sql: SqlClient.SqlClient, callerThreadId: string, pullRequestUrl: string) =>
  Effect.gen(function* () {
    // Central: any thread a card ever linked, retired links included.
    const linked = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM boards.board_card_thread_links WHERE thread_id = ${callerThreadId}
      LIMIT 1
    `;
    if (linked.length > 0) return "card-thread";
    // Worker: a thread a central board started here.
    const relayed = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM boards.board_relayed_threads WHERE thread_id = ${callerThreadId}
      LIMIT 1
    `;
    if (relayed.length > 0) return "card-thread";
    // Any caller naming a card's PR, such as a thread an agent spawned.
    const url = normalizedUrl(pullRequestUrl);
    const cardPrs = yield* sql<{ readonly url: string }>`
      SELECT json_extract(pull_request, '$.url') AS url FROM boards.board_cards
      WHERE pull_request IS NOT NULL
    `;
    if (cardPrs.some((row) => typeof row.url === "string" && normalizedUrl(row.url) === url))
      return "card-pull-request";
    return null;
  });

/**
 * Fails when a card's thread asks to merge, in any form (stack, auto), or anyone names a card's
 * pull request. Fails closed: an unreadable board, or no database at all, refuses too.
 */
export const refuseBoardOwnedMerge = Effect.fn("board.refuseBoardOwnedMerge")(function* (
  callerThreadId: string,
  pullRequestUrl: string,
) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const reason = Option.isNone(sql)
    ? "board-unreadable"
    : yield* refusalReason(sql.value, callerThreadId, pullRequestUrl).pipe(
        Effect.catch((error) =>
          Effect.logWarning("board merge guard could not read the board; refusing", {
            error,
          }).pipe(Effect.as("board-unreadable" as const)),
        ),
      );
  if (reason === null) return;
  return yield* new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      reason === "board-unreadable"
        ? `Couldn't confirm this pull request is not a board card's, so it was not merged. ${REFUSAL}`
        : REFUSAL,
  });
});
