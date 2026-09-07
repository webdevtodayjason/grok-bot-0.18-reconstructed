// cp/admin/admin.js -- the super admin console's whole behaviour. ADMIN-1.
//
// No framework and no build step. It fetches five routes, renders five panels, and offers six
// actions. The session token lives in sessionStorage and nowhere else: it dies with the tab, it is
// never in a URL, and it is never written into a cookie, so nothing carries it to a route that did
// not ask for it.
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
      tr.appendChild(el("td", "mono", row.ip || "unknown"));
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
      head.appendChild(el("span", "quiet", `plan: ${client.plan}`));

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

  // ---- everything at once ----------------------------------------------------------------------

  async function loadAll() {
    banner("");
    const button = $("refresh");
    button.disabled = true;
    // Each panel loads on its own and reports its own failure into its own space, so one route
    // being down does not blank the other four. `allSettled`, deliberately.
    const results = await Promise.allSettled([loadSignIns(), loadClients(), loadBoxes(), loadSystem()]);
    button.disabled = false;
    const broken = results.filter((result) => result.status === "rejected" && String(result.reason?.message) !== "unauthorized");
    if (broken.length > 0) banner(`${broken.length} panel${broken.length === 1 ? "" : "s"} could not be loaded: ${broken.map((row) => row.reason.message).join("; ")}`);
    // The one flag a browser gate waits on, rather than a fixed sleep. It says the render finished,
    // not that everything in it succeeded, which is exactly what a gate wants to inspect.
    window.__adminLive = { panels: 5, at: new Date().toISOString() };
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
