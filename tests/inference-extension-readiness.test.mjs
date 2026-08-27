import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// extension.ts carries type-only imports, so a single-file transform is enough to reach
// the readiness predicate without dragging the whole host graph into the test process.
async function loadSource(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const startExtension = ({ inferenceProvider, accessToken }, { inferenceExtension }) => inferenceExtension.start({
  deps: {
    auth: { peekAccessToken: () => accessToken, getAccessToken: async () => accessToken ?? "", getMachineId: () => "machine" },
    experiments: {},
    settings: { getInferenceProvider: () => inferenceProvider },
  },
  createPort: () => ({}),
  createWebSearch: () => ({}),
  createWebFetch: () => ({}),
});

test("routed providers are ready without a cached Cursor access token", async (t) => {
  const previous = process.env.SAND_AGENT_MOCK_RESPONSE;
  delete process.env.SAND_AGENT_MOCK_RESPONSE;
  t.after(() => { if (previous !== undefined) process.env.SAND_AGENT_MOCK_RESPONSE = previous; });
  const extension = await loadSource("source/host/extensions/inference/extension.ts");
  const shared = await loadSource("source/shared/inference-router.ts");
  for (const inferenceProvider of shared.SAND_INFERENCE_PROVIDERS.filter((provider) => provider !== "cursor")) {
    assert.equal(await startExtension({ inferenceProvider, accessToken: null }, extension).isReady(), true, inferenceProvider);
  }
});

test("cursor inference still stands down until an access token is cached", async (t) => {
  const previous = process.env.SAND_AGENT_MOCK_RESPONSE;
  delete process.env.SAND_AGENT_MOCK_RESPONSE;
  t.after(() => { if (previous !== undefined) process.env.SAND_AGENT_MOCK_RESPONSE = previous; });
  const extension = await loadSource("source/host/extensions/inference/extension.ts");
  assert.equal(await startExtension({ inferenceProvider: "cursor", accessToken: null }, extension).isReady(), false);
  assert.equal(await startExtension({ inferenceProvider: "cursor", accessToken: "cached-token" }, extension).isReady(), true);
});
