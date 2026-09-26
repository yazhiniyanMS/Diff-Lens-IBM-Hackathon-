import { MockAnalysisProvider } from "./mockProvider.js";
import { BobProvider } from "./bobProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { OpenAICompatibleProvider, createPresetProvider, OPENAI_COMPATIBLE_PRESETS } from "./openAICompatibleProvider.js";

let cached = null;

/**
 * Factory: AI_PROVIDER env var selects the provider. Defaults to "mock" so
 * the app runs out of the box with zero credentials.
 *  - "mock": deterministic heuristic provider, no network calls at all.
 *  - "ollama": free, fully open-source, runs locally, no API key at all.
 *  - "huggingface" / "openrouter" / "groq": free-tier-friendly hosted
 *    open-source models via one shared OpenAI-compatible connector.
 *  - "openai-compatible": any other OpenAI-chat-completions-compatible
 *    endpoint (a local server, a different host, ...), fully configured
 *    via OPENAI_COMPATIBLE_* env vars.
 *  - "bob": IBM Bob adapter, needs BOB_API_URL (+ typically BOB_API_KEY).
 * A misconfigured non-mock provider fails loud rather than silently
 * degrading, so a setup mistake is never confused with a real result.
 */
export function getAIProvider() {
  if (cached) return cached;
  const kind = (process.env.AI_PROVIDER || "mock").toLowerCase();
  if (kind === "bob") {
    cached = new BobProvider();
  } else if (kind === "ollama") {
    cached = new OllamaProvider();
  } else if (Object.prototype.hasOwnProperty.call(OPENAI_COMPATIBLE_PRESETS, kind)) {
    cached = createPresetProvider(kind);
  } else {
    cached = new MockAnalysisProvider();
  }
  return cached;
}

export { AIProvider } from "./AIProvider.js";
export { MockAnalysisProvider } from "./mockProvider.js";
export { BobProvider } from "./bobProvider.js";
export { OllamaProvider } from "./ollamaProvider.js";
export { OpenAICompatibleProvider, createPresetProvider, OPENAI_COMPATIBLE_PRESETS };
