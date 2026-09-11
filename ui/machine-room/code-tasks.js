/*
 * CODE-1 — the coding sandbox, from the console's side.
 * -----------------------------------------------------
 * One thing on screen: a small Coding strip inside the Computer card. The job's title, how long it
 * has been going, which computer it is running on in plain words, the last lines of its log, a Stop
 * button, and the files when it is done.
 *
 * WHY IT IS ITS OWN FILE, and this is the whole reason it exists rather than living in app.js.
 * `renderScreenTile` assigns innerHTML on #rail-screen on every repaint, app.js is 7,491 lines, and
 * three waves are editing this console the same week. cloud-browser.js already proved the shape: an
 * IIFE on a window global that finds its own mount point, adds only siblings of its own, and puts
 * them back after a repaint through one debounced MutationObserver. Nothing here writes a node
 * app.js owns, and nothing here needs a line in app.js to work.
 *
 * WHY IT READS THE RELAY AND NOT THE GATEWAY. The relay already holds the tasks -- it is the process
 * that creates the containers -- and it serves the console's own per-tenant routes behind the
 * session. So there is no new gateway command, and therefore none of the void-RPC class HANDBACK-2
 * is about: a gateway method a host has never heard of answers "unknown gateway method", which the
 * console has historically drawn as a missing feature. A 404 from the relay is the same fact said
 * once, and it is read once and then left alone rather than retried forever.
 *
 * WORDS. Nothing on this page names a tool, a vendor, or the coding agent inside the sandbox. "A
 * machine beside this box" and "a cloud sandbox" are what they are called, because which company
 * runs it is an operator's business and not a customer's. And no verdict lines: a prefixed,
 * underlined line reads as an error to the person who owns the business (host-notes-read-as-errors),
 * so a finished job is a quiet sentence, not a stamp.
 *
 * THE ROUTES IT USES, which are the relay's console-facing half of the frozen CODE-1 contract:
 *   GET  /code/tasks            -> {tasks:[{taskId,title,state,startedAt,endedAt,provider,elapsedS,
 *                                           lines[],files[],path,agentId}], available, message}
 *   POST /code/tasks/stop       {taskId} -> {stopped, message}
 * A 409 {error:"not_available"} on either is the install with no container engine in front of it,
 * and it is drawn as one quiet line offering a cloud sandbox rather than as a dead Stop button.
 */
(function attachCodeTasks(global) {
  "use strict";

  // ------------------------------------------------------------------ talking to the relay
  async function relayJson(path, init) {
    const response = await global.fetch(path, init);
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, ok: response.ok, body: body || {} };
  }

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /** Which computer, in words a person reads. No vendor, no product, no image tag.
   *
   *  THE RELAY'S OWN SENTENCE WINS. /code/tasks already says where a job ran in the same plain words
   *  this strip needs, and this used to ignore that field and test the provider itself -- against a
   *  value the relay has never sent, so a job on somebody else's machine would have been labelled as a
   *  machine beside this box. One vocabulary, in one place. The fallback is for a relay that answers
   *  rows without the field, and it asks only whether the provider is the local one: a provider this
   *  file has never heard of is still not this machine, and naming each cloud here is how the two
   *  vocabularies drifted apart in the first place. */
  function whereWords(task) {
    const said = task && typeof task.where === "string" ? task.where.trim() : "";
    if (said.length > 0) return said;
    return String((task && task.provider) || "local") === "local" ? "a machine beside this box" : "a cloud sandbox";
  }

  /** How long it has been going, or how long it took. Minutes and seconds, never a raw epoch. */
  function elapsedWords(task) {
    const started = Number(task && task.startedAt) || 0;
    const ended = Number(task && task.endedAt) || 0;
    const seconds = Number.isFinite(Number(task && task.elapsedS)) && Number(task.elapsedS) > 0
      ? Math.round(Number(task.elapsedS))
      : started > 0
        ? Math.round(((ended > 0 ? ended : Date.now()) - started) / 1000)
        : 0;
    if (seconds <= 0) return "just started";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  /** The state, in words. `running` is the only one that keeps a Stop button on screen. */
  function stateWords(state) {
    switch (String(state || "")) {
      case "running": return "running";
      case "done": return "finished";
      case "stopped": return "stopped";
      case "timed_out": return "ran out of time";
      case "spend_cap": return "reached its spending limit";
      case "failed": return "did not finish";
      default: return "running";
    }
  }

  const isRunning = (task) => String((task && task.state) || "running") === "running";

  /** Bytes, for the file list. A file list with raw byte counts beside it reads as a disk dump. */
  function sizeWords(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ------------------------------------------------------------------ the live state
  //
  // One poll, shared, at the beat the rail's own heartbeat runs at. `supported` is set false once and
  // never retried: a relay that does not serve these routes is a relay older than this wave, and
  // asking it every fifteen seconds forever is how a console starts costing a box something.
  const state = { tasks: [], asked: false, supported: true, available: true, message: "", at: 0 };
  let timer = null;

  async function refresh() {
    if (!state.supported) return state;
    try {
      const answer = await relayJson("/code/tasks", { headers: { accept: "application/json" } });
      if (answer.status === 404) { state.supported = false; state.asked = true; paint(); return state; }
      if (answer.status === 409 && answer.body.error === "not_available") {
        state.available = false;
        state.tasks = [];
        state.asked = true;
        state.at = Date.now();
        paint();
        return state;
      }
      if (!answer.ok) { state.asked = true; return state; }
      state.tasks = Array.isArray(answer.body.tasks) ? answer.body.tasks : [];
      state.available = answer.body.available !== false;
      state.message = typeof answer.body.message === "string" ? answer.body.message : "";
      state.asked = true;
      state.at = Date.now();
    } catch {
      // A relay being restarted is the LAST step of every ship, so a failed poll is a normal event
      // and is left silent. The strip keeps whatever it last knew rather than flashing empty.
      state.asked = true;
    }
    paint();
    return state;
  }

  function start() {
    if (timer != null || !state.supported) return;
    void refresh();
    timer = global.setInterval(() => { void refresh(); }, 15_000);
  }

  async function stopTask(taskId) {
    const id = String(taskId || "").trim();
    if (id.length === 0) return false;
    try {
      const answer = await relayJson("/code/tasks/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: id }),
      });
      await refresh();
      return answer.ok && answer.body.stopped === true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ the Computer card strip
  const STRIP_ID = "code-tasks-strip";

  // Geometry is inline rather than in a stylesheet, the same rule cloud-browser.js holds to: this
  // wave adds no CSS file and edits none, so nothing here can collide with the other waves painting
  // this console. The classes are still on every node so a later pass can style them properly.
  const STRIP_STYLE = "display:flex;flex-direction:column;gap:3px;margin-top:6px;font-size:11px;line-height:1.35;opacity:0.85";
  const LOG_STYLE = "margin:2px 0 0;padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.28);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.4;white-space:pre-wrap;overflow-x:auto;max-height:88px";
  const STOP_STYLE = "margin-top:3px;align-self:flex-start;font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.22);background:transparent;color:inherit;cursor:pointer";

  /** The last lines of the log. Already redacted relay-side; trimmed here so the strip stays a strip. */
  function logMarkup(lines) {
    const rows = (Array.isArray(lines) ? lines : [])
      .filter((line) => typeof line === "string" && line.trim().length > 0)
      .slice(-6);
    if (rows.length === 0) return "";
    return `<pre class="code-task-log" style="${LOG_STYLE}">${escapeHtml(rows.join("\n"))}</pre>`;
  }

  function filesMarkup(task) {
    const files = (Array.isArray(task && task.files) ? task.files : [])
      .filter((file) => file && typeof file.path === "string" && file.path.trim().length > 0)
      .slice(0, 8);
    if (files.length === 0) return "";
    const where = typeof task.path === "string" && task.path.trim().length > 0
      ? ` in ${escapeHtml(task.path.trim())}`
      : "";
    const rows = files.map((file) => {
      const size = sizeWords(file.bytes);
      return `<li>${escapeHtml(file.path)}${size ? ` <span class="code-task-size">· ${escapeHtml(size)}</span>` : ""}</li>`;
    }).join("");
    return `<div class="code-task-files"><small>It left ${files.length} file${files.length === 1 ? "" : "s"}${where}:</small>`
      + `<ul style="margin:2px 0 0;padding-left:16px">${rows}</ul></div>`;
  }

  function taskMarkup(task) {
    const title = String((task && task.title) || "").trim() || "A coding job";
    const head = isRunning(task)
      ? `${escapeHtml(title)} — ${escapeHtml(stateWords(task.state))} on ${escapeHtml(whereWords(task))}, ${escapeHtml(elapsedWords(task))} so far`
      : `${escapeHtml(title)} — ${escapeHtml(stateWords(task.state))} on ${escapeHtml(whereWords(task))} after ${escapeHtml(elapsedWords(task))}`;
    const stop = isRunning(task)
      ? `<button type="button" class="code-task-stop" data-code-task-stop="${escapeHtml(String(task.taskId || ""))}" style="${STOP_STYLE}">Stop</button>`
      : "";
    return `<div class="code-task-row" data-code-task-row="${escapeHtml(String(task.taskId || ""))}">`
      + `<span class="code-task-head">${head}</span>`
      + logMarkup(task.lines)
      + filesMarkup(task)
      + stop
      + `</div>`;
  }

  function stripMarkup() {
    // CODE-5. The install with no container engine in front of it. A quiet line that says what is and
    // is not possible here, and offers the other road -- never a dead Stop button and never a zero.
    if (!state.available) {
      const said = typeof state.message === "string" && state.message.trim().length > 0
        ? state.message.trim()
        : "Coding jobs cannot run on this installation. A cloud sandbox can be switched on for this"
          + " workspace if you want one.";
      return `<div class="code-tasks-strip" id="${STRIP_ID}" style="${STRIP_STYLE}">`
        + `<strong>Coding</strong>`
        + `<span class="code-tasks-absent">${escapeHtml(said)}</span>`
        + `</div>`;
    }
    const rows = Array.isArray(state.tasks) ? state.tasks : [];
    if (rows.length === 0) return "";
    const running = rows.filter(isRunning).length;
    const heading = running > 0
      ? `Coding · ${running} running`
      : "Coding";
    return `<div class="code-tasks-strip" id="${STRIP_ID}" style="${STRIP_STYLE}">`
      + `<strong>${escapeHtml(heading)}</strong>`
      + rows.slice(0, 4).map(taskMarkup).join("")
      + `</div>`;
  }

  /**
   * The strip, as markup, for a caller that wants to place it itself. Returns "" when there is
   * nothing honest to say -- no tasks, or a relay that has never heard of the routes. A control that
   * cannot work is not drawn.
   */
  function computerStrip() {
    if (!state.supported) return "";
    if (!state.asked) { start(); return ""; }
    return stripMarkup();
  }

  // ------------------------------------------------------------------ finding the card itself
  //
  // CONSOLE-6. The write is guarded on a change, and that guard is what keeps this module from
  // repainting the rail on every animation frame for the life of the page. The observer below
  // watches the whole body, so writing the strip is itself a mutation that wakes it, which
  // schedules another paint a frame later, which writes again. Measured in cloud-browser.js, which
  // carried the same shape: 603 replacements of #rail-screen's children in 10 seconds on an idle
  // console. The strip's own words change only when the box's task list does, which is every 15 s
  // at most, so anything more than that is the loop rather than the news.
  //
  // The markup this module last wrote is what is compared, not the element's outerHTML: a browser
  // normalises attribute quoting and order when it parses, so a generated string never equals a
  // parsed one and a guard written that way stops nothing.
  let painted = "";
  function paint() {
    const document_ = global.document;
    if (document_ == null) return;
    const rail = document_.querySelector("#rail-screen");
    if (rail == null) return;
    const held = document_.getElementById(STRIP_ID);
    const markup = computerStrip();
    if (markup.length === 0) {
      if (held != null) held.remove();
      painted = "";
      return;
    }
    if (held == null) { rail.insertAdjacentHTML("beforeend", markup); painted = markup; return; }
    if (markup === painted) return;
    held.outerHTML = markup;
    painted = markup;
  }

  // The Stop button, delegated off the document rather than bound per row: the strip is rebuilt on
  // every repaint and on every poll, so a listener on the button itself would be thrown away with it.
  function listen() {
    const document_ = global.document;
    if (document_ == null) return;
    document_.addEventListener("click", (event) => {
      const target = event.target && event.target.closest
        ? event.target.closest("[data-code-task-stop]")
        : null;
      if (target == null) return;
      event.preventDefault();
      const id = target.getAttribute("data-code-task-stop") || "";
      target.disabled = true;
      target.textContent = "Stopping…";
      void stopTask(id);
    });
  }

  // app.js assigns innerHTML on #rail-screen on every repaint, which takes our sibling with it. One
  // observer puts it back, debounced to a frame because a repaint fires many mutations and re-adding
  // a node per mutation is how a page starts flickering.
  let scheduled = false;
  function observe() {
    const document_ = global.document;
    if (document_ == null || document_.body == null) return;
    const observer = new global.MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      const frame = global.requestAnimationFrame || ((fn) => global.setTimeout(fn, 16));
      frame(() => { scheduled = false; paint(); });
    });
    observer.observe(document_.body, { childList: true, subtree: true });
  }

  global.__codeTasks = {
    computerStrip,
    refresh,
    start,
    stopTask,
    // Exposed so a test can drive the markup without a browser: the words on the strip ARE the
    // contract, and a click is no place to pin them.
    _state: state,
    _taskMarkup: taskMarkup,
    _stripMarkup: stripMarkup,
    _paint: paint,
    _whereWords: whereWords,
    _elapsedWords: elapsedWords,
    _stateWords: stateWords,
  };

  if (global.document != null) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", () => { observe(); listen(); start(); });
    } else {
      observe();
      listen();
      start();
    }
  }
})(typeof window === "undefined" ? globalThis : window);
