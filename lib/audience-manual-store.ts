import type { DatabaseSync } from "node:sqlite";
import type { AudiencePlatform, AudiencePrimaryMetric } from "./types";

export type AudienceManualEntry = {
  accountId: string;
  platform: AudiencePlatform;
  handle: string;
  total: number;
  primaryLabel: AudiencePrimaryMetric;
  note: string;
  entryDay: string;
  recordedAt: string;
};

type ManualEntryRow = {
  account_id: string;
  platform: string;
  handle: string;
  total: number;
  primary_label: string;
  note: string;
  entry_day: string;
  recorded_at: string;
};

/**
 * The Wire: manual audience readings are typed by a person, not scraped, so they
 * carry provenance the snapshot history has no field for — a free-text note and
 * the local calendar day that enforces one manual entry per account per day.
 */
export function initializeAudienceManualStore(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS audience_manual_entries (
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      total INTEGER NOT NULL,
      primary_label TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      entry_day TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (account_id, entry_day)
    );
    CREATE INDEX IF NOT EXISTS audience_manual_entries_recorded_at
      ON audience_manual_entries (account_id, recorded_at DESC);
  `);
  return database;
}

/** Calendar day in the server's local timezone, which is the day the user sees. */
export function localCalendarDay(value: Date | string | number = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("A manual entry needs a valid date.");
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

function toEntry(row: ManualEntryRow): AudienceManualEntry {
  return {
    accountId: row.account_id,
    platform: row.platform as AudiencePlatform,
    handle: row.handle,
    total: row.total,
    primaryLabel: row.primary_label as AudiencePrimaryMetric,
    note: row.note,
    entryDay: row.entry_day,
    recordedAt: row.recorded_at,
  };
}

export function readAudienceManualEntry(database: DatabaseSync, accountId: string, entryDay: string) {
  const row = database.prepare(`
    SELECT account_id, platform, handle, total, primary_label, note, entry_day, recorded_at
    FROM audience_manual_entries
    WHERE account_id = ? AND entry_day = ?
  `).get(accountId, entryDay) as unknown as ManualEntryRow | undefined;
  return row ? toEntry(row) : null;
}

/** The newest manual entry for each account, keyed by account id. */
export function latestAudienceManualEntries(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT account_id, platform, handle, total, primary_label, note, entry_day, recorded_at
    FROM audience_manual_entries
    WHERE (account_id, recorded_at) IN (
      SELECT account_id, MAX(recorded_at) FROM audience_manual_entries GROUP BY account_id
    )
  `).all() as unknown as ManualEntryRow[];
  return Object.fromEntries(rows.map((row) => [row.account_id, toEntry(row)]));
}

export function writeAudienceManualEntry(database: DatabaseSync, entry: AudienceManualEntry) {
  database.prepare(`
    INSERT INTO audience_manual_entries
      (account_id, platform, handle, total, primary_label, note, entry_day, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, entry_day) DO UPDATE SET
      platform = excluded.platform,
      handle = excluded.handle,
      total = excluded.total,
      primary_label = excluded.primary_label,
      note = excluded.note,
      recorded_at = excluded.recorded_at
  `).run(
    entry.accountId,
    entry.platform,
    entry.handle,
    entry.total,
    entry.primaryLabel,
    entry.note,
    entry.entryDay,
    entry.recordedAt,
  );
  return entry;
}

/** Manual entries survive an account being removed, so prune what no longer resolves. */
export function pruneAudienceManualEntries(database: DatabaseSync, accountIds: string[]) {
  if (!accountIds.length) return database.prepare("DELETE FROM audience_manual_entries").run().changes;
  const placeholders = accountIds.map(() => "?").join(", ");
  return database
    .prepare(`DELETE FROM audience_manual_entries WHERE account_id NOT IN (${placeholders})`)
    .run(...accountIds).changes;
}
