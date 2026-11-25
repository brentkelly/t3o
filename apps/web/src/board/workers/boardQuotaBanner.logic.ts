/**
 * T3o (T3O-139): what a provider at its quota threshold holds up. The card pill and the board
 * banner both read it from the workers' capacity snapshots, never from new wire data.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  PROVIDER_DISPLAY_NAMES,
  type BoardCardShell,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerProviderCapacity,
  type ProviderDriverKind,
} from "@t3tools/contracts";

/** One usage window at the worker's threshold: "weekly", 95, its reset. */
export interface BoardQuotaWindow {
  /** Lower-cased for "Claude weekly limit". */
  readonly window: string;
  readonly percent: number;
  readonly resetsAt: string | null;
}

export interface BoardQuotaBannerEntry {
  readonly workerId: string;
  readonly providerInstanceId: string;
  /** "Claude". */
  readonly provider: string;
  /** Latest reset first: the card waits for the last of them. */
  readonly windows: ReadonlyArray<BoardQuotaWindow>;
  /** This board's cards held for quota there. */
  readonly held: number;
}

export const boardQuotaProviderName = (provider: Pick<BoardWorkerProviderCapacity, "driver">) =>
  PROVIDER_DISPLAY_NAMES[provider.driver as ProviderDriverKind] ?? provider.driver;

/** "Wed 6:00 pm": a weekly window can be days away, so the clock alone isn't enough. */
export const boardQuotaResetClock = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The windows refusing placements, latest reset first (an unknown reset last). */
export function boardQuotaNearLimitWindows(
  provider: Pick<BoardWorkerProviderCapacity, "quota">,
): ReadonlyArray<BoardQuotaWindow> {
  if (!provider.quota.exhausted) return [];
  return provider.quota.windows
    .filter((window) => window.gating && window.nearLimit === true)
    .map((window) => ({
      window: window.label.charAt(0).toLowerCase() + window.label.slice(1),
      percent: Math.round(window.usedPercent),
      resetsAt: window.resetsAt,
    }))
    .toSorted((a, b) =>
      a.resetsAt === b.resetsAt
        ? 0
        : a.resetsAt === null
          ? 1
          : b.resetsAt === null
            ? -1
            : b.resetsAt.localeCompare(a.resetsAt),
    );
}

type QuotaCard = Pick<BoardCardShell, "workerId" | "queuedBy" | "queuedDetail">;

const quotaHeldOn = (card: QuotaCard, workerId: string, providerInstanceId: string) =>
  card.queuedBy === "quota" &&
  (card.queuedDetail?.workerId ?? card.workerId ?? BOARD_LOCAL_WORKER_ID) === workerId &&
  (card.queuedDetail?.providerInstanceId === undefined ||
    card.queuedDetail.providerInstanceId === providerInstanceId);

/** One entry per worker and provider at its threshold, whether or not a card waits on it. */
export function boardQuotaBannerEntries(
  capacity: ReadonlyMap<string, Pick<BoardWorkerCapacitySnapshot, "providers">>,
  cards: ReadonlyArray<QuotaCard>,
): ReadonlyArray<BoardQuotaBannerEntry> {
  const entries: Array<BoardQuotaBannerEntry> = [];
  for (const [workerId, snapshot] of capacity) {
    for (const provider of snapshot.providers) {
      const windows = boardQuotaNearLimitWindows(provider);
      if (windows.length === 0) continue;
      entries.push({
        workerId,
        providerInstanceId: provider.instanceId,
        provider: boardQuotaProviderName(provider),
        windows,
        held: cards.filter((card) => quotaHeldOn(card, workerId, provider.instanceId)).length,
      });
    }
  }
  return entries;
}
