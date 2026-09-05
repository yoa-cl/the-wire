import { collectionScope } from "./collection-scope";
import type { PublicSettings } from "./types";
import { isLocalAiProvider } from "./ai-providers";

type FeedSettings = Pick<PublicSettings, "industry" | "mentions"> & {
  ai: Pick<PublicSettings["ai"], "provider" | "model"> & Partial<Pick<PublicSettings["ai"], "localBaseUrls">>;
};

export function industryCacheScope(settings: FeedSettings) {
  return collectionScope("industry-response-v1", [
    settings.industry.description,
    // Pausing changes what a collection would return, so it must change the key.
    ...settings.industry.sources.map((source) => `${source.id}:${source.url}${source.paused ? ":paused" : ""}`),
    ...settings.industry.keywords.map((keyword) => `topic:${keyword}`),
    ...settings.industry.excludedTerms.map((term) => `exclude:${term}`),
    `limit:${settings.industry.dailyLimit}`,
    `ai:${settings.ai.provider}:${settings.ai.model}`,
    ...(isLocalAiProvider(settings.ai.provider) ? [settings.ai.localBaseUrls?.[settings.ai.provider] || ""] : []),
  ]);
}

export function mentionsCacheScope(settings: FeedSettings) {
  return collectionScope("mentions-response-v1", [
    `strict:${settings.mentions.strictMode}`,
    ...settings.mentions.terms.map((term) => `term:${term}`),
    ...settings.mentions.websites.map((website) => `website:${website}`),
    ...settings.mentions.identityAnchors.map((anchor) => `anchor:${anchor}`),
    ...settings.mentions.negativeTerms.map((term) => `exclude:${term}`),
    `exclude-owned:${settings.mentions.excludeOwnedSites}`,
    ...settings.industry.keywords.map((keyword) => `niche:${keyword}`),
    ...(settings.ai.provider !== "none" ? [`description:${settings.industry.description}`] : []),
    `ai:${settings.ai.provider}:${settings.ai.model}`,
    ...(isLocalAiProvider(settings.ai.provider) ? [settings.ai.localBaseUrls?.[settings.ai.provider] || ""] : []),
  ]);
}
