import "server-only";

import type { AiKeyProvider, AiModelOption } from "@/lib/types";
import {
  configuredAiApiKey,
  type StoredSettings,
} from "@/lib/server/settings";
import { AI_PROVIDER_LABELS, DEFAULT_AI_MODELS, aiSupportsWebSearch, cleanAiModelOverride, isLocalAiProvider, localAiBaseUrl } from "@/lib/ai-providers";
import { AiProviderRequestError, aiProviderJson } from "@/lib/ai-provider-http";
import { discoverAiModels } from "@/lib/server/ai-models";
import { assertLocalAiContext } from "@/lib/ai-local-context";

export type AiRunOptions = {
  prompt: string;
  webSearch?: boolean;
  maxOutputTokens?: number;
};

export type AiRunResult = {
  provider: AiKeyProvider;
  model: string;
  text: string;
};

export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

async function modelFor(settings: StoredSettings, provider: AiKeyProvider): Promise<AiModelOption> {
  const override = cleanAiModelOverride(settings.ai.model);
  if (isLocalAiProvider(provider)) {
    // Do not auto-load a downloaded model or accidentally use a cloud alias.
    const available = await discoverAiModels(settings, { refresh: true });
    const model = override || available.defaultModel;
    const selected = available.models.find((item) => item.id === model);
    if (!model || !selected)
      throw new AiNotConfiguredError(`${AI_PROVIDER_LABELS[provider]} has no matching loaded text model. Load a local model in that app, then reload models in Settings.`);
    return selected;
  }
  if (override) return { id: override, label: override };
  try {
    const available = await discoverAiModels(settings);
    const model = available.defaultModel || DEFAULT_AI_MODELS[provider];
    return { id: model, label: model };
  } catch {
    // Model-list permissions can differ from inference permissions. A known
    // default may still run; inference failure remains explicit to the caller.
    return { id: DEFAULT_AI_MODELS[provider], label: DEFAULT_AI_MODELS[provider] };
  }
}

function boundedTokens(value = 4_000) {
  return Math.min(8_000, Math.max(500, Math.round(value)));
}

async function providerFetch(
  provider: AiKeyProvider,
  url: string,
  init: RequestInit,
) {
  return aiProviderJson(provider, url, init, { timeoutMs: isLocalAiProvider(provider) ? 120_000 : 45_000 });
}

function openAiText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    return content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
  }).join("\n");
}

function anthropicText(payload: Record<string, unknown>) {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function geminiText(payload: Record<string, unknown>) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const content = (candidate as { content?: unknown }).content;
    if (!content || typeof content !== "object") return [];
    const parts = Array.isArray((content as { parts?: unknown }).parts)
      ? (content as { parts: unknown[] }).parts
      : [];
    return parts.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
  }).join("\n");
}

async function runOpenAi(
  key: string,
  model: string,
  options: AiRunOptions,
) {
  // The older GPT-3.5/GPT-4 and ChatGPT aliases use Chat Completions, not the
  // Responses API. They remain useful for curation but have no built-in search.
  const chatOnly = /^(?:gpt-3|gpt-4(?:-|$)|chatgpt-|ft:)/i.test(model) || /-chat-latest(?:-|$)/i.test(model);
  if (chatOnly) {
    if (options.webSearch) throw new Error("This OpenAI model does not support built-in web research. Select Default or a Responses API model for that feature.");
    return chatCompletionText(await providerFetch("openai", "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: options.prompt }],
        ...(/^(?:ft:)?(?:gpt-5|o\d)/i.test(model)
          ? { max_completion_tokens: boundedTokens(options.maxOutputTokens) }
          : { max_tokens: Math.min(4_096, boundedTokens(options.maxOutputTokens)) }),
        store: false,
      }),
    }));
  }
  const payload = await providerFetch("openai", "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: options.prompt,
      store: false,
      max_output_tokens: boundedTokens(options.maxOutputTokens),
      ...(/^(?:gpt-5|o\d)/i.test(model) && !/-pro(?:-|$)/.test(model)
        ? { reasoning: { effort: "low" } }
        : {}),
      ...(options.webSearch ? { tools: [{ type: "web_search" }] } : {}),
    }),
  });
  return openAiText(payload);
}

async function runAnthropic(
  key: string,
  model: string,
  options: AiRunOptions,
) {
  const body = {
    model,
    max_tokens: boundedTokens(options.maxOutputTokens),
    messages: [{ role: "user", content: options.prompt }],
    ...(options.webSearch
      ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }] }
      : {}),
  };
  let payload = await providerFetch("anthropic", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (payload.stop_reason === "pause_turn" && Array.isArray(payload.content)) {
    payload = await providerFetch("anthropic", "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        messages: [
          ...body.messages,
          { role: "assistant", content: payload.content },
        ],
      }),
    });
  }
  return anthropicText(payload);
}

async function runGemini(
  key: string,
  model: string,
  options: AiRunOptions,
) {
  const safeModel = encodeURIComponent(model);
  const payload = await providerFetch(
    "gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        generationConfig: {
          ...(!options.webSearch ? { responseMimeType: "application/json" } : {}),
          maxOutputTokens: boundedTokens(options.maxOutputTokens),
        },
        ...(options.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
      }),
    },
  );
  return geminiText(payload);
}

function chatCompletionText(payload: Record<string, unknown>) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : "";
}

async function runXai(key: string, model: string, options: AiRunOptions) {
  const payload = await providerFetch("xai", "https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: options.prompt }],
      store: false,
      max_output_tokens: boundedTokens(options.maxOutputTokens),
      ...(options.webSearch ? { tools: [{ type: "web_search" }] } : {}),
    }),
  });
  return openAiText(payload);
}

async function runLocalAi(settings: StoredSettings, provider: "lmstudio" | "ollama", key: string, model: string, options: AiRunOptions, loadedContextLength?: number) {
  const outputTokens = boundedTokens(options.maxOutputTokens);
  const contextLength = assertLocalAiContext(provider, loadedContextLength, options.prompt, outputTokens);
  const root = localAiBaseUrl(provider, settings.ai.localBaseUrls[provider]);
  const endpoint = `${root}${provider === "lmstudio" ? "/v1/chat/completions" : "/api/chat"}`;
  const headers = { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  // The Wire: a reasoning model bills its hidden thinking against num_predict but
  // returns it in a separate `thinking` field this app never reads. Left on, the
  // model can spend the whole output allowance reasoning and be cut off before it
  // finishes the JSON, which surfaces as "stopped before completing its answer".
  const requestBody = (thinking?: boolean) => JSON.stringify({
    model,
    messages: [{ role: "user", content: options.prompt }],
    stream: false,
    ...(provider === "lmstudio"
      ? { max_tokens: outputTokens }
      // Omit keep_alive: retain Ollama's user-configured server/runner lifetime.
      : {
          ...(thinking === undefined ? {} : { think: thinking }),
          options: { num_predict: outputTokens, num_ctx: contextLength },
          truncate: false,
          shift: false,
        }),
  });

  const send = (thinking?: boolean) =>
    providerFetch(provider, endpoint, { method: "POST", headers, body: requestBody(thinking) });

  let payload: Record<string, unknown>;
  if (provider === "ollama") {
    try {
      payload = await send(false);
    } catch (error) {
      // Ollama builds that predate the flag, and models without a thinking mode,
      // reject the parameter with a 400. Retry once without it so a non-reasoning
      // setup behaves exactly as it did before.
      if (!(error instanceof AiProviderRequestError) || error.status !== 400) throw error;
      payload = await send();
    }
  } else {
    payload = await send();
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const finish = provider === "lmstudio"
    ? (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason
    : payload.done_reason;
  if (["length", "max_tokens", "context_length"].includes(String(finish)) || payload.done === false)
    throw new Error(`${AI_PROVIDER_LABELS[provider]} stopped before completing its answer. Use a model with a larger context/output allowance and retry; this incomplete result was not saved.`);
  if (provider === "lmstudio") return chatCompletionText(payload);
  const message = payload.message as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

export async function runConfiguredAi(
  settings: StoredSettings,
  options: AiRunOptions,
): Promise<AiRunResult> {
  const provider = settings.ai.provider;
  if (provider === "none")
    throw new AiNotConfiguredError("AI curation is off in Settings.");
  const key = configuredAiApiKey(settings, provider);
  if (!key && !isLocalAiProvider(provider))
    throw new AiNotConfiguredError(
      `${provider} is selected, but no API key is available in Settings or the local environment.`,
    );
  if (options.webSearch && !aiSupportsWebSearch(provider))
    throw new AiNotConfiguredError(`${AI_PROVIDER_LABELS[provider]} can summarize and rank collected content, but it does not provide live web research. The built-in public-source collectors continue to run.`);
  const selectedModel = await modelFor(settings, provider);
  const model = selectedModel.id;
  const text = provider === "openai"
    ? await runOpenAi(key, model, options)
    : provider === "anthropic"
      ? await runAnthropic(key, model, options)
      : provider === "gemini"
        ? await runGemini(key, model, options)
        : provider === "xai"
          ? await runXai(key, model, options)
          : await runLocalAi(settings, provider, key, model, options, selectedModel.contextLength);
  if (!text.trim()) throw new Error(`${provider} returned no usable text.`);
  return { provider, model, text };
}

export function parseAiJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [trimmed, fenced].filter((value): value is string => Boolean(value));
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket)
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next bounded JSON representation.
    }
  }
  throw new Error("The AI provider returned invalid JSON.");
}
