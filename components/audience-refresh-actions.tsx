"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Check, Clock3, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type { AudienceMetric } from "@/lib/types";
import type { AudienceHistorySeries } from "@/lib/audience-charts";
import styles from "./audience-refresh-actions.module.css";

/**
 * The Wire: audience refreshes are manual on purpose. The scheduler no longer
 * scrapes profiles, so everything in here is a deliberate, user-initiated action
 * against `/api/live/audience`.
 */

/** Matches AUDIENCE_STAGGER_MS on the server; the payload sends the real value. */
const DEFAULT_STAGGER_MS = 10_000;
/** Rough per-account scrape time, used only to estimate the progress bar. */
const REQUEST_ESTIMATE_MS = 4_000;

export const AUDIENCE_STALE_DAYS = 30;
const SPIKE_PERCENT = 50;
const DROP_PERCENT = 20;
const MAGNITUDE_FACTOR = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export type AudienceManualEntry = {
  accountId: string;
  total: number;
  note: string;
  entryDay: string;
  recordedAt: string;
};

export type AudiencePayload = {
  configured: boolean;
  checkedAt: string;
  items: AudienceMetric[];
  history?: AudienceHistorySeries[];
  manual?: Record<string, AudienceManualEntry>;
  staggerMs?: number;
};

type RequestError = Error & { status?: number; payload?: Record<string, unknown> };

/**
 * Turn what a person actually types into a whole number: "10.5k" and "1,500" are
 * both valid, so neither reaches the API as NaN. Returns a null value with a
 * message when the text cannot be a count.
 */
export function parseAudienceInput(raw: string): { value: number | null; error: string } {
  const cleaned = raw.trim().toLowerCase().replace(/[,\s_]/g, "");
  if (!cleaned) return { value: null, error: "" };
  if (cleaned.startsWith("-")) return { value: null, error: "An audience count cannot be negative." };
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return { value: null, error: "Use digits, optionally with k, m, or b — for example 10.5k." };
  const multiplier = match[2] === "b" ? 1e9 : match[2] === "m" ? 1e6 : match[2] === "k" ? 1e3 : 1;
  const value = Math.round(Number(match[1]) * multiplier);
  if (!Number.isSafeInteger(value)) return { value: null, error: "That number is too large to record." };
  return { value, error: "" };
}

export function audienceDelta(next: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  const change = next - previous;
  return { change, percent: previous > 0 ? (change / previous) * 100 : null };
}

/**
 * Flag readings that look like a typo. A decrease is a real thing that happens —
 * purges, unfollows — so it warns and lets the entry through rather than blocking.
 */
export function audienceAnomaly(next: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous <= 0 || next === previous) return null;
  const percent = ((next - previous) / previous) * 100;
  if (next >= previous * MAGNITUDE_FACTOR)
    return { tone: "spike" as const, message: `That is about ${Math.round(next / previous)}× the last reading of ${number.format(previous)}. Check for an extra digit.` };
  if (next === 0)
    return { tone: "drop" as const, message: `That drops ${number.format(previous)} to zero. Check for a missing digit.` };
  if (next * MAGNITUDE_FACTOR <= previous)
    return { tone: "drop" as const, message: `That is about ${Math.round(previous / next)}× smaller than the last reading of ${number.format(previous)}. Check for a missing digit.` };
  if (percent >= SPIKE_PERCENT)
    return { tone: "spike" as const, message: `That is a ${Math.round(percent)}% jump from ${number.format(previous)} — a large move for one entry.` };
  if (percent <= -DROP_PERCENT)
    return { tone: "drop" as const, message: `That is a ${Math.round(Math.abs(percent))}% drop from ${number.format(previous)}. Declines are normal after a purge, so this is only a check.` };
  return null;
}

export function audienceLastReadingAt(item: AudienceMetric) {
  const parsed = Date.parse(item.lastSuccessfulAt || item.checkedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Days since the last real reading, or null when there has never been one. */
export function audienceStaleDays(item: AudienceMetric, now: number) {
  if (item.total === null) return null;
  const last = audienceLastReadingAt(item);
  if (last === null) return null;
  const days = Math.floor((now - last) / DAY_MS);
  return days > AUDIENCE_STALE_DAYS ? days : null;
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${`${seconds % 60}`.padStart(2, "0")}s`;
}

function signed(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${number.format(Math.abs(value))}`;
}

function signedPercent(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(Math.abs(value) < 1 ? 2 : 1)}%`;
}

async function requestAudience(url: string, init?: RequestInit): Promise<AudiencePayload> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(
      typeof payload.error === "string" ? payload.error : "The audience request failed.",
    ) as RequestError;
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload as unknown as AudiencePayload;
}

/** Ticks once a second while a sweep is running, so the progress copy stays live. */
function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  // A clock reading left over from an earlier sweep clamps to zero, not a negative.
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

/** The current time, read after mount so server and client render identical markup. */
function useClock(intervalMs: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Global controls: one staggered sweep of every configured account. The button
 * stays busy for the whole sweep, including the deliberate pauses between
 * accounts, so the wait is explained rather than looking like a hang.
 */
export function AudienceRefreshActions({
  items,
  staggerMs = DEFAULT_STAGGER_MS,
  onUpdated,
}: {
  items: AudienceMetric[];
  staggerMs?: number;
  onUpdated?: (payload: AudiencePayload) => void;
}) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const elapsed = useElapsed(startedAt);
  const running = startedAt !== null;

  const estimateMs = useMemo(
    () => items.length * REQUEST_ESTIMATE_MS + Math.max(0, items.length - 1) * staggerMs,
    [items.length, staggerMs],
  );
  const remaining = Math.max(0, estimateMs - elapsed);
  const progress = estimateMs > 0 ? Math.min(99, (elapsed / estimateMs) * 100) : 0;

  async function refreshAll() {
    setStartedAt(Date.now());
    setError("");
    setDone("");
    try {
      const payload = await requestAudience("/api/live/audience?refresh=1");
      onUpdated?.(payload);
      const failed = payload.items.filter((item) => item.error).length;
      setDone(
        failed
          ? `Checked ${payload.items.length} accounts · ${failed} skipped, previous values kept.`
          : `Checked ${payload.items.length} accounts.`,
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The refresh failed.");
    } finally {
      setStartedAt(null);
    }
  }

  if (!items.length) return null;

  return (
    <section className={styles.globalBar} aria-label="Audience refresh controls">
      <div className={styles.globalIntro}>
        <p className={styles.globalTitle}>Refresh on your terms</p>
        <p className={styles.globalNote}>
          Background collection no longer touches these profiles. A full sweep checks {items.length}{" "}
          {items.length === 1 ? "account" : "accounts"} one at a time, pausing {Math.round(staggerMs / 1000)}s between each
          to stay well under platform rate limits.
        </p>
      </div>
      <div className={styles.globalActions}>
        <button type="button" className={styles.primaryButton} onClick={refreshAll} disabled={running}>
          {running ? <Loader2 size={15} className={styles.spin} aria-hidden /> : <RefreshCw size={15} aria-hidden />}
          {running ? "Refreshing all…" : "Refresh all"}
        </button>
      </div>
      {running && (
        <div className={styles.progress} role="status" aria-live="polite">
          <div className={styles.progressTrack}>
            <span className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <span>
            {remaining > 0
              ? `About ${formatDuration(remaining)} left · staggered to avoid a rate-limit ban`
              : "Taking longer than estimated — still working through the queue"}
          </span>
        </div>
      )}
      {!running && done && (
        <p className={`${styles.status} ${styles.statusDone}`} role="status">
          <Check size={13} aria-hidden /> {done}
        </p>
      )}
      {error && (
        <p className={`${styles.status} ${styles.statusError}`} role="alert">
          <TriangleAlert size={13} aria-hidden /> {error}
        </p>
      )}
    </section>
  );
}

/**
 * Per-account controls: a granular refresh for one profile, plus manual entry with
 * live delta feedback for when a platform simply will not hand over a number.
 */
export function AudienceAccountActions({
  item,
  manual,
  onUpdated,
}: {
  item: AudienceMetric;
  manual?: AudienceManualEntry;
  onUpdated?: (payload: AudiencePayload) => void;
}) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"refresh" | "save" | null>(null);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"error" | "done" | "">("");
  const [conflict, setConflict] = useState(false);
  // Re-read every minute so a row crossing the stale threshold updates on its own.
  const now = useClock(60_000);

  const parsed = parseAudienceInput(draft);
  const delta = parsed.value === null ? null : audienceDelta(parsed.value, item.total);
  const staleDays = now === null ? null : audienceStaleDays(item, now);
  const query = `platform=${encodeURIComponent(item.platform)}&handle=${encodeURIComponent(item.handle.replace(/^@/, ""))}&id=${encodeURIComponent(item.id)}`;

  function report(text: string, nextTone: "error" | "done" | "") {
    setMessage(text);
    setTone(nextTone);
  }

  async function refreshOne() {
    setBusy("refresh");
    report("", "");
    setConflict(false);
    try {
      const payload = await requestAudience(`/api/live/audience?${query}`);
      onUpdated?.(payload);
      const updated = payload.items.find((entry) => entry.id === item.id);
      if (updated?.error) report(`Skipped: ${updated.error}`, "error");
      else report("Updated just now.", "done");
    } catch (requestError) {
      report(requestError instanceof Error ? requestError.message : "The refresh failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function save(replace: boolean) {
    if (parsed.value === null) {
      report(parsed.error || "Enter a number to save.", "error");
      return;
    }
    // Only confirm on a first attempt; a replace has already been reviewed.
    if (!replace) {
      const anomaly = audienceAnomaly(parsed.value, item.total);
      if (anomaly && !window.confirm(`${anomaly.message}\n\nSave ${number.format(parsed.value)} for ${item.label}?`))
        return;
    }
    setBusy("save");
    report("", "");
    try {
      const payload = await requestAudience("/api/live/audience", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: item.platform,
          handle: item.handle.replace(/^@/, ""),
          id: item.id,
          total: parsed.value,
          note,
          replace,
        }),
      });
      onUpdated?.(payload);
      setDraft("");
      setNote("");
      setConflict(false);
      report(replace ? "Today's entry replaced." : "Saved.", "done");
    } catch (requestError) {
      const failure = requestError as RequestError;
      setConflict(failure.status === 409);
      report(failure.message || "The entry could not be saved.", "error");
    } finally {
      setBusy(null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save(false);
  }

  return (
    <div className={styles.rowActions} data-stale={staleDays === null ? undefined : "true"}>
      <div className={styles.rowHead}>
        <button
          type="button"
          className={styles.ghostButton}
          onClick={refreshOne}
          disabled={busy !== null}
          aria-label={`Refresh ${item.label} now`}
        >
          {busy === "refresh" ? <Loader2 size={13} className={styles.spin} aria-hidden /> : <RefreshCw size={13} aria-hidden />}
          {busy === "refresh" ? "Checking…" : "Refresh"}
        </button>
        {staleDays !== null && (
          <span className={styles.staleChip}>
            <Clock3 size={12} aria-hidden /> {staleDays} days since a reading
          </span>
        )}
      </div>

      <div className={styles.entryRow}>
        <label className={styles.srOnly} htmlFor={`audience-manual-${item.id}`}>
          Manual {item.primaryLabel || "audience"} count for {item.label}
        </label>
        <input
          id={`audience-manual-${item.id}`}
          className={styles.entryInput}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={item.total === null ? "Enter count" : number.format(item.total)}
          inputMode="decimal"
          autoComplete="off"
          disabled={busy !== null}
        />
        {parsed.value !== null && (
          <span className={styles.parsedValue} aria-hidden>
            = {number.format(parsed.value)}
          </span>
        )}
        {delta && (
          <span
            className={`${styles.deltaBadge} ${delta.change > 0 ? styles.up : delta.change < 0 ? styles.down : styles.flat}`}
            role="status"
            aria-live="polite"
          >
            {signed(delta.change)}
            {delta.percent === null ? "" : ` (${signedPercent(delta.percent)})`}
          </span>
        )}
        {parsed.value !== null && delta === null && <span className={styles.deltaBadge}>First reading</span>}
        <button type="button" className={styles.saveButton} onClick={() => void save(false)} disabled={busy !== null || parsed.value === null}>
          {busy === "save" ? <Loader2 size={13} className={styles.spin} aria-hidden /> : <Check size={13} aria-hidden />}
          Save
        </button>
      </div>

      <input
        className={styles.noteInput}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Optional note — where the number came from"
        maxLength={500}
        autoComplete="off"
        disabled={busy !== null}
        aria-label={`Note for the manual ${item.label} entry`}
      />

      {parsed.error && !message && <p className={`${styles.status} ${styles.statusError}`}>{parsed.error}</p>}
      {message && (
        <p className={`${styles.status} ${tone === "error" ? styles.statusError : styles.statusDone}`} role={tone === "error" ? "alert" : "status"}>
          {tone === "error" ? <TriangleAlert size={12} aria-hidden /> : <Check size={12} aria-hidden />} {message}
        </p>
      )}
      {conflict && (
        <button type="button" className={styles.replaceButton} onClick={() => void save(true)} disabled={busy !== null}>
          Replace today&apos;s entry
        </button>
      )}
      {manual && !message && (
        <p className={styles.manualNote}>
          Manual entry {manual.entryDay}: {number.format(manual.total)}
          {manual.note ? ` — ${manual.note}` : ""}
        </p>
      )}
    </div>
  );
}
