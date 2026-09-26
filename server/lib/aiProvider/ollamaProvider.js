import { AIProvider } from "./AIProvider.js";
import { AnalysisResultSchema, PatchProposalSchema } from "../schemas.js";
import { SYSTEM_PREAMBLE, PATCH_SYSTEM_PREAMBLE, extractJson } from "./prompt.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Adapter for Ollama (https://ollama.com) -- a free, fully open-source
 * local LLM runner. Unlike BobProvider this requires no API key or
 * account: install Ollama, `ollama pull <model>` once, and point
 * AI_PROVIDER=ollama at it. This is the practical "use an open-source
 * model for real analysis, no credentials" path for this hackathon MVP.
 *
 * Small/quantized models (the kind that run comfortably on a laptop CPU,
 * e.g. llama3.2:1b, qwen2.5-coder:1.5b, phi3:mini) are exactly what the
 * evidence-package design in this app is built for: the context engine
 * already budgets repository context down to a small, ranked set (see
 * server/lib/contextEngine.js) instead of dumping a whole repo at the
 * model, which is what makes a small local model viable here at all.
 */
export class OllamaProvider extends AIProvider {
  constructor({ baseUrl, model, timeoutMs } = {}) {
    super();
    this.baseUrl = (baseUrl || process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
    this.model = model || process.env.OLLAMA_MODEL || "llama3.2:1b";
    this.timeoutMs = timeoutMs || Number(process.env.OLLAMA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  }

  get name() {
    return `ollama:${this.model}`;
  }

  async _generate(system, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, system, prompt, format: "json", stream: false }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Ollama did not respond within ${this.timeoutMs}ms (model: ${this.model}). Try a smaller model or increase OLLAMA_TIMEOUT_MS.`);
      }
      throw new Error(
        `Could not reach Ollama at ${this.baseUrl} (${err.message}). Is it running? Install from https://ollama.com, ` +
          `then \`ollama pull ${this.model}\` and \`ollama serve\`. Or set AI_PROVIDER=mock to use the built-in heuristic provider instead.`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new Error(`Ollama has no model "${this.model}" pulled. Run: ollama pull ${this.model}`);
      }
      throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    return body.response;
  }

  async analyzeChange(evidencePackage) {
    const raw = await this._generate(SYSTEM_PREAMBLE, JSON.stringify(evidencePackage));
    let json;
    try {
      json = extractJson(raw);
    } catch (err) {
      throw new Error(`${this.name} did not return valid JSON: ${err.message}`);
    }
    const parsed = AnalysisResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${this.name} response failed schema validation: ${parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`);
    }
    return parsed.data;
  }

  async generatePatch(finding, evidencePackage) {
    const raw = await this._generate(PATCH_SYSTEM_PREAMBLE, JSON.stringify({ finding, evidencePackage }));
    let json;
    try {
      json = extractJson(raw);
    } catch (err) {
      throw new Error(`${this.name} did not return valid JSON: ${err.message}`);
    }
    const parsed = PatchProposalSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${this.name} patch response failed schema validation: ${parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`);
    }
    return parsed.data;
  }

  async assessEquivalence(beforeCode, afterCode, context) {
    const raw = await this._generate(
      "Respond with ONLY JSON: {\"likelyEquivalent\": boolean, \"notes\": \"...\"}",
      JSON.stringify({ beforeCode, afterCode, context })
    );
    return extractJson(raw);
  }
}
