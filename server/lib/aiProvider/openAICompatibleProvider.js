import { AIProvider } from "./AIProvider.js";
import { AnalysisResultSchema, PatchProposalSchema } from "../schemas.js";
import { SYSTEM_PREAMBLE, PATCH_SYSTEM_PREAMBLE, extractJson } from "./prompt.js";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Generic adapter for any OpenAI-chat-completions-compatible endpoint.
 * This one implementation is the "connector" for several free/open-source
 * options at once -- Hugging Face's Inference Providers router, OpenRouter's
 * free-tier models, Groq's free tier, or a fully custom endpoint (a local
 * llama.cpp/vLLM/text-generation-webui server, etc.) -- since they all speak
 * the same /chat/completions shape. Only the base URL, API key, and model
 * differ, which is exactly what AI_PROVIDER's presets below configure.
 */
export class OpenAICompatibleProvider extends AIProvider {
  constructor({ baseUrl, apiKey, model, label, timeoutMs } = {}) {
    super();
    if (!baseUrl) throw new Error("OpenAICompatibleProvider requires a baseUrl.");
    if (!model) throw new Error("OpenAICompatibleProvider requires a model.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this._label = label || "openai-compatible";
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get name() {
    return `${this._label}:${this.model}`;
  }

  async _chat(system, userContent) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`${this.name} did not respond within ${this.timeoutMs}ms.`);
      }
      throw new Error(`Could not reach ${this.name} at ${this.baseUrl} (${err.message}).`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${this.name} rejected the request (${res.status}): check its API key env var is set and valid.`);
      }
      throw new Error(`${this.name} returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} returned no message content.`);
    return content;
  }

  async analyzeChange(evidencePackage) {
    const raw = await this._chat(SYSTEM_PREAMBLE, JSON.stringify(evidencePackage));
    let json;
    try {
      json = extractJson(raw);
    } catch (err) {
      throw new Error(`${this.name} did not return valid JSON: ${err.message}`);
    }
    const parsed = AnalysisResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `${this.name} response failed schema validation: ${parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`
      );
    }
    return parsed.data;
  }

  async generatePatch(finding, evidencePackage) {
    const raw = await this._chat(PATCH_SYSTEM_PREAMBLE, JSON.stringify({ finding, evidencePackage }));
    let json;
    try {
      json = extractJson(raw);
    } catch (err) {
      throw new Error(`${this.name} did not return valid JSON: ${err.message}`);
    }
    const parsed = PatchProposalSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `${this.name} patch response failed schema validation: ${parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`
      );
    }
    return parsed.data;
  }

  async assessEquivalence(beforeCode, afterCode, context) {
    const raw = await this._chat(
      'Respond with ONLY JSON: {"likelyEquivalent": boolean, "notes": "..."}',
      JSON.stringify({ beforeCode, afterCode, context })
    );
    return extractJson(raw);
  }
}

/**
 * Named presets for free/open-source-friendly hosts, each just a base URL
 * + API-key env var + a small, sensible default model. Any of them can be
 * overridden per-preset via env vars, or bypassed entirely with
 * AI_PROVIDER=openai-compatible + OPENAI_COMPATIBLE_* for anything else
 * (a local server, a different host, a paid model, ...).
 */
export const OPENAI_COMPATIBLE_PRESETS = {
  huggingface: {
    label: "huggingface",
    baseUrlEnv: "HF_BASE_URL",
    baseUrlDefault: "https://router.huggingface.co/v1",
    apiKeyEnv: "HF_TOKEN",
    modelEnv: "HF_MODEL",
    // Small, code-tuned, genuinely open-source -- a practical fit for the
    // budgeted evidence packages this app sends (see contextEngine.js).
    modelDefault: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  },
  openrouter: {
    label: "openrouter",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    baseUrlDefault: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    modelDefault: "meta-llama/llama-3.2-3b-instruct:free",
  },
  groq: {
    label: "groq",
    baseUrlEnv: "GROQ_BASE_URL",
    baseUrlDefault: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    modelDefault: "llama-3.1-8b-instant",
  },
  "openai-compatible": {
    label: "openai-compatible",
    baseUrlEnv: "OPENAI_COMPATIBLE_BASE_URL",
    baseUrlDefault: null,
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    modelEnv: "OPENAI_COMPATIBLE_MODEL",
    modelDefault: null,
  },
};

export function createPresetProvider(presetName) {
  const preset = OPENAI_COMPATIBLE_PRESETS[presetName];
  if (!preset) throw new Error(`Unknown provider preset: ${presetName}`);
  const baseUrl = process.env[preset.baseUrlEnv] || preset.baseUrlDefault;
  const model = process.env[preset.modelEnv] || preset.modelDefault;
  if (!baseUrl) {
    throw new Error(`AI_PROVIDER=${presetName} requires ${preset.baseUrlEnv} to be set (no default base URL for this preset).`);
  }
  if (!model) {
    throw new Error(`AI_PROVIDER=${presetName} requires ${preset.modelEnv} to be set (no default model for this preset).`);
  }
  return new OpenAICompatibleProvider({
    baseUrl,
    apiKey: process.env[preset.apiKeyEnv],
    model,
    label: preset.label,
  });
}
