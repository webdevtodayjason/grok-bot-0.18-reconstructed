import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the Machine Room allowance adapter renders all three measured states without app.js", async () => {
  const [html, css, adapter] = await Promise.all([
    readFile(path.join(root, "ui/machine-room/index.html"), "utf8"),
    readFile(path.join(root, "ui/machine-room/styles.css"), "utf8"),
    readFile(path.join(root, "ui/machine-room/gateway-adapter.js"), "utf8"),
  ]);
  assert.match(html, /id="allowance-meter"/);
  assert.match(html, /id="allowance-drawer"/);
  for (const state of ["warning", "exhausted"]) assert.match(css, new RegExp(`data-state=\\"${state}\\"`));
  assert.match(adapter, /dataset\.state = state/);
  assert.match(adapter, /Math\.min\(100/);
  assert.match(adapter, /\/allowance/);
  assert.doesNotMatch(adapter, /Math\.random\(\).*allowance/);
});
