/**
 * CLOUD-BROWSER-1. Where a person finds the cloud browser their agent is driving.
 *
 * THE HAND-OFF CARD IS NOT TOUCHED, and this file is why it does not have to be.
 *
 * request_box_help takes instruction, reason, domain and idp_domain and nothing else, and its card
 * paints a thumbnail off the box's own noVNC seat, chosen from `boxSeat`. HANDBACK-2 is the row
 * where painting the wrong seat showed a person another agent's wallpaper and they made a decision
 * on it. So: no new parameter on that tool, no repointing of boxSeat, no second meaning for a
 * field the card already reads.
 *
 * Instead the live view is a fact about the AGENT, held here while a session is open and answered
 * by a gateway command of its own. The console draws it BESIDE the existing card whenever the same
 * agent has a live cloud session, out of a separate file that owns nothing the card owns.
 *
 * Two consequences, accepted out loud rather than discovered later:
 *
 *   - every box desktop mount is same-origin `${origin}/vnc/<display>/` on purpose, which is what
 *     makes its canvas readable for a thumbnail. A vendor live view is third party, so NO thumbnail
 *     can ever be read from one. The console shows a frame or a link, never a picture;
 *   - a vendor may refuse framing. Browserbase documents an iframe embed verbatim, with
 *     sandbox="allow-same-origin allow-scripts"; Browser Use's liveUrl is a page. Either can start
 *     sending a frame-ancestors header tomorrow, so the console always draws a plain link beside
 *     the frame and a refused frame is never left as a blank rectangle.
 *
 * The register is in memory on purpose. A session that outlives this process is not a live view any
 * more, it is an orphan, and the ledger on disk is what finds those.
 */

import type { CloudBrowserVendor } from "./secrets.js";

export interface CloudBrowserLiveSession {
  readonly agentId: string;
  readonly vendor: CloudBrowserVendor;
  readonly sessionId: string;
  readonly liveViewUrl: string | null;
  readonly startedAt: string;
  readonly url: string;
}

export class CloudBrowserLiveRegister {
  #open = new Map<string, CloudBrowserLiveSession>();

  /** One session per key, keyed by session id so two agents cannot overwrite each other. */
  add(session: CloudBrowserLiveSession): void {
    this.#open.set(session.sessionId, session);
  }

  remove(sessionId: string): void {
    this.#open.delete(sessionId);
  }

  /** Everything open, newest first. What `listCloudBrowserSessions` answers. */
  all(): CloudBrowserLiveSession[] {
    return [...this.#open.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  /** This agent's own open sessions. What the console asks for when it draws beside the card. */
  forAgent(agentId: string): CloudBrowserLiveSession[] {
    return this.all().filter((session) => session.agentId === agentId);
  }

  /** How many this turn has opened, which is the ceiling the router reads. */
  countForAgent(agentId: string): number {
    return this.forAgent(agentId).length;
  }
}

/**
 * One register per host process, because there is one set of open sessions per host process.
 *
 * The runner's service writes into it as tool calls open and close sessions; the gateway command
 * that answers the console reads it. Those are two different modules, and giving each its own
 * register would have meant a console that draws a live view for nothing while a session runs, and
 * a live view still on screen after the session ended -- both of which are worse than no view.
 */
export const cloudBrowserLiveSessions = new CloudBrowserLiveRegister();
