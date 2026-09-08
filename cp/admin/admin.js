// cp/admin/admin.js -- the super admin console's whole behaviour. ADMIN-1.
//
// No framework and no build step. It fetches six routes, renders six panels, and offers the named
// actions below. The session token lives in sessionStorage and nowhere else: it dies with the tab,
// it is never in a URL, and it is never written into a cookie, so nothing carries it to a route
// that did not ask for it.
//
// PROVIDERS-1 ADDED THE ONE THING THIS PAGE HAD NEVER DONE: it takes a secret IN. Every panel
// before it was read-only plus seven actions that carried no value, and the only secret that ever
// moved was a temporary password coming back out once in a banner. A provider key is different. It
// is typed here, it crosses this page, and it must not stop anywhere on the way. So:
//
//   a key field is type=password, it is cleared the moment the request comes back, and nothing
//   ever writes a value back into one. No route on this service answers with a key, and if one
//   ever did, this page would still not have anywhere to put it.
//
//   the banner after a key action names the slot and the short hash the service reports, never a
//   fragment of the value.
//
//   the pass-through headers the proxy holds are NOT rendered here at all. That route answers with
//   them in the clear, unlike the credential list, so the only safe thing to draw is nothing.
//
// Two rules the rendering follows everywhere, and they are the two that make the screen worth
// having:
//
//   Every number carries when it was measured. A health screen whose figures have no timestamp is
//   a screen that quietly shows yesterday.
//
//   A fact that could not be measured says "not measured" and why, and never a zero, a dash or a
//   green tick. Made-up green is how an outage gets missed.

"use strict";

(function () {
  const TOKEN_KEY = "titanbot.admin.token";
  const EMAIL_KEY = "titanbot.admin.email";

  const $ = (id) => document.getElementById(id);
  const door = $("door");
  const panel = $("console");

  // sessionStorage throws outright in some privacy modes, so every touch is wrapped and the page
  // still works with none of it: the operator simply signs in again.
  const stored = {
    get(key) { try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* nothing to do */ } },
    clear() { try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(EMAIL_KEY); } catch { /* nothing to do */ } },
  };

  let token = stored.get(TOKEN_KEY);

  // ---- small helpers ---------------------------------------------------------------------------

  const text = (value) => document.createTextNode(String(value ?? ""));
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.appendChild(text(content));
    return node;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  const when = (iso) => {
    if (!iso) return "never";
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return String(iso);
    return at.toLocaleString();
  };

  // "3 minutes ago", because on this screen the gap matters more than the clock time. The absolute
  // time goes in the title attribute so hovering still answers "when exactly".
  const ago = (iso) => {
    const at = Date.parse(String(iso ?? ""));
    if (!Number.isFinite(at)) return "never";
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} days ago`;
  };

  const bytes = (value) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = Number(value);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  };

  const banner = (message, good) => {
    const node = $("banner");
    node.textContent = String(message ?? "");
    node.className = good ? "banner good" : "banner";
    node.hidden = String(message ?? "").length === 0;
  };

  // ---- the wire --------------------------------------------------------------------------------

  async function api(method, pathname, body) {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed = null;
    if (raw.length > 0) { try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 300) }; } }
    if (response.status === 401) {
      // The session expired or the flag was taken away while this tab was open. Back to the door
      // rather than a screen of half-loaded panels.
      signOut("That session is no longer valid. Sign in again.");
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      const error = new Error(String(parsed?.message ?? parsed?.error ?? `that request answered ${response.status}`));
      error.status = response.status;
      throw error;
    }
    return parsed ?? {};
  }

  // ---- the door --------------------------------------------------------------------------------

  function showDoor(message) {
    door.hidden = false;
    panel.hidden = true;
    $("doorMessage").textContent = String(message ?? "");
  }

  function showConsole(email) {
    door.hidden = true;
    panel.hidden = false;
    $("whoami").textContent = email ? `signed in as ${email}` : "signed in with the operator token";
  }

  function signOut(message) {
    token = "";
    stored.clear();
    showDoor(message ?? "");
  }

  $("signin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("signinButton");
    const email = $("email").value.trim();
    const password = $("password").value;
    $("doorMessage").textContent = "";
    button.disabled = true;
    try {
      const response = await fetch("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const answer = await response.json().catch(() => ({}));
      if (response.status === 429) {
        // The same lockout every other door on this service has: ten in ten minutes, counted
        // against the email and against the address.
        const seconds = Number(answer?.retryAfter ?? 0);
        $("doorMessage").textContent = seconds > 0
          ? `Too many attempts. Wait ${seconds} seconds and try again.`
          : "Too many attempts. Wait a moment and try again.";
        return;
      }
      if (!response.ok) {
        $("doorMessage").textContent = String(answer?.message ?? "That email or password is not right.");
        return;
      }
      if (answer?.account?.superAdmin !== true) {
        // Their password was right and this console is not theirs. Said plainly, and the token is
        // dropped on the floor rather than kept.
        $("doorMessage").textContent = "That sign-in works, and it is not a super admin. This console is for the person who runs the whole system.";
        return;
      }
      token = String(answer.token ?? "");
      stored.set(TOKEN_KEY, token);
      stored.set(EMAIL_KEY, String(answer.account.email ?? ""));
      $("password").value = "";
      showConsole(String(answer.account.email ?? ""));
      await loadAll();
    } catch {
      $("doorMessage").textContent = "This service is not answering right now.";
    } finally {
      button.disabled = false;
    }
  });

  $("signout").addEventListener("click", () => signOut("Signed out."));
  $("refresh").addEventListener("click", () => { void loadAll(); });
  $("hours").addEventListener("change", () => { void loadSignIns(); });
  $("outcome").addEventListener("change", () => { void loadSignIns(); });

  // ---- panel 1: sign-in attempts ---------------------------------------------------------------

  async function loadSignIns() {
    const hours = $("hours").value;
    const outcome = $("outcome").value;
    const answer = await api("GET", `/v1/admin/sign-ins?hours=${encodeURIComponent(hours)}&outcome=${encodeURIComponent(outcome)}&limit=500`);

    const note = [];
    note.push(`${answer.rows.length} attempt${answer.rows.length === 1 ? "" : "s"}`);
    note.push(`measured ${when(answer.measuredAt)}`);
    // The console's own ledger is half the picture. If it could not be read, the panel says so
    // rather than showing a shorter list as though it were the whole story.
    if (answer.relay && answer.relay.reachable === false) {
      note.push(`the console's own ledger could not be read: ${answer.relay.why}`);
    }
    $("signInsNote").textContent = note.join(" - ");

    const addresses = $("addresses").querySelector("tbody");
    clear(addresses);
    if (answer.addresses.length === 0) {
      addresses.appendChild(rowSpanning(8, "Nobody has tried to sign in during this window."));
    }
    for (const row of answer.addresses) {
      const tr = document.createElement("tr");
      const ip = el("td", "mono");
      ip.appendChild(text(row.ip));
      if (row.attack) {
        ip.appendChild(text(" "));
        const chip = el("span", "chip attack", "Attack");
        chip.title = answer.rule;
        ip.appendChild(chip);
      }
      tr.appendChild(ip);
      tr.appendChild(el("td", "num", row.attempts));
      tr.appendChild(el("td", "num", row.refused));
      tr.appendChild(el("td", "num", row.locked));
      tr.appendChild(el("td", "num", row.ok));
      tr.appendChild(el("td", null, row.passwordStory));
      tr.appendChild(el("td", null, row.emails.length === 0 ? "none" : row.emails.join(", ")));
      const last = el("td", null, ago(row.lastAt));
      last.title = when(row.lastAt);
      tr.appendChild(last);
      addresses.appendChild(tr);
    }

    const accounts = $("accounts").querySelector("tbody");
    clear(accounts);
    const accountRows = answer.accounts ?? [];
    if (accountRows.length === 0) {
      accounts.appendChild(rowSpanning(8, "No account was named during this window."));
    }
    for (const row of accountRows) {
      const tr = document.createElement("tr");
      const who = el("td", "mono");
      who.appendChild(text(row.email));
      if (row.sprayed) {
        who.appendChild(text(" "));
        const chip = el("span", "chip attack", "Spray");
        chip.title = answer.sprayRule ?? "";
        who.appendChild(chip);
      }
      tr.appendChild(who);
      tr.appendChild(el("td", "num", row.attempts));
      tr.appendChild(el("td", "num", row.refused));
      tr.appendChild(el("td", "num", row.locked));
      tr.appendChild(el("td", "num", row.ok));
      tr.appendChild(el("td", null, row.passwordStory));
      tr.appendChild(el("td", null, row.addresses.length === 0 ? "through the console" : row.addresses.join(", ")));
      const seen = el("td", null, ago(row.lastAt));
      seen.title = when(row.lastAt);
      tr.appendChild(seen);
      accounts.appendChild(tr);
    }

    const attempts = $("attempts").querySelector("tbody");
    clear(attempts);
    if (answer.rows.length === 0) {
      attempts.appendChild(rowSpanning(7, "Nothing during this window."));
    }
    for (const row of answer.rows) {
      const tr = document.createElement("tr");
      const at = el("td", null, ago(row.at));
      at.title = when(row.at);
      tr.appendChild(at);
      tr.appendChild(el("td", null, row.door === "account" ? "account" : "instance password"));
      tr.appendChild(el("td", "mono", row.email || "-"));
      // A row this service wrote for a sign-in that came through a customer's console carries that
      // machine's address, not the visitor's, so printing it would name the wrong place.
      tr.appendChild(row.via === "relay"
        ? el("td", null, "through the console")
        : el("td", "mono", row.ip || "unknown"));
      tr.appendChild(el("td", null, row.tenant || "-"));
      const outcomeCell = document.createElement("td");
      outcomeCell.appendChild(el("span", `chip ${row.outcome}`, row.outcome === "ok" ? "signed in" : row.outcome === "locked" ? "locked out" : "refused"));
      tr.appendChild(outcomeCell);
      tr.appendChild(el("td", null, row.source === "relay" ? "the console" : "this service"));
      attempts.appendChild(tr);
    }
  }

  const rowSpanning = (columns, message) => {
    const tr = document.createElement("tr");
    const td = el("td", "empty", message);
    td.colSpan = columns;
    tr.appendChild(td);
    return tr;
  };

  // ---- panel 2: clients and users --------------------------------------------------------------

  // The two numbers on this screen that are money, formatted once. A null is never a zero: it goes
  // through `measured` below and comes out as the reason it could not be read.
  const dollars = (value) => (Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : null);

  // WHERE 80 AND 100 ARE DECIDED, and they are decided here rather than by the proxy, because until
  // CP_PROXY_ENFORCE is set the proxy does not fail anything: observe mode mints a soft budget,
  // which produces the number and never the refusal. So this chip is the whole of the warning today
  // and the wording has to be the wording a customer's own agent will use on the day it is armed.
  const ALLOWANCE_WARN_PCT = 80;

  function allowanceChips(spend) {
    const nodes = [];
    if (spend == null) return nodes;
    if (spend.minted !== true) {
      const chip = el("span", "quiet", "no plan key");
      chip.title = String(spend.why || "this workspace has no key at the proxy");
      nodes.push(chip);
      return nodes;
    }
    if (spend.pct === null || spend.pct === undefined) {
      const chip = el("span", "quiet", "allowance not measured");
      chip.title = String(spend.spendToDateWhy || spend.why || (spend.allowance == null ? "no allowance is set on this server (CP_PROXY_ALLOWANCE_USD)" : "the proxy did not answer"));
      nodes.push(chip);
      return nodes;
    }
    const pct = Number(spend.pct);
    const chip = el("span", pct >= 100 ? "chip attack" : pct >= ALLOWANCE_WARN_PCT ? "chip locked" : "chip ok",
      `${pct}% of the plan`);
    // The sentence, in the customer's words rather than ours. At 100 it is what their Titan tells
    // them; below it, it is what this number means.
    chip.title = pct >= 100
      ? (spend.enforced
        ? "They have used everything their plan includes this month. Their agent is telling them: You have used everything your plan includes this month. Add your own key under Settings and I will keep going, or ask for more."
        : "They are past what their plan includes. Nothing is being stopped, because this server is in observe mode (CP_PROXY_ENFORCE is not set).")
      : `${dollars(spend.spendToDate) ?? "not measured"} of ${dollars(spend.allowance) ?? "not measured"} this month`;
    nodes.push(chip);
    return nodes;
  }

  /**
   * One workspace's model, on its own row under the customer.
   *
   * Three honest states and no fourth. Not reported at all, which reads as not measured with the
   * reason on it. Pinned in that workspace's own environment, which reads as pinned and offers no
   * control, because the control would not do anything. Or settable, which is a picker built from
   * the plan models a customer can actually be put on, showing the name they would see and never
   * the routing alias.
   */
  function clientModelRow(client) {
    const row = el("div", "row modelRow");
    row.appendChild(el("span", "quiet", "Runs on"));
    const model = client.model;
    if (model == null) {
      row.appendChild(measured(null, "this control plane did not report a model for this workspace"));
      return row;
    }
    const label = String(model.label ?? "").length > 0 ? model.label : String(model.current ?? "");
    if (model.pinned === true) {
      row.appendChild(el("strong", null, label || "not measured"));
      row.appendChild(el("span", "chip locked", "pinned"));
      row.appendChild(el("span", "clock", model.why
        || "This workspace's model is fixed in its own environment, so changing it here would record a different answer and change nothing the customer sees. Change it where it is pinned, or unpin it first."));
      return row;
    }
    const select = document.createElement("select");
    select.className = "clientModel";
    const options = (model.choices ?? []).map((one) => ({ value: one.alias, label: one.name || one.alias }));
    if (options.length === 0) options.push({ value: String(model.current ?? ""), label: label || "not measured" });
    fill(select, options, model.current ?? "");
    row.appendChild(select);
    const save = el("button", "ghost small", "Save");
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/model`, { planModel: select.value });
        banner(String(result.message || `${client.slug} runs on the new model from its next turn.`), true);
        // Both panels, because this change is made here and recorded down there. Reloading only
        // this one leaves What changed a row short of the truth until somebody hits Refresh, and a
        // ledger that is behind the screen it sits on is worse than no ledger.
        await Promise.all([loadClients(), loadProviders()]);
      } catch (error) { banner(String(error.message)); }
      finally { save.disabled = false; }
    });
    row.appendChild(save);
    row.appendChild(el("span", "clock", CLOCK.proxy));
    return row;
  }

  async function loadClients() {
    const answer = await api("GET", "/v1/admin/clients");
    const host = $("clients");
    clear(host);
    if (answer.clients.length === 0) {
      host.appendChild(el("p", "empty", "No customers yet."));
      return;
    }
    for (const client of answer.clients) {
      const card = el("div", "client");
      const head = el("div", "head");
      head.appendChild(el("strong", null, client.name || client.slug));
      head.appendChild(el("span", "quiet", client.slug));
      head.appendChild(el("span", "chip", client.status));
      head.appendChild(el("span", "quiet", `Coolify says ${client.coolify && client.coolify.reachable ? client.coolify.status : "not measured"}`));
      // PROXY-1. What this customer's plan includes, and how close to it they are. The chip is the
      // only thing on this card that is ever red, and the words on it are the words their own agent
      // will say to them, so an operator reading the console and a customer reading their screen
      // are looking at the same fact.
      for (const node of allowanceChips(client.spend)) head.appendChild(node);

      const actions = el("div", "actions");
      for (const action of ["stop", "start", "restart", "provision"]) {
        const button = el("button", "ghost small", action);
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const result = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/${action}`, {});
            banner(String(result.message || `${action} was asked for on ${client.slug}.`), true);
            await loadClients();
          } catch (error) { banner(String(error.message)); }
          finally { button.disabled = false; }
        });
        actions.appendChild(button);
      }
      head.appendChild(actions);
      card.appendChild(head);

      if (client.lastError) card.appendChild(el("p", "quiet", `last error: ${client.lastError}`));

      // PROVIDERS-1. What this one workspace runs on, and the way to change it.
      //
      // A workspace can have its model PINNED in its own environment, and when it is, saving a
      // different one here changes a record and changes nothing a customer would notice. That case
      // gets said out loud rather than a select that appears to work: a control that silently does
      // nothing is worse than no control.
      card.appendChild(clientModelRow(client));

      const wrap = el("div", "scroll users");
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Email", "Name", "Added", "Last signed in", "Role", ""]) headRow.appendChild(el("th", null, label));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const body = document.createElement("tbody");
      if (client.users.length === 0) body.appendChild(rowSpanning(6, "Nobody can sign in to this workspace yet."));
      for (const user of client.users) {
        const tr = document.createElement("tr");
        tr.appendChild(el("td", "mono", user.email));
        tr.appendChild(el("td", null, user.name || "-"));
        const added = el("td", null, ago(user.createdAt));
        added.title = when(user.createdAt);
        tr.appendChild(added);
        const seen = el("td", null, user.lastSignInAt ? ago(user.lastSignInAt) : "never");
        seen.title = user.lastSignInAt ? when(user.lastSignInAt) : "no successful sign-in is on record";
        tr.appendChild(seen);
        const role = document.createElement("td");
        if (user.superAdmin) role.appendChild(el("span", "chip super", "super admin"));
        if (user.disabled) role.appendChild(el("span", "chip off", "sign-in off"));
        if (!user.superAdmin && !user.disabled) role.appendChild(text("customer"));
        tr.appendChild(role);

        const cell = document.createElement("td");
        const toggle = el("button", "ghost small", user.disabled ? "enable" : "disable");
        toggle.type = "button";
        toggle.addEventListener("click", async () => {
          toggle.disabled = true;
          try {
            const result = await api("POST", `/v1/admin/users/${encodeURIComponent(user.id)}/${user.disabled ? "enable" : "disable"}`, {});
            banner(String(result.message ?? ""), true);
            await loadClients();
          } catch (error) { banner(String(error.message)); }
          finally { toggle.disabled = false; }
        });
        cell.appendChild(toggle);

        const reset = el("button", "ghost small", "reset password");
        reset.type = "button";
        reset.addEventListener("click", async () => {
          reset.disabled = true;
          try {
            const result = await api("POST", `/v1/admin/users/${encodeURIComponent(user.id)}/reset-password`, {});
            // Shown once, in the banner, and nowhere else. There is no route that can be asked for
            // it again and nothing on this page keeps it.
            banner(`Temporary password for ${user.email}: ${result.temporaryPassword} - ${result.message}`, true);
            await loadClients();
          } catch (error) { banner(String(error.message)); }
          finally { reset.disabled = false; }
        });
        cell.appendChild(reset);
        tr.appendChild(cell);
        body.appendChild(tr);
      }
      table.appendChild(body);
      wrap.appendChild(table);
      card.appendChild(wrap);
      host.appendChild(card);
    }
  }

  // ---- panel 3: box health ---------------------------------------------------------------------

  // The one function that keeps the screen honest: a value that was not measured renders as the
  // reason it was not, in plain words, and never as a zero or a dash.
  const measured = (value, why, format) => {
    if (value === null || value === undefined || value === "not measured") {
      const node = el("span", "quiet", "not measured");
      if (why) node.title = String(why);
      return node;
    }
    return text(format ? format(value) : String(value));
  };

  async function loadBoxes() {
    const answer = await api("GET", "/v1/admin/boxes");
    const body = $("boxes").querySelector("tbody");
    clear(body);
    if (answer.boxes.length === 0) {
      body.appendChild(rowSpanning(7, "No workspaces yet."));
      return;
    }
    for (const box of answer.boxes) {
      const tr = document.createElement("tr");
      const name = el("td", null, box.slug);
      name.title = box.boxContainer || "no container recorded";
      tr.appendChild(name);

      const state = document.createElement("td");
      state.appendChild(measured(box.containerState === "not measured" ? null : box.containerState, box.containerStateWhy));
      tr.appendChild(state);

      const gateway = document.createElement("td");
      if (box.gatewayAnswering === null || box.gatewayAnswering === undefined) {
        gateway.appendChild(measured(null, box.gatewayWhy || "the console did not report this workspace"));
      } else {
        gateway.appendChild(el("span", `chip ${box.gatewayAnswering ? "ok" : "refused"}`, box.gatewayAnswering ? "answering" : "silent"));
        if (box.gatewayMs !== null && box.gatewayMs !== undefined) gateway.appendChild(text(` ${box.gatewayMs} ms`));
        if (!box.gatewayAnswering && box.gatewayWhy) gateway.title = box.gatewayWhy;
      }
      tr.appendChild(gateway);

      const activity = document.createElement("td");
      activity.appendChild(measured(box.lastActivityAt, box.lastActivityWhy, ago));
      if (box.lastActivityAt) activity.title = when(box.lastActivityAt);
      tr.appendChild(activity);

      const disk = el("td", "num");
      disk.appendChild(measured(box.diskKb, box.diskWhy, (kb) => bytes(Number(kb) * 1024)));
      tr.appendChild(disk);

      const memory = el("td", "num");
      memory.appendChild(measured(box.memoryBytes, box.memoryWhy, bytes));
      tr.appendChild(memory);

      const backup = document.createElement("td");
      backup.appendChild(measured(box.lastBackupStamp, box.lastBackupWhy));
      tr.appendChild(backup);

      body.appendChild(tr);
    }
    $("measuredAt").textContent = `measured ${when(answer.measuredAt)}`;
  }

  // ---- panel 4: system health ------------------------------------------------------------------

  const card = (title, value, detail, tone) => {
    const node = el("div", `card${tone ? ` ${tone}` : ""}`);
    node.appendChild(el("div", "title", title));
    const line = el("div", "value");
    if (value === null || value === undefined) {
      line.className = "value unmeasured";
      line.appendChild(text("not measured"));
    } else {
      line.appendChild(text(String(value)));
    }
    node.appendChild(line);
    if (detail) node.appendChild(el("div", "detail", detail));
    return node;
  };

  async function loadSystem() {
    const answer = await api("GET", "/v1/admin/system");
    const host = $("system");
    clear(host);

    host.appendChild(card("Host load",
      answer.load.one === null ? null : `${answer.load.one} ${answer.load.five} ${answer.load.fifteen}`,
      answer.load.why || "one, five and fifteen minutes, read from /proc/loadavg"));

    host.appendChild(card("Host memory free",
      answer.memory.availableBytes === null ? null : bytes(answer.memory.availableBytes),
      answer.memory.why || (answer.memory.totalBytes ? `of ${bytes(answer.memory.totalBytes)}` : "")));

    for (const disk of answer.disks) {
      host.appendChild(card(`Free on ${disk.path}`,
        disk.freeBytes === null ? null : bytes(disk.freeBytes),
        disk.why || (disk.totalBytes ? `of ${bytes(disk.totalBytes)}` : "")));
    }

    host.appendChild(card("Coolify",
      answer.coolify.reachable ? "reachable" : "not answering",
      answer.coolify.why || answer.coolify.url || "",
      answer.coolify.reachable ? "good" : "bad"));

    host.appendChild(card("Console relay",
      answer.relay.reachable ? "reachable" : "not answering",
      answer.relay.why || answer.relay.url || "",
      answer.relay.reachable ? "good" : "bad"));

    host.appendChild(card("Mail webhook", null, answer.mailWebhook.why));

    // Without this card, a ledger that cannot sign looks exactly like a quiet day: every address
    // reads "no password reached the check" and nothing is flagged.
    if (answer.signInRecord) {
      host.appendChild(card("Sign-in record",
        answer.signInRecord.signing ? "being written" : "not being written",
        answer.signInRecord.why,
        answer.signInRecord.signing ? "good" : "bad"));
    }

    host.appendChild(card("Nightly backup",
      answer.backup.measured ? answer.backup.stamp : null,
      answer.backup.measured
        ? `${answer.backup.mode === "consistent" ? "everything was paused for the copy" : "taken while things were running"}, ${answer.backup.tenantCount} workspace${answer.backup.tenantCount === 1 ? "" : "s"}, ${answer.backup.storeDbCount} agent databases, taken ${when(answer.backup.takenAt)}`
        : answer.backup.why,
      answer.backup.measured && answer.backup.mode === "consistent" ? "good" : ""));

    host.appendChild(card("Box isolation check",
      answer.isolation.measured ? (answer.isolation.ok ? "no box reaches another" : "a box-to-box path is open") : null,
      answer.isolation.measured ? `checked ${when(answer.isolation.at)}` : answer.isolation.why,
      answer.isolation.measured ? (answer.isolation.ok ? "good" : "bad") : ""));

    host.appendChild(card("Builds that never finished",
      answer.stuckProvisioning.length,
      answer.stuckProvisioning.length === 0
        ? "no workspace has been stuck building"
        : answer.stuckProvisioning.map((row) => `${row.slug} since ${when(row.since)} at step ${row.lastStep}`).join("; "),
      answer.stuckProvisioning.length === 0 ? "good" : "bad"));

    host.appendChild(card("Sign-ins in the last day", answer.counts.signInsLastDay,
      `${answer.counts.tenants} workspaces, ${answer.counts.accounts} people, ${answer.counts.superAdmins} super admin${answer.counts.superAdmins === 1 ? "" : "s"}`));

    $("version").textContent = `control plane ${answer.version} - measured ${when(answer.measuredAt)}`;
  }

  // ---- panel 5: spend --------------------------------------------------------------------------

  async function loadSpend() {
    const answer = await api("GET", "/v1/admin/spend");
    const body = document.querySelector("#spend tbody");
    clear(body);
    $("spendNote").textContent = answer.configured
      ? `${answer.note} Month is ${answer.window.month} UTC.${answer.enforced ? "" : " This server is in observe mode, so an allowance is recorded and nothing is stopped."}`
      : `Not measured: ${answer.why}`;
    if (answer.clients.length === 0) {
      body.appendChild(rowSpanning(6, "No customers yet."));
      return;
    }
    for (const client of answer.clients) {
      const tr = document.createElement("tr");
      const who = document.createElement("td");
      who.appendChild(el("strong", null, client.name || client.slug));
      who.appendChild(el("div", "quiet", client.slug));
      tr.appendChild(who);

      const window = (one) => {
        const cell = document.createElement("td");
        cell.appendChild(measured(dollars(one.dollars), one.why || client.why));
        cell.appendChild(el("div", "quiet", one.requests === null || one.requests === undefined
          ? "requests not measured"
          : `${one.requests} request${one.requests === 1 ? "" : "s"}`));
        return cell;
      };
      tr.appendChild(window(client.thisMonth));
      tr.appendChild(window(client.today));

      const against = document.createElement("td");
      for (const node of allowanceChips(client)) against.appendChild(node);
      if (client.allowance != null) against.appendChild(el("div", "quiet", `plan includes ${dollars(client.allowance)} a month`));
      tr.appendChild(against);

      // Requests and never dollars. The web tools are priced per request on our side and an agent
      // run's real credits vary, so a dollar figure here would look precise and would not be.
      const web = document.createElement("td");
      web.appendChild(measured(client.tinyfish.requests, client.tinyfish.why, (value) => `${value} request${value === 1 ? "" : "s"}`));
      tr.appendChild(web);

      const key = document.createElement("td");
      key.appendChild(el("div", "mono", client.alias || "not minted"));
      // The alias and the key id. Never the key: it is a live credential for that customer's box,
      // and this page is a browser.
      if (client.keyId) key.appendChild(el("div", "quiet mono", `${String(client.keyId).slice(0, 12)}...`));
      if (client.mintedAt) key.appendChild(el("div", "quiet", `minted ${ago(client.mintedAt)}`));
      tr.appendChild(key);
      body.appendChild(tr);
    }
  }

  // ---- panel 6: providers, keys and plan models ------------------------------------------------
  //
  // THE ROUTE CONTRACT THIS PANEL IS WRITTEN AGAINST. PROVIDERS-1, version 1. The whole panel is
  // one GET, because every part of it is read together and a page that fired six requests would
  // render in six stages on a bad connection.
  //
  //   GET /v1/admin/providers
  //     { configured, why, db: { on, why }, measuredAt,
  //       providers: [{ id, name, kind, baseUrl, fromPreset, bootstrapEnv,
  //                     health: { reachable, why, checkedAt },
  //                     catalog: { models: [id], live, readAt, why, note, ready, wired },
  //                     keys: [{ slot, label, order, masked, parked, backsCatalog,
  //                              serves: [alias], lastError: { at, why } | null,
  //                              spend: { month, requests, why },
  //                              quota: { unit, window, used, total, remaining, pct, resetAt,
  //                                       warn, live, why, byWorkspace: [{ slug, requests,
  //                                       tokens, dollars }] } }] }],
  //       planModels: [{ alias, provider, vendorModel, customerName, customerLabel, servedBy,
  //                      contextWindow, supportsVision, visionFallback, vision: { ok, at, why },
  //                      plans, customerVisible, shownToCustomers,
  //                      deployments: [{ id, keySlot, fromDb, healthy, why }],
  //                      workspaces, workspaceSlugs, workspacesWhy, labelBehind,
  //                      labelBehindWhy }],
  //       defaults: { planModel, why },
  //       actions: [{ at, actor, via, ip, action, target, detail, outcome }] }
  //
  //   POST /v1/admin/providers                                   { id, name, kind, baseUrl,
  //                                                                catalogBaseUrl?, catalogPath? }
  //   POST /v1/admin/providers/:id/keys                          { label, apiKey, slot?, order? }
  //   POST /v1/admin/providers/:id/keys/:slot/roll               { apiKey }
  //   POST /v1/admin/providers/:id/keys/:slot/park               { parked }
  //   POST /v1/admin/providers/:id/keys/:slot/remove             { confirm: "<slot>" }
  //   POST /v1/admin/providers/:id/keys/:slot/quota              { total, unit, window, resetAt }
  //   POST /v1/admin/providers/:id/catalog/refresh               {}
  //   POST /v1/admin/plan-models                                 { alias, provider, keySlots: [],
  //                                                                vendorModel, customerName,
  //                                                                customerLabel, servedBy,
  //                                                                customerVisible, supportsVision,
  //                                                                visionFallback, contextWindow,
  //                                                                plans }
  //   POST /v1/admin/plan-models/:alias/update                   any of the above but alias
  //   POST /v1/admin/plan-models/:alias/vision-check             {}
  //   POST /v1/admin/plan-models/:alias/apply                    {}
  //   POST /v1/admin/plan-models/:alias/push-label               { all: true } or { slugs: [] }
  //   POST /v1/admin/defaults                                    { planModel }
  //   POST /v1/admin/clients/:slug/model                         { planModel, pushLabel? }
  //
  // Every write answers { message } and never a key value. The names above are cp/admin.mjs's own
  // and cp/PROVIDERS-ROUTES.md's: the panel and the route were written in parallel against that
  // document, and where this file once used a different word for the same field the panel drew an
  // empty card against a route that was answering perfectly.

  // The three clocks, in the words the operator reads. There is no fourth, and there is no bare
  // "takes effect immediately" anywhere on this page: the proxy, a box and a customer's open tab
  // each pick a change up at a different moment and saying otherwise is how PROXY-10 cost a day.
  const CLOCK = {
    proxy: "The proxy uses this on the next request. A workspace picks it up on its next turn.",
    label: "A workspace picks this up on its next turn, once you push it. A customer's open page shows it the next time that page loads.",
    added: "A new model reaches a customer's list within a minute, and only once every workspace has been given access to it.",
    customerPage: "A customer's open page shows this the next time that page loads.",
  };

  // What the panel holds between renders. Only the answer: no key value is ever kept here, and no
  // form value survives a reload of the panel.
  let providersAnswer = { providers: [], planModels: [], defaults: {}, actions: [] };
  let editingAlias = "";

  // The one wrapper every action on this panel goes through: disabled in flight, a banner either
  // way, the panel reloaded, and the button put back in a finally. Exactly the shape the client
  // and user actions above already use.
  const act = async (button, run) => {
    button.disabled = true;
    try {
      const result = await run();
      banner(String(result?.message ?? "Done."), true);
      await loadProviders();
    } catch (error) {
      banner(String(error.message));
    } finally {
      button.disabled = false;
    }
  };

  const option = (value, label) => {
    const node = document.createElement("option");
    node.value = String(value ?? "");
    node.appendChild(text(label ?? value));
    return node;
  };
  const fill = (select, options, selected) => {
    clear(select);
    for (const one of options) select.appendChild(option(one.value, one.label));
    select.value = String(selected ?? "");
    if (select.value !== String(selected ?? "") && select.options.length > 0) select.selectedIndex = 0;
  };

  // A count that might not have been measured. Never a zero standing in for "nobody asked".
  const countWord = (value, one, many) => (value === 1 ? one : many.replace("{n}", String(value)));

  /**
   * ONE SUBSCRIPTION'S PLAN WINDOW. The vendor sells a window (Alibaba a 7-day token plan, Z.AI
   * prompts in a 5-hour window and a month, MiniMax its own), and the number that matters is how
   * much of THAT is gone. Nothing on this build reads it from the vendor, so the total and the
   * reset are typed in off the vendor's own page and what we count against them is our own count
   * out of the proxy's request log. The cell says which half is which rather than drawing a bar
   * that looks measured when half of it was typed.
   */
  function quotaCell(key) {
    const cell = document.createElement("td");
    const quota = key.quota ?? null;
    if (quota == null || quota.total == null) {
      const none = el("span", "quiet", "not set");
      none.title = String(quota?.why || "No plan size is recorded for this subscription, so there is no window to draw.");
      cell.appendChild(none);
      return cell;
    }
    const bar = el("div", "quotaBar");
    const fill = el("div", quota.warn ? "quotaFill warn" : "quotaFill");
    fill.style.width = `${Math.min(100, Math.max(0, Number(quota.pct ?? 0)))}%`;
    bar.appendChild(fill);
    cell.appendChild(bar);
    const line = el("div", "quiet", `${Number(quota.remaining ?? 0).toLocaleString()} of ${Number(quota.total).toLocaleString()} ${quota.unit} left`);
    line.title = String(quota.why || "");
    cell.appendChild(line);
    if (quota.resetAt) cell.appendChild(el("div", "quiet", `resets ${ago(quota.resetAt)}`));
    if (quota.warn) cell.appendChild(el("span", "chip refused", `${quota.pct}% used`));
    // WHICH CUSTOMER used it, inside the same window. The second half of what this was asked for:
    // a shared subscription with no per-workspace split is a bill nobody can explain.
    const share = Array.isArray(quota.byWorkspace) ? quota.byWorkspace : [];
    if (share.length > 0) {
      const who = el("div", "quiet", share.slice(0, 3).map((one) => `${one.slug} ${one.requests}`).join(", "));
      who.title = share.map((one) => `${one.slug}: ${one.requests} requests, ${one.tokens.toLocaleString()} tokens`).join("\n");
      cell.appendChild(who);
    }
    return cell;
  }

  /** The quiet line under a plan model that names the routing alias, captioned so it reads as one. */
  const aliasLine = (alias) => {
    const line = el("div", "aliasLine");
    line.appendChild(text("what the routing calls it: "));
    line.appendChild(el("span", "alias", alias));
    return line;
  };

  function renderProviderCard(provider) {
    const card = el("div", "provider");
    card.dataset.provider = provider.id;

    const head = el("div", "head");
    head.appendChild(el("strong", null, provider.name || provider.id));
    head.appendChild(el("span", "quiet", provider.kind || "kind not recorded"));
    head.appendChild(el("span", "quiet mono", provider.baseUrl || "no address recorded"));
    const health = provider.health ?? {};
    if (health.reachable === true) head.appendChild(el("span", "chip ok", "answering"));
    else if (health.reachable === false) {
      const chip = el("span", "chip refused", "not answering");
      chip.title = String(health.why || "");
      head.appendChild(chip);
    } else {
      const chip = el("span", "quiet", "not measured");
      chip.title = String(health.why || "this provider has not been asked yet");
      head.appendChild(chip);
    }

    const actions = el("div", "actions");
    const refresh = el("button", "ghost small", "Refresh the model list");
    refresh.type = "button";
    refresh.addEventListener("click", () => act(refresh, () => api("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/catalog/refresh`, {})));
    actions.appendChild(refresh);
    head.appendChild(actions);
    card.appendChild(head);

    // WHERE THE MODEL LIST CAME FROM, in those words, because the two are not the same thing and
    // an operator picking a vendor model needs to know which one they are looking at.
    const catalog = provider.catalog ?? {};
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const where = models.length === 0
      ? "no model list yet"
      : catalog.live === true
        ? `${models.length} model${models.length === 1 ? "" : "s"}, read from the provider ${catalog.readAt ? ago(catalog.readAt) : "at some point"}`
        : `${models.length} model${models.length === 1 ? "" : "s"}, from our own list`;
    const line = el("p", "quiet", where);
    if (catalog.why) line.title = String(catalog.why);
    card.appendChild(line);
    // The refresh button cannot do anything until the vendor's list has somewhere to be read from
    // and a key to read it with, and a button that answers "nothing happened" is worse than one
    // that says why before it is pressed.
    if (catalog.ready === false) {
      refresh.disabled = true;
      refresh.title = "This provider has no model list address recorded, so there is nothing to read. Add one when you register it.";
    }
    card.appendChild(el("p", "quiet", String(catalog.note || "A model list is names and nothing else. The context window, whether it takes a screenshot and what a customer sees it called are set by you on the plan model below.")));

    const wrap = el("div", "scroll");
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Key", "Order", "Value", "Used by", "This month", "Requests", "Plan window", "Last error", ""]) headRow.appendChild(el("th", null, label));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const body = document.createElement("tbody");
    const keys = Array.isArray(provider.keys) ? provider.keys : [];
    if (keys.length === 0) body.appendChild(rowSpanning(9, "This provider has no key yet, so nothing can run on it."));
    for (const key of keys) {
      const tr = document.createElement("tr");
      tr.dataset.key = key.slot;
      const name = document.createElement("td");
      name.appendChild(el("div", null, key.label || key.slot));
      name.appendChild(el("div", "quiet mono", key.slot));
      if (key.parked) name.appendChild(el("span", "chip locked", "parked"));
      if (key.backsCatalog) {
        const chip = el("span", "chip ok", "reads the model list");
        chip.title = "The provider's own model list is read through this key. Rolling it keeps working; removing it takes the Refresh button with it.";
        name.appendChild(chip);
      }
      tr.appendChild(name);
      tr.appendChild(el("td", "num", key.order ?? "-"));
      // The mask the service reported and nothing else. This page never sees a key value.
      tr.appendChild(el("td", "mono", key.masked || "not shown"));
      tr.appendChild(el("td", null, (key.serves ?? []).length === 0 ? "nothing yet" : (key.serves ?? []).join(", ")));
      const month = el("td", "num");
      month.appendChild(measured(dollars(key.spend?.month), key.spend?.why));
      tr.appendChild(month);
      const requests = el("td", "num");
      requests.appendChild(measured(key.spend?.requests, key.spend?.why));
      tr.appendChild(requests);
      tr.appendChild(quotaCell(key));
      const error = document.createElement("td");
      if (key.lastError != null && String(key.lastError.why ?? "").length > 0) {
        const chip = el("span", "chip refused", "an error");
        chip.title = `${key.lastError.why}${key.lastError.at ? ` (${when(key.lastError.at)})` : ""}`;
        error.appendChild(chip);
      } else {
        error.appendChild(el("span", "quiet", "none"));
      }
      tr.appendChild(error);

      const cell = document.createElement("td");
      const roll = el("button", "ghost small", "Roll");
      roll.type = "button";
      roll.className = "ghost small rollKey";
      const park = el("button", "ghost small", key.parked ? "Use again" : "Park");
      park.type = "button";
      park.className = "ghost small parkKey";
      park.addEventListener("click", () => act(park, () => api(
        "POST",
        `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/park`,
        { parked: !key.parked },
      )));
      const remove = el("button", "ghost small", "Remove");
      remove.type = "button";
      remove.className = "ghost small removeKey";
      const window_ = el("button", "ghost small", "Plan size");
      window_.type = "button";
      window_.className = "ghost small quotaKey";
      cell.appendChild(roll);
      cell.appendChild(park);
      cell.appendChild(window_);
      cell.appendChild(remove);
      tr.appendChild(cell);
      body.appendChild(tr);

      // The roll. One row below the key, revealed by the button above it, and the value in it never
      // comes back: the field is cleared whether the roll worked or not.
      //
      // The row itself is hidden until one of the two forms in it is open, or every key on the
      // screen sits above an empty stripe the height of a row. `showRow` below is what keeps the
      // two in step, because either form can be the one that is open.
      const rollRow = document.createElement("tr");
      rollRow.hidden = true;
      const rollCell = document.createElement("td");
      rollCell.colSpan = 9;
      const rollForm = el("form", "keyForm rollForm");
      rollForm.hidden = true;
      const rollField = document.createElement("input");
      rollField.type = "password";
      rollField.autocomplete = "off";
      rollField.placeholder = "the new key";
      rollField.className = "keyValue";
      const rollGo = el("button", "ghost small", "Replace this key");
      rollGo.type = "submit";
      rollForm.appendChild(rollField);
      rollForm.appendChild(rollGo);
      rollForm.appendChild(el("span", "why", `The new key goes in beside the old one, the old one comes out once the new one has answered, and nothing in between fails. ${CLOCK.proxy}`));
      rollForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = rollField.value;
        if (value.length === 0) { banner("Type the new key first. Rolling to an empty key would take every workspace on this provider down."); return; }
        rollField.value = "";
        await act(rollGo, () => api(
          "POST",
          `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/roll`,
          { apiKey: value },
        ));
      });
      rollCell.appendChild(rollForm);

      // The remove. The one destructive control on this page, and the only one anywhere in this
      // console that takes a typed confirmation: one stray click here takes every workspace on this
      // provider off the air, and there is no undo because the value is gone.
      const removeForm = el("form", "keyForm danger");
      removeForm.hidden = true;
      const confirmField = document.createElement("input");
      confirmField.type = "text";
      confirmField.autocomplete = "off";
      confirmField.placeholder = key.slot;
      confirmField.className = "confirmField";
      const removeGo = el("button", "ghost small", "Remove this key for good");
      removeGo.type = "submit";
      removeForm.appendChild(confirmField);
      removeForm.appendChild(removeGo);
      // The slot and not the provider's name, because the slot is what the route checks and a
      // confirmation the service will refuse is a confirmation that teaches nothing.
      removeForm.appendChild(el("span", "why", `Type ${key.slot} to confirm. The key value is gone after this and cannot be read back from anywhere, so if it is the last key on this provider every workspace using it stops on the next request.`));
      removeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const typed = confirmField.value.trim();
        if (typed !== String(key.slot)) {
          banner(`Type ${key.slot} in the box to remove this key. Nothing was removed.`);
          return;
        }
        confirmField.value = "";
        await act(removeGo, () => api(
          "POST",
          `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/remove`,
          { confirm: typed },
        ));
      });
      rollCell.appendChild(removeForm);

      // The vendor's plan window, typed in once off their own page. No endpoint on this build
      // reports it, which the form says rather than implying the numbers came from the vendor.
      const quotaForm = el("form", "keyForm quotaForm");
      quotaForm.hidden = true;
      const quotaTotal = document.createElement("input");
      quotaTotal.type = "number";
      quotaTotal.min = "0";
      quotaTotal.placeholder = "the plan's total";
      quotaTotal.className = "quotaTotal";
      quotaTotal.value = key.quota?.total != null ? String(key.quota.total) : "";
      const quotaUnit = document.createElement("input");
      quotaUnit.type = "text";
      quotaUnit.placeholder = "what it is counted in";
      quotaUnit.className = "quotaUnit";
      quotaUnit.value = String(key.quota?.unit ?? "");
      const quotaReset = document.createElement("input");
      quotaReset.type = "text";
      quotaReset.placeholder = "when it resets, e.g. 2026-09-09T22:37:00Z";
      quotaReset.className = "quotaReset";
      quotaReset.value = String(key.quota?.resetAt ?? "");
      const quotaGo = el("button", "ghost small", "Record this plan window");
      quotaGo.type = "submit";
      quotaForm.appendChild(quotaTotal);
      quotaForm.appendChild(quotaUnit);
      quotaForm.appendChild(quotaReset);
      quotaForm.appendChild(quotaGo);
      quotaForm.appendChild(el("span", "why", "Read the total and the reset off the provider's own plan page and type them here. What is counted against them is our own count of what went through this key, which is why the bar says so."));
      quotaForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await act(quotaGo, () => api(
          "POST",
          `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/quota`,
          {
            total: Number(quotaTotal.value) || 0,
            unit: quotaUnit.value.trim(),
            window: String(key.quota?.window ?? ""),
            resetAt: quotaReset.value.trim(),
          },
        ));
      });
      rollCell.appendChild(quotaForm);
      rollRow.appendChild(rollCell);
      body.appendChild(rollRow);

      // The one place the row and the two forms inside it are kept in step. Opening either closes
      // the other, because a key row with a roll field and a delete confirmation open at once is
      // two ways to type into the wrong one.
      const showRow = () => { rollRow.hidden = rollForm.hidden && removeForm.hidden && quotaForm.hidden; };
      roll.addEventListener("click", () => {
        rollForm.hidden = !rollForm.hidden;
        if (!rollForm.hidden) { removeForm.hidden = true; quotaForm.hidden = true; }
        showRow();
        if (!rollForm.hidden) rollField.focus();
      });
      remove.addEventListener("click", () => {
        removeForm.hidden = !removeForm.hidden;
        if (!removeForm.hidden) { rollForm.hidden = true; quotaForm.hidden = true; }
        showRow();
        if (!removeForm.hidden) confirmField.focus();
      });
      window_.addEventListener("click", () => {
        quotaForm.hidden = !quotaForm.hidden;
        if (!quotaForm.hidden) { rollForm.hidden = true; removeForm.hidden = true; }
        showRow();
        if (!quotaForm.hidden) quotaTotal.focus();
      });
    }
    table.appendChild(body);
    wrap.appendChild(table);
    card.appendChild(wrap);

    // Add a key to this provider. Same masked field, same rule: it goes out once and is cleared.
    const addForm = el("form", "keyForm addKeyForm");
    const addLabel = document.createElement("input");
    addLabel.type = "text";
    addLabel.autocomplete = "off";
    addLabel.placeholder = "what to call this key";
    addLabel.className = "keyLabel";
    const addValue = document.createElement("input");
    addValue.type = "password";
    addValue.autocomplete = "off";
    addValue.placeholder = "the key itself";
    addValue.className = "keyValue";
    const addGo = el("button", "ghost small", "Add this key");
    addGo.type = "submit";
    addForm.appendChild(addLabel);
    addForm.appendChild(addValue);
    addForm.appendChild(addGo);
    addForm.appendChild(el("span", "why", `A second, third or fourth key on the same provider shares the load and covers the others when one is rate limited. ${CLOCK.proxy}`));
    addForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = addValue.value;
      const label = addLabel.value.trim();
      if (value.length === 0) { banner("Type the key before adding it."); return; }
      addValue.value = "";
      addLabel.value = "";
      await act(addGo, () => api("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys`, { label, apiKey: value }));
    });
    card.appendChild(addForm);
    return card;
  }

  function renderPlanModelCard(model, answer) {
    const card = el("div", "planModel");
    card.dataset.alias = model.alias;
    const head = el("div", "head");
    // The customer's name for it is the prominent one. The routing alias is below, captioned.
    head.appendChild(el("span", "name", model.customerName || model.alias));
    head.appendChild(el("span", "quiet", model.provider || "no provider"));
    head.appendChild(el("span", "quiet mono", model.vendorModel || "no vendor model"));
    // shownToCustomers is the route's own answer to the one question that keeps a routing target
    // off a customer's Settings card: visible AND named on both sides. A row that fails it is drawn
    // here plainly, because the operator's page is where the reason has to be visible.
    if (model.shownToCustomers === false) {
      const chip = el("span", "chip locked", "not shown to customers");
      chip.title = model.customerVisible === false
        ? "This model is marked as not for customers, so it stays off their Settings card."
        : "This model has no customer name or no label, so it would show up as its routing alias. It is kept off the customer's card until both are set.";
      head.appendChild(chip);
    }

    const actions = el("div", "actions");
    const edit = el("button", "ghost small", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => openPlanModelForm(model));
    actions.appendChild(edit);

    const running = model.workspaces;
    const known = Number.isFinite(Number(running));
    const grant = el("button", "ghost small", known
      ? `Give all ${running} workspace${running === 1 ? "" : "s"} access to this model`
      : "Give every workspace access to this model");
    grant.type = "button";
    grant.title = CLOCK.added;
    grant.addEventListener("click", () => act(grant, () => api("POST", `/v1/admin/plan-models/${encodeURIComponent(model.alias)}/apply`, {})));
    actions.appendChild(grant);

    const push = el("button", "ghost small", known
      ? `Update what ${running} workspace${running === 1 ? "" : "s"} call it`
      : "Update what their Titan calls it");
    push.type = "button";
    push.title = CLOCK.label;
    // { all: true }, because the route refuses a push that names nobody: it writes INSIDE a box
    // and it sets the model as well as the label, so an empty body answers 409 with the candidates.
    push.addEventListener("click", () => act(push, () => api("POST", `/v1/admin/plan-models/${encodeURIComponent(model.alias)}/push-label`, { all: true })));
    actions.appendChild(push);

    // Whether this model takes an image is the one fact a model list can never tell us, and getting
    // it wrong is a fleet-wide screenshot outage rather than a cosmetic error. So it is asked.
    const check = el("button", "ghost small", "Check screenshots");
    check.type = "button";
    check.title = "Sends one image through this model and records what came back.";
    check.addEventListener("click", () => act(check, () => api("POST", `/v1/admin/plan-models/${encodeURIComponent(model.alias)}/vision-check`, {})));
    actions.appendChild(check);
    head.appendChild(actions);
    card.appendChild(head);

    card.appendChild(aliasLine(model.alias));

    const facts = [];
    facts.push(`their Titan says it runs ${model.customerLabel || "nothing, because no label is set"}`);
    facts.push(model.contextWindow ? `${Number(model.contextWindow).toLocaleString()} tokens of context` : "no context window set");
    const slots = [...new Set((model.deployments ?? []).map((one) => String(one.keySlot)).filter((one) => one.length > 0))];
    facts.push(slots.length === 0 ? "no key behind it" : `${slots.length === 1 ? "key" : "keys"} ${slots.join(", ")}`);
    facts.push((model.plans ?? []).length > 0 ? `part of ${(model.plans ?? []).join(", ")}` : "no plan named");
    card.appendChild(el("p", "quiet", facts.join(" . ")));

    const visionName = (answer.planModels ?? []).find((one) => one.alias === model.visionFallback);
    const vision = el("p", "quiet");
    // Three states, and the middle one is the reason this is not a two-branch check. The model every
    // other one falls back TO has no fallback of its own and never will, so a bare "is there a
    // fallback" test shouts an outage warning at the one model that is working exactly as designed,
    // on every load, forever. The save handler already knows the difference; the screen has to as
    // well, or the operator learns to read the warning as furniture and misses the real one.
    if (String(model.visionFallback ?? "").length > 0) {
      vision.appendChild(text(`a screenshot falls back to ${visionName?.customerName || model.visionFallback}`));
    } else if (model.supportsVision === true) {
      vision.appendChild(text("this one takes screenshots itself, so nothing falls back"));
      if (model.vision?.ok === false) {
        const chip = el("span", "chip refused", "it refused an image when asked");
        chip.title = String(model.vision?.why || "");
        vision.appendChild(chip);
      }
    } else {
      vision.appendChild(el("span", "chip off", "no screenshot route"));
      vision.appendChild(text(" Every Titan conversation carries screenshots, so a workspace on this model fails on its next turn."));
    }
    card.appendChild(vision);

    const runs = el("p", "quiet");
    runs.appendChild(text("running this right now: "));
    runs.appendChild(measured(known ? running : null, model.workspacesWhy, (value) => countWord(Number(value), "one workspace", "{n} workspaces")));
    card.appendChild(runs);
    return card;
  }

  function openPlanModelForm(model) {
    const form = $("planModelForm");
    const answer = providersAnswer;
    editingAlias = String(model?.alias ?? "");
    $("planModelWhich").textContent = editingAlias
      ? `Editing ${model.customerName || editingAlias}. The routing name cannot change: every workspace already on it names it.`
      : "A new plan model. Pick the routing name carefully, because it is the one field that can never change afterwards.";
    $("pmCustomerName").value = String(model?.customerName ?? "");
    $("pmCustomerLabel").value = String(model?.customerLabel ?? "");
    $("pmContext").value = model?.contextWindow ? String(model.contextWindow) : "";
    $("pmPlans").value = (model?.plans ?? []).join(", ");
    $("pmAlias").value = editingAlias;
    $("pmAlias").readOnly = editingAlias.length > 0;
    $("pmVisible").checked = model ? model.customerVisible !== false : true;
    $("pmAliasNote").hidden = false;
    $("pmSelfVision").checked = model ? model.supportsVision === true : false;

    const providers = answer.providers ?? [];
    fill($("pmProvider"), providers.map((one) => ({ value: one.id, label: one.name || one.id })), model?.provider ?? providers[0]?.id ?? "");
    const refreshKeys = () => {
      const chosen = providers.find((one) => one.id === $("pmProvider").value);
      // EVERY KEY, PRESELECTED. A plan model is a pool: one deployment per key, all sharing the
      // alias. That is what makes a second subscription carry load and what makes a rate limit on
      // one key survivable. A single-key picker here is how a pool quietly becomes one key.
      const keySelect = $("pmKey");
      const running = new Set((model?.deployments ?? []).map((one) => String(one.keySlot)));
      clear(keySelect);
      for (const one of chosen?.keys ?? []) {
        const node = document.createElement("option");
        node.value = one.slot;
        node.appendChild(text(`${one.label || one.slot} (${one.slot})`));
        node.selected = running.size === 0 ? !one.parked : running.has(String(one.slot));
        keySelect.appendChild(node);
      }
      keySelect.disabled = editingAlias.length > 0;
      const catalogModels = Array.isArray(chosen?.catalog?.models) ? chosen.catalog.models : [];
      const options = catalogModels.map((one) => ({ value: one, label: one }));
      options.push({ value: "__other__", label: "something else, typed in" });
      const current = String(model?.vendorModel ?? "");
      const inList = catalogModels.includes(current);
      fill($("pmVendorModel"), options, inList ? current : (current.length > 0 ? "__other__" : options[0]?.value ?? ""));
      $("pmVendorOther").value = inList ? "" : current;
      $("pmVendorOtherWrap").hidden = $("pmVendorModel").value !== "__other__";
    };
    refreshKeys();
    $("pmProvider").onchange = refreshKeys;
    $("pmVendorModel").onchange = () => { $("pmVendorOtherWrap").hidden = $("pmVendorModel").value !== "__other__"; };

    // The screenshot route. Every plan model the panel knows about is a candidate except this one,
    // because a model cannot fall back to itself.
    const visionOptions = [{ value: "", label: "nothing, this model has no screenshot route" }];
    for (const one of answer.planModels ?? []) {
      if (one.alias === editingAlias) continue;
      visionOptions.push({ value: one.alias, label: one.customerName || one.alias });
    }
    fill($("pmVision"), visionOptions, model?.visionFallback ?? "");
    // The keys a model runs on are its pool at the proxy. Changing that is adding or removing a
    // deployment, which is not what this form does, so on an edit the picker shows what is really
    // there and does not pretend to change it.
    $("pmKeyNote").textContent = editingAlias.length > 0
      ? "These are the keys this model runs on now. To change the pool, add or remove a key on the provider above."
      : "It runs on every key selected here, one deployment each. That is what makes a second subscription share the load.";

    form.hidden = false;
    $("pmCustomerName").focus();
  }

  $("addPlanModelShow").addEventListener("click", () => openPlanModelForm(null));
  $("planModelCancel").addEventListener("click", () => { $("planModelForm").hidden = true; editingAlias = ""; });
  $("addProviderShow").addEventListener("click", () => { $("addProviderForm").hidden = false; $("providerName").focus(); });
  $("addProviderCancel").addEventListener("click", () => { $("addProviderForm").hidden = true; });

  $("addProviderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("providerName").value.trim();
    const kind = $("providerKind").value.trim() || "openai";
    const baseUrl = $("providerBase").value.trim();
    // The short name is the handle every key slot is named after (zai-1, zai-2) and it is on every
    // spend row forever, so it is typed rather than guessed from a display name.
    const id = $("providerId").value.trim().toLowerCase();
    const catalogPath = $("providerCatalog").value.trim();
    if (name.length === 0 || baseUrl.length === 0) { banner("A provider needs a name and an address."); return; }
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) { banner("The short name is lower case letters, numbers and dashes, and it is what every key slot on this provider is named after."); return; }
    const button = $("addProviderSave");
    await act(button, () => api("POST", "/v1/admin/providers", { id, name, kind, baseUrl, catalogPath }));
    $("providerId").value = "";
    $("providerName").value = "";
    $("providerKind").value = "";
    $("providerBase").value = "";
    $("providerCatalog").value = "";
    $("addProviderForm").hidden = true;
  });

  $("planModelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const alias = $("pmAlias").value.trim();
    const visionFallback = $("pmVision").value;
    const vendorModel = $("pmVendorModel").value === "__other__" ? $("pmVendorOther").value.trim() : $("pmVendorModel").value;
    const supportsVision = $("pmSelfVision").checked;
    // THE ONE FIELD THIS FORM WILL NOT LET THROUGH. A plan model with no screenshot route is a
    // fleet-wide outage on the next turn, not a missing nicety: every Titan conversation carries
    // screenshots and the flagship models refuse them. The refusal says that, in those words.
    //
    // The one model that legitimately has no route is the one everything else falls back TO, which
    // is why the box beside it exists. Making the route flatly mandatory would make that model
    // unsaveable and would push somebody into pointing it at itself, which is worse than the hole
    // it was meant to close.
    if (visionFallback.length === 0 && !supportsVision) {
      banner("Pick where a screenshot falls back to before saving. Every conversation on this product carries screenshots, and a plan model that cannot take one fails the next turn for every workspace on it.");
      return;
    }
    if (alias.length === 0) { banner("A plan model needs a routing name."); return; }
    if (vendorModel.length === 0) { banner("Pick the vendor model this points at, or type one in."); return; }
    const customerLabel = $("pmCustomerLabel").value.trim();
    const shared = {
      provider: $("pmProvider").value,
      vendorModel,
      customerName: $("pmCustomerName").value.trim(),
      customerLabel,
      // What the customer's Titan says it is served by follows the label unless somebody says
      // otherwise. One less field on the form, and never an empty string reaching a box.
      servedBy: customerLabel,
      customerVisible: $("pmVisible").checked,
      supportsVision,
      visionFallback,
      contextWindow: $("pmContext").value.trim().length > 0 ? Number($("pmContext").value) : null,
      plans: $("pmPlans").value.split(",").map((one) => one.trim()).filter((one) => one.length > 0),
    };
    const button = $("planModelSave");
    // AN EDIT IS AN EDIT. The alias is a contract with every box already pointed at it, so the
    // create route refuses one that exists; sending an edit there answered 409 and changed nothing.
    if (editingAlias.length > 0) {
      await act(button, () => api("POST", `/v1/admin/plan-models/${encodeURIComponent(editingAlias)}/update`, shared));
    } else {
      const keySlots = [...$("pmKey").selectedOptions].map((one) => one.value);
      if (keySlots.length === 0) { banner("Pick at least one key for it to run on."); return; }
      await act(button, () => api("POST", "/v1/admin/plan-models", { alias, keySlots, ...shared }));
    }
    $("planModelForm").hidden = true;
    editingAlias = "";
  });

  function renderDefaults(answer) {
    const host = $("providerDefaults");
    clear(host);
    const row = el("div", "row");
    row.appendChild(el("span", "quiet", "A new workspace starts on"));
    const select = document.createElement("select");
    select.id = "defaultModel";
    const options = (answer.planModels ?? []).map((one) => ({ value: one.alias, label: one.customerName || one.alias }));
    if (options.length === 0) options.push({ value: "", label: "nothing, because there is no plan model yet" });
    fill(select, options, answer.defaults?.planModel ?? "");
    row.appendChild(select);
    const save = el("button", "ghost small", "Save");
    save.type = "button";
    save.id = "defaultModelSave";
    save.addEventListener("click", () => act(save, () => api("POST", "/v1/admin/defaults", { planModel: select.value })));
    row.appendChild(save);
    host.appendChild(row);
    const note = el("p", "quiet", `This is what a workspace provisioned from now on runs on. It changes nothing about a workspace that already exists: those are set one at a time on their own row under Clients and users. ${CLOCK.customerPage}`);
    if (answer.defaults?.why) note.title = String(answer.defaults.why);
    host.appendChild(note);
  }

  function renderLedger(rows) {
    const body = $("adminLedger").querySelector("tbody");
    clear(body);
    if (rows.length === 0) {
      body.appendChild(rowSpanning(7, "Nothing has been changed from this console yet."));
      return;
    }
    for (const row of rows) {
      const tr = document.createElement("tr");
      const at = el("td", null, ago(row.at));
      at.title = when(row.at);
      tr.appendChild(at);
      tr.appendChild(el("td", "mono", row.actor || "the operator token"));
      tr.appendChild(row.via === "relay" ? el("td", null, "through the console") : el("td", "mono", row.ip || "not recorded"));
      tr.appendChild(el("td", null, row.action || "-"));
      tr.appendChild(el("td", "mono", row.target || "-"));
      tr.appendChild(el("td", null, row.detail || ""));
      const outcome = document.createElement("td");
      outcome.appendChild(el("span", `chip ${row.outcome === "ok" ? "ok" : "refused"}`, row.outcome === "ok" ? "done" : String(row.outcome || "failed")));
      tr.appendChild(outcome);
      body.appendChild(tr);
    }
  }

  async function loadProviders() {
    const answer = await api("GET", "/v1/admin/providers");
    providersAnswer = answer;

    const note = [];
    if (answer.configured === false) {
      note.push(`Not measured: ${answer.why}`);
    } else {
      note.push(`${(answer.providers ?? []).length} provider${(answer.providers ?? []).length === 1 ? "" : "s"}`);
      note.push(`${(answer.planModels ?? []).length} plan model${(answer.planModels ?? []).length === 1 ? "" : "s"}`);
      note.push(`measured ${when(answer.measuredAt)}`);
      // THE HALF-STATE, SAID OUT LOUD. With the proxy reading its models out of its file, a key
      // added here really persists and a plan model refuses, so half of what this page does works
      // and the page would otherwise look fine. null is "cannot be told apart yet", not false.
      if (answer.db?.on === false) {
        note.push(`the proxy is still reading its models out of its own file, so a change made here will not stick: ${answer.db.why || "store_model_in_db is off"}`);
      } else if (answer.db?.on == null && answer.db?.why) {
        note.push(String(answer.db.why));
      }
    }
    $("providersNote").textContent = note.join(" - ");

    const host = $("providers");
    clear(host);
    const providers = answer.providers ?? [];
    if (providers.length === 0) host.appendChild(el("p", "empty", "No provider yet. Add one, add a key to it, then point a plan model at that key."));
    for (const provider of providers) host.appendChild(renderProviderCard(provider));

    const models = $("planModels");
    clear(models);
    const planModels = answer.planModels ?? [];
    if (planModels.length === 0) models.appendChild(el("p", "empty", "No plan model yet, so no workspace has anything to run on."));
    for (const model of planModels) models.appendChild(renderPlanModelCard(model, answer));

    renderDefaults(answer);
    renderLedger(answer.actions ?? []);
  }

  // ---- everything at once ----------------------------------------------------------------------

  async function loadAll() {
    banner("");
    const button = $("refresh");
    button.disabled = true;
    // Each panel loads on its own and reports its own failure into its own space, so one route
    // being down does not blank the other four. `allSettled`, deliberately.
    const results = await Promise.allSettled([loadSignIns(), loadClients(), loadBoxes(), loadSystem(), loadSpend(), loadProviders()]);
    button.disabled = false;
    const broken = results.filter((result) => result.status === "rejected" && String(result.reason?.message) !== "unauthorized");
    if (broken.length > 0) banner(`${broken.length} panel${broken.length === 1 ? "" : "s"} could not be loaded: ${broken.map((row) => row.reason.message).join("; ")}`);
    // The one flag a browser gate waits on, rather than a fixed sleep. It says the render finished,
    // not that everything in it succeeded, which is exactly what a gate wants to inspect.
    window.__adminLive = { panels: 6, at: new Date().toISOString() };
    document.body.setAttribute("data-admin-loaded", "true");
  }

  // A tab reopened with a session still in sessionStorage goes straight in. A token that has since
  // expired lands on the 401 above and comes back to the door.
  if (token.length > 0) {
    showConsole(stored.get(EMAIL_KEY));
    void loadAll();
  } else {
    showDoor("");
  }
})();
