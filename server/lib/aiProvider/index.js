import { MockAnalysisProvider } from "./mockProvider.js";
import { BobProvider } from "./bobProvider.js";

let cached = null;

/**
 * Factory: AI_PROVIDER env var selects the provider ("mock" | "bob").
 * Defaults to mock so the app runs out of the box with zero credentials.
 * If AI_PROVIDER=bob is requested but BOB_API_URL is missing, we fail loud
 * rather than silently degrading, so a misconfiguration is never confused
 * with a real analysis result.
 */
export function getAIProvider() {
  if (cached) return cached;
  const kind = (process.env.AI_PROVIDER || "mock").toLowerCase();
  if (kind === "bob") {
    cached = new BobProvider();
  } else {
    cached = new MockAnalysisProvider();
  }
  return cached;
}

export { AIProvider } from "./AIProvider.js";
export { MockAnalysisProvider } from "./mockProvider.js";
export { BobProvider } from "./bobProvider.js";
