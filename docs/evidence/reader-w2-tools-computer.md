# Reader output: w2:tools-computer

## Evidence-grade read: sand computer/browser tool surface (Grok Bot 0.18 reconstructed)

All five target files read end to end. Line refs are absolute; repo root `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb`.

### 1. THE DISPATCH MECHANISM (the focus question)

**There is no `DispatchComputerUse` tool. Dispatch is the ordinary `Task` tool with `subagent_type: "computerUse"` or `subagent_type: "browserUse"`.**

Chain of evidence:

1. `sand-computer-use-subagent.ts:3` — `export const COMPUTER_USE_SUBAGENT_TYPE = "computerUse"`. `sand-browser-use-subagent.ts:1` — `export const BROWSER_USE_SUBAGENT_TYPE = "browserUse"`.
2. Each file exports a *subagent config* factory, not a tool: `sand-computer-use-subagent.ts:23-28` and `sand-browser-use-subagent.ts:12-17`. Both emit the same shape — `subagent_type: { type: { case: "custom", value: { name } } }`, `description`, `preserveTaskTool: false`, `subagentSource: "builtin"`.
3. Those configs are pushed into the run's subagent config list at `source/host/runner/turn-agent-composition.ts:1697-1698`.
4. The config list feeds the Task tool's parameter schema: `source/packages/agent/tools/task-tool-schema.ts:87` maps configs to names, `:100` builds `parsingSubagentTypeField` as `stringChoice(configNames, ...)`, and `:123` puts it on the object as `subagent_type`. Description text at `:99`: "Subagent type to use for this task. Must be one of: <names>."
5. The model-facing tool name is `Task` — `source/packages/agent/tools/task-tool-name.ts:9-13` (`getTaskToolName`): returns `"mcp_task"` for Composer1/1.5, `"Subagent"` for codex prompt versions, else `"Task"`.
6. At execution, `source/packages/agent/tools/task-subagent-preparation.ts:495` resolves the requested config via `findSubagentConfigByName(subagentConfigs, rawArgs.subagent_type)`, falling back to `generalPurpose` (`:493-495`) when the name does not match. Name matching is normalization-tolerant: `:475-476` lowercases and strips `-`/`_`.
7. The system prompt tells the model to do exactly this in prose — `source/host/runner/prompt-collector-glue.ts:264-266`: "Browser work goes to `browserUse` first; the desktop itself goes to `computerUse`."

Both files also export a normalizer-based type predicate used elsewhere to recognize the dispatch after the fact: `isComputerUseSubagentType` (`sand-computer-use-subagent.ts:4-5`), `isBrowserUseSubagentType` (`sand-browser-use-subagent.ts:2-3`), both stripping `[-_ ]` and lowercasing.

### 2. WHAT GATES THE DISPATCH

**Gate A — desktop present + box available (both subagent types):**
`turn-agent-composition.ts:1695` — `if (host.toolHost.remoteBoxHasDesktop && host.toolHost.getRemoteBoxAvailable())`. Only inside this branch are either config pushed. No desktop or no box → neither `computerUse` nor `browserUse` appears in the Task enum at all.

**Gate B — not itself a subagent:**
`turn-agent-composition.ts:1693` — `buildSubagentConfigsForRun()` returns `undefined` immediately `if (host.isSubagentRunner)`. A computerUse/browserUse subagent cannot dispatch another one.

**Gate C — `browserUse` additionally requires a feature flag:**
`turn-agent-composition.ts:1696` — `const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true;` and `:1698` — `if (browserUseOffered) configs.push(createSandBrowserUseSubagentConfig())`. The flag resolves to a server feature gate: `source/host/extensions/experiments/extension.ts:23` — `isBrowserUseSubagentEnabled: () => service.checkFeatureGate("sand_browser_use_subagent")`, wired through `source/host/host-runner-composition.ts:1459-1460` (defaults `false` when the method is absent).
`computerUse` has **no** feature flag — it is pushed unconditionally inside Gate A (`:1697`).

**Gate D — the flag also rewrites `computerUse`'s own description.** `createSandComputerUseSubagentConfig({ browserUseOffered })` (`turn-agent-composition.ts:1697`) forwards the flag into `computerUseSubagentDescription(browserUseOffered)` (`sand-computer-use-subagent.ts:7-21`). Flag on → the description says "For browser-only work, dispatch browserUse instead" (`:11`). Flag off → the single-sentence variant claiming computerUse handles "browsing, signing in to sites, and using GUI apps" (`:13`). Same fork in the system prompt at `prompt-collector-glue.ts:266-274`.

**Gate E — runtime concurrency, computerUse only.** `source/host/runner/agent-adapters.ts:38`: on `createOrResumeSession`, `computer = args.subagentType.replace(/[-_ ]/g,"").toLowerCase() === "computeruse"`; if so and `dispatcher.allocateComputerUseWindow(id) == null`, it throws `SandSubagentDispatchError("A computerUse subagent is already using the box's desktop. Only one can run at a time.")`. Stated to the model at `sand-computer-use-subagent.ts:18`. `browserUse` has no such window allocation — consistent with `prompt-collector-glue.ts:265` ("it never touches the desktop's mouse, so it can run alongside other work").

**No model gate found.** Nothing in these files or in the composition path conditions either subagent type on the model id. (The Task tool's `model` field, `task-tool-schema.ts:107`, is a per-dispatch override, not a gate.)

### 3. WHAT THE SUBAGENTS ACTUALLY HOLD (tool grants)

The subagent type is what unlocks the tools. `source/host/runner/tools/turn-toolset.ts`:
- `:1447-1452` — `Computer` tool granted iff `host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`.
- `:1455-1460` — the 15 `browser_*` tools granted iff `host.isBrowserUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`.
- `:1463-1470` — `Screenshot` + `request_box_help` granted iff `!host.isSubagentRunner && remoteBoxHasDesktop && getRemoteBoxAvailable()` — i.e. the **parent** gets read-only Screenshot, never Computer.
- `:1300` — a subagent runner that is neither computerUse nor browserUse takes an early divergent path in `buildTurnTools`.

The identity flags themselves are string-normalized subagent-type checks on the runner: `source/host/runner/sand-agent-runner.ts:588-593` (`isComputerUseSubagent` = isSubagentRunner && normalized type === "computeruse") and `:613-618` (`isBrowserUseSubagent` === "browseruse"); `:619-621` `isBoxScopedSubagent` = either.

This is the enforced boundary the prompt describes at `prompt-collector-glue.ts:264`: the parent "cannot click, move, type, press keys, scroll, or wait on the desktop" — mechanically true because `factories.computer` is only invoked under `isComputerUseSubagent`.

### 4. COMPUTER TOOL MECHANICS (`sand-computer-tool.ts`)

- 8 actions: `screenshot, click, move, drag, type, key, scroll, wait` (`:26`).
- Batching: a `then` array of 1..9 follow-up actions (`:25` `SAND_COMPUTER_MAX_FOLLOW_UP_ACTIONS = 9`; `:79`). `screenshot` is excluded from follow-ups (`:72`). A trailing screenshot is auto-appended if the last action isn't one (`:258`).
- `wait` capped at 30s (`:24`, `:58`); click `count` 1..3 (`:55`).
- **Auto-review coupling:** when `autoReview.mode === "enforce"`, the follow-up action set shrinks to `REVIEWABLE_FOLLOW_UP_ACTIONS` (`:73`, `:76`) and `click`/`drag` require a non-empty `description` or schema validation fails (`:83-85`). This means the tool's advertised schema differs by auto-review mode.
- Preflight: `runSandComputerAutoReviewPreflight` runs before any action when `deps.autoReview != null` (`:259-279`), with a page-state identity captured by shelling `navigationProbeCommand(displayNumber)` on the box (`:191-223`); failure to resolve the display throws `SandComputerAutoReviewBlockedError` (`:201-205`).
- Both `Computer` and `Screenshot` share tool id `OPENAI_COMPUTER_USE` (`:239`, `:252`) — id is not unique per tool.
- Screenshots are persisted out-of-band: base64 → `image/webp` via `getPersistImage()`, and the returned `fileUrl` is mutated onto `success.screenshotPath` (`:225-235`).

### 5. BROWSER TOOL MECHANICS (`sand-browser-tools.ts` + `sand-browser-driver-source.ts`)

- 15 tools declared in `BROWSER_TOOL_SPECS` (`sand-browser-tools.ts:551-567`); the driver implements exactly the matching 15 `OPS` keys (`sand-browser-driver-source.ts:494-815`).
- Transport is **not** an RPC: `SandBrowserDriver.run` base64-encodes the request and shells `node /tmp/.sand-browser/driver-v2.mjs <base64>` on the box (`sand-browser-tools.ts:272-282`; path from `sand-browser-driver-source.ts:1-3`). The driver source is a template string uploaded to the box once per driver instance (`sand-browser-tools.ts:229-242`).
- Result channel is a stdout marker line `__SAND_BROWSER_RESULT__<json>`, scanned bottom-up (`sand-browser-tools.ts:124-148`; marker at `sand-browser-driver-source.ts:4`, `:906`).
- Per-agent isolation: `display = windowIndex`, `cdpPort = 9222 + windowIndex` (`sand-browser-tools.ts:22`, `:265-266`). Default `viewId` is the session id (`host-runner-composition.ts:1066`).
- Driver watchdog: 90s hard timeout that emits `{ok:false,error:"Browser driver timed out after 90s"}` and exits 0 (`sand-browser-driver-source.ts:886-891`). Action timeout 10s, navigate 25s (`:11-12`).
- Chrome bring-up is automatic: `ensureChrome` spawns `box-chrome --new-window` with `DISPLAY=:<n>` when CDP is dead, waiting up to 30s (`sand-browser-driver-source.ts:102-121`).
- `reviveDiscardedTabs` (`:215-283`) works around Memory-Saver-discarded tabs hanging `connectOverCDP`, using a raw ws client pulled from `playwright-core/lib/utilsBundle` (`:128-135`).
- Cross-process tab-claim locking via a lockfile with a 5s leak break (`:64-89`), plus dirty-key-only state persistence to avoid clobbering concurrent driver calls (`:839-859`).
- **CDP escape hatch is denylisted**, not allowlisted: `browser_cdp` rejects prefixes `Browser. Target. Storage. SystemInfo. Security. Input. Tethering. Cast.` and 7 explicit `Network.*` cookie/cache methods (`sand-browser-driver-source.ts:771-800`). Everything else passes through, output truncated at 20000 chars (`:806-809`).
- Snapshot redacts password-ish input values (`sand-browser-driver-source.ts:451-455`) and caps at 400 nodes (`:387`, `:481`).
- Browser auto-review preflight mirrors the computer one (`sand-browser-tools.ts:604-624`), capturing state by concatenating the nav probe with `cat /tmp/.sand-browser/views-<display>.json` around a `__SAND_BROWSER_VIEW_STATE__` marker (`:416`).
- Error handling: every browser tool `execute` swallows throws into `{text, isError:true}` (`sand-browser-tools.ts:637-642`) — errors reach the model as tool text, never as a thrown tool failure.
- Screenshot render path has a stash/immediately-unstash round-trip through the module-global `pendingScreenshots` map (`sand-browser-tools.ts:645-648`), i.e. `stashScreenshot` + `get` + `delete` in three consecutive lines; the 32-entry cap (`:23`, `:29-32`) is therefore never exercised on this path.

### 6. DISPLAY GEOMETRY

`computerUse`'s description embeds `displaySpaceSentence()` (`sand-computer-use-subagent.ts:15`), which resolves to a hardcoded 1280×800 with an explicit coordinate-clamp instruction (`source/host/box/box-monitor-layout.ts:1-3`).

## Tool table

### Task (with subagent_type: "computerUse")
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-computer-use-subagent.ts:23-28`
- gate: turn-agent-composition.ts:1693 `if (host.isSubagentRunner) return undefined;` THEN :1695 `if (host.toolHost.remoteBoxHasDesktop && host.toolHost.getRemoteBoxAvailable())` THEN :1697 `configs.push(createSandComputerUseSubagentConfig({ browserUseOffered }))` — unconditional inside that branch, NO feature flag
- notes: Not its own tool. It is a subagent CONFIG that becomes an allowed value of the `Task` tool's `subagent_type` enum (task-tool-schema.ts:87,:100,:123). Tool name resolved by task-tool-name.ts:9-13 ("Task", or "mcp_task"/"Subagent" for other prompt versions). Runtime concurrency gate: agent-adapters.ts:38 throws SandSubagentDispatchError if allocateComputerUseWindow returns null — one at a time. Description text forks on browserUseOffered (sand-computer-use-subagent.ts:9-14) and embeds 1280x800 display geometry (:15 -> box-monitor-layout.ts:3).

### Task (with subagent_type: "browserUse")
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-use-subagent.ts:12-17`
- gate: turn-agent-composition.ts:1693 not-a-subagent AND :1695 `remoteBoxHasDesktop && getRemoteBoxAvailable()` AND :1696-1698 `const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true; ... if (browserUseOffered) configs.push(createSandBrowserUseSubagentConfig())` — flag resolves to `service.checkFeatureGate("sand_browser_use_subagent")` at extensions/experiments/extension.ts:23
- notes: Same config-into-Task-enum mechanism as computerUse. Strictly gated behind the sand_browser_use_subagent feature gate; defaults false when the experiments method is absent (host-runner-composition.ts:1459-1460). No desktop-window concurrency limit (contrast agent-adapters.ts:38, which only checks "computeruse").

### Computer
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-computer-tool.ts:249-291`
- gate: turn-toolset.ts:1447-1452 `host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`; isComputerUseSubagent defined sand-agent-runner.ts:588-593 (isSubagentRunner && normalized subagentType === "computeruse")
- notes: Tool id "OPENAI_COMPUTER_USE" (:252). 8 actions screenshot/click/move/drag/type/key/scroll/wait (:26). Optional `then` batch of 1..9 non-screenshot follow-ups (:72,:79). Auto-review mode "enforce" shrinks the follow-up enum (:73,:76) and makes `description` mandatory for click/drag (:83-85), so the advertised schema is mode-dependent. Auto-append trailing screenshot (:258). Preflight blocks on display-resolution failure (:201-205).

### Screenshot
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-computer-tool.ts:237-247`
- gate: turn-toolset.ts:1463-1468 `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — the PARENT agent only
- notes: Empty parameter object (:90). Shares tool id "OPENAI_COMPUTER_USE" with Computer (:239 vs :252). Read-only: it hard-codes `actions: [toAction({action:"screenshot"})]` (:242). This is the mechanical basis of the prompt's claim that the parent can look but not act (prompt-collector-glue.ts:264).

### browser_navigate
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:552`
- gate: turn-toolset.ts:1455-1460 `host.isBrowserUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`
- notes: id BROWSER_NAVIGATE, op "navigate", required [url], canNavigate. Driver impl sand-browser-driver-source.ts:495-510; `newTab:true` mints viewId "tab-<Date.now()>" (:498). domcontentloaded within 25s then best-effort load within 5s.

### browser_snapshot
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:553`
- gate: turn-toolset.ts:1455-1460 (isBrowserUseSubagent && remoteBoxHasDesktop && getRemoteBoxAvailable)
- notes: op "snapshot", no required args. Driver :511-525 evaluates SNAPSHOT_FN (:378-483): builds globalThis.__sandRefs map, emits `[ref=eN]` handles, caps at 400 nodes (:387,:481), redacts password/current-password/new-password input values (:451-455), trims names to 80 chars.

### browser_click
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:554`
- gate: turn-toolset.ts:1455-1460
- notes: op "click", required [ref], canNavigate. Driver :526-542; resolves ref via refHandle (:364-376) which throws "Unknown or stale ref" telling the model to re-snapshot. Supports button/modifiers/holdDurationMs/doubleClick via clickOptionsFor (:485-492) and offsetX/offsetY (:530-538).

### browser_mouse_click_xy
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:555`
- gate: turn-toolset.ts:1455-1460
- notes: op "mouse_click_xy", required [x,y], canNavigate. Driver :543-550. Pixel fallback inside the browserUse surface — description explicitly says prefer browser_click with refs.

### browser_type
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:556`
- gate: turn-toolset.ts:1455-1460
- notes: op "type", required [ref,text], canNavigate. Driver :551-564: clicks the element first, optional `clear`, keyboard.type with 40ms delay when `slowly`, optional `submit` presses Enter and waits for domcontentloaded.

### browser_fill
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:557`
- gate: turn-toolset.ts:1455-1460
- notes: op "fill", required [ref,value]. Driver :565-570 — element.fill, no navigation wait, not marked canNavigate.

### browser_select_option
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:558`
- gate: turn-toolset.ts:1455-1460
- notes: op "select_option", required [ref,values]. Driver :571-586 tries selectOption(values) then falls back to matching by label.

### browser_press_key
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:559`
- gate: turn-toolset.ts:1455-1460
- notes: op "press_key", required [key], canNavigate. Driver :587-592.

### browser_scroll
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:560`
- gate: turn-toolset.ts:1455-1460
- notes: op "scroll", no required args. Driver :593-613: with `ref` scrolls that element into view; otherwise mouse.wheel by deltaX/deltaY, or direction+amount (default down/300).

### browser_drag
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:561`
- gate: turn-toolset.ts:1455-1460
- notes: op "drag", required [sourceRef]. Driver :691-729 needs targetRef OR targetX+targetY (throws :709), synthesizes a 12-step mouse move.

### browser_get_bounding_box
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:562`
- gate: turn-toolset.ts:1455-1460
- notes: op "get_bounding_box", required [ref], skipScreenshot:true (so sand-browser-tools.ts:258-260 sends no screenshotPath). Driver :730-746.

### browser_highlight
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:563`
- gate: turn-toolset.ts:1455-1460
- notes: op "highlight", required [ref]. Driver :747-770 injects a fixed-position overlay at z-index 2147483647, duration clamped to <=5000ms (default 2000).

### browser_cdp
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:564`
- gate: turn-toolset.ts:1455-1460, plus in-driver method denylist sand-browser-driver-source.ts:771-800
- notes: op "cdp", required [method], canNavigate. DENYLIST not allowlist: prefixes Browser./Target./Storage./SystemInfo./Security./Input./Tethering./Cast. and explicit Network.{setCookie,setCookies,getCookies,getAllCookies,deleteCookies,clearBrowserCookies,clearBrowserCache} (:773-791). Anything else reaches the page's CDP session; result JSON truncated at 20000 chars (:806-809).

### browser_tabs
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:565`
- gate: turn-toolset.ts:1455-1460; arg enum enforced at sand-browser-tools.ts:578-584
- notes: op "tabs", required [action] with enum list/new/close/select, skipScreenshot:true. Driver :614-686. `select`/`close` need an index unless closing the current view (:640-657).

### browser_take_screenshot
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-browser-tools.ts:566`
- gate: turn-toolset.ts:1455-1460
- notes: op "screenshot", no required args, supports fullPage. Driver :687-690 -> :866-878 writes the PNG to the box path then the host downloads it (sand-browser-tools.ts:314-342). Its own description calls it "usually redundant" since every other browser op returns a screenshot.

### CheckSubagent / MessageSubagent / StopSubagent
- defined: `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/sand-subagent-management-tools.ts:91,:112,:133`
- gate: turn-toolset.ts:1180-1191 `!host.isSubagentRunner` AND `turn.subagentConfigs != null`
- notes: Out-of-file but load-bearing for the dispatch story: the descriptions at :91 and :133 explicitly reference steering/killing a stuck computerUse subagent, and sand-computer-use-subagent.ts:17 / sand-browser-use-subagent.ts (implicitly) tell the model to use them. These are the control plane for a dispatched Task.


## Did not verify

- The exact tool name the model sees for dispatch. task-tool-name.ts:9-13 returns "Task" by default but "mcp_task" for Composer1/1.5 and "Subagent" for codex prompt versions. I did not verify which promptVersion/model Grok Bot 0.18 actually runs, so "Task" is the default-path name, not confirmed for this product's shipping model.
- Whether remoteBoxHasDesktop is ever false in this product. All four assignment sites I grepped (host-runner-composition.ts:1279, 1407, 1561, 2317) pass the literal `true`, but I did not read those regions in context to confirm there is no other path that sets it false.
- The runtime/default value of checkFeatureGate("sand_browser_use_subagent") — whether browserUse is on for real users. Only the wiring is in the source (extensions/experiments/extension.ts:23); the gate's backing service and default are not in these files.
- The full JSON parameter schema the model sees for the 15 browser_* tools. sand-browser-tools.ts defines NO zod schema — BROWSER_TOOL_SPECS carries only `required` and `enum` hints (:551-567) consumed by validateArguments at execute time (:569-585). Where the model-facing argument schema for browser_* is generated (asTurnTool, or the proto tool catalogue) is outside these files and I did not trace it. Consequence: I cannot state which optional args (viewId, newTab, slowly, offsetX, fullPage, interactive, maxDepth, selector, durationMs, holdDurationMs, deltaX/deltaY) are actually advertised to the model versus merely honored by the driver.
- What allocateComputerUseWindow does on the allocation side. I read the throw site (agent-adapters.ts:38) and the free site (subagent-runtime.ts:315) but did not read host-runner-composition.ts:2488-2490 in context, so the pool size ("only one") is asserted from the error string and the description text, not from reading the allocator.
- Whether the parent agent is mechanically prevented from Shell-driven GUI automation (xdotool, CDP attach, Playwright). prompt-collector-glue.ts:264 forbids it in prose; I found no enforcement code and did not search for one.
- How SandBrowserAutoReviewOptions.mode is set for browser tools independently of computer tools. host-runner-composition.ts:1071 passes `mode: projectionAutoReviewModes.computer` into the BROWSER driver dependencies — the browser surface appears to reuse the computer auto-review mode — but I did not read sand-browser-auto-review.ts or the autoReviewGate to confirm whether a separate browser mode exists.
- Whether the two dead-code observations are intentional: (a) Computer and Screenshot sharing tool id "OPENAI_COMPUTER_USE" (sand-computer-tool.ts:239 vs :252), and (b) the stash/get/delete round-trip in sand-browser-tools.ts:645-648 that makes the PENDING_SCREENSHOT_CAP=32 eviction path (:29-32) unreachable from the render path. I verified the code reads that way; I did not verify there is no other caller of stashScreenshot/pendingScreenshots (no other consumer appeared in these files, but I did not grep the whole repo for it).