import "server-only";

import type { AudienceMetric, AudiencePlatform, AudiencePrimaryMetric } from "@/lib/types";
import {
  AUDIENCE_SAMPLE_BUCKET_MS,
  AUDIENCE_SNAPSHOT_VERSION,
  audienceGrowthFromHistory,
  nextAudienceHistory,
  type AudienceAccountHistory,
  type AudienceSnapshotHistory,
} from "@/lib/audience-growth";
import { audienceAccountFingerprint } from "@/lib/public-metrics";
import type { StoredSettings } from "@/lib/server/settings";
import {
  cachedMetric,
  collectAccount,
  readSnapshots,
  usernameFor,
  writeSnapshots,
} from "@/lib/server/audience";
import { getDatabase } from "@/lib/server/database";
import {
  latestAudienceManualEntries,
  localCalendarDay,
  pruneAudienceManualEntries,
  readAudienceManualEntry,
  writeAudienceManualEntry,
  type AudienceManualEntry,
} from "@/lib/audience-manual-store";

type Account = StoredSettings["audience"]["accounts"][number];

/**
 * The Wire: unauthenticated profile scrapes are throttled by the platforms, not
 * by us. Ten seconds between sequential requests keeps a full sweep under the
 * rate limits that got the original concurrent batch IP-banned.
 */
export const AUDIENCE_STAGGER_MS = 10_000;
export const AUDIENCE_MANUAL_SOURCE = "Manual entry";

declare global {
  var theWireAudienceQueue: Promise<unknown> | undefined;
}

/**
 * Every refresh path performs a read-modify-write on a single snapshots.json, so
 * they run one at a time. Concurrent runs would silently drop history.
 */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalThis.theWireAudienceQueue ?? Promise.resolve();
  const run = previous.then(task, task);
  globalThis.theWireAudienceQueue = run.then(() => undefined, () => undefined);
  return run;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedHandle(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function defaultPrimaryLabel(platform: AudiencePlatform): AudiencePrimaryMetric {
  return platform === "youtube" ? "subscribers" : "followers";
}

function displayHandle(account: Account) {
  return usernameFor(account) || account.username || account.profileUrl || account.accountId || account.label;
}

/** An account that has never produced a reading, so the UI can show it as waiting. */
function pendingMetric(account: Account, checkedAt: string): AudienceMetric {
  return {
    id: account.id,
    platform: account.platform,
    label: account.label,
    handle: displayHandle(account),
    total: null,
    change: null,
    checkedAt,
  };
}

/**
 * A reading already on disk. Scraped values keep the upstream "(cached)" label so
 * the existing badge still reads true; a hand-entered value is not a cached
 * scrape, so it is reported as itself.
 */
function storedMetric(account: Account, prior: AudienceAccountHistory): AudienceMetric {
  if (prior.latest.source !== AUDIENCE_MANUAL_SOURCE) return cachedMetric(account, prior);
  return {
    id: account.id,
    platform: account.platform,
    label: account.label,
    handle: prior.latest.handle || displayHandle(account),
    total: prior.latest.total,
    ...audienceGrowthFromHistory(prior),
    primaryLabel: prior.latest.primaryLabel,
    secondaryLabel: prior.latest.secondaryLabel,
    secondaryValue: prior.latest.secondaryValue,
    checkedAt: prior.latest.checkedAt,
    source: AUDIENCE_MANUAL_SOURCE,
  };
}

/** A failed check: report the last known value and leave stored history untouched. */
function lastKnownMetric(
  account: Account,
  prior: AudienceAccountHistory | undefined,
  checkedAt: string,
  error: unknown,
): AudienceMetric {
  const latest = prior?.latest;
  return {
    id: account.id,
    platform: account.platform,
    label: account.label,
    handle: latest?.handle || displayHandle(account),
    total: latest?.total ?? null,
    ...(prior ? audienceGrowthFromHistory(prior) : { change: null }),
    primaryLabel: latest?.primaryLabel,
    secondaryLabel: latest?.secondaryLabel,
    secondaryValue: latest?.secondaryValue,
    checkedAt,
    error: error instanceof Error ? error.message : "Unknown provider error",
    stale: Boolean(prior),
    lastSuccessfulAt: latest?.checkedAt,
  };
}

function priorFor(snapshots: AudienceSnapshotHistory, account: Account) {
  const saved = snapshots.accounts[account.id];
  return saved?.fingerprint === audienceAccountFingerprint(account) ? saved : undefined;
}

/**
 * Resolve `?platform=&handle=` (or the unambiguous `?id=`) to a configured account.
 * Handles are compared without a leading @ and case-insensitively, because that is
 * how people actually type them.
 */
export function resolveAudienceTarget(
  settings: StoredSettings,
  target: { platform?: string | null; handle?: string | null; id?: string | null },
) {
  const accounts = settings.audience.accounts;
  const handle = target.handle ? normalizedHandle(target.handle) : "";
  const platform = target.platform ? target.platform.trim().toLowerCase() : "";
  const candidates = platform ? accounts.filter((account) => account.platform === platform) : accounts;
  const byHandle = handle
    ? candidates.find((account) =>
        [usernameFor(account), account.username, account.accountId, account.label]
          .filter(Boolean)
          .some((value) => normalizedHandle(value) === handle),
      )
    : candidates.length === 1 && (platform || target.id === null || target.id === undefined)
      ? candidates[0]
      : undefined;
  if (byHandle) return byHandle;
  // A handle can drift after a rename; the account id is stable, so it is the fallback.
  return target.id ? (accounts.find((account) => account.id === target.id) ?? null) : null;
}

/** Read stored readings without touching the network. This is the default GET path. */
export async function readAudienceMetrics(settings: StoredSettings): Promise<AudienceMetric[]> {
  const snapshots = await readSnapshots();
  const checkedAt = new Date().toISOString();
  return settings.audience.accounts.map((account) => {
    const prior = priorFor(snapshots, account);
    return prior ? storedMetric(account, prior) : pendingMetric(account, checkedAt);
  });
}

/**
 * Refresh accounts one at a time, pausing `staggerMs` between requests. Accounts
 * outside `only` are returned from storage and never contacted. A failure skips
 * that record entirely: its stored history is left exactly as it was, and the
 * sweep continues.
 */
export async function refreshAudienceAccounts(
  settings: StoredSettings,
  options: { only?: Account[]; staggerMs?: number } = {},
): Promise<AudienceMetric[]> {
  const staggerMs = options.staggerMs ?? AUDIENCE_STAGGER_MS;
  const targetIds = options.only ? new Set(options.only.map((account) => account.id)) : null;
  return serialize(async () => {
    const previous = await readSnapshots();
    const next: AudienceSnapshotHistory = {
      version: AUDIENCE_SNAPSHOT_VERSION,
      accounts: { ...previous.accounts },
    };
    const checkedAt = new Date().toISOString();
    const results: AudienceMetric[] = [];
    let attempted = 0;
    for (const account of settings.audience.accounts) {
      const fingerprint = audienceAccountFingerprint(account);
      const saved = previous.accounts[account.id];
      const prior = saved?.fingerprint === fingerprint ? saved : undefined;
      if (saved && !prior) delete next.accounts[account.id];
      if (targetIds && !targetIds.has(account.id)) {
        results.push(prior ? storedMetric(account, prior) : pendingMetric(account, checkedAt));
        continue;
      }
      if (attempted > 0 && staggerMs > 0) await delay(staggerMs);
      attempted += 1;
      try {
        const current = await collectAccount(account);
        const history = nextAudienceHistory(
          {
            total: current.total,
            checkedAt,
            handle: current.handle,
            secondaryLabel: current.secondaryLabel,
            secondaryValue: current.secondaryValue,
            source: current.source,
            primaryLabel: current.primaryLabel,
          },
          fingerprint,
          prior,
        );
        next.accounts[account.id] = history;
        results.push({
          id: account.id,
          platform: account.platform,
          label: account.label,
          handle: current.handle,
          total: current.total,
          ...audienceGrowthFromHistory(history),
          primaryLabel: current.primaryLabel,
          secondaryLabel: current.secondaryLabel,
          secondaryValue: current.secondaryValue,
          checkedAt,
          source: current.source,
        });
      } catch (error) {
        results.push(lastKnownMetric(account, prior, checkedAt, error));
      }
    }
    await writeSnapshots(next);
    return results;
  });
}

export type ManualEntryResult =
  | { status: "created" | "replaced"; entry: AudienceManualEntry; metric: AudienceMetric }
  | { status: "duplicate"; existing: AudienceManualEntry };

/**
 * Record a hand-entered reading. No network request is made: the value goes into
 * the snapshot history so the charts pick it up, and into SQLite as a manual-entry
 * ledger row carrying the optional note and the calendar day that enforces the
 * one-per-account-per-day rule.
 */
export async function recordManualAudienceEntry(
  settings: StoredSettings,
  input: { account: Account; total: number; note?: string; replace?: boolean; now?: Date },
): Promise<ManualEntryResult> {
  const { account, total } = input;
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error("A manual audience entry must be a whole number of zero or more.");
  const now = input.now ?? new Date();
  const entryDay = localCalendarDay(now);
  const database = getDatabase();
  const existing = readAudienceManualEntry(database, account.id, entryDay);
  if (existing && !input.replace) return { status: "duplicate", existing };

  return serialize(async () => {
    const previous = await readSnapshots();
    const fingerprint = audienceAccountFingerprint(account);
    const prior = priorFor(previous, account);
    const checkedAt = now.toISOString();
    const primaryLabel = prior?.latest.primaryLabel ?? defaultPrimaryLabel(account.platform);
    const handle = prior?.latest.handle || displayHandle(account);
    const bucket = Math.floor(now.getTime() / AUDIENCE_SAMPLE_BUCKET_MS);
    // A hand-entered value is authoritative for its 12-hour bucket, so drop any
    // scraped sample already sitting there instead of letting it win the dedupe.
    const trimmed = prior
      ? {
          ...prior,
          samples: prior.samples.filter(
            (sample) => Math.floor(Date.parse(sample.checkedAt) / AUDIENCE_SAMPLE_BUCKET_MS) !== bucket,
          ),
        }
      : undefined;
    const history = nextAudienceHistory(
      { total, checkedAt, handle, primaryLabel, source: AUDIENCE_MANUAL_SOURCE },
      fingerprint,
      trimmed,
    );
    await writeSnapshots({
      version: AUDIENCE_SNAPSHOT_VERSION,
      accounts: { ...previous.accounts, [account.id]: history },
    });

    const entry: AudienceManualEntry = {
      accountId: account.id,
      platform: account.platform,
      handle,
      total,
      primaryLabel,
      note: (input.note ?? "").trim().slice(0, 500),
      entryDay,
      recordedAt: checkedAt,
    };
    writeAudienceManualEntry(database, entry);
    pruneAudienceManualEntries(database, settings.audience.accounts.map((configured) => configured.id));
    return {
      status: existing ? ("replaced" as const) : ("created" as const),
      entry,
      metric: storedMetric(account, history),
    };
  });
}

/** The newest manual entry per account, so the UI can surface the attached note. */
export function readLatestManualEntries() {
  return latestAudienceManualEntries(getDatabase());
}
