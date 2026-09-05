"use client";

import { useState } from "react";
import { Check, Loader2, Radar, TriangleAlert } from "lucide-react";
import styles from "./source-test-button.module.css";

/**
 * The Wire: test one industry source on demand.
 *
 * Saving a broken source is costly — it re-probes its homepage, fourteen feed
 * candidates, robots.txt and sitemap locations on every collection and every
 * restart, and the only feedback arrives hours later in an error box. This asks
 * the same question about one URL, now.
 */

type TestResult =
  | { ok: true; mode: string; endpoint: string; itemCount: number; message: string }
  | { ok: false; error: string };

const MODE_LABEL: Record<string, string> = {
  feed: "RSS/Atom feed",
  sitemap: "Sitemap",
  topics: "Topic search",
};

export function SourceTestButton({ url, name }: { url: string; name?: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/settings/test-source", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, name }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true) {
        setResult({
          ok: false,
          error: typeof payload.error === "string" ? payload.error : "The source could not be read.",
        });
      } else {
        setResult({
          ok: true,
          mode: String(payload.mode || ""),
          endpoint: String(payload.endpoint || ""),
          itemCount: Number(payload.itemCount) || 0,
          message: String(payload.message || ""),
        });
      }
    } catch {
      setResult({ ok: false, error: "The test request could not be completed." });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !url.trim();

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        onClick={() => void test()}
        disabled={disabled}
        title={url.trim() ? `Check ${url} for a readable feed or sitemap` : "Enter a URL first"}
      >
        {busy ? <Loader2 size={13} className={styles.spin} aria-hidden /> : <Radar size={13} aria-hidden />}
        {busy ? "Checking…" : "Test"}
      </button>
      {result && (
        <p className={`${styles.result} ${result.ok ? styles.ok : styles.bad}`} role="status">
          {result.ok ? <Check size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
          <span>
            {result.ok ? (
              <>
                {MODE_LABEL[result.mode] || result.mode} found
                {result.itemCount ? ` · ${result.itemCount} item${result.itemCount === 1 ? "" : "s"}` : ""}
                <small className={styles.endpoint}>{result.endpoint}</small>
              </>
            ) : (
              result.error
            )}
          </span>
        </p>
      )}
    </div>
  );
}
