import { readAudienceHistory } from "@/lib/server/audience";
import {
  AUDIENCE_STAGGER_MS,
  readAudienceMetrics,
  readLatestManualEntries,
  recordManualAudienceEntry,
  refreshAudienceAccounts,
  resolveAudienceTarget,
} from "@/lib/server/audience-refresh";
import { readSettings } from "@/lib/server/settings";

export const runtime = "nodejs";
// A staggered sweep deliberately outlasts the default serverless budget.
export const maxDuration = 900;

function emptyPayload() {
  return Response.json({
    configured: false,
    checkedAt: new Date().toISOString(),
    items: [],
    history: [],
    manual: {},
    staggerMs: AUDIENCE_STAGGER_MS,
  });
}

function manualEntries() {
  try {
    return readLatestManualEntries();
  } catch {
    // The audience view must still render if the local database is unavailable.
    return {};
  }
}

/**
 * Manual entries arrive from a keyboard, so accept the shapes a person produces —
 * "1,500", " 1500 " — while rejecting anything that is not a whole, non-negative
 * count. Shorthand such as "10.5k" is expanded by the UI before it is submitted.
 */
function parseManualTotal(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Enter a number, not a blank or invalid value.");
    if (value < 0) throw new Error("An audience count cannot be negative.");
    if (!Number.isSafeInteger(value)) throw new Error("Enter a whole number within a safe integer range.");
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/[,\s_]/g, "");
    if (!cleaned) throw new Error("Enter a number, not a blank or invalid value.");
    if (cleaned.startsWith("-")) throw new Error("An audience count cannot be negative.");
    if (!/^\d+$/.test(cleaned)) throw new Error(`"${value}" is not a whole number. Enter digits only, for example 12500.`);
    const parsed = Number(cleaned);
    if (!Number.isSafeInteger(parsed)) throw new Error("Enter a whole number within a safe integer range.");
    return parsed;
  }
  throw new Error("Enter a number, not a blank or invalid value.");
}

/**
 * Reads are free by default: a plain GET returns what is already on disk without
 * contacting any platform. Scraping happens only when it is asked for, either for
 * one account (`?platform=&handle=`) or as a staggered sweep (`?refresh=1`).
 */
export async function GET(request: Request) {
  const settings = await readSettings();
  if (!settings.audience.accounts.length) return emptyPayload();
  const parameters = new URL(request.url).searchParams;
  const platform = parameters.get("platform");
  const handle = parameters.get("handle");
  const id = parameters.get("id");

  let items;
  if (platform || handle || id) {
    const account = resolveAudienceTarget(settings, { platform, handle, id });
    if (!account) {
      return Response.json(
        { error: `No configured account matches ${platform ? `platform "${platform}"` : "that request"}${handle ? ` and handle "${handle}"` : ""}.` },
        { status: 404 },
      );
    }
    items = await refreshAudienceAccounts(settings, { only: [account], staggerMs: 0 });
  } else if (parameters.get("refresh") === "1") {
    items = await refreshAudienceAccounts(settings, { staggerMs: AUDIENCE_STAGGER_MS });
  } else {
    items = await readAudienceMetrics(settings);
  }

  return Response.json({
    configured: true,
    checkedAt: new Date().toISOString(),
    items,
    history: await readAudienceHistory(settings),
    manual: manualEntries(),
    staggerMs: AUDIENCE_STAGGER_MS,
  });
}

/**
 * Record a hand-entered reading. Nothing here touches the network: the value is
 * validated, checked against today's manual entry for the same account, and
 * written straight to local storage.
 */
export async function POST(request: Request) {
  const settings = await readSettings();
  if (!settings.audience.accounts.length)
    return Response.json({ error: "Add an audience account in Settings before saving a reading." }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad body");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send a JSON object with a total and an account to attach it to." }, { status: 400 });
  }

  let total: number;
  try {
    total = parseManualTotal(body.total);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid audience count." }, { status: 400 });
  }

  const account = resolveAudienceTarget(settings, {
    platform: typeof body.platform === "string" ? body.platform : null,
    handle: typeof body.handle === "string" ? body.handle : null,
    id: typeof body.id === "string" ? body.id : null,
  });
  if (!account) return Response.json({ error: "No configured account matches that platform and handle." }, { status: 404 });

  if (body.note !== undefined && typeof body.note !== "string")
    return Response.json({ error: "A note must be text." }, { status: 400 });

  try {
    const result = await recordManualAudienceEntry(settings, {
      account,
      total,
      note: typeof body.note === "string" ? body.note : "",
      replace: body.replace === true,
    });
    if (result.status === "duplicate") {
      return Response.json(
        {
          error: `${account.label} already has a manual entry for today (${result.existing.total.toLocaleString("en-US")} recorded at ${result.existing.recordedAt}). Save again with replace to overwrite it.`,
          duplicate: true,
          existing: result.existing,
        },
        { status: 409 },
      );
    }
    return Response.json({
      ok: true,
      status: result.status,
      entry: result.entry,
      items: await readAudienceMetrics(settings),
      history: await readAudienceHistory(settings),
      manual: manualEntries(),
      checkedAt: new Date().toISOString(),
      configured: true,
      staggerMs: AUDIENCE_STAGGER_MS,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The manual entry could not be saved." },
      { status: 400 },
    );
  }
}
