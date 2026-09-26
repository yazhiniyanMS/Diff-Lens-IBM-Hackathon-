import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../server/lib/aiProvider/ollamaProvider.js";
import { extractJson } from "../server/lib/aiProvider/prompt.js";
import { AnalysisResultSchema } from "../server/lib/schemas.js";

const VALID_ANALYSIS = {
  intent: "Rename a field",
  intentProvenance: "inference",
  behavioralChanges: [],
  affectedWorkflows: [],
  impactedModules: [],
  apiContractChanges: [],
  schemaInterfaceImpact: [],
  relatedTests: [],
  missingTests: [],
  documentationGaps: [],
  securityConcerns: [],
  backwardCompatibilityConcerns: [],
  untouchedFiles: [],
  reviewQuestions: ["Was this intentional?"],
};

test("extractJson pulls a JSON object out of a markdown-fenced response", () => {
  const text = "Sure, here you go:\n```json\n" + JSON.stringify({ a: 1 }) + "\n```\nHope that helps!";
  assert.deepEqual(extractJson(text), { a: 1 });
});

test("extractJson pulls a bare JSON object with no fences or prose", () => {
  assert.deepEqual(extractJson(JSON.stringify({ b: 2 })), { b: 2 });
});

test("extractJson throws a clear error when there's no JSON object at all", () => {
  assert.throws(() => extractJson("I cannot help with that."), /did not contain a JSON object/);
});

test("OllamaProvider.analyzeChange parses a well-formed model response", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, opts) => {
    assert.match(url, /\/api\/generate$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.format, "json");
    return {
      ok: true,
      json: async () => ({ response: JSON.stringify(VALID_ANALYSIS) }),
    };
  };

  const provider = new OllamaProvider({ model: "test-model" });
  const result = await provider.analyzeChange({ changedFiles: [], changeSignals: {}, contextItems: [] });
  assert.equal(AnalysisResultSchema.safeParse(result).success, true);
  assert.equal(result.intent, "Rename a field");
});

test("OllamaProvider surfaces a clear error when the model returns invalid JSON", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({ ok: true, json: async () => ({ response: "not json at all" }) });

  const provider = new OllamaProvider({ model: "test-model" });
  await assert.rejects(
    () => provider.analyzeChange({ changedFiles: [], changeSignals: {}, contextItems: [] }),
    /did not return valid JSON/
  );
});

test("OllamaProvider surfaces a clear error when it can't reach the server at all", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  const provider = new OllamaProvider({ model: "test-model" });
  await assert.rejects(
    () => provider.analyzeChange({ changedFiles: [], changeSignals: {}, contextItems: [] }),
    /Could not reach Ollama/
  );
});

test("OllamaProvider defaults to localhost:11434 and llama3.2:1b, both overridable", () => {
  const defaults = new OllamaProvider();
  assert.equal(defaults.baseUrl, "http://localhost:11434");
  assert.equal(defaults.model, "llama3.2:1b");

  const custom = new OllamaProvider({ baseUrl: "http://example.com:1234/", model: "phi3:mini" });
  assert.equal(custom.baseUrl, "http://example.com:1234");
  assert.equal(custom.model, "phi3:mini");
  assert.equal(custom.name, "ollama:phi3:mini");
});
