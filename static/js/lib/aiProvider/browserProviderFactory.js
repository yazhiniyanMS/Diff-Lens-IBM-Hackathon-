import { MockAnalysisProvider } from "./mockProvider.js";
import { OpenAICompatibleProvider, OPENAI_COMPATIBLE_PRESETS } from "./openAICompatibleProvider.js";

const STORAGE_KEY = "difflens-ai-settings";

/** { kind: "mock" | "huggingface" | "openai-compatible", apiKey, model, baseUrl } */
export function loadAISettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore -- storage disabled/unavailable, fall through to default
  }
  return { kind: "mock" };
}

export function saveAISettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // private browsing / storage disabled: setting just won't persist
  }
}

/**
 * Builds an AIProvider from settings entered in the UI (never from env
 * vars -- there is no server here). The API key, if any, lives only in
 * this browser's localStorage and is sent directly to the chosen AI host,
 * never to any server of ours (there isn't one).
 */
export function createBrowserProvider(settings) {
  if (!settings || settings.kind === "mock") {
    return new MockAnalysisProvider();
  }
  const preset = OPENAI_COMPATIBLE_PRESETS[settings.kind];
  if (!preset) throw new Error(`Unknown AI provider: ${settings.kind}`);
  const baseUrl = settings.baseUrl || preset.baseUrlDefault;
  const model = settings.model || preset.modelDefault;
  if (!baseUrl) throw new Error(`Enter a base URL for "${settings.kind}".`);
  if (!model) throw new Error(`Enter a model for "${settings.kind}".`);
  return new OpenAICompatibleProvider({ baseUrl, apiKey: settings.apiKey, model, label: preset.label });
}
