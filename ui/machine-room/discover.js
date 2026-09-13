/* DISCOVER-1. The relay owns every fact; this module only paints its signed-in-person answer. */
(function attachDiscover(global) {
  "use strict";

  const doc = () => global.document ?? null;
  const pill = () => doc()?.getElementById("discover-pill") ?? null;
  const menu = () => doc()?.getElementById("discover-menu") ?? null;
  const pollMs = Number(global.__discoverPollMs) > 0 ? Number(global.__discoverPollMs) : 60_000;
  let answer = { steps: [], pct: 0, hidden: true };
  let timer = null;
  let wired = false;

  const percent = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const normalized = (value) => ({
    steps: Array.isArray(value?.steps) ? value.steps.map((step) => ({
      id: String(step?.id ?? ""),
      label: String(step?.label ?? ""),
      done: step?.done === true,
      count: Number.isFinite(Number(step?.count)) ? Number(step.count) : 0,
      of: Number.isFinite(Number(step?.of)) ? Number(step.of) : 1,
    })).filter((step) => step.id.length > 0 && step.label.length > 0) : [],
    pct: percent(value?.pct),
    hidden: value?.hidden === true,
  });

  async function request(method, pathname) {
    const response = await global.fetch(pathname, {
      method,
      headers: { accept: "application/json" },
      signal: global.AbortSignal?.timeout ? global.AbortSignal.timeout(12_000) : undefined,
    });
    if (!response.ok) throw new Error(`Welcome steps answered ${response.status}`);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { return null; }
  }

  function close() {
    const button = pill();
    const sheet = menu();
    if (sheet != null) sheet.hidden = true;
    if (button != null) button.setAttribute("aria-expanded", "false");
    doc()?.body?.removeAttribute("data-discover-open");
  }

  function paint(value = answer) {
    answer = normalized(value);
    const button = pill();
    const sheet = menu();
    if (button == null || sheet == null) return answer;

    const shouldHide = answer.hidden || answer.pct >= 100;
    doc()?.body?.toggleAttribute("data-discover-visible", !shouldHide);
    button.hidden = shouldHide;
    button.querySelector("[data-discover-pct]").textContent = `${answer.pct}%`;
    sheet.querySelector("[data-discover-summary]").textContent = `${answer.pct}% complete`;
    const progress = sheet.querySelector(".discover-progress");
    progress.setAttribute("aria-valuenow", String(answer.pct));
    sheet.querySelector("[data-discover-fill]").style.width = `${answer.pct}%`;

    const list = sheet.querySelector("[data-discover-steps]");
    list.replaceChildren();
    for (const step of answer.steps) {
      const row = doc().createElement("li");
      row.className = `discover-step${step.done ? " is-done" : ""}`;
      row.dataset.discoverStep = step.id;
      const mark = doc().createElement("span");
      mark.className = "discover-step-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = step.done ? "✓" : "";
      const label = doc().createElement("span");
      label.className = "discover-step-label";
      label.textContent = step.label;
      const count = doc().createElement("span");
      count.className = "discover-step-count";
      // DISCOVER-1c: a step counts evidence, not a score. Sixty-eight messages against a target of one
      // read as "68/1" on the demo workspace; the display caps at the target.
      const of = Math.max(1, Number(step.of) || 1);
      count.textContent = `${Math.min(of, Math.max(0, Number(step.count) || 0))}/${of}`;
      row.append(mark, label, count);
      list.appendChild(row);
    }
    if (shouldHide) close();
    return answer;
  }

  async function refresh() {
    try { paint(await request("GET", "/discover")); } catch { /* a missing relay route is no welcome bar */ }
    return answer;
  }

  async function hide() {
    close();
    if (pill() != null) pill().hidden = true;
    doc()?.body?.removeAttribute("data-discover-visible");
    answer = { ...answer, hidden: true };
    try { await request("POST", "/discover/hide"); } catch { /* the local choice still avoids a stuck control */ }
    return answer;
  }

  async function show() {
    try {
      const shown = await request("POST", "/discover/show");
      if (shown?.steps) paint(shown);
      else await refresh();
    } catch { /* Settings stays usable when an older relay has no route */ }
    return answer;
  }

  function open() {
    if (answer.hidden || answer.pct >= 100 || pill()?.hidden !== false) return false;
    const sheet = menu();
    if (sheet == null) return false;
    doc().documentElement.style.setProperty("--discover-left", `${Math.round(pill().getBoundingClientRect().left)}px`);
    sheet.hidden = false;
    pill().setAttribute("aria-expanded", "true");
    doc()?.body?.setAttribute("data-discover-open", "true");
    return true;
  }

  function wire() {
    if (wired || doc() == null) return;
    wired = true;
    pill()?.addEventListener("click", () => (menu()?.hidden === false ? close() : open()));
    menu()?.querySelector("[data-discover-close]")?.addEventListener("click", close);
    menu()?.querySelector("[data-discover-hide]")?.addEventListener("click", () => { void hide(); });
    doc().addEventListener("click", (event) => {
      if (menu()?.hidden !== false || menu()?.contains(event.target) || pill()?.contains(event.target)) return;
      close();
    });
    doc().addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    void refresh();
    timer = global.setInterval(() => {
      if (doc()?.visibilityState !== "hidden") void refresh();
    }, pollMs);
  }

  global.__discover = {
    refresh, paint, open, close, hide, show,
    state: () => ({ ...answer, steps: answer.steps.map((step) => ({ ...step })) }),
    stop: () => { if (timer != null) global.clearInterval(timer); timer = null; },
    _normalized: normalized,
    _pollMs: pollMs,
  };

  if (doc() != null) {
    if (doc().readyState === "loading") doc().addEventListener("DOMContentLoaded", wire, { once: true });
    else wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
