import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, createPresetProvider } from "../server/lib/aiProvider/openAICompatibleProvider.js";

const VALID_ANALYSIS = {
  intent: "Add a helper function",
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
  reviewQuestions: [],
};

test("createPresetProvider('huggingface') uses the documented default base URL and model", () => {
  const original = { HF_BASE_URL: process.env.HF_BASE_URL, HF_MODEL: process.env.HF_MODEL, HF_TOKEN: process.env.HF_TOKEN };
  delete process.env.HF_BASE_URL;
  delete process.env.HF_MODEL;
  delete process.env.HF_TOKEN;
  try {
    const provider = createPresetProvider("huggingface");
    assert.equal(provider.baseUrl, "https://router.huggingface.co/v1");
    assert.equal(provider.model, "Qwen/Qwen2.5-Coder-1.5B-Instruct");
    assert.equal(provider.name, "huggingface:Qwen/Qwen2.5-Coder-1.5B-Instruct");
  } finally {
    Object.entries(original).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
});

test("createPresetProvider('openai-compatible') requires an explicit base URL and model", () => {
  const original = { OPENAI_COMPATIBLE_BASE_URL: process.env.OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_MODEL: process.env.OPENAI_COMPATIBLE_MODEL };
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  delete process.env.OPENAI_COMPATIBLE_MODEL;
  try {
    assert.throws(() => createPresetProvider("openai-compatible"), /requires OPENAI_COMPATIBLE_BASE_URL/);
  } finally {
    Object.entries(original).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
});

test("createPresetProvider throws on an unknown preset name", () => {
  assert.throws(() => createPresetProvider("not-a-real-preset"), /Unknown provider preset/);
});

test("OpenAICompatibleProvider sends an OpenAI-style chat completion and validates the response", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, opts) => {
    assert.match(url, /\/chat\/completions$/);
    assert.equal(opts.headers.authorization, "Bearer test-key");
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "some/model");
    assert.equal(body.messages[0].role, "system");
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(VALID_ANALYSIS) } }] }),
    };
  };

  const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.com/v1", apiKey: "test-key", model: "some/model", label: "test" });
  const result = await provider.analyzeChange({ changedFiles: [], changeSignals: {}, contextItems: [] });
  assert.equal(result.intent, "Add a helper function");
  assert.equal(provider.name, "test:some/model");
});

test("OpenAICompatibleProvider surfaces a clear error on 401/403", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });

  const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.com/v1", model: "some/model", label: "test" });
  await assert.rejects(
    () => provider.analyzeChange({ changedFiles: [], changeSignals: {}, contextItems: [] }),
    /rejected the request/
  );
});

test("OpenAICompatibleProvider requires baseUrl and model", () => {
  assert.throws(() => new OpenAICompatibleProvider({ model: "x" }), /requires a baseUrl/);
  assert.throws(() => new OpenAICompatibleProvider({ baseUrl: "https://example.com" }), /requires a model/);
});
