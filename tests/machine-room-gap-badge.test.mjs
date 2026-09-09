// CONSOLE-4 item 2: the between-chats badge. Jason, 2026-09-08 20:03: "All the shell commands and
// everything that happens in between chats, while the agent is doing work, can live inside a badge,
// right? If I want, I can click the badge to expand it or just leave it shrunk inside the badge."
//
// ui/machine-room/gap-badge.js is RUN here, not copied: a copy in this file would go on passing
// after the console changed. It is loaded the way the browser loads it -- as a classic script with
// a window handed to it -- so the same code answers here and on the page.
//
// What is pinned, because each of these is a way the badge could lose something a person needs:
//
//   - The gap predicate. A gap is a maximal run of rows whose type is "system", and that one line
//     is the entire "never hides a card" requirement: a decision card, a hand-off card, a secret
//     card, an attachment and a failed turn all carry another type, so each of them bounds a gap
//     and none of them can land inside a body. If that predicate ever widens, this file goes red.
//
//   - Receipts stay one click away (SHOT-4). The rows inside a body are messageMarkup's own output
//     byte for byte -- the <details> receipt and the exchange row keep their markup and their
//     delegated handlers -- so folding them into a badge costs a click and hides nothing.
//
//   - The words never lie. Steps sum the counts foldRepeatedRows stamped. Kinds come from the
//     `kind` field the adapter carries and never from the row's sentence: after SHOT-4 a shell row
//     that wrote a file reads "Wrote console4-probe.md · ...", so a text parse mislabels exactly
//     the rows that carry receipts. A gap missing either bounding chat entry prints the step count
//     and no duration, because no tool row carries a timestamp of any kind and a made-up span is
//     worse than none.
//
//   - State is not in the DOM. A working turn wiped #transcript five times in 36 s on
//     grok-bot-local-vm, so an open badge has to survive a rebuild, and a private window whose
//     localStorage accessor throws has to leave badges collapsed rather than take the render down.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const badgePath = path.join(repoRoot, "ui/machine-room/gap-badge.js");
const appPath = path.join(repoRoot, "ui/machine-room/app.js");

// ---- loading the module the way a page does ---------------------------------------------------
function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

async function loadBadge(options = {}) {
  const source = await readFile(badgePath, "utf8");
  const store = options.store === undefined ? memoryStore() : options.store;
  const window = options.window ?? {};
  if (options.throwingStore) {
    Object.defineProperty(window, "localStorage", {
      get() { throw new Error("The operation is insecure."); },
    });
  } else {
    window.localStorage = store;
  }
  // `document` is left undefined on purpose: the module guards every DOM reach on
  // `typeof document === "undefined"`, and a test that never lies about having a document is the
  // only way render() stays provably pure.
  const factory = new Function("window", `${source}\nreturn window.__gapBadge;`);
  return { api: factory(window), store, window };
}

// The console's real messageMarkup, sliced out of app.js and run, so "byte-identical to
// messageMarkup's output" means the actual function and not a second copy of its string.
async function realMessageMarkup() {
  const source = await readFile(appPath, "utf8");
  const grab = (name) => {
    const start = source.indexOf(`  function ${name}(`);
    assert.notEqual(start, -1, `app.js no longer defines ${name}`);
    const end = source.indexOf("\n  }\n", start);
    return source.slice(start, end + 4);
  };
  // The chat branch of messageMarkup reaches into half of app.js. Those helpers are stubbed, not
  // sliced: what is being pinned here is the SYSTEM branch -- the receipt <details> and the
  // exchange row that ride inside a badge body -- and that branch returns before it touches any
  // of them.
  return new Function(`
    const workerById = () => null;
    const activeContext = () => null;
    const avatarMarkup = () => "";
    const roomSpeakerMarkup = () => "";
    const paragraphMarkup = (text) => "<p>" + escapeHtml(text) + "</p>";
    const attachmentMarkup = () => "";
    const specialMessageMarkup = () => "";
    const evidenceChipMarkup = () => "";
    ${grab("escapeHtml")}
    ${grab("messageMarkup")}
    return messageMarkup;
  `)();
}

// A stand-in for the rows this file only needs to see BOUND a gap. It escapes its id the way the
// console does, so anything unescaped in a result came out of gap-badge.js and not out of here.
const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const stubMarkup = (message) => `<x data-id="${esc(message.id)}" data-type="${esc(message.type)}"></x>`;

const chat = (id, extra = {}) => ({ id, type: "text", authorId: "agent", authorName: "Titan", text: "ok", ...extra });
const sys = (id, text, extra = {}) => ({ id, type: "system", text, ...extra });

// The badge's body holds whole <article> rows, so a badge cannot be cut out with a regex: the
// first </article> in it belongs to a row inside it. This walks the tags and counts depth.
function badges(html) {
  const open = '<article class="message-row is-system gap-badge';
  const out = [];
  let at = html.indexOf(open);
  while (at !== -1) {
    let depth = 0;
    let i = at;
    while (i < html.length) {
      if (html.startsWith("<article", i)) { depth += 1; i += 8; continue; }
      if (html.startsWith("</article>", i)) { depth -= 1; i += 10; if (depth === 0) break; continue; }
      i += 1;
    }
    assert.equal(depth, 0, "every badge closes");
    out.push(html.slice(at, i));
    at = html.indexOf(open, i);
  }
  return out;
}
const bodyOf = (badge) => {
  const at = badge.indexOf('<div class="gap-badge-body"');
  assert.notEqual(at, -1, "the badge must carry a body");
  const end = badge.lastIndexOf("</div></article>");
  assert.ok(end > at, "the body is the badge's last element");
  return badge.slice(badge.indexOf(">", at) + 1, end);
};
const headOf = (html) => html.slice(html.indexOf('<button class="gap-badge-head"'), html.indexOf("</button>"));

// ---- B1, the grouping pass ---------------------------------------------------------------------
test("chat, system, system, chat is one badge with both system rows inside its body", async () => {
  const { api } = await loadBadge();
  const html = api.render(
    [chat("c1"), sys("t1", "Shell · ls"), sys("t2", "Computer · running"), chat("c2")],
    stubMarkup,
    { agentId: "titan", working: false },
  );
  const found = badges(html);
  assert.equal(found.length, 1, "one gap is one badge");
  const body = bodyOf(found[0]);
  assert.ok(body.includes('data-id="t1"'), "the first system row is inside the body");
  assert.ok(body.includes('data-id="t2"'), "the second system row is inside the body");
  assert.ok(!body.includes('data-id="c1"') && !body.includes('data-id="c2"'), "no chat row is inside a body");
  // The chat rows are still drawn, outside the badge, in order.
  assert.ok(html.indexOf('data-id="c1"') < html.indexOf("gap-badge"), "the opening chat row is above the badge");
  assert.ok(html.indexOf('data-id="c2"') > html.indexOf("</article>"), "the closing chat row is below it");
});

test("a decision, a hand-off, a secret card, an attachment and a failed turn each bound a gap and never appear inside one", async () => {
  const { api } = await loadBadge();
  const cards = [
    { id: "d1", type: "decision", text: "Approve?", card: {} },
    { id: "h1", type: "handoff", text: "", handoff: {} },
    { id: "s1", type: "attachment", text: "", attachment: { name: "key.env", path: "/x", kind: "file" } },
    { id: "a1", type: "attachment", text: "", attachment: { name: "notes.md", path: "/y", kind: "file" } },
    { id: "f1", type: "turn-failed", text: "That turn did not finish." },
    { id: "w1", type: "working", text: "", authorName: "Titan" },
  ];
  for (const card of cards) {
    const html = api.render(
      [sys("t1", "Shell · ls"), sys("t2", "Shell · pwd"), card, sys("t3", "Shell · ls"), sys("t4", "Shell · pwd")],
      stubMarkup,
      { agentId: "titan", working: false },
    );
    const found = badges(html);
    assert.equal(found.length, 2, `a ${card.type} row splits the run in two (${card.id})`);
    for (const badge of found) {
      assert.ok(!bodyOf(badge).includes(`data-id="${card.id}"`), `a ${card.type} row is never inside a body`);
    }
    assert.ok(html.includes(`data-id="${card.id}"`), `the ${card.type} row is still drawn`);
  }
});

// A run of one is already one row, and swapping a sentence for "1 step" hides a fact behind a click
// while saving about eight pixels. On the Books agent on grok-bot-local-vm five of seven runs are
// single rows; folding those would have cost five legible lines -- "Accepted by the host", "Wrote
// reminder-1042.md · /workspace/reminder-1042.md" -- and on a lone receipt row it would have put a
// second click in front of a receipt SHOT-4 put one click away.
test("a run of one row is drawn as that row, not swapped for a badge that says 1 step", async () => {
  const { api } = await loadBadge();
  const messageMarkup = await realMessageMarkup();
  const lone = sys("t1", "Accepted by the host");
  const html = api.render([chat("c1"), lone, chat("c2")], messageMarkup, { agentId: "titan", working: false });
  assert.equal(badges(html).length, 0, "nothing to collapse, so nothing is collapsed");
  assert.ok(html.includes(messageMarkup(lone)), "the row is exactly what it was");
  assert.ok(html.includes("Accepted by the host"), "and the person can still read it without clicking");

  const receipt = sys("tool-1", "Wrote reminder-1042.md · /workspace/reminder-1042.md", { detail: "Shell · cat > x\n\nexit 0", kind: "shell" });
  const alone = api.render([chat("c1"), receipt, chat("c2")], messageMarkup, { agentId: "titan", working: false });
  assert.equal(badges(alone).length, 0);
  assert.ok(alone.includes('<details class="message-bubble tool-receipt">'), "its receipt is still one click, not two");

  // Two is where a badge starts buying something.
  assert.equal(api.MIN_FOLD, 2);
  assert.equal(badges(api.render([chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")], stubMarkup, {})).length, 1);
});

test("a receipt opened on an unfolded single row also survives a rebuild", async () => {
  const { api } = await loadBadge();
  const messageMarkup = await realMessageMarkup();
  const receipt = sys("tool-9", "Wrote notes.md · notes.md", { detail: "Shell · cat > notes.md", kind: "shell" });
  const rows = [chat("c1"), receipt, chat("c2")];
  api.render(rows, messageMarkup, {});
  api.noteReceipt("tool-9", true);
  assert.ok(api.render(rows, messageMarkup, {}).includes('<details class="message-bubble tool-receipt" open>'));
});

test("a run of system rows with no chat around it is still one badge", async () => {
  const { api } = await loadBadge();
  const html = api.render([sys("t1", "a"), sys("t2", "b"), sys("t3", "c")], stubMarkup, { agentId: "titan", working: false });
  assert.equal(badges(html).length, 1);
  assert.match(html, /data-gap-steps="3"/);
});

// ---- B2, the badge, and the receipts inside it -------------------------------------------------
test("a receipt row and an exchange row are inside the body, byte for byte as messageMarkup drew them", async () => {
  const { api } = await loadBadge();
  const messageMarkup = await realMessageMarkup();
  const receipt = sys("tool-1", "Wrote console4-probe.md · docs/console4-probe.md", { detail: "Shell · cat > x\n\nexit 0", kind: "shell" });
  const exchange = sys("x-1", "2 messages with Scribe", { peer: "Scribe", self: "Titan", exchange: { rows: [] } });
  const html = api.render([chat("c1"), receipt, exchange, chat("c2")], messageMarkup, { agentId: "titan", working: false });
  const body = bodyOf(badges(html)[0]);
  assert.ok(body.includes(messageMarkup(receipt)), "the receipt row's markup is unchanged");
  assert.ok(body.includes(messageMarkup(exchange)), "the exchange row's markup is unchanged");
  assert.ok(body.includes("<details class=\"message-bubble tool-receipt\">"), "the receipt is still a <details>, one click from open");
  assert.ok(body.includes('role="button"'), "the exchange row keeps the role its delegated handler looks for");
});

test("the head is a real button and no <button> is ever nested inside a body", async () => {
  const { api } = await loadBadge();
  const messageMarkup = await realMessageMarkup();
  const html = api.render(
    [chat("c1"), sys("t1", "Shell · ls", { kind: "shell" }), sys("x1", "2 messages with Scribe", { exchange: {} }), chat("c2")],
    messageMarkup,
    { agentId: "titan", working: false },
  );
  const badge = badges(html)[0];
  assert.match(headOf(badge), /^<button class="gap-badge-head" type="button" data-gap-toggle="[^"]+" aria-expanded="(true|false)"/);
  assert.equal(bodyOf(badge).includes("<button"), false, "a button inside a button is not a control anybody can click");
});

test("the body is aria-live off, because #transcript is aria-live polite", async () => {
  const { api } = await loadBadge();
  const html = api.render([chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")], stubMarkup, { agentId: "titan", working: false });
  assert.match(badges(html)[0], /<div class="gap-badge-body" id="[^"]+" aria-live="off"/);
});

test("the DOM contract the gate reads is on the article", async () => {
  const { api } = await loadBadge();
  const html = api.render([chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")], stubMarkup, { agentId: "titan", working: false });
  const badge = badges(html)[0];
  assert.match(badge, /class="message-row is-system gap-badge/, "the badge is a system message row");
  assert.match(badge, /data-gap="gap:c2"/, "keyed on the chat row that closes the gap");
  assert.match(badge, /data-gap-steps="2"/);
  assert.match(badge, /data-gap-open="0"/, "collapsed by default");
  assert.match(badge, /<div class="gap-badge-body"[^>]* hidden>/, "collapsed means the body is hidden, not absent");
});

// ---- B3, the words -------------------------------------------------------------------------------
test("steps sum the counts foldRepeatedRows stamped, not the row count", async () => {
  const { api } = await loadBadge();
  const html = api.render(
    [chat("c1"), sys("t3", "Computer · running", { count: 17 }), sys("t4", "Shell · ls", { detail: "x" }), chat("c2")],
    stubMarkup,
    { agentId: "titan", working: false },
  );
  const badge = badges(html)[0];
  assert.match(badge, /data-gap-steps="18"/, "17 folded steps plus one receipt row");
  assert.match(headOf(badge), /18 steps/);
});

test("a SHOT-4 row that reads 'Wrote ...' is counted as shell, from the kind field", async () => {
  const { api } = await loadBadge();
  const rows = [
    chat("c1"),
    sys("t1", "Wrote console4-probe.md · docs/console4-probe.md", { detail: "Shell · cat > x", kind: "shell" }),
    sys("t2", "Opened github.com", { detail: "Shell · box-chrome ...", kind: "browser" }),
    sys("t3", "Read app.js · ui/machine-room/app.js", { kind: "read" }),
    chat("c2"),
  ];
  const words = api.kindWords(api.group(rows, {}).find((item) => item.rows));
  assert.equal(words, "browser 1, read 1, shell 1", "the kinds come from `kind`; nothing here says 'wrote'");
  assert.ok(!words.includes("wrote"), "a text parse would have mislabelled exactly the row that carries a receipt");
});

test("the kinds line reads biggest first and is dropped when it would only restate the count", async () => {
  const { api } = await loadBadge();
  const many = [chat("c1")];
  for (let i = 0; i < 6; i += 1) many.push(sys(`s${i}`, "Shell", { kind: "shell" }));
  for (let i = 0; i < 3; i += 1) many.push(sys(`b${i}`, "Opened", { kind: "browser" }));
  for (let i = 0; i < 5; i += 1) many.push(sys(`r${i}`, "Read", { kind: "read" }));
  many.push(chat("c2"));
  const gap = api.group(many, {}).find((item) => item.rows);
  assert.equal(api.kindWords(gap), "shell 6, read 5, browser 3", "Jason's own example, in his own order");

  const lone = api.group([chat("c1"), sys("t1", "Shell · ls", { kind: "shell" }), chat("c2")], {}).find((item) => item.rows);
  assert.equal(api.kindWords(lone), "", "'shell 1' under '1 step' is the same fact twice");

  // The seventeen folded "Computer · running" rows DASH-FOLD-1 was built for: one kind, and it
  // accounts for every step, so the line under the headline would say nothing new.
  const folded = api.group([chat("c1"), sys("t1", "Computer · running", { kind: "computer", count: 17 }), chat("c2")], {}).find((item) => item.rows);
  assert.equal(folded.steps, 17);
  assert.equal(api.kindWords(folded), "");
});

test("a row the adapter did not classify is counted and never guessed at", async () => {
  const { api } = await loadBadge();
  const gap = api.group([chat("c1"), sys("t1", "Accepted by the host"), sys("t2", "Shell", { kind: "shell" }), chat("c2")], {}).find((i) => i.rows);
  assert.equal(gap.steps, 2, "both steps counted");
  assert.equal(api.kindWords(gap), "shell 1", "one of the two is named; the other is counted and named nowhere");
  const none = api.group([chat("c1"), sys("t1", "Accepted by the host"), sys("t2", "Delivered"), chat("c2")], {}).find((i) => i.rows);
  assert.equal(none.steps, 2);
  assert.equal(api.kindWords(none), "", "nothing classified means nothing claimed");
  const three = api.group([chat("c1"), sys("t1", "?"), sys("t2", "S", { kind: "shell" }), sys("t3", "R", { kind: "read" }), chat("c2")], {}).find((i) => i.rows);
  assert.equal(api.kindWords(three), "read 1, shell 1", "the unclassified row is in the count and in no kind");
});

test("a peer exchange is named from the exchange it carries, never from the sentence it prints", async () => {
  const { api } = await loadBadge();
  const gap = api.group(
    [chat("c1"), sys("x1", "2 messages with Scribe", { exchange: {} }), sys("t1", "Shell", { kind: "shell" }), chat("c2")],
    {},
  ).find((i) => i.rows);
  assert.equal(api.kindWords(gap), "messages 1, shell 1");
});

test("the span is the interval between the two bounding chat entries", async () => {
  const { api } = await loadBadge();
  const at = 1_757_360_000_000;
  const html = api.render(
    [
      chat("c1", { timestampMs: at }),
      sys("t1", "a", { count: 9 }), sys("t2", "b", { count: 5 }),
      chat("c2", { timestampMs: at + 132_000 }),
    ],
    stubMarkup,
    { agentId: "titan", working: false },
  );
  assert.match(headOf(badges(html)[0]), /Worked for 2 min · 14 steps/, "Jason's own copy");
});

test("a gap missing either bounding chat entry prints the step count and no duration", async () => {
  const { api } = await loadBadge();
  const at = 1_757_360_000_000;
  // Leading gap: a partial tail window that starts mid-turn, so there is no chat row above it.
  const leading = api.render([sys("t1", "a"), sys("t2", "b"), chat("c2", { timestampMs: at })], stubMarkup, { agentId: "titan", working: false });
  assert.match(headOf(badges(leading)[0]), /^[\s\S]*>2 steps</);
  assert.ok(!badges(leading)[0].includes("Worked for"), "no bound above means no span");
  // Trailing gap: the agent is still working, so there is no chat row below it yet.
  const trailing = api.render([chat("c1", { timestampMs: at }), sys("t1", "a"), sys("t2", "b")], stubMarkup, { agentId: "titan", working: false });
  assert.ok(!badges(trailing)[0].includes("Worked for"), "no bound below means no span");
  // Both bounds present but one carries no timestamp: still no span, rather than an interval to 0.
  const halfStamped = api.render([chat("c1"), sys("t1", "a"), chat("c2", { timestampMs: at })], stubMarkup, { agentId: "titan", working: false });
  assert.ok(!halfStamped.includes("Worked for"), "a missing timestamp is not a zero timestamp");
});

test("the span reads in the unit a person would say it in", async () => {
  const { api } = await loadBadge();
  const span = (ms) => api.headline({ steps: 1, spanMs: ms, forced: false, kinds: [] });
  assert.equal(span(400), "1 step", "under a second is not worth a number");
  assert.equal(span(12_000), "Worked for 12 sec · 1 step");
  assert.equal(span(132_000), "Worked for 2 min · 1 step");
  assert.equal(span(4_800_000), "Worked for 1 hr 20 min · 1 step");
});

// Measured on grok-bot-local-vm during integration: a real gap of six steps whose closing chat
// arrived the next morning printed "Worked for 13 hr 9 min", and nothing had worked for thirteen
// hours. The span is the interval between the bounding chat entries, which stops being the work as
// soon as the conversation goes quiet, so past a ceiling the badge says the count alone.
test("a span longer than a plausible run of work is not called work", async () => {
  const { api } = await loadBadge();
  const span = (ms) => api.headline({ steps: 6, spanMs: ms, forced: false, kinds: [] });
  assert.equal(span(89 * 60_000), "Worked for 1 hr 29 min · 6 steps", "just inside the ceiling still reads as work");
  assert.equal(span(91 * 60_000), "6 steps", "just outside it, the count alone");
  assert.equal(span(13 * 3_600_000 + 9 * 60_000), "6 steps", "the reading that named this");
});

// ---- B4, state that is not in the DOM -----------------------------------------------------------
test("an opened badge survives two full render passes", async () => {
  const { api } = await loadBadge();
  const rows = [chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")];
  const ctx = { agentId: "titan", working: false };
  assert.match(api.render(rows, stubMarkup, ctx), /data-gap-open="0"/);
  api.toggle({ dataset: { gapToggle: "gap:c2" } });
  assert.match(api.render(rows, stubMarkup, ctx), /data-gap-open="1"/, "pass one");
  assert.match(api.render(rows, stubMarkup, ctx), /data-gap-open="1"/, "pass two");
  const badge = badges(api.render(rows, stubMarkup, ctx))[0];
  assert.match(headOf(badge), /aria-expanded="true"/);
  assert.ok(!/<div class="gap-badge-body"[^>]* hidden>/.test(badge), "an open badge's body is not hidden");
});

test("the preference is stored as the exceptions to the collapsed default, and read back", async () => {
  const first = await loadBadge();
  const rows = [chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")];
  first.api.render(rows, stubMarkup, {});
  first.api.toggle({ dataset: { gapToggle: "gap:c2" } });
  const raw = first.store.getItem(first.api.STORE_KEY);
  assert.deepEqual(JSON.parse(raw), { "gap:c2": 1 }, "one key, and only the badge that is not at its default");

  const second = await loadBadge({ store: first.store });
  assert.match(second.api.render(rows, stubMarkup, {}), /data-gap-open="1"/, "a reload keeps the choice");
});

test("collapsing a badge again removes it from the store rather than growing it", async () => {
  const { api, store } = await loadBadge();
  const rows = [chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")];
  api.render(rows, stubMarkup, {});
  api.toggle({ dataset: { gapToggle: "gap:c2" } });
  api.toggle({ dataset: { gapToggle: "gap:c2" } });
  assert.deepEqual(JSON.parse(store.getItem(api.STORE_KEY)), {}, "back at the default is nothing to remember");
  assert.match(api.render(rows, stubMarkup, {}), /data-gap-open="0"/);
});

test("the store is capped, so a long-lived console cannot grow it without bound", async () => {
  const { api, store } = await loadBadge();
  for (let i = 0; i < 260; i += 1) {
    api.render([chat(`a${i}`), sys(`t${i}a`, "x"), sys(`t${i}b`, "y"), chat(`b${i}`)], stubMarkup, {});
    api.toggle({ dataset: { gapToggle: `gap:b${i}` } });
  }
  const stored = JSON.parse(store.getItem(api.STORE_KEY));
  assert.equal(Object.keys(stored).length, 200, "capped");
  assert.ok(stored["gap:b259"], "the most recent choice is kept");
  assert.ok(!stored["gap:b0"], "the oldest is pruned");
});

test("a localStorage that throws on the accessor leaves every badge collapsed and never throws", async () => {
  const { api } = await loadBadge({ throwingStore: true });
  const rows = [chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")];
  assert.match(api.render(rows, stubMarkup, {}), /data-gap-open="0"/);
  assert.doesNotThrow(() => api.toggle({ dataset: { gapToggle: "gap:c2" } }), "a private window must not take the render down");
  assert.match(api.render(rows, stubMarkup, {}), /data-gap-open="1"/, "the choice still holds for this session");
});

test("the key is the chat row that closes the gap, never a tool row id", async () => {
  const { api } = await loadBadge();
  // foldRepeatedRows keeps the NEWEST id, and compaction rewrites outline ids, so a tool row id
  // re-points at every new step. Two renders where the tool ids moved must be the same badge.
  const before = api.render([chat("c1"), sys("tool-7", "a", { count: 3 }), sys("tool-8", "b"), chat("c2")], stubMarkup, {});
  api.toggle({ dataset: { gapToggle: "gap:c2" } });
  const after = api.render([chat("c1"), sys("tool-31", "a", { count: 9 }), sys("tool-32", "b"), chat("c2")], stubMarkup, {});
  assert.match(before, /data-gap="gap:c2"/);
  assert.match(after, /data-gap="gap:c2"/);
  assert.match(after, /data-gap-open="1"/, "the badge did not lose its state when the tool ids moved");
});

test("a leading gap with no chat row above it is keyed without colliding with the earlier-messages row", async () => {
  const { api } = await loadBadge();
  const html = api.render([sys("t1", "a"), sys("t2", "b"), chat("c2")], stubMarkup, { agentId: "titan" });
  assert.match(html, /data-gap="gap:c2"/, "the closer is there even when the opener is not");
  const solo = api.render([sys("t1", "a"), sys("t2", "b")], stubMarkup, { agentId: "titan" });
  assert.match(solo, /data-gap="gap:solo:titan:0"/, "a window of nothing but system rows still gets a stable handle");
  assert.ok(!html.includes("transcript-older"), "the badge draws nothing that could be taken for the paging row");
});

// ---- B5, the live gap ---------------------------------------------------------------------------
test("the trailing gap is forced open while the agent works, and unforced once a chat row follows", async () => {
  const { api, store } = await loadBadge();
  const working = api.render(
    [chat("c1"), sys("t1", "Shell", { kind: "shell" }), sys("t2", "Shell", { kind: "shell" })],
    stubMarkup,
    { agentId: "titan", working: true },
  );
  const live = badges(working)[0];
  assert.match(live, /data-gap-open="1"/, "the person watches it move");
  assert.match(live, /data-gap-forced="1"/);
  assert.match(live, /class="message-row is-system gap-badge is-live"/);
  assert.match(headOf(live), /Working · 2 steps/);
  assert.deepEqual(JSON.parse(store.getItem(api.STORE_KEY) ?? "{}"), {}, "forcing is never written to the preference");

  const landed = api.render(
    [chat("c1"), sys("t1", "Shell", { kind: "shell" }), sys("t2", "Shell", { kind: "shell" }), chat("c2")],
    stubMarkup,
    { agentId: "titan", working: false },
  );
  assert.match(badges(landed)[0], /data-gap-open="0"/, "the reply landed, so the gap collapses to its default");
  assert.ok(!badges(landed)[0].includes("data-gap-forced"), "nothing is forced any more");
});

test("only the trailing gap is forced; earlier gaps in a working conversation keep their default", async () => {
  const { api } = await loadBadge();
  const html = api.render(
    [chat("c1"), sys("t1", "a"), sys("t1b", "a2"), chat("c2"), sys("t2", "b"), sys("t3", "c")],
    stubMarkup,
    { agentId: "titan", working: true },
  );
  const found = badges(html);
  assert.equal(found.length, 2);
  assert.match(found[0], /data-gap-open="0"/, "a gap the conversation already closed is not live");
  assert.match(found[1], /data-gap-open="1"/);
});

test("a person who shuts the live badge keeps it shut", async () => {
  const { api, store } = await loadBadge();
  const rows = [chat("c1"), sys("t1", "a"), sys("t2", "b")];
  const ctx = { agentId: "titan", working: true };
  api.render(rows, stubMarkup, ctx);
  api.toggle({ dataset: { gapToggle: "gap:after:c1" } });
  assert.match(api.render(rows, stubMarkup, ctx), /data-gap-open="0"/, "an explicit choice beats the forcing");
  assert.deepEqual(JSON.parse(store.getItem(api.STORE_KEY)), { "gap:after:c1": 0 }, "and only that exception is stored");
});

test("a choice made while the gap was live is carried across the reply that closes it", async () => {
  const { api } = await loadBadge();
  const ctx = { agentId: "titan", working: true };
  api.render([chat("c1"), sys("t1", "a"), sys("t2", "b")], stubMarkup, ctx);
  api.toggle({ dataset: { gapToggle: "gap:after:c1" } });   // shut while live
  api.toggle({ dataset: { gapToggle: "gap:after:c1" } });   // and opened again on purpose
  const landed = api.render([chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")], stubMarkup, { agentId: "titan", working: false });
  assert.match(badges(landed)[0], /data-gap-open="1"/, "the same gap, one key later, is still the one the person opened");
});

// ---- B6, the edges ------------------------------------------------------------------------------
test("openContaining finds a row inside a collapsed gap", async () => {
  const { api } = await loadBadge();
  const rows = [chat("c1"), sys("t1", "a"), sys("t2", "b"), chat("c2")];
  assert.match(api.render(rows, stubMarkup, {}), /data-gap-open="0"/);
  assert.equal(api.openContaining("t2"), true, "the row is inside a gap this render drew");
  assert.match(api.render(rows, stubMarkup, {}), /data-gap-open="1"/, "the flash has a box to scroll to");
  assert.equal(api.openContaining("c1"), false, "a chat row is not inside a badge");
  assert.equal(api.openContaining("nobody"), false);
});

test("a receipt opened inside a body is re-opened after a rebuild", async () => {
  const { api } = await loadBadge();
  const messageMarkup = await realMessageMarkup();
  const receipt = sys("tool-1", "Wrote notes.md · notes.md", { detail: "Shell · cat > notes.md\n\nexit 0", kind: "shell" });
  const rows = [chat("c1"), receipt, chat("c2")];
  const ctx = { agentId: "titan", working: true };
  assert.ok(api.render(rows, messageMarkup, ctx).includes('<details class="message-bubble tool-receipt">'), "closed to start with");
  api.noteReceipt("tool-1", true);
  const again = api.render(rows, messageMarkup, ctx);
  assert.ok(again.includes('<details class="message-bubble tool-receipt" open>'), "a rebuild during a live turn does not shut it");
  assert.equal(again.includes("<pre>"), true, "and the receipt is still the same markup");
  api.noteReceipt("tool-1", false);
  assert.ok(api.render(rows, messageMarkup, ctx).includes('<details class="message-bubble tool-receipt">'), "closing it sticks too");
});

test("toggle with nothing to go on does not throw and changes nothing", async () => {
  const { api } = await loadBadge();
  assert.equal(api.toggle(null), false);
  assert.equal(api.toggle({}), false);
  assert.equal(api.toggle({ dataset: {} }), false);
});

test("the key is escaped into the markup", async () => {
  const { api } = await loadBadge();
  // The key is built out of a host transcript entry id. It has never been anything but a uuid, and
  // that is a fact about today's host rather than a guarantee, so it goes through the escaper.
  const html = api.render([chat("c1"), sys("t1", "a"), sys("t2", "b"), chat('c"><img src=x onerror=alert(1)>')], stubMarkup, {});
  assert.ok(!html.includes("<img"), "no tag came out of an id");
  assert.match(html, /data-gap="gap:c&quot;&gt;&lt;img/, "escaped in the article");
  assert.match(html, /data-gap-toggle="gap:c&quot;&gt;&lt;img/, "and in the button the click is routed by");
});

// ---- the file's place on the page ----------------------------------------------------------------
test("gap-badge.js and gap-badge.css are loaded by the page once app.js calls the seam", async () => {
  const app = await readFile(appPath, "utf8");
  if (!app.includes("__gapBadge")) return; // the seam has not landed yet; nothing to hold the page to
  const index = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
  assert.match(index, /<script src="gap-badge\.js"><\/script>/, "the module must load before app.js");
  assert.match(index, /<link rel="stylesheet" href="gap-badge\.css" \/>/);
  // app.js is not a static tag on this page: the boot script waits for the gateway and then
  // appends it, so the thing to be ahead of is whichever of those two shapes the page uses.
  const appAt = [index.indexOf('src="app.js"'), index.indexOf('script.src = "app.js"')]
    .filter((at) => at >= 0);
  assert.ok(appAt.length, "index.html no longer loads app.js in any shape this test knows");
  assert.ok(
    index.indexOf('src="gap-badge.js"') < Math.min(...appAt),
    "app.js reads window.__gapBadge at render time, so the module has to be there first",
  );
});
