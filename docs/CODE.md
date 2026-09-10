# Coding tasks — Titanium Bot (CODE-1)

A bot can hand a piece of work to a throwaway computer: "write the script and its test, run the
test". The computer is a container with a coding agent in it, one directory, a wall clock and **no way
out to the internet**. It writes its files where the bot can already read them and it is gone when the
task ends.

Nothing on a person's screen names a tool, a container, or a vendor. The bot says *"Started a coding
task"* and later *"Coding task finished"*, and the only nouns an owner meets are *this computer* and
*a cloud computer*.

> **Measured numbers name their machine.** Anything below written as *planned* has not been measured
> yet and says so. The two are kept apart on purpose.

---

## 1. What a task is

| | |
|---|---|
| **One task** | one container, one network, one directory, one model credential, one row on the operator's ledger |
| **Where the files go** | `/workspace/code/<taskId>` inside the bot's own box — the same directory the sandbox writes into, so **there is no copy-back at all** |
| **How long** | 30 minutes of wall clock, enforced off the container's own deadline label by the sweep. The sweep runs once a minute, so the real ceiling is **the limit plus up to a minute**; a task killed for time is billed **to its limit** and not to the moment the sweep noticed |
| **How much** | a hard spending cap per task, enforced by the model credential itself — and it only bites on a **priced** model. On an unpriced deployment every turn books nothing, the budget is never reached and the clock is the only limit there is (**CODE-13**) |
| **How many** | 2 running at once and 20 a day per workspace |
| **How big** | 2 CPUs, 2 GB of memory, 512 processes |
| **Internet** | **none.** Not narrowed, not filtered: absent. So no `git clone`, no `npm install`, no `pip install` |
| **Who may start one** | every bot in a workspace, not only Titan |

The task directory is the bot's own directory. The relay binds the host side of what the box already
mounts as `/workspace`, so the sandbox writes straight where the bot reads with the tools it already
has. A symlink the sandbox writes can only ever dereference inside its own mount namespace, so binding
once and never copying is both safer than a copy and one fewer moving part.

## 2. Why the relay owns it

The relay is the only process on the machine holding `/var/run/docker.sock`. It mounts `/data/titanbot`
at the identical path the host uses and it already drives docker through the CLI in its own image, so
it needed nothing added. The box holds nothing but the gateway bearer it already has, which the
registry maps to a workspace — the same credential and the same comparison `POST /mail/send` takes. No
new secret is minted anywhere for this.

A box with no relay in front of it resolves nothing, and then **the tool withholds itself** rather than
offering a control that cannot work.

## 3. The wire

Box-facing, on the relay, bearer = the box's own gateway token, registered before the console login
beside `/mail/send`, rate limited on a hash of the bearer:

```
POST /code/start   {agentId,title,instructions,files?,provider?}
                -> {started:true,taskId,provider,deadlineAt,capUsd}
                 | {started:false,message,error}
                 | 409 {error:"not_available",detail}
                 | 429 {message}
POST /code/status  {agentId,taskId} -> {found,state,startedAt,endedAt,elapsedS,provider,lines[],message}
POST /code/stop    {agentId,taskId} -> {stopped,message}
POST /code/result  {agentId,taskId} -> {ready,summary,files:[{path,bytes}],path,message}
POST /code/list    {agentId}        -> {tasks:[{taskId,title,state,startedAt,endedAt,provider}]}
```

`state` is one of `running`, `done`, `failed`, `timed_out`, `stopped`, `spend_cap`.

Console-facing, behind the session, scoped to the session's own tenant:

```
GET  /code/tasks        -> {tasks:[{taskId,title,state,provider,startedAt,endedAt,elapsedS,where,
                                    path,lines[],files:[{path,bytes}]}], available, message}
POST /code/tasks/stop   {taskId} -> {stopped,message}
GET  /code/settings     -> {minutes,capUsd,concurrent,where,internet}
```

These read the **same rows** the box routes read, so the strip in the Computer card and the bot can
never disagree about what is running. No new gateway command, so none of the void-RPC class of failure.

`lines` and `files` are carried only for the rows the strip actually draws (the first four): a log read
and a directory listing apiece is a fixed cost for four and an unbounded one for twenty. A **running**
local task's lines come from the container's own stream; a **finished** one's come from `agent.log`
beside its artifacts, because the stream goes with the container. `available` is false on an
installation with no container engine in front of the relay, and `message` is then the sentence the
strip draws — the same sentence `/code/start` refuses with.

Relay to control plane, `CP_RELAY_TOKEN`:

```
POST /v1/relay/code/task/open  {slug,agentId,taskId,provider}
                -> {ok,id,key,alias,model,capUsd,minutesCap,e2bKey?} | 429 {message}
POST /v1/relay/code/task/close {id,outcome,minutes,detail}
```

Operator read, `requireAdmin`, at `/v1/code` and **not** under `/v1/admin/*`: `GET /v1/code/tasks`,
`POST /v1/code/settings`.

Labels on every container: `com.titanbot.role=code-sandbox`, `.tenant`, `.task`, `.agent`,
`.deadline` (epoch ms), `.image`.

### `files?` and the one parameter that is not there

`files` names paths in the bot's **own** box and they are copied in, at most 20 of them. A path is
refused unless it resolves under `/home/box` or `/workspace`, and `/home/box/sand-data` is refused
outright because that is where the host keeps its stores, its settings and its secrets. Two files
sharing a basename are numbered rather than overwriting each other.

**There is no `repo` parameter in this release.** A task has no egress, so a clone cannot run. A
parameter that always refuses teaches the model a capability it does not have, and silence teaches it
the clone happened, so a supplied `repo` is refused **by name** with a sentence saying to copy the
files in instead. Fetching a repo is **CODE-2**.

## 4. Isolation, and what was measured

### One network per task, and that is not optional

Each task gets `docker network create --internal --subnet 10.97.<n>.0/24 tbcode-<taskId>`, where
`<n>` is the **lowest free** `/24` discovered by listing docker's own networks. Never a counter in the
relay's memory: the relay is restarted as the **last** step of every ship, so a counter hands out a
subnet again while the network of that name is still there.

The live proxy is attached with `docker network connect --alias titanbot-proxy`, found by the label
`com.titanbot.role=proxy` and **never by name** (Coolify regenerates container names). The alias is
required: aliases are not copied from another network.

Per task rather than shared, because on a shared internal network a task reached a peer container by
name, and turning ICC off to stop that killed the proxy too.

**Measured on this Mac** (MacBook-Pro.local, darwin/arm64, Docker Desktop 29.5.3, cgroup 2 cgroupfs),
`node scripts/verify-code-sandbox-isolation.mjs`, 4 s of a 600 s ceiling, every leg from **inside** a
real sandbox:

| Leg | Reading |
|---|---|
| the proxy | `status=200` with the stub's own body, by the alias `titanbot-proxy` |
| `1.1.1.1:443`, `8.8.8.8:53` | `errno=101 ENETUNREACH` — the kernel has no route at all |
| `api.anthropic.com`, `registry.npmjs.org`, `example.com` | `UNRESOLVED gaierror` — no name resolves |
| the proxy's own `5432` | `errno=111 ECONNREFUSED` |
| a neighbour container on another bridge | `errno=101 ENETUNREACH` |
| network create and attach | 19–31 ms; teardown removed container and network cleanly |
| the limits, read off the container | `NanoCpus=2000000000`, `Memory=2147483648` with `MemorySwap` equal, `PidsLimit=512`, `CapDrop=ALL`, `no-new-privileges`, `uid 1000` |

A **timeout is never accepted as proof** that something is shut. A firewall in front of a reachable
network looks exactly like a timeout, so only a kernel error or an unresolved name counts.

### `--internal` does not close the host, so one static rule does

`--internal` is a real boundary outward and it leaves **the bridge gateway on-link**. Measured from
inside the sandbox on this Mac: the host's 22, 445, 2049, 5000, 8000, 11434 and 5432 each answered
`errno=111 ECONNREFUSED` on the gateway `10.97.0.1` — refused, not unreachable. On the R750 the host
really does listen on 22, 2049, 445, 11434, 5000, 8000, 47291, 80 and 443, and `box-isolation.sh`'s
existing box-scoped drop cannot help: it is built from the addresses of containers labelled
`com.titanbot.role=box`, and a sandbox is not a box.

So `deploy/r750/box-isolation.sh` carries **one static rule**, first in the guarded chain of the
prerouting hook it already has:

```
ip saddr 10.97.0.0/16 counter drop
```

One rule for every task forever, because the pool is fixed and the rule is written on the pool rather
than on a container. Nothing for the relay to write and nothing for it to clean up, already in place
before the first task of a ship exists, re-applied by the 60 s timer that already runs, and it holds
even if a sandbox ever lands on a non-internal bridge by mistake.

It **drops in shadow mode too**, which is the one place that table's own rule is deliberately set
aside. Shadow exists to accumulate evidence before taking away something that might be in use; nothing
has ever used this pool, so there is no evidence to gather and nothing to break.

**The R750 leg is what proves that rule, and the local provider is not done without it.** Planned, at
ship: the same script once against a live sandbox on the R750, where 2049, 445, 11434, 5000, 22 and
8000 must read shut rather than refused.

### Hard refusals in the create path

Never `titanbot-net` — checked against the **resolved network id** and not the name, because the whole
point of the check is that something above handed us a network that is not ours. Never `--network
host`. Never the socket. Exactly one mount. Nothing from `/home/sem`.

## 5. Custody: where the model credential lives

**MARKET-17** is the measured story of a key sitting in the argument list of three root processes on
three live boxes, readable by any agent's own shell, and `docker inspect` prints `-e` values to anyone
who asks. So:

1. `docker create` with **non-secret env only** — `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`,
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CODE_MAX_TURNS`.
2. The key is written **into the container** by piping a tar on stdin to
   `docker cp - <container>:/run/code`. Nothing is written to the host filesystem.
3. `docker start`.
4. The entrypoint sources `/run/code/env` and **truncates it in the same breath**, then runs the agent
   with stdin from `/dev/null`.

`/run/code` is mode `0711`, which is the weakest permission that still works: **measured on this
Mac**, a task could not `ls /run/code` (`Permission denied`) and could read `/run/code/env` by exact
name. `docker inspect`, `Config.Env` and every label were free of the key in the same run, and the
delivery leg that worked was **stdin-tar**.

The named fallback, for a daemon that will not take a tar on stdin: a `0600` file owned by the run uid
**outside** `volumes/`, bind-mounted read only, deleted by the end path and by the sweep. Outside
`volumes/` is the load-bearing part — a credential under the workspace mount is one the box can open,
and the box must never hold this key. With no fallback directory configured, a daemon that refuses
stdin is a plain refusal rather than a key written somewhere readable.

The key is revoked at the end of every task, by the sweep when a deadline passes, and by a control
plane sweep of orphan aliases.

### The run uid is read, never guessed

The tenant root is uid 1001 while `volumes/workspace` is uid 1000, so the uid is read once per task
from `docker exec <box> id -u`, defaulting to 1000. A root-owned artifact in the bot's `/workspace` is
a file it can never open, which reads to a person as the task having produced nothing.

## 6. The model path

The agent is **Claude Code**, pinned to an exact version in the image. Codex is ruled out: its
`chat/completions` support was removed in February 2026, a custom provider must declare the Responses
wire, and the proxy's `/v1/responses` is a pass-through.

The wave adds **one hidden deployment**, `plan-zai-code`, declared `hosted_vllm/glm-5.3` against
`plan-zai`'s own api_base, credential slot and per-token prices, created through the proxy's
`/model/new` by a CLI verb. No restart, no config edit, `plan-zai` untouched, and with no
`tb_customer_visible` key it can never appear in a customer's Settings.

**The `hosted_vllm` prefix is a LiteLLM routing choice made for its translation behaviour, not a claim
about the upstream.** Measured: LiteLLM v1.100.0 registers `/v1/messages`, but on an `openai/`
deployment it drives the vendor's `/responses` endpoint; declared `hosted_vllm/<model>` against the
same api_base and key it bridges to upstream `chat/completions` and the whole Anthropic surface comes
back correct — text, system, tools, `tool_use` and `tool_result` round trip, the full SSE sequence,
`count_tokens` — and Claude Code 2.1.267 completed a headless turn through it on a per-task virtual
key. **Tidying the prefix to `openai/` silently turns every coding task into an HTTP 200 carrying an
error body.** There is a test asserting it. That is **CODE-7**.

The deployment carries its **own** `litellm_params.timeout` (600) and `stream_timeout`, because the
global `request_timeout` is 60 and nobody may restart the proxy to change it. A coding turn longer
than a minute would otherwise die as a provider error.

### The per-task key

- `models` is `[plan-zai-code]` and nothing else.
- `allowed_routes` is the tenant list **plus** `/v1/messages` and `/v1/messages/count_tokens`, on the
  **task key only**. Adding those to the tenant list would hand every box on the bridge an Anthropic
  door. `/v1/messages` is absent from the tenant routes, so a key minted the ordinary way answers 403,
  which a model narrates to a person as the model refusing.
- The alias is `titanbot-<slug>-code-<taskId>`, so a revoke can never take the tenant's own
  `titanbot-<slug>` key with it.
- `max_budget` **always** and never `soft_budget`, regardless of the enforcement setting: a cap that
  never fails a request is not a stop.

## 7. The image

`deploy/r750/code-sandbox/`, built **on the host** by `install.sh` and never by the relay, whose CLI
has no buildx and whose legacy builder a modern daemon refuses. The relay only ever *runs* it.

- `node:22-bookworm-slim`, **pinned by digest**.
- `ca-certificates git ripgrep python3 python3-venv curl jq less procps`.
- `@anthropic-ai/claude-code` pinned to an exact version.
- uid 1000, `/run/code` mode `0711`, workdir `/task`.
- **No keys, and the gate asserts it**: the image's own environment holds nothing matching a
  credential.

**Measured on this Mac** (MacBook-Pro.local, darwin/arm64, Docker Desktop 29.5.3): **877 MB on disk /
231 MB content**, **14 s with a warm layer cache and 17 s with `--no-cache`** — both with the pinned
base already local, so neither number includes pulling it. `claude --version` 2.1.267, Python 3.11.2
and ripgrep 13.0.0 all answered from inside it. `install.sh` starts nothing and restarts nothing, so it
is safe to run on a live machine at any time.

The R750's own build time and size are **planned**, measured at ship. An arm64 Mac and an x86 server do
not produce the same image, so this Mac's size is this Mac's.

## 8. Metering

**Two routes and not one**, the mail shape: the relay claims the task at the control plane **before
the container exists** and closes it with the outcome. An unstarted task is recoverable; an unbilled
container-hour is not.

The row is tenant, agent, task, provider, model, key alias, started, ended, minutes, spend, outcome,
detail. It carries **no title and no instructions** — the same rule `mail_send_log` holds about
subjects. The customer's own words stay in the workspace's own tasks file on the relay, which only
that workspace's console reads.

Model spend is read from `GET /key/info` on the per-task key, which was immediate and correct in
measurement. Deliberately **not** from `/spend/logs`, which is batch-written every 10 s and produced
zero rows for priced `/v1/messages` calls over three minutes of polling (**CODE-11**).

The admin Spend panel gets one additive quiet line inside the existing Client cell — no seventh
column — and **anything not measured says so rather than drawing a zero**, which is that panel's own
written rule.

## 9. Absence and refusal

A customer's own instance is rendered without the docker socket, so there is no local computer to run
a task on. That answers **409** with the sentence from `ui/docker-edge.mjs`:

> This instance cannot run a coding task on its own computer yet.

…and the answer **offers a cloud computer** rather than leaving a dead control. A dead control is a
support ticket; an honestly absent feature is not. That is **CODE-5**.

Every other stopping point is a plain sentence the bot can repeat, never a throw and never a silent
half-success: a missing image, a proxy not found by label, an exhausted subnet pool, a control plane
that will not answer the claim, a cap already reached.

## 10. The cloud provider, off by default

Same task shape, run on E2B from the `zai-claude` template. `template.py` is one line —
`from_template("claude")` — and everything that makes it a Z.AI sandbox is passed per create, so
nothing needs reproducing.

The key is a **write-only control plane setting** the operator pastes, handed to the relay only inside
an open response, never persisted relay-side and never read from any file. The relay carries no npm
dependencies, so the driver is plain `fetch`, unit tested against a stub, with `allowInternetAccess`
narrowed and the sandbox's own timeout set so it dies on its own if nothing stops it.

**The structural limit, said out loud rather than shown as a zero:** an E2B microVM cannot reach
`titanbot-proxy`, so an E2B task is metered as **minutes plus E2B's own bill, with model spend
unattributed**. That is why local is the default, and why a public ingress for the proxy is a question
for the operator rather than a design detail somebody settles in a driver.

**The live leg is CODE-3 and is not measured in this wave.** The driver is unit tested against a stub
and nothing more. Jason's own box's E2B timings — 15 s for the stock template, 37 s stock and 13 s on
the custom one — are **E2B's cloud** and are not comparable to local Docker numbers.

## 11. What bites

Every one of these cost somebody an afternoon, or would have.

| | |
|---|---|
| **`cache_control` is dropped** | LiteLLM drops it on the way to `chat/completions`, so a coding task **re-bills its whole context every turn**. The default cap is sized for uncached pricing. **CODE-6** |
| **LiteLLM wraps upstream errors** | which breaks Claude Code's documented retry-and-downgrade path, so a dead task must be turned into a plain sentence rather than left to recover itself. **CODE-8** |
| **The 300 s silent-stream watchdog** | a turn that streams nothing for five minutes is cut. The per-deployment `stream_timeout` is what keeps a long thinking turn alive |
| **`[claude-code:unrecognized_model]`** | is what the agent **always** prints on stderr against a proxy whose model name is not in its own table. The turn completes. It is dropped from the log the relay shows, because a model handed that line narrates it to a person as a broken model |
| **A `--max-turns` exit is not a failure** | it means the agent stopped because it was told how many turns it may take. The summary says what is unfinished |
| **`docker cp` into a tmpfs** | **measured on this Mac:** a `docker cp` into a path covered by `--tmpfs /tmp` writes into the image layer *underneath* the tmpfs, so the running process sees nothing. The credential goes to `/run/code`, which is an image-layer directory and not a tmpfs, and the gate's own probes go in on **stdin** for this reason |
| **`docker ps --filter name=x` is a substring match** | so filtering on a sandbox's name also matches `<name>-proxy`, and a removal check then passes or fails for the wrong reason. Exact-name comparison only |
| **A repeat `network connect` exits 1** | so the inspect comes first and `endpoint with name … already exists` is read as success |
| **Aliases are not copied between networks** | so `--alias titanbot-proxy` is passed on every connect, or the sandbox can only reach the proxy by whatever name Coolify gave the container |
| **E2B model spend is unattributed** | see §10. Not a zero on a panel |
| **The 28th tool schema** | on a mail-enabled tenant box this is schema 28. Above Ollama's measured six-tool shim ceiling and below the 26 that vLLM Nemotron and GLM both passed, so small local endpoints are a known risk rather than a discovery. **CODE-10** |
| **`/spend/logs` batching** | see §8. **CODE-11** |
| **A box's own `id -u` is 0** | **measured on the R750 2026-09-10:** the boxes there run as root, so `id -u` answers `0`. A `uid > 0` guard read that as "no answer" and fell back to 1000 while the task directory was made root-owned, and the agent inside failed on its very first write: `cannot create /task/SUMMARY.md: Permission denied`. Zero is an answer. The directory owner and `--user` now come from that one number, so they cannot disagree |
| **A container is not an endpoint before it starts** | so a sweep tick landing between `docker create` and `docker start` saw no sandbox on the task network and removed it. A live task keeps its network; `finish` → `teardown` is what removes it |
| **Nothing else closes a task that dies early** | the deadline is half an hour away, the relay still holds it live so it is no orphan, and `/code/list` — which is what the bot's watcher polls — reads the rows as they stand. **Measured on the R750 2026-09-10:** the Coding strip read "running, 9m 38s" ten minutes after the container had exited 2, and the bot was never told anything. The sweep settles a live task whose container has stopped, which is §12's job |
| **The close waits on a spend the proxy has not booked** | the control plane reads the task's spend off the per-task key before it answers, and the proxy books it about fifteen seconds late, so that read waits twenty. **Measured on the R750 2026-09-10** with a 10 s deadline on this side: `could not close task row 2: The operation was aborted due to timeout` for a close that was working, which leaves a container's minutes unbilled. Forty-five seconds, and a timeout is asked again once — safe because the other side writes `ended_at` before the wait and answers `already:true` |
| **Minutes are the container's, not the waiting's** | **measured on the R750 2026-09-10:** a container that exited after about a second went onto the operator's ledger as **16.78 minutes**, because the clock ran until the sweep noticed. `State.FinishedAt` is the end of a task |
| **A root box cannot run the agent, and a non-root one cannot own the directory** | the two constraints look symmetrical and are not. **Measured on the R750 2026-09-10, in both directions:** with `--user 1000` on a root-owned directory the agent failed on its first write; with `--user 0` it failed with `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`. The artifacts only need to be READABLE by the box, and a root box reads anything, so a root box maps to the image's own `USER 1000:1000` and a non-root box keeps its uid |
| **A pipe and a redirect cannot both feed one stdin** | the entrypoint piped the prompt into the agent and then wrote `< /dev/null` after the pipe, so the redirect won. **Measured on the R750 2026-09-10:** every task died with `Error: Input must be provided either through stdin or as a prompt argument when using --print`, and the test guarding it asserted the redirect was PRESENT — it pinned the bug. Once the agent has read its prompt, stdin is at EOF, which is all a child process needed anyway |
| **Coolify's docker cleanup prunes the sandbox image** | the image is built by a script, and the script was called by no deploy step. **Measured on the R750 2026-09-10:** `docker image inspect titanbot/code-sandbox:1` answered *No such image* twenty minutes after a real task had run on it, because this host's Coolify row carries `force_docker_cleanup` with a nightly schedule and its image prune spares only the repos Coolify itself deploys. Every task on the machine was then refused with "The coding computer has not been built on this machine yet", and the only cure was a person running the build by hand. Two lines fixed it: `deploy/r750/install.sh` builds the image on every ship, and the build leaves **one never-started keeper container**, because `docker image prune -a` skips any image a container references. The relay's sweep also says in its own log when the image is absent, so the next surprise is visible before a customer finds it |
| **The tenant route list is egress** | the per-task key's `allowed_routes` was the tenant list plus the two Anthropic routes, and the tenant list carries the proxy's web fetch and search pass-throughs and the `/mcp` mount. **Measured inside a live sandbox on the R750 2026-09-10:** the proxy enumerated those paths as allowed on a task key, and a POST to the fetch one was **not refused** — it was relayed upstream and came back with that service's own request id. The only thing between the sandbox and arbitrary web fetches was an operator step nobody had finished. The list is now a literal of six model routes, the tenant list is deliberately not reused, and a test asserts no route containing `tinyfish` or `mcp` is ever on a task key |
| **A task whose container vanishes is in no leg of a docker-driven sweep** | not the deadline branch, not the orphan branch, not the settle. **Measured on the R750 2026-09-10:** a container removed eight seconds after its task started left the row reading `running, endedAt:0` three sweeps later — each logging "removed 0 code container(s)" — its network still on the machine, and one of the workspace's two slots gone for good, because `adopt` re-adds a running row as live on every restart so it never ages out. Closing it by hand billed **3.13 minutes for a container that lived 8 seconds**. The settle leg is driven by the **rows** now, one `inspect` apiece, and a vanished task is closed as failed with *the machine it was running on is gone*, billed to the last moment the sweep saw the container alive |
| **The agent prints almost nothing while it works** | so the log half of the strip is usually empty even now that it can render. **Measured on the R750 2026-09-10**, on four real tasks: `agent.log` came to **80 bytes** on a task that wrote six files and passed its own test, and the 80 bytes are the one `[claude-code:unrecognized_model]` line the relay drops on purpose. `claude -p --output-format json` writes one object at the end and keeps stderr for errors, so there is no progress stream to show. What the strip really carries is the title, the state, where it ran, the clock and the file list; the substance is `SUMMARY.md` and `agent.json`. The fix is a streaming output format, which changes what the transcript artifact is and where the exit code comes from -- the part of the entrypoint that has already produced three live defects -- so it is **CODE-18** and not a line in this pass |
| **`docker logs` is empty when the entrypoint redirects** | the agent's streams went into files in the task directory, so the container's own streams were empty: **measured on the R750 2026-09-10**, `docker logs` on a live mid-turn container printed nothing at all and every status answer carried `lines:[]`. The log strip being enough is the stated reason no terminal was built, so the entrypoint follows the log file onto its own stderr as well, and the console route sends the lines it draws |
| **A close that tells the control plane first is a close that happens twice** | the row stayed `running` for the twenty seconds the spend read waits, so any status, result or sweep in that window settled the same task again. **Measured twice on the R750 2026-09-10:** two byte-identical `done` rows per task id in the workspace ledger, and a first status answering `state:"done"` beside `endedAt:0, elapsedS:0`. The closed row is written **first**, a second caller waits on the first close instead of making its own, and status reports the stop time the settle decided rather than the row it read before it |
| **The spending cap had no producer** | `spend_cap` was in the state set, in the wire vocabulary, in the strip's words and in the refusal sentence, and **nothing ever wrote it**: a key over its budget produces a plain non-zero exit, so the money was reported as "did not finish". The close now writes `spend_cap` when the spend it read reaches the cap or when the proxy's budget refusal is in the agent's log — and on an unpriced deployment neither can happen, which is why `code cap` says the clock is the only limit there rather than claiming a runaway task is stopped |
| **The operator's own selftest was on the customer's line** | `code selftest` leaves a real ledger row, which is the point of it. **Measured on the R750 2026-09-10:** `code spend` read "demo 8 task(s)" and one of the eight was `cp-selftest`, on the same rollup the admin Spend panel draws — the number Jason bills from. The rollup excludes `outcome='selftest'`; the detail listings still show it, because there it is the truth about what ran |
| **The deployment can be unpriced** | **measured on the R750 2026-09-10:** `plan-zai` there carries no per-token prices, so `plan-zai-code` is created unpriced, every dollar figure reads *not measured*, and `max_budget` counts a spend that is never booked — **the $2 cap cannot bite until that plan model is priced**. `code deployment ensure` says `NOT PRICED` in those words when it happens. **CODE-13** |

## 12. The sweep, which is the only real wall clock

One pass at relay start and one every 60 s, mounted exactly where the mail sweep is and never awaited
into `listen`. It lists **by label only** and never by name shape: the local Mac's box carries no role
label at all, and a container somebody else named `tbcode-something` is not ours to touch.

It force-removes anything past its own deadline label or orphaned, **closes its claim first** (a
container removed with its row left open is an hour nobody is billed for and a bot waiting on a task
that will never answer), removes every task network with nothing of ours in it, disconnects the proxy
from it, and never touches `titanbot-net` or the proxy's own Coolify network.

**It is driven by the rows as well as by docker**, which is the half that was missing. Everything
above walks the containers docker returns, so a task whose container has been **removed** is in none of
it; the settle leg walks what this relay believes is live instead, one `inspect` apiece, and closes
both cases — a container that has stopped, and a container that is not there any more. It stamps the
moment it last saw each live container, which is what a vanished task is billed to, and it decides the
networks twice so a network whose task it has just closed goes in the same pass rather than a minute
later. It also says once, in the relay's own log, whether the sandbox image is on the machine.

**A task killed for time is billed to its limit.** The sweep is the only enforcement and it runs once a
minute, so the kill lands up to a minute late: measured on the R750 2026-09-10, a one minute task was
swept 58 s past its deadline and the operator's row read 1.96 minutes against a one minute cap. The
overshoot is the product's and not the customer's, so the clock stops at the deadline the task was
given — or at the container's own `FinishedAt` when that is earlier.

Before the first sweep the relay reads every workspace's rows and adopts what they say is running.
Without that a restart during a 30 minute task kills the task, which is a worse failure than the one
the sweep exists to fix.

**Measured on this Mac:** the gate stood up a real task, then ran the relay's own sweep with an empty
live map — precisely the state a restarted relay is in. It found the orphan, closed its row as
`failed` with `minutes=1.5`, removed the container, removed the network, and **left the proxy
running**, detached rather than removed, because the real proxy is shared by every tenant and must
outlive every task.

On a machine that has never run a coding task the first line says it removed zero containers and zero
networks, which is how an operator tells *the sweep is running* from *the sweep is absent*.

## 13. Rollback

Nothing here is a migration, so each piece reverts on its own:

- the tool withholds itself when the relay does not answer, and can be switched off by setting the
  workspace provider;
- the relay's routes answer a plain refusal;
- the `plan-zai-code` deployment is deleted by one CLI verb without touching `plan-zai`;
- the `box-isolation.sh` block is one guarded block that reverts and re-applies on the timer;
- the image is a tag nothing else references, built by `deploy/code-sandbox/install.sh` — which
  `deploy/r750/install.sh` now calls on every ship, so a ship always restores it, and which leaves one
  never-started `titanbot-code-image-keeper` container so this host's nightly docker cleanup cannot
  prune it. Both revert by removing the tag and that container;
- the ledger table is additive and read by one panel block.

No box is recreated and the relay is only restarted, never redeployed.

## 14. Not built, on purpose

E2B's self-hosted cluster; GPU sandboxes; snapshots and forks; an interactive terminal in the console
(the log strip is enough); any egress inside a task; any repo clone.

## 14b. What the R750 measured, 2026-09-10

Separated from everything above on purpose: these are numbers off `jason-PowerEdge-R750` (x86_64,
cgroup v2 systemd), not off the Mac the image was first built on, and not plans.

| | |
|---|---|
| the image | `titanbot/code-sandbox:1`, **588 MB**, built in **26 s**, base `node:22-bookworm-slim@sha256:83f487e0…`, agent 2.1.267. Nothing started, nothing restarted. The Mac's own arm64 build of the same Dockerfile was 877 MB on disk / 231 MB content in 14 s — a different architecture, so the two are not comparable and neither is "the" size |
| the model wire | `plan-zai-code` created as `hosted_vllm/glm-5.3` against `plan-zai`'s own api_base and credential slot, own `timeout` 600. One real `/v1/messages` turn on the live pool: **200 in 2,241 ms**, `stop_reason end_turn`, 25 tokens in and 16 out. Key revoked, and the same key then **401** |
| the spend | **not measured**, and that is the honest answer rather than a zero: `plan-zai` on this machine carries no per-token prices, so the coding deployment is unpriced. See §11 and **CODE-13** |
| the host rule | `box-isolation.sh` put `ip saddr 10.97.0.0/16 … drop` **first** in the guarded chain, `--verify` then PASS with nothing else moved |
| the boxes | the demo box and Jason's box both came back `post-swap watch disarmed: host up 60s on af63780b1115 (healthy)`. **Richard's box was never swapped and never written**, so his workspace does not have the coding tool from this ship |
| the tool count | **40 tools** offered to the demo tenant's Titan with `code_task` among them, read off the box's own `[sand][toolset]` line. The planned figure of 28 was for a tenant box with mail on and nothing else; 40 is what this one really carries. **CODE-10** |
| the relay | start sweep `removed 0 code container(s) and 0 code network(s)` on a machine that had never had one |
| the first live task | handed off from the demo Titan through console.titanium.bot. It **failed**, for the three reasons in §11, and every one of them is fixed and re-measured below |

## 15. The gates

| | |
|---|---|
| `tests/code-sandbox-plan.test.mjs` | the argv plan asserted whole, the pool allocator, the copy-in guard, the redactor, the labels, the tar, and that `sync.sh` ships the image directory |
| `tests/code-edge-routes.test.mjs` | all five box routes against an injected `execFile`, the refusal order, and every half-started case |
| `tests/code-edge-sweep.test.mjs` | the wall clock, the orphans, what the sweep must not touch, a live task whose container has already stopped, and the minutes being the container's own |
| `scripts/verify-code-sandbox-isolation.mjs` | the boundary, from inside a real sandbox, against a real daemon. User agent `titanbot-gate/verify-code-sandbox-isolation`, 600 s ceiling |

The gate stands up its own `tbcode-gate-*` containers and removes them on the way in and on the way
out. It never lists, filters on, or removes a `codeprobe-*` container: those belong to a reader.
