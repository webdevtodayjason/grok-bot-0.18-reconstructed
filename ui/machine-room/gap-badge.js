/*
 * The between-chats badge: one calm row per gap of work.
 * -------------------------------------------------------
 * Jason, 2026-09-08 20:03: "All the shell commands and everything that happens in between chats,
 * while the agent is doing work, can live inside a badge, right? If I want, I can click the badge
 * to expand it or just leave it shrunk inside the badge."
 *
 * Loaded by index.html before app.js; attaches window.__gapBadge. app.js calls render() from
 * transcriptMarkup and routes clicks on [data-gap-toggle] here. Nothing in this file opens app.js,
 * gateway-adapter.js, index.html or styles.css, and render() is a pure function of its arguments
 * plus this module's own state, so it runs in a test with no DOM at all.
 *
 * The grouping rule carries the whole "never hides a card" requirement: a gap is a maximal run of
 * rows that are STEPS. Everything the person must not lose behind a click already carries another
 * type -- a decision card is "decision", a hand-off card is "handoff", a secret card and an
 * attachment are "attachment", a failed turn is "turn-failed", the working bubble is "working", a
 * reply is "text" -- so each of those ends a gap for free and none of them can ever land inside a
 * body. Evidence chips draw inside a reply's own row. The one thing "type === system" got wrong is
 * that the adapter also SPEAKS to the person in system rows -- "Sending failed: …", "… is not
 * wired to the gateway yet." -- and those carry an author where a step never does, so isChat below
 * reads the author rather than taking the type's word for it.
 *
 * Three things this file will not do, each because the measurement said so:
 *
 *   - It never reads row.text to decide what a step was. After SHOT-4 a shell row that wrote a
 *     file reads "Wrote console4-probe.md · ...", so a text parse mislabels exactly the rows that
 *     carry receipts. The kind comes from the `kind` field the adapter stamps, or the step is
 *     counted and left unnamed. A row with no kind is never guessed at.
 *
 *   - It never invents a duration. No tool row carries a timestamp of any kind and the transcript
 *     keeps only a minute-resolution display string, so the span is the interval between the two
 *     BOUNDING chat entries' timestampMs and nothing else. A leading gap in a partial tail window
 *     and the trailing live gap are each missing a bound, and those print the step count alone.
 *     A fabricated duration is worse than none.
 *
 *   - It never keeps open state in the DOM. A working turn wiped #transcript five times in 36 s on
 *     grok-bot-local-vm and an opened receipt snapped shut within 2 s, so a bare <details> looks
 *     right only on an idle agent. State lives in the Map below, keyed by the id of the CHAT row
 *     that CLOSES the gap -- a durable host transcript entry id. Never a tool row id: those are
 *     outline ids that compaction rewrites, and foldRepeatedRows keeps the newest id, so a folded
 *     row's id re-points at every new step.
 */
(function () {
  "use strict";

  // A run of ONE row is already one row. Folding it swaps a sentence a person can read -- "Accepted
  // by the host", "Wrote reminder-1042.md · /workspace/reminder-1042.md" -- for a badge that says
  // "1 step", costs a click to get the sentence back, and on a lone receipt row costs a SECOND
  // click to reach the receipt that used to be one click away. Measured on grok-bot-local-vm in
  // real Chrome against the Books agent, whose gaps are 1, 1, 1, 1, 3, 1, 2 at 30, 46, 30, 30,
  // 186, 78 and 68 px: the two runs worth folding go from 253 px to 54, while the five single rows
  // would have given up a legible line each to save a handful of pixels. So the badge starts where
  // there is something to collapse.
  var MIN_FOLD = 2;

  var LOCAL = {
    esc: function (value) {
      return String(value == null ? "" : value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    },
  };
  // The console's own escaper when app.js has published it, so an escaping fix lands in one place;
  // an identical local copy otherwise, which is what a node test and a page mid-boot both get.
  function esc(value) {
    var ui = typeof window !== "undefined" ? window.__mrUi : null;
    return (ui && typeof ui.escapeHtml === "function" ? ui.escapeHtml : LOCAL.esc)(value);
  }

  // ---- state ------------------------------------------------------------------------------------
  // openState holds only EXPLICIT choices. The default is collapsed, so a `true` here is the
  // person opening a badge, and a `false` here only ever exists for a gap that was being forced
  // open (the live one) and that the person deliberately shut: an explicit action beats the force.
  var STORE_KEY = "machineRoom.gapBadge.v1";
  var STORE_CAP = 200;
  var openState = new Map();
  // Which receipts inside a body are open, this session. Not persisted: a receipt is a glance, and
  // a rebuild during a live turn is the only thing this defends against.
  var RECEIPT_CAP = 100;
  var receipts = new Map();
  // messageId -> gap key, rebuilt every render, so transcript:reveal can open the badge a row is
  // hiding inside before the flash tries to scroll to a box that has no layout.
  var rowIndex = new Map();
  // key -> the gap object the last render drew, so a click can be answered without the DOM. The DOM
  // is still the truth when it is there; this is what makes toggle testable and what answers a
  // click that lands in the moment between a rebuild and the next paint.
  var gapIndex = new Map();

  function storage() {
    try {
      return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
    } catch (error) {
      // A private window and a browser with site data blocked both throw on the ACCESSOR, before
      // any read. Badges then sit at their collapsed default rather than taking the render down.
      return null;
    }
  }

  function load() {
    var store = storage();
    if (!store) return;
    try {
      var raw = store.getItem(STORE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      Object.keys(parsed).forEach(function (key) {
        openState.set(key, Boolean(parsed[key]));
      });
    } catch (error) {
      /* unreadable or not ours; the default is collapsed and that is a fine place to be */
    }
  }

  function persist() {
    var store = storage();
    if (!store) return;
    try {
      var keys = Array.from(openState.keys());
      // Map keeps insertion order and every touch re-inserts, so the tail is the recently used end.
      var kept = keys.slice(Math.max(0, keys.length - STORE_CAP));
      while (openState.size > kept.length) openState.delete(openState.keys().next().value);
      var out = {};
      kept.forEach(function (key) { out[key] = openState.get(key) ? 1 : 0; });
      store.setItem(STORE_KEY, JSON.stringify(out));
    } catch (error) {
      /* quota, private mode, a disabled store: the session keeps its choices, the next load does not */
    }
  }

  function setOpen(key, value, forced) {
    openState.delete(key);
    if (value) openState.set(key, true);
    else if (forced) openState.set(key, false);
    persist();
  }

  function stateFor(gap) {
    if (openState.has(gap.key)) return openState.get(gap.key);
    // A trailing gap is keyed on the chat row ABOVE it because it has no row below yet. When a
    // reply lands the same gap acquires a closer and its key changes, so a choice made while it
    // was live is read once from the old key rather than silently thrown away.
    if (gap.legacyKey && openState.has(gap.legacyKey)) return openState.get(gap.legacyKey);
    return Boolean(gap.forced);
  }

  // ---- grouping ---------------------------------------------------------------------------------
  // A gap is a run of rows that are STEPS. "type === system" alone was not that predicate: the
  // adapter writes its own notices to the person as system rows too -- "Sending failed: …",
  // "… is not wired to the gateway yet.", "Approve … in the tab that just opened" -- and those are
  // things said to the reader, not work done for them. Run in node against the shipped file on
  // 2026-09-08: [shell][read][Sending failed: boom][… not wired …] folded into one badge headlined
  // "4 steps" with kinds "read 1, shell 1", both notices inside a hidden body and neither counted
  // in the headline. A notice now ends the gap and is drawn where the person can read it, the same
  // way a decision, a hand-off, an attachment and a failed turn already were.
  var isChat = function (row) {
    if (!row || row.type !== "system") return true;
    // A step is nobody's message. Every tool row and every peer-exchange row the adapter maps out
    // of a transcript carries no author at all; the four places the adapter SPEAKS to the person in
    // a system row -- notWired, failed, the send-failure push and the connect-approval push -- all
    // stamp authorId "system" and authorName "Machine Room", because that is what those rows are.
    // So the author field is the mark, and it is read here rather than the type.
    return Boolean(row.authorId) && !row.kind && !row.exchange;
  };

  function group(rows, ctx) {
    var out = [];
    var gap = null;
    var lastChatId = null;
    var lastChatAt = null;
    var index = 0;
    (rows || []).forEach(function (row) {
      if (isChat(row)) {
        if (gap) { gap.closer = row; out.push(gap); gap = null; }
        out.push({ chat: row });
        lastChatId = row && row.id != null ? String(row.id) : null;
        lastChatAt = Number(row && row.timestampMs);
        return;
      }
      if (!gap) {
        gap = { rows: [], opener: lastChatId, openerAt: lastChatAt, closer: null, index: index++, agentId: ctx && ctx.agentId };
      }
      gap.rows.push(row);
    });
    if (gap) out.push(gap);
    out.forEach(function (item) { if (item.rows) describe(item, ctx); });
    return out;
  }

  function keyFor(gap) {
    if (gap.closer && gap.closer.id != null) return "gap:" + String(gap.closer.id);
    if (gap.opener) return "gap:after:" + gap.opener;
    // A window that holds nothing but system rows -- a partial tail that starts mid-turn. Index is
    // the only handle there is, and it is stable for as long as that window is what the host sends.
    return "gap:solo:" + String(gap.agentId || "") + ":" + gap.index;
  }

  function describe(gap, ctx) {
    gap.key = keyFor(gap);
    gap.legacyKey = gap.closer && gap.opener ? "gap:after:" + gap.opener : "";
    gap.steps = gap.rows.reduce(function (total, row) {
      var count = Number(row && row.count);
      return total + (Number.isFinite(count) && count > 0 ? count : 1);
    }, 0);
    gap.kinds = kindsOf(gap.rows);
    var closerAt = Number(gap.closer && gap.closer.timestampMs);
    gap.spanMs = Number.isFinite(gap.openerAt) && gap.openerAt > 0 && Number.isFinite(closerAt) && closerAt > 0
      ? closerAt - gap.openerAt
      : null;
    // Forced open only while the host says this agent is running AND nothing has closed the gap.
    // A reply landing gives the gap a closer, which drops the forcing on the very next render.
    gap.forced = Boolean(ctx && ctx.working) && !gap.closer;
  }

  // Counts by kind, biggest first, ties alphabetical so two renders of the same gap read the same.
  // A row the adapter did not classify is counted in `steps` and named nowhere.
  function kindsOf(rows) {
    var counts = new Map();
    rows.forEach(function (row) {
      var kind = row && row.kind ? String(row.kind).trim().toLowerCase() : "";
      // The one structural fallback: a peer exchange is a system row that carries the exchange
      // itself, so the field says what it is without anyone reading the sentence it prints.
      if (!kind && row && row.exchange) kind = "messages";
      if (!kind) return;
      var count = Number(row.count);
      counts.set(kind, (counts.get(kind) || 0) + (Number.isFinite(count) && count > 0 ? count : 1));
    });
    return Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); })
      .map(function (entry) { return { kind: entry[0], count: entry[1] }; });
  }

  // ---- words ------------------------------------------------------------------------------------
  // The span is the interval between the two bounding CHAT entries, which is the work only while
  // the person was there for it. Measured on grok-bot-local-vm during integration: a gap of six
  // steps whose closing chat came the next morning printed "Worked for 13 hr 9 min", and the agent
  // had not been working for thirteen hours -- it finished, and then the conversation sat idle
  // until somebody came back. Past this ceiling the two are no longer the same number, so the badge
  // stops claiming they are and prints the step count alone, which it can still stand behind.
  var SPAN_CEILING_MS = 90 * 60 * 1000;
  function spanWords(ms) {
    if (!Number.isFinite(ms) || ms < 1000 || ms > SPAN_CEILING_MS) return "";
    var sec = Math.round(ms / 1000);
    if (sec < 60) return "Worked for " + sec + " sec";
    var min = Math.round(sec / 60);
    if (min < 60) return "Worked for " + min + " min";
    var hr = Math.floor(min / 60);
    var rest = min % 60;
    return "Worked for " + hr + " hr" + (rest ? " " + rest + " min" : "");
  }

  function headline(gap) {
    var steps = gap.steps + (gap.steps === 1 ? " step" : " steps");
    if (gap.forced) return "Working · " + steps;
    var span = spanWords(gap.spanMs);
    return span ? span + " · " + steps : steps;
  }

  // The plural the badge prints for each kind. The `kind` itself is a machine identifier -- it is
  // TOOL_LABELS' label lowercased, or the tool's own name with "ToolCall" cut off it -- so printing
  // it raw put "websearch 3, webfetch 1" on the one row this badge adds to the conversation a
  // customer reads. Measured on Jason's console 2026-09-08: "Worked for 7 sec · 8 steps · shell 4,
  // websearch 3, webfetch 1". The table is here rather than in the adapter because the adapter's
  // label is also what the ROW is headlined with, where "Shell" is the right word and "commands" is
  // not. Anything unmapped prints its kind unchanged: a wrong guess at a plural is worse than a
  // word the reader can look at and understand is a tool's name.
  var KIND_WORDS = {
    shell: ["command", "commands"],
    read: ["file read", "files read"],
    write: ["file written", "files written"],
    browser: ["browser step", "browser steps"],
    computer: ["computer step", "computer steps"],
    websearch: ["web search", "web searches"],
    webfetch: ["page read", "pages read"],
    messages: ["message", "messages"],
    update: ["update", "updates"],
    task: ["subagent run", "subagent runs"],
  };
  function kindPhrase(entry) {
    var words = KIND_WORDS[entry.kind];
    if (!words) return entry.count + " " + entry.kind;
    return entry.count + " " + (entry.count === 1 ? words[0] : words[1]);
  }

  // "6 commands, 5 files read, 3 browser steps". Dropped when it would only restate the headline: a
  // gap whose every step is the one named kind says nothing under "14 steps" that "14 commands" adds.
  function kindWords(gap) {
    if (!gap.kinds.length) return "";
    if (gap.kinds.length === 1 && gap.kinds[0].count === gap.steps) return "";
    var shown = gap.kinds.slice(0, 4).map(kindPhrase);
    if (gap.kinds.length > 4) shown.push("and " + (gap.kinds.length - 4) + " more");
    return shown.join(", ");
  }

  // ---- markup -----------------------------------------------------------------------------------
  var RECEIPT_TAG = '<details class="message-bubble tool-receipt">';
  var RECEIPT_TAG_OPEN = '<details class="message-bubble tool-receipt" open>';

  // A receipt the person opened, re-opened after a rebuild wiped it. Deliberately a single targeted
  // substitution on that one row's own markup, guarded on an exact match: if app.js ever changes the
  // receipt's markup this quietly stops re-opening rather than corrupting a row.
  function rowMarkup(row, messageMarkup) {
    var html = messageMarkup(row);
    if (!row || row.id == null || !receipts.get(String(row.id))) return html;
    var at = html.indexOf(RECEIPT_TAG);
    if (at === -1) return html;
    return html.slice(0, at) + RECEIPT_TAG_OPEN + html.slice(at + RECEIPT_TAG.length);
  }

  function badgeMarkup(gap, messageMarkup) {
    var open = stateFor(gap);
    var bodyId = "gap-body-" + gap.index;
    var kinds = kindWords(gap);
    var body = gap.rows.map(function (row) { return rowMarkup(row, messageMarkup); }).join("");
    return '<article class="message-row is-system gap-badge' + (gap.forced ? " is-live" : "") + '"'
      + ' data-gap="' + esc(gap.key) + '"'
      + ' data-gap-steps="' + gap.steps + '"'
      + ' data-gap-open="' + (open ? "1" : "0") + '"'
      + (gap.forced ? ' data-gap-forced="1"' : "")
      + ">"
      + '<button class="gap-badge-head" type="button" data-gap-toggle="' + esc(gap.key) + '"'
      + ' aria-expanded="' + (open ? "true" : "false") + '" aria-controls="' + esc(bodyId) + '">'
      + '<span class="gap-badge-mark" aria-hidden="true"></span>'
      + '<span class="gap-badge-words"><span class="gap-badge-title">' + esc(headline(gap)) + "</span>"
      + (kinds ? '<span class="gap-badge-kinds">' + esc(kinds) + "</span>" : "")
      + "</span>"
      + '<span class="gap-badge-chevron" aria-hidden="true"></span>'
      + "</button>"
      // aria-live off, and it matters: #transcript is aria-live="polite", so without this,
      // expanding the 47-row gap on Atera Triage reads all 63 steps out loud.
      + '<div class="gap-badge-body" id="' + esc(bodyId) + '" aria-live="off"' + (open ? "" : " hidden") + ">"
      + body
      + "</div>"
      + "</article>";
  }

  // ---- the seam app.js calls --------------------------------------------------------------------
  function render(rows, messageMarkup, ctx) {
    rowIndex = new Map();
    gapIndex = new Map();
    var items = group(rows, ctx || {});
    return items.map(function (item) {
      if (item.chat) return messageMarkup(item.chat);
      if (item.rows.length < MIN_FOLD) {
        // Drawn as it always was, and still through rowMarkup, so a receipt the person opened on
        // one of these survives a rebuild too.
        return item.rows.map(function (row) { return rowMarkup(row, messageMarkup); }).join("");
      }
      gapIndex.set(item.key, item);
      item.rows.forEach(function (row) {
        if (row && row.id != null) rowIndex.set(String(row.id), item.key);
      });
      return badgeMarkup(item, messageMarkup);
    }).join("");
  }

  // ---- the DOM half -----------------------------------------------------------------------------
  function articleFor(key) {
    if (typeof document === "undefined" || !document.querySelector) return null;
    try {
      return document.querySelector('[data-gap="' + String(key).replaceAll('"', '\\"') + '"]');
    } catch (error) {
      return null;
    }
  }

  // Toggle in place. A click that rebuilt the whole transcript would throw away every open receipt
  // in every other badge and, during a live turn, race the next tick.
  function apply(key, open) {
    var article = articleFor(key);
    if (!article) return false;
    var head = article.querySelector(".gap-badge-head");
    var body = article.querySelector(".gap-badge-body");
    article.setAttribute("data-gap-open", open ? "1" : "0");
    if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
    if (body) body.hidden = !open;
    return true;
  }

  function toggle(el) {
    var article = el && typeof el.closest === "function" ? el.closest("[data-gap]") : null;
    var key = (el && el.dataset && el.dataset.gapToggle)
      || (article && article.getAttribute && article.getAttribute("data-gap"))
      || "";
    if (!key) return false;
    var gap = gapIndex.get(key);
    var forced = Boolean(article && article.getAttribute && article.getAttribute("data-gap-forced"))
      || Boolean(gap && gap.forced);
    // What is on screen decides, when there is a screen. Off it -- a node test, or a click answered
    // between a rebuild and its paint -- the last render's own state is the next best truth.
    var open = article && article.getAttribute
      ? article.getAttribute("data-gap-open") === "1"
      : gap ? stateFor(gap) : Boolean(openState.get(key));
    var next = !open;
    setOpen(key, next, forced);
    if (apply(key, next)) return true;
    // The badge is not on screen -- a rebuild landed between the click and here. Ask for a redraw
    // rather than leaving the person's click with nothing to show for it.
    var ui = typeof window !== "undefined" ? window.__mrUi : null;
    if (ui && typeof ui.renderAll === "function") ui.renderAll();
    return true;
  }

  // A revealed row (a search hit) that lives inside a collapsed gap has no box for the flash to
  // scroll to. app.js calls this before it flashes.
  function openContaining(messageId) {
    if (messageId == null) return false;
    var key = rowIndex.get(String(messageId));
    if (!key) return false;
    var gap = gapIndex.get(key);
    setOpen(key, true, Boolean(gap && gap.forced));
    apply(key, true);
    return true;
  }

  // `toggle` does not bubble, so this listens in the capture phase. It is the only live wire in the
  // file and it does nothing but remember, so a page without <details> anywhere pays nothing.
  function noteReceipt(messageId, open) {
    if (messageId == null) return;
    var id = String(messageId);
    receipts.delete(id);
    if (open) receipts.set(id, true);
    while (receipts.size > RECEIPT_CAP) receipts.delete(receipts.keys().next().value);
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("toggle", function (event) {
      var details = event && event.target;
      if (!details || !details.classList || !details.classList.contains("tool-receipt")) return;
      var row = typeof details.closest === "function" ? details.closest("[data-message-id]") : null;
      if (!row || typeof row.getAttribute !== "function") return;
      noteReceipt(row.getAttribute("data-message-id"), Boolean(details.open));
    }, true);
  }

  load();

  var api = {
    render: render,
    toggle: toggle,
    openContaining: openContaining,
    noteReceipt: noteReceipt,
    // Named parts, so the gate and the unit tests read the same words the badge draws rather than
    // re-deriving them and passing while the page says something else.
    group: group,
    headline: headline,
    kindWords: kindWords,
    MIN_FOLD: MIN_FOLD,
    isOpen: function (key) {
      var gap = gapIndex.get(key);
      return gap ? stateFor(gap) : Boolean(openState.get(key));
    },
    reset: function () { openState.clear(); receipts.clear(); rowIndex = new Map(); gapIndex = new Map(); },
    STORE_KEY: STORE_KEY,
  };

  if (typeof window !== "undefined") window.__gapBadge = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
