// cp/decommission.mjs -- removing a customer, with every effect named and the one that matters proved.
//
// ONBOARD-2 item 3. Jason asked for a Remove beside Add a client, for tests and for churn, and the
// shape of it is decided by one measured fact about Coolify:
//
//   A COOLIFY 200 IS NOT A REMOVED CONTAINER. DELETE /api/v1/services/{uuid} answers 200 with
//   "Service deletion request queued" and dispatches DeleteResourceJob later. That job's remote
//   block is wrapped in a catch that logs "Remote cleanup failed, continuing with local deletion"
//   and deletes the local record anyway. So the failure that costs the most -- Coolify forgetting
//   the service while titanbot-box-<uuid> keeps running with the customer's gateway token -- answers
//   200 and looks exactly like success.
//
// Therefore nothing here trusts a status code. The removal POLLS until the container name is absent,
// asking the relay (the one process with the docker socket) and accepting GET /services/{uuid}
// answering 404 as a second proof, records WHICH of the two proved it, and if neither does inside
// the budget it STOPS, LEAVES THE TENANT ROW WHERE IT IS, and says so with the command that
// finishes the job. A tenant row with no container is a tidy lie; a container with no tenant row is
// a customer's gateway token running unattended.
//
// The nine steps, in this order, each one written to the provisioning ledger as remove:<name>:
//
//   disable-signins  every account for the slug is disabled FIRST, so nobody can sign in mid-teardown
//   addresses        every active directory address for the slug is retired. Nothing else ever will:
//                    the mail sweep only retires codes for agents missing from a roster it could
//                    READ, and it cannot read a box that no longer exists, so a removed tenant's
//                    agent<code>@myagents.email would keep routing for ever
//   proxy-key        the tenant's model key is revoked BEFORE the container goes. A box that is up
//                    and cannot reach a model is visible; a box that is gone and can is not
//   stop             POST /services/{uuid}/stop, bounded wait
//   service          DELETE /services/{uuid}, with docker_cleanup=false (see cp/provision.mjs)
//   container-gone   the step that matters. Poll until the name is absent; record which proof
//   data             only with the switch on, and only after container-gone proved absence. The
//                    relay does it: the control plane is uid 1001 and the volumes are 0700 uid 1000
//   accounts         deleteTenant, then deleteAccount for each, then releaseSlug. The order is
//                    load-bearing and the comment at that step says why
//   audit-ready      the last ledger row, and the only one that survives. The caller writes the
//                    admin_actions row
//
// WHAT THE LEDGER KEEPS. store.deleteTenant also deletes the slug's ledger rows, so the accounts
// step wipes remove:disable-signins through remove:data on its way past. That is not a bug to work
// around: the durable record of a removal is the returned `effects` list and the admin_actions row
// the caller writes, and the one ledger row left behind (remove:audit-ready) is a breadcrumb saying
// this name was removed once, which is a useful thing for the next tenant built under it to carry.
//
// THE DATA IS NOT ON A TIMER. With the switch off the card says what is true: the tree is kept and
// nothing deletes it. There is no reaper in this product, nothing counts days, and a card promising
// thirty days while nothing counts them is the product lying to the operator. ONBOARD-4 is filed.
import { boxContainerName, containerProbe, createRelayAsk, RESERVED_SLUGS, tenantDirectory, validateSlug } from "./provision.mjs";

/** The sentences an operator reads. Pinned as constants because the tests assert them word for word. */
export const REFUSALS = Object.freeze({
  not_found: (slug) => `There is no workspace called ${slug}.`,
  adopted: () =>
    "This workspace was already running when it was claimed, so this service did not build it and will not remove it."
    + " Remove it in Coolify if that is really what you want.",
  operator_slug: (slug) =>
    `${slug} is one of the product's own names, so it is not a customer and cannot be removed here.`,
  confirm_required: (slug) =>
    `To remove this workspace, type its name to confirm. It is ${slug}.`,
});

/** What the container-gone step could not prove, said as the operator's next move. */
export const STILL_RUNNING = (slug, container) =>
  `Coolify took the record and the container is still running.`
  + ` Nothing was deleted from the database and ${slug} is still a workspace.`
  + ` Finish it on the server with: docker rm -f ${container}`
  + `, then run node cp/cli.mjs tenant remove ${slug} again.`;

const KEPT = (path) =>
  `Their data is kept at ${path}. Nothing deletes it on a timer.`;

/**
 * Was this instance already running when it was claimed?
 *
 * The same shape cp/server.mjs:244 uses, and it reads the LEDGER as well as the status column for
 * the same reason: the status column moves. tenantPower writes "adopted" back over a stop, so a
 * guard that read only the column could be walked around by stopping first. This is what makes it
 * impossible to remove tenant `titanium`, whose Coolify service is the live console.
 */
const wasAdopted = (store, slug, row) =>
  row?.status === "adopted" || store.completedSteps(slug).has("adopt");

export function createDecommission({
  store,
  config,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  client,
  proxy = { configured: false },
  // POST to the relay. {ok, status, body, why}. The relay is reached over HTTP and never imported:
  // it is the only process that holds the docker socket and /data/titanbot read-write. Built from
  // this control plane's own config by default, so a caller that has one has to do nothing.
  askRelayPost = createRelayAsk({ config, fetchImpl }),
  // The mail directory, when the caller has one built. Only used to READ: retiring goes through the
  // store, because the directory has no retire and inventing one here would be a second way to do
  // the same thing.
  mailDirectory = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /**
   * Every active address this workspace's bots hold.
   *
   * Read through the caller's directory when it has one, so the count on the confirm panel is the
   * same number the operator's Mail page shows, and off the store otherwise.
   */
  const activeAddresses = (slug) => {
    if (mailDirectory != null && typeof mailDirectory.directory === "function") {
      const rows = mailDirectory.directory(slug)?.tenants?.[String(slug)]?.addresses ?? [];
      return rows.filter((row) => row.state === "active");
    }
    return store.listMailAddresses(slug).filter((row) => row.state === "active");
  };

  /**
   * What is about to happen, before anything happens, so the confirm panel can say it in the
   * operator's own terms rather than "are you sure".
   */
  function plan(slug) {
    const name = String(slug ?? "");
    const row = name.length > 0 ? store.getTenant(name) : null;
    if (row == null) return { ok: false, status: "not_found", slug: name, why: REFUSALS.not_found(name) };
    const adopted = wasAdopted(store, name, row);
    const operator = RESERVED_SLUGS.has(name);
    return {
      ok: !adopted && !operator,
      status: adopted ? "adopted" : operator ? "operator_slug" : "ready",
      slug: name,
      name: row.name ?? "",
      accounts: store.listAccountsForTenant(name).map((account) => account.email),
      addresses: activeAddresses(name).length,
      dataPath: tenantDirectory(name, config),
      container: row.boxContainer || (row.coolifyServiceUuid ? boxContainerName(row.coolifyServiceUuid) : ""),
      adopted,
      why: adopted ? REFUSALS.adopted() : operator ? REFUSALS.operator_slug(name) : "",
    };
  }

  /**
   * The removal. Nine effects in a fixed order, each recorded, and a stop rather than a lie when the
   * container cannot be shown to be gone.
   *
   * deadlineMs is the whole budget. container-gone takes at most containerDeadlineMs of it (120 s by
   * the design), because that is the one wait an operator is actually sitting through.
   */
  async function remove({
    slug: rawSlug,
    confirm = "",
    deleteData = false,
    actor = "",
    deadlineMs = 240_000,
    containerDeadlineMs = 120_000,
    stopDeadlineMs = 30_000,
    pollMs = 2_000,
  } = {}) {
    const slug = String(rawSlug ?? "");
    const effects = [];
    const startedAt = now();
    const wholeDeadline = startedAt + Math.max(0, deadlineMs);

    const record = (step, status, detail = "") => {
      store.recordStep({ slug, step: `remove:${step}`, status, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
      effects.push({ step, status, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    };

    // ---- the refusals, in order, and not one of them has an effect ------------------------------
    //
    // Nothing above this line touches Coolify, the proxy, the relay, the directory or the store. A
    // refused removal has to be indistinguishable from never having been asked, which is what lets
    // an operator type a name into the confirm box and find out they typed the wrong one.
    const row = slug.length > 0 ? store.getTenant(slug) : null;
    if (row == null) {
      return { ok: false, status: "not_found", slug, message: REFUSALS.not_found(slug), effects, containerGone: false, provedBy: "", dataDeleted: false, bytesFreed: 0, accountsRemoved: [], slugFree: false };
    }
    if (wasAdopted(store, slug, row)) {
      return { ok: false, status: "adopted", slug, message: REFUSALS.adopted(), effects, containerGone: false, provedBy: "", dataDeleted: false, bytesFreed: 0, accountsRemoved: [], slugFree: false };
    }
    if (RESERVED_SLUGS.has(slug)) {
      return { ok: false, status: "operator_slug", slug, message: REFUSALS.operator_slug(slug), effects, containerGone: false, provedBy: "", dataDeleted: false, bytesFreed: 0, accountsRemoved: [], slugFree: false };
    }
    if (String(confirm) !== slug) {
      return { ok: false, status: "confirm_required", slug, message: REFUSALS.confirm_required(slug), effects, containerGone: false, provedBy: "", dataDeleted: false, bytesFreed: 0, accountsRemoved: [], slugFree: false };
    }

    const dataPath = tenantDirectory(slug, config);
    const container = row.boxContainer || (row.coolifyServiceUuid ? boxContainerName(row.coolifyServiceUuid) : "");
    const accounts = store.listAccountsForTenant(slug);

    // ---- 1. disable-signins ---------------------------------------------------------------------
    //
    // First, and before anything else moves. A customer who signs in while their box is being torn
    // down gets a console that half works over a workspace that is half gone, and the support call
    // that follows is about the product rather than about the removal.
    const disabled = [];
    for (const account of accounts) {
      try {
        store.setAccountDisabled(account.id, true);
        disabled.push(account.email);
      } catch (error) {
        record("disable-signins", "failed", `${account.email}: ${String(error?.message ?? error)}`);
        return { ok: false, status: "disable_failed", slug, message: `Could not close ${account.email}'s sign-in, so nothing else was touched.`, effects, containerGone: false, provedBy: "", dataDeleted: false, bytesFreed: 0, accountsRemoved: [], slugFree: false };
      }
    }
    record("disable-signins", "ok", JSON.stringify({ accounts: disabled }));

    // ---- 2. addresses ---------------------------------------------------------------------------
    //
    // Before the container, on purpose. Retiring is permanent by design -- a code is never handed
    // back, so mail addressed to a removed bot can never reach a stranger -- and that is exactly
    // right here, because after the box is gone NOTHING else would ever retire these. The sweep
    // retires a code whose agent is missing from a roster it could READ; a box that does not exist
    // answers no roster, so the sweep leaves the whole workspace alone and every one of these
    // addresses keeps routing for ever.
    const retired = [];
    for (const address of activeAddresses(slug)) {
      store.retireMailAddress(address.code);
      retired.push(address.address);
    }
    record("addresses", "ok", JSON.stringify({ retired }));

    // ---- 3. proxy-key ---------------------------------------------------------------------------
    //
    // BEFORE the container, and the tests assert it by call order. A key revoked after the service
    // is gone is a key still spending for however long the delete takes, and a key revoked after a
    // FAILED delete is worse: the box is up with a credential the operator believes they took away.
    // Revoking first means the worst case is a workspace that is up and cannot reach a model, which
    // is visible, rather than one that is gone and can, which is not.
    //
    // A failed revoke does NOT stop the removal. The operator asked to remove a customer and a
    // proxy that is down must not strand that; it carries on with a sentence naming the CLI that
    // finishes it, because the alias is derivable from the slug for ever.
    let revokeNote = "";
    if (proxy?.configured) {
      const revoked = await proxy.deleteKeyByAlias(slug);
      if (revoked?.ok) record("proxy-key", "ok", JSON.stringify({ alias: revoked.alias ?? "" }));
      else {
        revokeNote = ` The key this workspace used with the models in its plan could NOT be revoked: ${revoked?.why ?? "the proxy did not say"}.`
          + ` Revoke it with node cp/cli.mjs proxy revoke ${slug}.`;
        record("proxy-key", "carried-on", String(revoked?.why ?? "the proxy did not say"));
      }
    } else {
      record("proxy-key", "skipped", "this control plane has no model proxy configured");
    }

    // ---- 4. stop --------------------------------------------------------------------------------
    const uuid = String(row.coolifyServiceUuid ?? "");
    if (uuid.length === 0) {
      record("stop", "skipped", "this workspace has no Coolify service, so there is nothing to stop");
    } else {
      try {
        const answer = await client.stopService(uuid);
        record("stop", "ok", JSON.stringify({ message: answer?.message ?? "" }));
      } catch (error) {
        // A stop that fails is not a reason to keep a customer. The delete below is what removes
        // the service, and Coolify stops a running service as part of it.
        record("stop", "carried-on", String(error?.message ?? error));
      }
      // A bounded wait, so the delete is not racing a container that is still shutting down.
      //
      // It waits for Coolify to stop calling this service RUNNING, and NOT for the container name to
      // disappear: a stopped container keeps its name (`docker ps -a` lists it), so a wait for
      // absence here would burn the whole budget every single time and prove nothing. Absence is
      // step 6's question and step 6 asks the relay, which reads the host rather than Coolify's
      // opinion of it.
      const stopBy = Math.min(wholeDeadline, now() + Math.max(0, stopDeadlineMs));
      for (;;) {
        let running = false;
        try {
          const service = await client.getService(uuid);
          running = String(service?.status ?? "").trim().toLowerCase().startsWith("running");
        } catch { running = false; }
        if (!running) break;
        if (now() + pollMs >= stopBy) break;
        await sleep(pollMs);
      }
    }

    // ---- 5. service -----------------------------------------------------------------------------
    if (uuid.length === 0) {
      record("service", "skipped", "this workspace has no Coolify service");
    } else {
      try {
        const answer = await client.deleteService(uuid);
        // Recorded as "queued" rather than "ok", because that is what the 200 means. See the header.
        record("service", "queued", JSON.stringify({ message: answer?.message ?? "" }));
      } catch (error) {
        record("service", "failed", String(error?.message ?? error));
        return {
          ok: false, status: "coolify_error", slug,
          message: `Coolify would not remove the service: ${String(error?.message ?? error)}.`
            + ` Nothing was deleted from the database and ${slug} is still a workspace.`,
          effects, containerGone: false, provedBy: "", dataDeleted: false, bytesFreed: 0, accountsRemoved: [], slugFree: false,
        };
      }
    }

    // ---- 6. container-gone, THE STEP THAT MATTERS -----------------------------------------------
    //
    // Two independent proofs, either of which is enough, and the result records which one answered:
    //
    //   docker        the relay says the container name is absent. This is the real question.
    //   coolify-404   GET /services/{uuid} answers 404, so Coolify has forgotten the service. This
    //                 is weaker -- Coolify forgets the record whether or not the remote cleanup
    //                 worked -- so it is taken only when the relay could not be asked at all.
    //
    // Neither inside the budget and the removal STOPS. The tenant row stays, the data stays, and the
    // operator gets the one command that finishes it.
    let containerGone = false;
    let provedBy = "";
    let lastWhy = "nothing answered yet";
    if (container.length === 0 && uuid.length === 0) {
      containerGone = true;
      provedBy = "nothing-to-remove";
      record("container-gone", "ok", "this workspace never had a container");
    } else {
      const goneBy = Math.min(wholeDeadline, now() + Math.max(0, containerDeadlineMs));
      for (;;) {
        const probe = await containerProbe({ askRelayPost, slug });
        if (probe.present === false) { containerGone = true; provedBy = "docker"; break; }
        lastWhy = probe.present === true
          ? `the relay still sees ${container}`
          : `the relay could not say whether ${container} is there (${probe.why})`;

        if (uuid.length > 0 && probe.present == null) {
          // The second proof, and it is ONLY taken when the first could not be had. A Coolify that
          // has forgotten the service while the container runs answers 404 here too, which is the
          // exact failure this step exists for, so a 404 is never allowed to close a step the relay
          // was able to answer with "it is still there".
          let coolify404 = false;
          try { await client.getService(uuid); }
          catch (error) { coolify404 = Number(error?.status) === 404; }
          if (coolify404) { containerGone = true; provedBy = "coolify-404"; break; }
        }

        if (now() + pollMs >= goneBy) break;
        await sleep(pollMs);
      }

      if (!containerGone) {
        record("container-gone", "failed", lastWhy);
        return {
          ok: false, status: "container_still_there", slug,
          message: `${STILL_RUNNING(slug, container || `titanbot-box-${uuid}`)} ${lastWhy}.${revokeNote}`,
          effects, containerGone: false, provedBy: "", dataDeleted: false, bytesFreed: 0, accountsRemoved: [], slugFree: false,
        };
      }
      record("container-gone", "ok", JSON.stringify({ provedBy, container }));
    }

    // ---- 7. data, only with the switch on and only after step 6 ---------------------------------
    //
    // The relay does this, and it is not a choice. MEASURED from inside titanbot-cp on the R750
    // 2026-09-10: the control plane runs as uid 1001, a box's volumes/{data,workspace,chrome} are
    // 0700 owned by uid 1000, and both ls and touch answer Permission denied. Only the relay (root,
    // /data/titanbot read-write, the docker socket) can. It resolves the path from its own tenant
    // root and is never handed one.
    let dataDeleted = false;
    let bytesFreed = 0;
    if (!deleteData) {
      record("data", "kept", KEPT(dataPath));
    } else {
      const purge = await askRelayPost("/tenant/purge", { slug });
      if (purge.ok && (purge.body?.deleted === true || purge.body?.ok === true)) {
        dataDeleted = true;
        bytesFreed = Number(purge.body?.bytesFreed ?? purge.body?.bytes ?? 0) || 0;
        record("data", "ok", JSON.stringify({ path: purge.body?.path ?? dataPath, bytesFreed }));
      } else {
        // Carried on rather than stopped. The container is already proved gone, so the customer is
        // off the air either way, and a tenant row kept alive only because a directory would not
        // delete is a row that will be forgotten about. The sentence names the path.
        record("data", "carried-on", String(purge.why ?? purge.body?.message ?? `the relay answered ${purge.status}`));
      }
    }

    // ---- 8. accounts and the slug ---------------------------------------------------------------
    //
    // THE ORDER IS LOAD-BEARING. store.deleteTenant inserts a retired_slugs row whenever an account
    // still points at the slug, and store.deleteAccount clears that retirement only when the tenant
    // row is already gone and no account is left. Tenant first, then the accounts, then releaseSlug
    // as a belt, and the name is genuinely free.
    //
    // And this resolves what reads like a contradiction in the brief: the accounts are DISABLED at
    // step 1 so nobody signs in mid-teardown, and DELETED here so the name comes back. The
    // retirement exists to stop a new company inheriting a previous customer's sign-ins; with the
    // sign-ins deleted there is nothing left to inherit.
    //
    // deleteTenant also deletes this slug's ledger rows, so remove:disable-signins through
    // remove:data go with it. The durable record from here is the effects list and the admin_actions
    // row the caller writes.
    store.deleteTenant(slug);
    const accountsRemoved = [];
    for (const account of accounts) {
      store.deleteAccount(account.id);
      accountsRemoved.push(account.email);
    }
    store.releaseSlug(slug);
    const slugFree = !store.isSlugRetired(slug) && store.getTenant(slug) == null;
    record("accounts", "ok", JSON.stringify({ removed: accountsRemoved, slugFree, ledgerWiped: true }));

    // ---- 9. audit-ready -------------------------------------------------------------------------
    //
    // The last ledger row and the only one that outlives the tenant, because the rows above went
    // with the tenant row at step 8. The caller writes the admin_actions row from what is returned.
    record("audit-ready", "ok", JSON.stringify({
      actor: String(actor ?? ""),
      provedBy,
      dataDeleted,
      bytesFreed,
      addresses: retired.length,
      accounts: accountsRemoved.length,
      tookMs: now() - startedAt,
    }));

    const dataSentence = dataDeleted
      ? `Their data is gone: ${dataPath} was deleted${bytesFreed > 0 ? ` and ${bytesFreed} bytes came back` : ""}.`
      : deleteData
        ? `Their data could NOT be deleted. ${KEPT(dataPath)}`
        : KEPT(dataPath);

    return {
      ok: true,
      status: "removed",
      slug,
      message: `${slug} is removed. The container is gone${provedBy === "docker" ? " (the relay says the name is absent)" : provedBy === "coolify-404" ? " (Coolify no longer has the service; the relay could not be asked)" : ""}.`
        + ` ${retired.length} bot address${retired.length === 1 ? "" : "es"} retired, ${accountsRemoved.length} sign-in${accountsRemoved.length === 1 ? "" : "s"} removed, and the name ${slug} is free again.`
        + ` ${dataSentence}${revokeNote}`,
      effects,
      containerGone,
      provedBy,
      dataDeleted,
      bytesFreed,
      accountsRemoved,
      addressesRetired: retired,
      slugFree,
      dataPath,
      tookMs: now() - startedAt,
    };
  }

  return { plan, remove, validateSlug, activeAddresses, mailDirectory };
}
