/**
 * BROWSER-1. Titan's own browser.
 *
 * The box has always had a signed-in Chrome, and the host has always had a driver for it, but the
 * main agent was never handed either: `buildTurnTools` pushed the fifteen page-level `browser_*`
 * tools only when the runner was a browserUse subagent, and that subagent sat behind a feature
 * gate this deployment cannot turn on. So the model's only honest answer to "read this page for
 * me" was a web fetch, and when the fetch was refused there was nowhere left to go.
 *
 * These four are the common case, offered to the main agent: open a page, click something, type
 * something, take one more look. They are deliberately not the fifteen. A chief holding a
 * snapshot-ref vocabulary would spend its turn learning the page's element map; the long
 * multi-step jobs are still the desktop subagent's work, and the fifteen are still what that
 * subagent holds. Everything here rides the same `SandBrowserDriver` as the fifteen -- same box
 * shell, same auto-review preflight, same single screenshot pulled back as one image part -- so
 * there is exactly one path to the box's Chrome and one place a bug in it can live.
 *
 * The arguments are the difference. The fifteen act on `ref=eN` handles from a `browser_snapshot`;
 * these act on what a person would say: the visible words on a button, or a CSS selector when the
 * words are ambiguous. That is why the specs carry their own zod schemas rather than borrowing the
 * op-keyed table (three of the four ops collide by name with the fifteen's).
 *
 * And they run a different driver on the box, which is what `usesRuntimeDriver` says. The fifteen
 * upload their driver from the host process on first use; these four run the one that SHIPS with
 * the product, in the read-only runtime mount every box already has
 * (/opt/titanbot-runtime/browser-driver). That is the driver that reads a page's words, notices a
 * sign-in wall, and takes one JPEG 1280 wide -- the three things the model needs and the fifteen's
 * ref-and-snapshot driver was never asked for. Same shell call, same result line, same screenshot
 * pulled back off the box; only the file that runs is different.
 */
import { z } from "zod";
import {
  createSandBrowserTools,
  type BrowserDriverDependencies,
  type BrowserToolDefinition,
  type BrowserToolSpec,
} from "./sand-browser-tools.js";

const target = z.string().describe(
  "What to act on: the visible words on it (a button's label, a link's text, a field's label or placeholder), or a CSS selector when the words are not unique.",
);

/**
 * The descriptions carry the routing rule, because the model picks the tool before it reads any
 * prompt section: fetch first, the browser when fetch cannot do it, the desktop subagent when the
 * job is long. Naming the alternatives inside the description is what stops the browser becoming
 * the default road to every page.
 */
export const DIRECT_BROWSER_TOOL_SPECS: readonly BrowserToolSpec[] = [
  {
    id: "BROWSER_OPEN",
    name: "browser_open",
    op: "open",
    description:
      "Open a web page in your computer's own browser and read it. Returns the page title, the page's readable words, and one picture of the page."
      + " Reach for this when a plain web fetch will not do: the site refused the fetch or answered with a stub, the page needs the person's sign-in (this browser keeps their logins), or you have to see the page to answer."
      + " For an ordinary public page, fetch it instead -- it is faster and costs less. If a page needs many steps of clicking and typing to get through, hand the whole job to a desktop subagent instead of driving it one call at a time here."
      + " If the answer says the page wants a sign-in, tell the person they can sign in on the computer's screen and that you will carry on after.",
    schema: { required: ["url"] },
    parameters: z.object({
      url: z.string().describe("The full web address, including https://"),
    }),
    canNavigate: true,
    recordsNavigation: true,
    usesRuntimeDriver: true,
  },
  {
    id: "BROWSER_CLICK_TARGET",
    name: "browser_click",
    op: "click",
    description:
      "Click something on the page the browser is showing. Returns the page after the click and one picture of it."
      + " Open the page with browser_open first; the picture it returned is what you are clicking on.",
    schema: { required: ["target"] },
    parameters: z.object({ target }),
    canNavigate: true,
    usesRuntimeDriver: true,
  },
  {
    id: "BROWSER_TYPE_TARGET",
    name: "browser_type",
    op: "type",
    description:
      "Type into a field on the page the browser is showing, and optionally press Enter. Returns the page afterwards and one picture of it."
      + " Never type a password or a one-time code: if a page asks for either, stop and tell the person they can sign in on the computer's screen.",
    schema: { required: ["target", "text"] },
    parameters: z.object({
      target,
      text: z.string().describe("The text to type into the field"),
      submit: z.boolean().optional().describe("Press Enter after typing, to search or send the form"),
    }),
    canNavigate: true,
    usesRuntimeDriver: true,
  },
  {
    id: "BROWSER_SCREENSHOT_ONE",
    name: "browser_screenshot",
    op: "screenshot",
    description:
      "Take one fresh picture of the page the browser is showing, without changing anything."
      + " Every other browser tool already returns a picture, so you rarely need this: use it to look again after the page has had a moment to finish loading.",
    parameters: z.object({}),
    usesRuntimeDriver: true,
  },
];

/** The four names, in offer order, for the tool trace and the tests. */
export const DIRECT_BROWSER_TOOL_NAMES: readonly string[] =
  DIRECT_BROWSER_TOOL_SPECS.map(spec => spec.name);

/**
 * The same driver, the same auto-review, the same one-image result as the fifteen; only the four
 * specs differ. `recordNavigation` on the dependencies is what turns a browser_open into one
 * `browser_navigation` row in this agent's audit ledger.
 */
export function createSandDirectBrowserTools<Context>(
  dependencies: BrowserDriverDependencies<Context> & {
    readonly onPossibleNavigation?: (context: Context) => void;
  },
): BrowserToolDefinition<Context>[] {
  return createSandBrowserTools(dependencies, DIRECT_BROWSER_TOOL_SPECS);
}
