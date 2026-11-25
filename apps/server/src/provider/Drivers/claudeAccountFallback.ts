import { Effect, FileSystem, Schema } from "effect";

import type { ClaudeCapabilitiesProbe } from "../ClaudeProvider.ts";

const AccountConfig = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      organizationUuid: Schema.optional(Schema.String),
      emailAddress: Schema.optional(Schema.String),
    }),
  ),
});

export interface ClaudeOauthIdentity {
  readonly organizationUuid: string | undefined;
  readonly emailAddress: string | undefined;
}

/** The signed-in account in `.claude.json`; undefined when unreadable or signed out. */
export const readClaudeOauthIdentity = (accountConfigPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(accountConfigPath);
    const config = yield* Schema.decodeEffect(Schema.fromJsonString(AccountConfig))(raw);
    const account = config.oauthAccount;
    if (account === undefined) return undefined;
    return {
      organizationUuid: account.organizationUuid?.trim() || undefined,
      emailAddress: account.emailAddress?.trim() || undefined,
    } satisfies ClaudeOauthIdentity;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Whether a failed probe may reuse the last good account. Matching the organization alone lets
 * a re-login to another seat in the same organization republish the previous account and usage.
 */
export const claudeFallbackAllowed = (
  lastGood: Pick<ClaudeCapabilitiesProbe, "email" | "workspaceId">,
  identity: ClaudeOauthIdentity | undefined,
): boolean => {
  if (identity === undefined) {
    return lastGood.email === undefined && lastGood.workspaceId === undefined;
  }
  if (identity.organizationUuid !== lastGood.workspaceId) return false;
  return (
    identity.emailAddress === undefined ||
    identity.emailAddress.toLowerCase() === lastGood.email?.toLowerCase()
  );
};
