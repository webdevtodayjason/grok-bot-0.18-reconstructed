// The browser tools declared only a list of required argument names; nothing turned that into a
// model-facing schema, and the OpenAI-compatible executor drops any tool without `parameters`.
// A browserUse subagent therefore reached the wire holding Shell and Read alone (GAP-ANALYSIS
// SUB-1). This pins the fix: every browser tool carries a zod schema that names each required
// argument, and the executor's mapper keeps all fifteen.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBrowserTools() {
  const outfile = path.join(repoRoot, `.tmp-browser-tools-${randomUUID()}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, "source/host/runner/tools/sand-browser-tools.ts")],
    bundle: true, format: "esm", platform: "node", target: "node22", packages: "external", outfile, logLevel: "silent",
  });
  return { module: await import(`file://${outfile}`), cleanup: () => rm(outfile, { force: true }) };
}

async function loadExecutor() {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/openai-compatible-chat.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("every browser tool carries parameters naming its required arguments, and the executor keeps all fifteen", async () => {
  const { module, cleanup } = await loadBrowserTools();
  try {
    const tools = module.createSandBrowserTools({});
    assert.equal(tools.length, 15);
    for (const tool of tools) {
      assert.ok(tool.parameters, `${tool.name} has no parameters`);
      const shape = Object.keys(tool.parameters.shape ?? {});
      for (const name of tool.schema.required ?? []) {
        assert.ok(shape.includes(name), `${tool.name}: required argument "${name}" is not in its parameter schema`);
      }
    }
    const { openAiCompatibleTools } = await loadExecutor();
    const sent = openAiCompatibleTools(tools).map((tool) => tool.name);
    assert.deepEqual(sent, tools.map((tool) => tool.name));
  } finally {
    await cleanup();
  }
});
