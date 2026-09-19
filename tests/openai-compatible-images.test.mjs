// A computerUse screenshot has to reach the model as a picture. Tool results were unconditionally
// JSON-stringified, so a screenshot arrived as a megabyte of base64 TEXT: the model had nothing it
// could see, every computerUse subagent finished having driven nothing, and the agent honestly
// reported that the pass returned no result and dispatched again. That loop is what "the agent
// says it will do something and never comes back" looked like from the outside.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  path.join(repoRoot, "source/host/extensions/inference/openai-compatible-chat.ts"), "utf8");

// Lift the three pure helpers out of the TypeScript by stripping the annotations they use. Reading
// the shipped file keeps the test honest about what actually runs.
function loadHelpers() {
  const start = source.indexOf("const IMAGE_BYTES_MAX");
  const end = source.indexOf("async function executeToolCalls");
  assert.ok(start > 0 && end > start, "the image helpers must be findable");
  // Strip exactly the annotations these three helpers use. Regex-stripping TypeScript in general
  // is a bad idea; strip a known, small set and let the test fail loudly if the source drifts.
  const js = source.slice(start, end)
    .replace(/\): Array<\{ b64: string; mediaType: string \}> \{/g, ") {")
    .replace(/\): unknown \{/g, ") {")
    .replace(/: Array<\{ b64: string; mediaType: string \}> = \[\]/g, " = []")
    .replace(/\(value: unknown\)/g, "(value)")
    .replace(/\(b64: unknown, mediaType: unknown\)/g, "(b64, mediaType)")
    .replace(/ as Loose/g, "");
  assert.doesNotMatch(js, /:\s*(unknown|Loose|string|Array)/, "an unstripped annotation means the source shape changed");
  return new Function(`${js}\nreturn { imagePartsFrom, withoutImageBytes, IMAGE_BYTES_MAX };`)();
}

const { imagePartsFrom, withoutImageBytes, IMAGE_BYTES_MAX } = loadHelpers();

test("a computerUse screenshot is recognised as an image", () => {
  const parts = imagePartsFrom({ kind: "image", text: "clicked", imageB64: "AAAA" });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].b64, "AAAA");
  assert.equal(parts[0].mediaType, "image/png", "png is the right default for a screenshot");
});

test("a nested image object is recognised too", () => {
  const parts = imagePartsFrom({ image: { base64: "BBBB", mediaType: "image/jpeg" } });
  assert.deepEqual(parts, [{ b64: "BBBB", mediaType: "image/jpeg" }]);
});

test("a plain text tool result yields no image", () => {
  assert.deepEqual(imagePartsFrom({ kind: "text", text: "done" }), []);
  assert.deepEqual(imagePartsFrom("just a string"), []);
  assert.deepEqual(imagePartsFrom(null), []);
});

test("an implausibly large image is refused rather than sent", () => {
  // Guards against one screenshot blowing the whole request.
  assert.deepEqual(imagePartsFrom({ imageB64: "x".repeat(IMAGE_BYTES_MAX + 1) }), []);
});

test("a non-image media type does not smuggle a file through as a picture", () => {
  const parts = imagePartsFrom({ imageB64: "CCCC", mediaType: "application/pdf" });
  assert.equal(parts[0].mediaType, "image/png", "anything not image/* falls back rather than being trusted");
});

test("the base64 is stripped from the tool message so it is not sent twice", () => {
  const stripped = withoutImageBytes({ kind: "image", text: "clicked", imageB64: "AAAA" });
  assert.equal(stripped.imageB64, undefined);
  assert.equal(stripped.text, "clicked", "the tool's own text must survive");
});

test("stripping leaves a plain result untouched", () => {
  assert.deepEqual(withoutImageBytes({ kind: "text", text: "done" }), { kind: "text", text: "done" });
});

test("the request shape is the one OpenAI-compatible vision endpoints accept", () => {
  // The tool role cannot carry an image, so it follows as a user message with image_url parts.
  assert.match(source, /role: "user"/);
  assert.match(source, /type: "image_url"/);
  assert.match(source, /data:\$\{image\.mediaType\};base64,/);
});

// ================================================================================================
// MODEL-1c. A SCREENSHOT GOES WHERE IT CAN BE READ, rather than to a model with no eyes.
//
// MEASURED ON THE R750 2026-09-19: a turn carrying a picture on plan-nemotron, which is text only,
// cost the refused hop, a learned refusal flag, the picture being replaced by a sentence and the
// same question asked again. Three round trips to arrive somewhere that cannot see, with the route
// sitting in the deployment's own record the whole time.
//
// The rule is lifted out of the shipped file the same way the three helpers above are, so what is
// measured is what runs rather than a copy of it.
function loadRouting() {
  const start = source.indexOf("export function modelForRequest");
  const end = source.indexOf("export function noteAnsweredModel");
  assert.ok(start > 0 && end > start, "modelForRequest must be findable in the shipped file");
  const carries = source.slice(source.indexOf("export function carriesImageParts"), source.indexOf("export function withoutImageParts"));
  const guard = source.slice(source.indexOf("function record(value: unknown)"), source.indexOf("function safeJson"));
  const js = `${guard}\n${carries}\n${source.slice(start, end)}`
    .replace(/export function /g, "function ")
    .replace(/\(value: unknown\): Loose \| null \{/g, "(value) {")
    .replace(/\(messages: readonly Loose\[\]\): boolean \{/g, "(messages) {")
    .replace(/\(part: unknown\) =>/g, "(part) =>")
    .replace(/\(pin: string, messages: readonly Loose\[\], visionFallback: string\): string \{/g, "(pin, messages, visionFallback) {")
    .replace(/ as Loose/g, "");
  assert.doesNotMatch(js, /:\s*(readonly|Loose|unknown|boolean)/, "an unstripped annotation means the source shape changed");
  return new Function(`${js}\nreturn { modelForRequest, carriesImageParts };`)();
}
const { modelForRequest } = loadRouting();

const withPicture = [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }];
const textOnly = [{ role: "user", content: "what is this" }];

test("a request carrying a picture on a text-only pin goes to the vision route", () => {
  assert.equal(modelForRequest("plan-nemotron", withPicture, "plan-zai-vision"), "plan-zai-vision");
});

test("the same pin answers its own text turns", () => {
  assert.equal(modelForRequest("plan-nemotron", textOnly, "plan-zai-vision"), "plan-nemotron",
    "only a picture reroutes; everything else is the plan the customer chose");
});

test("a pin that can see is never rerouted, whatever is configured beside it", () => {
  // The relay writes the route ONLY for a plan measured text-only, so an empty value is what a
  // seeing model carries and the rule has to answer the pin for it.
  assert.equal(modelForRequest("plan-qwen", withPicture, ""), "plan-qwen");
  // And a row that names itself is "images stop here", not a second model to route to.
  assert.equal(modelForRequest("plan-minimax", withPicture, "plan-minimax"), "plan-minimax");
});

test("the rule reads the picture out of the messages rather than being told", () => {
  // A tool result carrying a screenshot is an image part like any other, which is the shape a
  // computerUse turn actually arrives in.
  const toolShot = [{ role: "tool", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }] }];
  assert.equal(modelForRequest("plan-nemotron", toolShot, "plan-zai-vision"), "plan-zai-vision");
  assert.equal(modelForRequest("plan-nemotron", [], "plan-zai-vision"), "plan-nemotron");
});
