import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../shared/node/atomic-write.js";
import {
  ensureDataRootAlias,
  getSandRootDir,
  SAND_BOX_DATA_ROOT,
  SAND_BOX_MODEL_VISIBLE_DATA_ROOT,
} from "../host-paths.js";
import { ensureLeadAgentMarker } from "./standing-persona.js";

export const SAND_BOX_REFERENCE_DIR = "/home/box/reference";
export const LEGACY_SAND_BOX_REFERENCE_DIR = "/home/box/sand-reference";
export const DEBUGGING_THE_BOX_FILE = "debugging-the-box.md";
export const SAND_APP_UI_FILE = "app-ui.md";
export const SAND_BOX_DEBUGGING_REFERENCE_PATH =
  `${SAND_BOX_REFERENCE_DIR}/${DEBUGGING_THE_BOX_FILE}`;
export const SAND_APP_UI_REFERENCE_PATH =
  `${SAND_BOX_REFERENCE_DIR}/${SAND_APP_UI_FILE}`;

export const SAND_BOX_DEBUGGING_REFERENCE_DOC = [
  "# Debugging the box (Titanium Bot)",
  "",
  "When the box acts up (won't start, Shell or Screenshot calls fail, a computerUse subagent reports Computer failures, or the desktop won't render), diagnose it yourself before giving up, and keep the user posted with a plain status instead of going silent.",
  `- Is it up? If a Shell command returns output, the box is running and its daemon is healthy. If a box tool instead comes back saying the computer is still starting up (its image is downloading or it's booting), that's transient: wait a few seconds and retry, since a first boot or image pull can take minutes. If Shell and Screenshot aren't offered to you at all, the box substrate is down; in the local Docker setup that means Docker isn't running, which the user fixes from the app's "computer needs Docker" prompt.`,
  "- Run the self-check. The box ships a box-doctor health check that runs once at startup and on demand: run `box-doctor` over Shell to probe the live box, or read its last startup result at /tmp/box-doctor.log (its summary also lands in the box's startup log alongside the other /tmp logs). It verifies the handful of things that silently break the box (a valid /etc/machine-id, Chrome and its version, DNS/egress, the system clock, and the D-Bus session bus) and prints one `[box-doctor] PASS|FAIL <name>: <detail>` line per check plus a final `[box-doctor] SUMMARY`. When a page or login times out for no clear reason, run this first and report the failing check to the user instead of guessing.",
  "- Desktop not rendering? Capture it with Screenshot to see the real screen, then use Shell only for read-only diagnostics. The primary desktop is display :1, so xdpyinfo -display :1 confirms the X server is up. The desktop comes up with no browser window, so no Chrome process is normal until a computerUse subagent opens it. Each desktop piece logs under /tmp on the box (start-desktop.log for the overall bringup, plus x11vnc:1.log and novnc:1.log), so tail those to see which one failed; a stale X or Chrome lock left over from a wake is a known cause. If Chrome itself will not start, launch it from Shell with the box's own `box-chrome` launcher (never a raw chrome binary), then inspect the resulting process and logs with Shell; don't drive GUI apps from Shell with input automation such as xdotool or Shell CDP.",
  "- Which runtime, and is it healthy? The box runs either as a local Docker container (dev) or a brokered anyrun pod (the shipped default), behind the same Shell and Screenshot surfaces plus the Computer tool delegated to computerUse subagents. Tell them apart by testing for /.dockerenv from Shell (present means Docker, absent means anyrun). On Docker you can inspect the runtime straight from ExternalShell on the user's computer with docker ps, docker logs, and docker inspect on the sand-box- container, and a stopped Docker daemon is why the box won't come up. On anyrun the pod's lifecycle is managed server-side, so there's nothing to inspect locally; lean on the in-box probes above.",
  "- Commands failing? Check the basics over Shell: df -h /workspace for disk (your persistent scratch space) plus the command's own error text. Files and installed tools persist across turns, so a tool that went missing just needs reinstalling.",
  `- Next steps: retry first, since most failures are just a box still booting. You can't rebuild the box yourself, so if it's wedged or stuck on a stale image, surface a clear status and tell the user their computer can be rebuilt from the console: the data-preserving rebuild moves the box to a fresh instance while keeping files and logins, and can unstick a wedged box without data loss. That is the recovery to point them at; the destructive reset beside it restores from the last saved snapshot and can lose recent unsynced work, so never direct the user to that one. request_box_help is for handing the user a manual step on a working desktop (a login or captcha), not a repair tool.`,
  "",
].join("\n");

export const SAND_APP_UI_REFERENCE_DOC = [
  "# The Titanium Bot console (real paths — never invent others)",
  "",
  // MAP-1. What used to be here described a macOS desktop app that does not exist on this
  // deployment: five Settings tabs, Cmd+comma, a "Sign In" card for the dead upstream, and an
  // "Update <product>'s Computer" row. An agent reading it guided people around an interface
  // they were not looking at, which is the same failure as inventing one. Cut to what is true of
  // the console, which is a web app the person opens in a browser. A verified full map is owed;
  // until it lands this file stays short on purpose.
  "Titanium Bot is used through a web console in a browser. There is no desktop app to open, no",
  "menu bar and no keyboard shortcut into settings, so never describe one.",
  "",
  "What is verified here, and nothing else is:",
  "- The sidebar lists the bots in this workspace. Opening one opens its conversation.",
  "- A bot's own page carries its conversation, a live view of its computer, and its settings",
  "  (name, title, description, avatar, notifications).",
  "- The Marketplace is where plugins and ready-made bots are added.",
  "- Settings is where the operator's own configuration lives, including the mail domain.",
  "",
  "If you are asked where something is and it is not on this list, say you are not sure rather",
  "than describing a plausible-looking path — see \"Never fabricate data\". Guessing a menu that",
  "does not exist wastes the person's time and costs you their trust in everything else you say.",
].join("\n");

export const SAND_BOX_REFERENCE_DOCS = [
  { fileName: DEBUGGING_THE_BOX_FILE, contents: SAND_BOX_DEBUGGING_REFERENCE_DOC },
  { fileName: SAND_APP_UI_FILE, contents: SAND_APP_UI_REFERENCE_DOC },
] as const;

export async function writeSandBoxReferenceDocs(
  referenceDir = SAND_BOX_REFERENCE_DIR,
): Promise<string[]> {
  const encoder = new TextEncoder();
  const written: string[] = [];
  for (const doc of SAND_BOX_REFERENCE_DOCS) {
    const path = join(referenceDir, doc.fileName);
    await writeFileAtomic(path, encoder.encode(doc.contents));
    written.push(path);
  }
  return written;
}

export async function provisionSandBoxPromptArtifacts(): Promise<void> {
  // PERSONA-1. The one place a box that predates the lead marker gets one: the oldest agent
  // directory is the workspace's first agent. It belongs here rather than on the prompt path,
  // which is synchronous and must not walk a directory, and here it runs once per host start --
  // so a host swap gives every existing box its lead without anybody touching the box.
  try { ensureLeadAgentMarker(); } catch { /* no marker is a missing paragraph, never a failed boot */ }
  const outcomes = await Promise.allSettled([
    getSandRootDir() === SAND_BOX_DATA_ROOT
      ? ensureDataRootAlias({
        dataRoot: SAND_BOX_DATA_ROOT,
        aliasPath: SAND_BOX_MODEL_VISIBLE_DATA_ROOT,
      })
      : Promise.resolve(),
    writeSandBoxReferenceDocs(),
    rm(LEGACY_SAND_BOX_REFERENCE_DIR, { recursive: true, force: true }),
  ]);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed != null) throw failed.reason;
}
