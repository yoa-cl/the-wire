import "server-only";

import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { AudienceMetric, AudiencePrimaryMetric } from "@/lib/types";
import {
  AUDIENCE_SNAPSHOT_VERSION,
  audienceGrowthFromHistory,
  nextAudienceHistory,
  parseAudienceSnapshots,
  type AudienceAccountHistory,
  type AudienceSnapshotHistory,
} from "@/lib/audience-growth";
import type { StoredSettings } from "@/lib/server/settings";
import { snapshotsPath } from "@/lib/server/settings";
import { safeFetchText } from "@/lib/server/safe-fetch";
import { fetchPinned } from "@/lib/server/pinned-fetch";
import {
  audienceAccountFingerprint,
  audienceCacheWindowMs,
  linkedInHttpError,
  parseFacebookPublicProfile,
  parseLinkedInPublicProfile,
  parseTikTokPublicProfile,
  parseThreadsPublicProfile,
  parseYouTubePublicProfile,
  publicProfileHandle,
  resolvePublicProfileUrl,
  samePublicProfileIdentity,
  sameHostRedirectSession,
} from "@/lib/public-metrics";
import { readBoundedResponseText } from "@/lib/sitemap";
import { configuredAudienceHistory } from "@/lib/audience-charts";

type Account = StoredSettings["audience"]["accounts"][number];
type CollectedAccount = { total: number; handle: string; primaryLabel: AudiencePrimaryMetric; secondaryLabel?: string; secondaryValue?: number; source: string };
type PublicProviderErrorCode = "not_found" | "provider_blocked" | "provider_unavailable";
declare global {
  var controlCenterAudienceRun: Promise<AudienceMetric[]> | undefined;
  var controlCenterAudienceRunForced: boolean | undefined;
}

class PublicProviderError extends Error {
  constructor(readonly code: PublicProviderErrorCode, message: string) {
    super(message);
    this.name = "PublicProviderError";
  }
}

const browserHeaders = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

const linkedInHeaders = {
  ...browserHeaders,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  "Upgrade-Insecure-Requests": "1",
};

export async function readSnapshots(): Promise<AudienceSnapshotHistory> {
  try {
    return parseAudienceSnapshots(
      JSON.parse(await readFile(snapshotsPath(), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: AUDIENCE_SNAPSHOT_VERSION, accounts: {} };
    throw new Error(
      "Audience snapshot history could not be read safely. Restore snapshots.json from a backup or move the corrupt file aside.",
      { cause: error },
    );
  }
}

export async function readAudienceHistory(settings: StoredSettings) {
  return configuredAudienceHistory(settings.audience.accounts, await readSnapshots());
}

export async function writeSnapshots(snapshots: AudienceSnapshotHistory) {
  const target = snapshotsPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshots, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000), headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  return response.json() as Promise<T>;
}

export function usernameFor(account: Account) {
  const fromProfile = publicProfileHandle(account.platform, account.profileUrl);
  if (fromProfile) return fromProfile;
  const fallbackUrl = resolvePublicProfileUrl(account.platform, "", account.username);
  return publicProfileHandle(account.platform, fallbackUrl);
}

function normalizedHandle(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function requireMatchingHandle(provider: string, actual: unknown, expected: string) {
  if (typeof actual !== "string" || !normalizedHandle(actual) || normalizedHandle(actual) !== normalizedHandle(expected)) {
    throw new Error(`${provider} returned a different account than the configured public profile.`);
  }
}

function metricCount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function requiredMetricCount(provider: string, label: string, value: unknown) {
  const count = metricCount(value);
  if (count === null) throw new Error(`${provider} did not return a ${label} count; the previous verified value was preserved.`);
  return count;
}

function facebookProfileId(value: string) {
  const canonical = resolvePublicProfileUrl("facebook", value, "");
  if (!canonical) return "";
  const url = new URL(canonical);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "profile.php") return url.searchParams.get("id") || "";
  if (["pages", "people"].includes(parts[0])) return parts[2] || "";
  return "";
}

function publicProfileUrl(account: Account) {
  return resolvePublicProfileUrl(account.platform, account.profileUrl, usernameFor(account));
}

function requireMatchingProfileRedirect(account: Account, configuredUrl: string, finalUrl: string) {
  if (!samePublicProfileIdentity(account.platform, configuredUrl, finalUrl)) {
    const platformName = account.platform[0].toUpperCase() + account.platform.slice(1);
    throw new Error(`${platformName} redirected to a different page than the configured public profile.`);
  }
}

function responseCookies(headers: Headers) {
  const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof cookieHeaders.getSetCookie === "function") return cookieHeaders.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

async function fetchLinkedInPublicProfile(value: string, fetchImplementation: typeof fetchPinned = fetchPinned) {
  let currentUrl = new URL(value).toString();
  let cookies = "";
  let referer = "";
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImplementation(currentUrl, {
      signal: AbortSignal.timeout(12_000),
      headers: {
        ...linkedInHeaders,
        ...(cookies ? { Cookie: cookies } : {}),
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 5) {
        await response.body?.cancel().catch(() => undefined);
        throw new PublicProviderError("provider_unavailable", "LinkedIn redirected this public profile too many times.");
      }
      const session = sameHostRedirectSession(currentUrl, location, cookies, responseCookies(response.headers));
      if (!session) {
        await response.body?.cancel().catch(() => undefined);
        throw new PublicProviderError("provider_unavailable", "LinkedIn redirected this profile away from linkedin.com.");
      }
      await response.body?.cancel().catch(() => undefined);
      referer = currentUrl;
      currentUrl = session.nextUrl;
      cookies = session.cookieHeader;
      continue;
    }
    if (!response.ok) {
      const failure = linkedInHttpError(response.status);
      await response.body?.cancel().catch(() => undefined);
      throw new PublicProviderError(failure.code, failure.message);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 5_000_000) {
      await response.body?.cancel().catch(() => undefined);
      throw new PublicProviderError("provider_unavailable", "LinkedIn returned a public profile larger than 5 MB.");
    }
    return { text: await readBoundedResponseText(response, 5_000_000), finalUrl: currentUrl };
  }
  throw new PublicProviderError("provider_unavailable", "LinkedIn could not complete this public profile check right now.");
}

async function collectPublicAccount(account: Account): Promise<CollectedAccount> {
  const username = usernameFor(account);
  const profileUrl = publicProfileUrl(account);
  if (!username && !profileUrl) throw new Error("Add a valid public profile URL or username.");

  if (account.platform === "instagram") {
    const response = await safeFetchText(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers: { ...browserHeaders, "x-ig-app-id": "936619743392459", Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } });
    const data = JSON.parse(response.text) as { data?: { user?: { username?: string; edge_followed_by?: { count?: number }; edge_owner_to_timeline_media?: { count?: number } } } };
    const user = data.data?.user;
    if (!user || typeof user.edge_followed_by?.count !== "number") throw new Error("Instagram did not expose a public follower count.");
    requireMatchingHandle("Instagram", user.username, username);
    return { total: user.edge_followed_by.count, handle: `@${user.username || username}`, primaryLabel: "followers", secondaryLabel: "posts", secondaryValue: user.edge_owner_to_timeline_media?.count, source: "Instagram public profile" };
  }

  if (account.platform === "x") {
    const response = await safeFetchText(`https://api.fxtwitter.com/${encodeURIComponent(username)}`, { headers: browserHeaders });
    const data = JSON.parse(response.text) as { user?: { screen_name?: string; followers?: number; tweets?: number } };
    if (!data.user || typeof data.user.followers !== "number") throw new Error("X did not expose a public follower count.");
    requireMatchingHandle("X", data.user.screen_name, username);
    return { total: data.user.followers, handle: `@${data.user.screen_name || username}`, primaryLabel: "followers", secondaryLabel: "posts", secondaryValue: data.user.tweets, source: "FxTwitter public proxy" };
  }

  if (account.platform === "linkedin") {
    const response = await fetchLinkedInPublicProfile(profileUrl);
    requireMatchingProfileRedirect(account, profileUrl, response.finalUrl);
    const profile = parseLinkedInPublicProfile(response.text.replaceAll("\\u0026", "&"), profileUrl);
    if (!profile || profile.followers === null) throw new Error(`LinkedIn did not expose a public follower count for this ${profile?.kind || "public"} profile.`);
    const source = profile.kind === "personal" ? `LinkedIn public personal profile${profile.rounded ? " (rounded)" : ""}` : `LinkedIn public organization profile${profile.rounded ? " (rounded)" : ""}`;
    return { total: profile.followers, handle: username, primaryLabel: "followers", source };
  }

  const requestHeaders = account.platform === "facebook" ? { ...browserHeaders, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } : account.platform === "threads" ? { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" } : browserHeaders;
  const response = await safeFetchText(profileUrl, { headers: requestHeaders });
  requireMatchingProfileRedirect(account, profileUrl, response.finalUrl);
  const html = response.text.replaceAll("\\u0026", "&");

  if (account.platform === "youtube") {
    const profile = parseYouTubePublicProfile(html, profileUrl);
    if (!profile || profile.subscribers === null) throw new Error("YouTube did not expose a target-verified public subscriber count.");
    return { total: profile.subscribers, handle: `@${username}`, primaryLabel: "subscribers", secondaryLabel: profile.videos === null ? undefined : "videos", secondaryValue: profile.videos ?? undefined, source: `YouTube public profile${profile.rounded ? " (rounded)" : ""}` };
  }

  if (account.platform === "tiktok") {
    const profile = parseTikTokPublicProfile(html, profileUrl);
    if (!profile || profile.followers === null) throw new Error("TikTok did not expose a target-verified public follower count.");
    return { total: profile.followers, handle: `@${profile.handle}`, primaryLabel: "followers", secondaryLabel: profile.videos === null ? undefined : "videos", secondaryValue: profile.videos ?? undefined, source: `TikTok public profile${profile.rounded ? " (rounded)" : ""}` };
  }

  if (account.platform === "facebook") {
    const profile = parseFacebookPublicProfile(html, profileUrl);
    const followers = profile?.followers ?? null;
    const likes = profile?.likes ?? null;
    const total = followers ?? likes;
    if (total === null) throw new Error("Facebook did not expose a public follower or page-like count.");
    const source = followers !== null ? "Facebook public profile" : "Facebook public page likes";
    return { total, handle: username, primaryLabel: followers !== null ? "followers" : "page likes", secondaryLabel: followers !== null && likes !== null ? "page likes" : undefined, secondaryValue: followers !== null ? likes ?? undefined : undefined, source: `${source}${profile?.rounded ? " (rounded)" : ""}` };
  }

  const threadsProfile = parseThreadsPublicProfile(html, profileUrl);
  if (threadsProfile.followers === null) throw new Error("Threads did not expose a public follower count for this profile.");
  return { total: threadsProfile.followers, handle: `@${username}`, primaryLabel: "followers", secondaryLabel: threadsProfile.threads === null ? undefined : "threads", secondaryValue: threadsProfile.threads ?? undefined, source: "Threads public profile (rounded)" };
}

async function collectWithCredential(account: Account): Promise<CollectedAccount> {
  if (!account.credential) throw new Error("No optional API credential is saved.");
  if (account.platform === "youtube") {
    const canonical = publicProfileUrl(account);
    const parts = canonical ? new URL(canonical).pathname.split("/").filter(Boolean) : [];
    const expectedChannelId = parts[0] === "channel" ? parts[1] || "" : !canonical ? account.accountId : "";
    const expectedHandle = expectedChannelId ? "" : usernameFor(account);
    const selector = expectedChannelId ? `id=${encodeURIComponent(expectedChannelId)}` : `forHandle=${encodeURIComponent(expectedHandle)}`;
    if (!expectedChannelId && !expectedHandle) throw new Error("YouTube needs a channel ID, handle, or public channel URL for the API fallback.");
    const data = await fetchJson<{ items?: Array<{ id?: string; snippet?: { customUrl?: string }; statistics?: { subscriberCount?: string; videoCount?: string } }> }>(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&${selector}&key=${encodeURIComponent(account.credential)}`);
    const channel = data.items?.[0];
    if (!channel) throw new Error("YouTube channel was not found.");
    if (expectedChannelId && channel.id !== expectedChannelId) throw new Error("YouTube returned a different channel than the configured public profile.");
    if (expectedHandle && channel.snippet?.customUrl) requireMatchingHandle("YouTube", channel.snippet.customUrl, expectedHandle);
    const total = requiredMetricCount("YouTube", "subscriber", channel.statistics?.subscriberCount);
    const videos = metricCount(channel.statistics?.videoCount);
    return { total, handle: channel.snippet?.customUrl || expectedChannelId, primaryLabel: "subscribers", secondaryLabel: videos === null ? undefined : "videos", secondaryValue: videos ?? undefined, source: "YouTube Data API" };
  }
  if (account.platform === "x") {
    const expected = usernameFor(account);
    if (!expected) throw new Error("X needs a handle or public profile URL for the API fallback.");
    const data = await fetchJson<{ data?: { username?: string; public_metrics?: { followers_count?: number; tweet_count?: number } } }>(`https://api.x.com/2/users/by/username/${encodeURIComponent(expected)}?user.fields=public_metrics`, { Authorization: `Bearer ${account.credential}` });
    if (!data.data) throw new Error("X account was not found.");
    requireMatchingHandle("X", data.data.username, expected);
    const total = requiredMetricCount("X", "follower", data.data.public_metrics?.followers_count);
    const posts = metricCount(data.data.public_metrics?.tweet_count);
    return { total, handle: `@${data.data.username}`, primaryLabel: "followers", secondaryLabel: posts === null ? undefined : "posts", secondaryValue: posts ?? undefined, source: "X API" };
  }
  if (account.platform === "instagram") {
    if (!account.accountId) throw new Error("Instagram business account ID is required for the API fallback.");
    const data = await fetchJson<{ username?: string; followers_count?: number; media_count?: number }>(`https://graph.facebook.com/v21.0/${encodeURIComponent(account.accountId)}?fields=username,followers_count,media_count&access_token=${encodeURIComponent(account.credential)}`);
    const expected = usernameFor(account);
    if (expected) requireMatchingHandle("Instagram", data.username, expected);
    const total = requiredMetricCount("Instagram", "follower", data.followers_count);
    const posts = metricCount(data.media_count);
    return { total, handle: `@${data.username || expected}`, primaryLabel: "followers", secondaryLabel: posts === null ? undefined : "posts", secondaryValue: posts ?? undefined, source: "Meta Graph API" };
  }
  if (account.platform === "facebook") {
    if (!account.accountId) throw new Error("Facebook page ID is required for the API fallback.");
    const data = await fetchJson<{ id?: string; name?: string; link?: string; followers_count?: number; fan_count?: number }>(`https://graph.facebook.com/v21.0/${encodeURIComponent(account.accountId)}?fields=id,name,link,followers_count,fan_count&access_token=${encodeURIComponent(account.credential)}`);
    if (data.id !== account.accountId) throw new Error("Facebook returned a different page than the configured page ID.");
    const canonical = publicProfileUrl(account);
    const targetId = facebookProfileId(canonical);
    if (targetId && targetId !== data.id) throw new Error("Facebook page ID does not match the configured public profile.");
    if (canonical && !targetId && (!data.link || !samePublicProfileIdentity("facebook", canonical, data.link))) {
      throw new Error("Facebook could not verify that the API page matches the configured public profile.");
    }
    const followers = metricCount(data.followers_count);
    const likes = metricCount(data.fan_count);
    const total = followers ?? likes;
    if (total === null) throw new Error("Facebook did not return a follower or page-like count; the previous verified value was preserved.");
    return { total, handle: data.name || account.label, primaryLabel: followers !== null ? "followers" : "page likes", secondaryLabel: followers !== null && likes !== null ? "page likes" : undefined, secondaryValue: followers !== null ? likes ?? undefined : undefined, source: "Meta Graph API" };
  }
  throw new Error("This platform does not have an API fallback configured.");
}

export async function collectAccount(account: Account) {
  try { return await collectPublicAccount(account); } catch (publicError) {
    if (account.credential) {
      try { return await collectWithCredential(account); } catch (apiError) {
        throw new Error(`Public check failed: ${publicError instanceof Error ? publicError.message : "unknown error"} API fallback failed: ${apiError instanceof Error ? apiError.message : "unknown error"}`);
      }
    }
    throw publicError;
  }
}

export function cachedMetric(account: Account, prior: AudienceAccountHistory): AudienceMetric {
  const platformName = account.platform[0].toUpperCase() + account.platform.slice(1);
  const cacheLabel = account.platform === "linkedin" ? "daily cache" : "cached";
  const latest = prior.latest;
  const growth = audienceGrowthFromHistory(prior);
  return {
    id: account.id,
    platform: account.platform,
    label: account.label,
    handle: latest.handle || usernameFor(account),
    total: latest.total,
    ...growth,
    primaryLabel: latest.primaryLabel,
    secondaryLabel: latest.secondaryLabel,
    secondaryValue: latest.secondaryValue,
    checkedAt: latest.checkedAt,
    source: `${latest.source || `${platformName} public profile`} (${cacheLabel})`,
  };
}

async function collectAudienceNow(settings: StoredSettings, forceRefresh: boolean): Promise<AudienceMetric[]> {
  const previous = await readSnapshots();
  const next: AudienceSnapshotHistory = {
    version: AUDIENCE_SNAPSHOT_VERSION,
    accounts: { ...previous.accounts },
  };
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(settings.audience.accounts.map(async (account): Promise<AudienceMetric> => {
    const fingerprint = audienceAccountFingerprint(account);
    const saved = previous.accounts[account.id];
    const prior = saved?.fingerprint === fingerprint ? saved : undefined;
    if (saved && !prior) delete next.accounts[account.id];
    if (!forceRefresh && prior && Date.parse(prior.latest.checkedAt) >= Date.parse(checkedAt) - audienceCacheWindowMs(account.platform)) {
      return cachedMetric(account, prior);
    }
    try {
      const current = await collectAccount(account);
      const history = nextAudienceHistory({
        total: current.total,
        checkedAt,
        handle: current.handle,
        secondaryLabel: current.secondaryLabel,
        secondaryValue: current.secondaryValue,
        source: current.source,
        primaryLabel: current.primaryLabel,
      }, fingerprint, prior);
      next.accounts[account.id] = history;
      return { id: account.id, platform: account.platform, label: account.label, handle: current.handle, total: current.total, ...audienceGrowthFromHistory(history), primaryLabel: current.primaryLabel, secondaryLabel: current.secondaryLabel, secondaryValue: current.secondaryValue, checkedAt, source: current.source };
    } catch (error) {
      const latest = prior?.latest;
      return { id: account.id, platform: account.platform, label: account.label, handle: account.username || account.profileUrl || account.accountId, total: latest?.total ?? null, ...(prior ? audienceGrowthFromHistory(prior) : { change: null }), primaryLabel: latest?.primaryLabel, secondaryLabel: latest?.secondaryLabel, secondaryValue: latest?.secondaryValue, checkedAt, error: error instanceof Error ? error.message : "Unknown provider error", stale: Boolean(prior), lastSuccessfulAt: latest?.checkedAt };
    }
  }));
  await writeSnapshots(next);
  return results;
}

export async function collectAudience(settings: StoredSettings, options: { forceRefresh?: boolean } = {}): Promise<AudienceMetric[]> {
  const forceRefresh = options.forceRefresh === true;
  if (globalThis.controlCenterAudienceRun) {
    if (!forceRefresh || globalThis.controlCenterAudienceRunForced) return globalThis.controlCenterAudienceRun;
    try { await globalThis.controlCenterAudienceRun; } catch { /* The forced run below still gets its own result. */ }
    return collectAudience(settings, options);
  }
  const run = collectAudienceNow(settings, forceRefresh);
  globalThis.controlCenterAudienceRun = run;
  globalThis.controlCenterAudienceRunForced = forceRefresh;
  try {
    return await run;
  } finally {
    if (globalThis.controlCenterAudienceRun === run) {
      globalThis.controlCenterAudienceRun = undefined;
      globalThis.controlCenterAudienceRunForced = undefined;
    }
  }
}
