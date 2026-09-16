# Custody: what the box protects, from whom, and what it does not

Two conditions that get filed as bugs over and over, written down once so the next agent to find
them reads the decision instead of reporting them a third time. Both are about the same thing: the
box's shell runs as root, so most of what looks like access control in this product is a boundary
on the model's context, not custody of a secret.

Neither of these is a promise the product is failing to keep. They are the shape of the product as
built, and each names the one change that would actually alter it.

---

## 1. Read refuses what Shell reads, and that stays (TOOLS-READ-1, TOOLS-READ-2)

**Reported by Titan**, twice, from its own self-test on Jason's box:

> Read tool refuses /home/box/sand-data/ paths but Shell can read them fine. Inconsistent access
> control.

and, the day before, the same complaint about
`/home/box/agent-data/agents/<id>/profile.json`.

They are one condition, not two. `/home/box/agent-data` is a symlink to `/home/box/sand-data` and
the guard resolves realpaths before comparing, so the alias is refused for the same reason the real
path is. TOOLS-READ-1 closes with TOOLS-READ-2.

### The decision

The fence stays, on Read only, and the wording changes.

The two tools are not the same kind of thing. **Read pulls a file into the model's context**, where
it is replayed to a provider on every subsequent turn and kept in a transcript that survives the
conversation. **Shell runs a command whose output the agent already chose to ask for**, once. The
first is a context boundary worth having even when it is trivially walked around, because the cost
of getting it wrong is a credential sitting in a transcript for the rest of the workspace's life.
The second is not a boundary at all, and the reason is in the next section.

### Why no shell fence ships

The obvious symmetrical fix is to add the same path list to the shell tool. It does not survive
contact with the tree:

* **There is no shell deny list to add a line to.** The three shell executors in
  `source/host/runner/remote-box-resources.ts` are registered with no path filter and no command
  filter. The only deny list in the repo is a *network* one for the macOS sandbox.
* **The honest seam is a preflight hook that nothing passes.** It is threaded through
  `turn-agent-composition.ts`, which is a file this pass does not own and which would need a real
  design rather than a list.
* **`adminCommandDenylist` matches command text** and answers with the upstream vendor's phrasing,
  "blocked by administrator policy", which is not how this product talks to a person.
* **Every exec daemon in the box runs as uid 0.** Any filter on a path or a command string is
  walked around in one line: `base64`, `python3 -c`, a `cp` to another name, a symlink, `dd`. A
  filter that stops an honest agent and not a determined one is theatre, and theatre is worse than
  a documented asymmetry because it invites people to trust it.

So the asymmetry is real, intended, and now written down in `tests/read-fence.test.mjs` as
behaviour rather than left to be rediscovered. If somebody later adds a path filter to the shell
executors, that test fails and sends them here to change the decision on purpose.

### The real fix

**CUSTODY-1: run the agent's shell as an unprivileged uid.** Keep the connector processes and the
`sand-data` root under another one. Until that lands, the guarantee for a stored secret is "it is in
one 0600 file and in a process environment", and the agent's own shell can read both through the
file and through `/proc/<pid>/environ`. That is the condition; the Read fence never changed it.

The two files actually worth fencing are already named as a pair in
`source/host/durable-file-policy.ts` (`BOX_STORE_SECRET_FILE_NAMES`): `box-secrets.json` and
`connector-env-secrets.json`, the second of which also carries the shell secret store in its
`"shell"` section. Whoever picks up CUSTODY-1 has the list already written.

### What the refusal says now

> That path is inside this workspace's host-owned store, which holds its saved credentials, its
> agent records and its settings, so Read will not open it. Your own files are under /home/box.
> This is a boundary, not a fault: `<path>`

Three things about that wording are load-bearing.

It is true of the **whole store**. The fence is `protectedBoxPaths: [getSandRootDir()]` — the entire
`sand-data` root, which holds transcripts, skills, gate records and agent stores as well as
credentials. Wording that promised "this path holds the workspace's stored secrets" would be false
most of the times it fires, and an agent that catches the product in one false statement is right
to distrust the next one.

It **points somewhere**. An agent told only "no" retries, or files a bug. An agent told where its
own files live goes there.

It says **"a boundary, not a fault"**, in those words, because the whole cost of the old message was
an agent spending a self-test writing up a working product as broken.

### One subtree is readable (BASELINE-1, 2026-09-16)

`managed-skills/skills/` is carved out of the fence, and only that. Measured on the R750 demo box
on 2026-09-15: a bot asked a research question reached for
`/home/box/agent-data/managed-skills/skills/research/SKILL.md` one minute into its turn, was
refused here, and answered without the recipe, scoring 2 of 8 on the acceptance gate and opening
on the universal negative that recipe exists to forbid. Every managed seed was in that state: the
`<available_skills>` catalog hands the model exactly those paths (KB-1f) and the standing persona
tells it to open the handbook index at one (KB-1), so eleven skills were named to the model and
none of them could be opened.

The carve-out is safe in the terms this fence is written in. This is a **context** boundary, and a
seed skill exists to enter the model's context; that subtree holds no credential, and the host
writes it from the bundle rather than from anything a customer typed. It is the materialized
`SKILL.md` files alone: `managed-skills/cache.json` sits one directory up and stays fenced, and so
does everything else under the root. `tests/read-fence.test.mjs` pins both halves, including the
`agent-data` spelling, which is the one the catalog actually hands over.

The carve-out is decided on the **realpath**, not on the spelling, and that is what keeps it a
carve-out rather than a hole. The agent's shell runs as uid 0 in the box, so it can plant a link
inside that subtree; resolving first means such a link is refused by where it points rather than
allowed by where it sits.

---

## 2. Where the GitHub credential lives, and what wiped it (GH-1)

**Reported by Titan** on Jason's box, 2026-09-08 into 2026-09-09: the GitHub CLI's credentials were
gone twice, on 6 September and again on 8 September, each time ending in "gh auth re-login whenever
you're ready". Browser logins in the box survived both times. The gh credential did not.

### What gh actually reads

Measured in the box with gh 2.46.0, 2026-09-09:

| Source | Precedence | Verdict gh prints |
| --- | --- | --- |
| `GH_TOKEN` | first | `Failed to log in to github.com using token (GH_TOKEN)` — it names the source |
| `GITHUB_TOKEN` | second | `using token (GITHUB_TOKEN)` |
| `~/.config/gh/hosts.yml` | last | `Logged in to github.com account ...` |
| nothing | — | `You are not logged into any GitHub hosts` |

An **empty** value falls through to the next source rather than failing, which matters: a deleted
shell secret reads as empty until the next restart, and that must not lock gh out of a file
credential it still has.

The consequence worth stating plainly: **once a token is set, `gh auth login` inside a box is
decorative.** The environment wins. Anyone debugging "I logged in and it still uses the wrong
account" is looking at precedence, not at a broken login.

### What was already true, and was not the cause

Three premises in the original row were wrong, and measuring them is what made the fix small:

* `~/.config/gh` is **already** the first entry in the image's `persist-cli-auth`
  `CLI_AUTH_TARGETS`, mirrored to `/home/box/cli-config` every 30 seconds, and that mirror is a box
  store category of its own, so it comes back on a container recreate.
* The shell secret store's name rule **already** allows `GITHUB_TOKEN`, and the store is re-pushed
  into the primary daemon and every window daemon on every bring-up.
* **A host bundle swap never touches a home at all.** The supervisor writes under
  `/home/box/sand-host` and `/usr/local/bin` and nowhere else. Swaps were never the mechanism.

So nothing was added to any persistence list and no new export path was written. What shipped is
proof plus a corrected row.

### What did wipe it

Container recreates, not swaps. `SAND_BOX_STORE_COPY_IN` was set nowhere, so a Coolify restart
recreated the container and the home came back from the image; that is where Titan lost gh and the
Bitwarden login at the 03:20 ship on 2026-09-06. Copy-in is on now and ships go through
`updateHostNow` rather than a Coolify restart, which is why this row is a proof rather than a fix.

`persist-cli-auth` also **prunes**, which is the second mechanism and the one still live: when the
live `~/.config/gh` has no content it deletes the mirror and the signature file too, logging
`save: pruned <home>:.config/gh (no live creds)`. The one copy that could restore the credential is
cleared by the same sweep meant to protect it, so anything that empties the live directory once — a
recreate that beats the copy-in, a partial login, a cleanup — is permanent thirty seconds later.

### The part that is easy to get backwards

**Neither path survives everything, and they fail on opposite events.**

| | host bundle swap | container recreate |
| --- | --- | --- |
| stored `GITHUB_TOKEN` (shell secret store) | survives | **lost, by design** |
| `~/.config/gh` (file, via the mirror) | survives | survives, unless the prune already ran |

The shell secret store is not a file of its own. It is the `"shell"` section of
`connector-env-secrets.json` (`shell-secrets.ts`), and that file is one of the two named in
`BOX_STORE_SECRET_FILE_NAMES` — deliberately **excluded** from the box store, because a store copy
is content-addressed, mode 0644, and readable by any agent shell in the box as root. That exclusion
was bought with a real incident: on 2026-09-08 an operator's provider key was proved removed from
`box-secrets.json` in all three customer boxes while a byte-identical copy still sat in each box's
own blob store (PROXY-1 / SECRET-3).

So the honest statement is not "the store is the primary path". It is: **a stored token is the
durable path across a swap and the file is the durable path across a recreate**, and after any
container recreate the token has to be pushed in again by whatever owns it. That is a gap, it is
named here rather than papered over, and it is worth its own row: the control plane provisions a
box's secrets at create time and nothing re-pushes an operator's own shell secrets after a recreate.

### The proof

`scripts/verify-host-upgrade.mjs` carries it, on a real `updateHostNow`:

1. `GITHUB_TOKEN` is read before the swap, and set only if the box holds none — a gate never
   overwrites or deletes an operator's own stored credential.
2. It is probed **through an agent that has a window**, not the primary daemon. ENV-1 and GATE-11:
   an agent with a desktop runs every command through that window's own exec daemon with its own
   environment, and a probe of the primary once answered "set" for a variable a real agent read zero
   characters from.
3. `gh auth status` is reduced to a verdict shape and compared across the swap.
4. `/root/.config/gh`, `/home/box/.config/gh` and the mirror `/home/box/cli-config/.config/gh` are
   signed by content hash and compared across the swap.

On a box with no gh login of its own, step 3 compares `no-credential` on both sides. That is a real
assertion — the swap invented nothing and destroyed nothing — but it is not the same assertion as
step 2, and the gate says which one it made rather than letting a green line stand for both.

### What is still an operator action

Jason's box holds no gh credential and no GitHub token anywhere, and nothing in this product can
invent one. The token is a paste, once, into the shell secret store under the name `GITHUB_TOKEN`.
After that it reaches every agent shell in the box, including the window daemons, and it survives
host swaps by the path proved above — but it has to be pasted again after a container recreate,
for the reason in the table.
