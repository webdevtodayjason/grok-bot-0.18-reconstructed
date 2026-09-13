import { z } from "zod";

import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  SendToUserArgs,
  SendToUserError,
  SendToUserResult,
  SendToUserSuccess,
  SendToUserToolCall,
} from "../../../packages/proto/generated/agent/v1/send_to_user_tool_pb.js";
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.js";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/common.js";
import type { Context } from "../../../packages/context/core.js";
import type { AgentMailAddress } from "../../extensions/mail/agent-mail-store.js";
import type {
  RelaySendAnswer,
  RelaySendRequest,
  RelaySendTarget,
} from "../../extensions/mail/relay-send-client.js";

/**
 * MAIL-3. The bot's own send. Jason, 2026-09-09 12:15: "I didn't realize that the bots couldn't
 * send mail yet." He asked his Titan for a test mail and Titan answered, correctly, that sending
 * was not wired up.
 *
 * This is a PLAIN zod agent tool rather than a `defineCommunicateTool` one, for the same reason
 * problem-report-tool.ts is, and that file's header is the record of how the trap was found: a
 * communicate-wrapped tool lands in the outline as `communicateUpdateToolCall`, and the console's
 * NOT_A_RECEIPT filter drops every row whose name matches /communicate|update_state|todo|.../ --
 * so the person would have seen NO CHIP AT ALL for a mail their bot sent in their name. The chip
 * is the point: mail leaves the workspace, and the person has to see that it did, in plain words,
 * without ever reading a tool name.
 *
 * The proto case it rides is `sendToUserToolCall`, which the upstream 0.18 protocol carries and
 * nothing in this product emits. Its args are ONE string, which is the whole reason it is the
 * right carrier: the outline summary is that JSON and it is drawn on a customer's screen, so the
 * subject and the body must not be able to reach it even by accident. What that one string holds
 * is the RECIPIENT, and on a refusal the recipient behind a fixed marker -- see
 * MAIL_SEND_FAILED_PREFIX below for why the outcome has to travel there.
 *
 * WHAT THIS TOOL DOES NOT HOLD: a Resend key, a From address, or any say over either. The relay
 * holds the key, looks this box's workspace up from the bearer, finds the agent's row in the
 * directory it already serves, and sets the From itself. A box cannot send as another workspace's
 * bot because it cannot present another workspace's bearer, and it cannot send as its own Titan
 * while claiming to be somebody else because the From is never a field on this request.
 */
export const SEND_EMAIL_TOOL_ID = "SEND_EMAIL";
export const SEND_EMAIL_TOOL_NAME = "send_email";
/** The name this tool's row carries in the conversation outline. The console keys its label off it. */
export const SEND_EMAIL_OUTLINE_NAME = "sendToUserToolCall";
/** The one line the model reads in the dynamic-tool hint table. */
export const SEND_EMAIL_TOOL_HINT =
  "Send an email from your own address, to one person or several, and say afterwards what went and to whom.";

/**
 * The outcome marker, and the one place this design bends.
 *
 * MEASURED in this tree 2026-09-09: an OutlineItem for a non-shell, non-task tool call carries
 * `{kind, id, name, status, summary}` and nothing else (conversation-outline.ts:25-35), and
 * `getOutlineToolCallStatus` reports "failed" only for a failed taskToolCall
 * (conversation-outline.ts:222). So the console cannot see this tool's error result at all: left
 * alone, a send the relay REFUSED would have drawn "Sent an email to jane@client.example" on the
 * person's screen. That is precisely the failure this whole wave exists to stop, so the outcome
 * travels in the one string the outline does carry, in front of the recipient, and the console's
 * branch reads it. Still no subject and still no body; two fixed words in front of an address are neither.
 */
export const MAIL_SEND_FAILED_PREFIX = "not sent: ";

/**
 * The sentence the model reads back, keyed by the result object itself.
 *
 * `SendToUserSuccess` has no fields upstream (send_to_user_tool_pb.ts:47) and this wave does not
 * change the generated protocol, so unlike ReportBugSuccess there is nowhere inside the result to
 * put the ack. `render` is handed the very object `execute` returned (agent/tools/core.ts:209) and
 * is given neither the arguments nor the call id, so the object IS the key: no id to collide, no
 * "last call wins" field to race when the model issues two sends in one turn, and a WeakMap so a
 * result nobody rendered is collected rather than remembered.
 */
const ACK_BY_RESULT = new WeakMap<SendToUserResult, string>();

export const sendEmailParameters = z.object({
  to: z.string().trim().min(1).describe(
    "Who this goes to, as a plain email address. Several people go in this one field separated by"
      + " commas, and they all see each other on the mail. At most twenty addresses across this"
      + " field, cc and bcc together.",
  ),
  cc: z.string().trim().optional().catch(undefined).describe(
    "Anybody who should get a copy, separated by commas. Everybody on the mail sees these"
      + " addresses. Leave it out when there is nobody to copy.",
  ),
  bcc: z.string().trim().optional().catch(undefined).describe(
    "Anybody who should get a copy the other people cannot see, separated by commas. The send is"
      + " still written down where your operator can read it, names and all, so use it to keep an"
      + " address private from the other recipients and never to hide a mail from the person here.",
  ),
  subject: z.string().trim().min(1).describe(
    "The subject line, as the person receiving it would want to read it. Keep it short and say"
      + " what the mail is about.",
  ),
  text: z.string().trim().min(1).describe(
    "The message itself, in plain words. Write it as yourself, the way you would write it here.",
  ),
  html: z.string().trim().optional().catch(undefined).describe(
    "An HTML version of the same message. Optional, and only when the formatting matters; the"
      + " plain text is what most people will read.",
  ),
  in_reply_to: z.string().trim().optional().catch(undefined).describe(
    "When you are answering a mail that arrived here, the Message-ID of that mail, copied exactly"
      + " from its `Message-ID:` line, angle brackets included. Without it your answer starts a new"
      + " thread and looks like you ignored them.",
  ),
});

export type SendEmailArgs = z.infer<typeof sendEmailParameters>;

export interface SendEmailDependencies {
  getAgentId(): string | undefined;
  /** This agent's own row in the box's copy of the directory, or null when it has none. */
  readMail(agentId: string): AgentMailAddress | null;
  /** Where the relay is and the bearer for it, or undefined when this box has no relay. */
  resolveRelay(): RelaySendTarget | undefined;
  post(
    target: RelaySendTarget,
    body: RelaySendRequest,
    timeoutMs?: number,
  ): Promise<RelaySendAnswer>;
  timeoutMs?: number;
}

const DESCRIPTION = `Send an email from your own address to one person or several.

Your address is fixed and this tool has no "from": every mail goes out as your own code address at the workspace's mail domain, with your name and workspace shown beside it, and replies come back to you here. You cannot send as anybody else, and there is no parameter that would let you try.

Several people go in "to" separated by commas, and they see each other. "cc" is a copy everybody can see and "bcc" is a copy they cannot. At most twenty addresses across the three, and one bad address stops the whole mail rather than sending part of it.

Ask the person you are working with before writing to somebody they did not name. Mail leaves the workspace and arrives with your business's name on it, so a mail nobody asked for is a mistake you cannot take back.

Every send is written down where the operator can read it: who sent it, to whom, whether it went. There is a limit on how many you may send in an hour and in a day, and if you reach it this tool tells you the number and when the next one can go.

Say in one line afterwards what you sent and to whom. Only say a mail went out when this tool told you it did: if it comes back with a reason, repeat that reason and do not describe the send as done. Accepted by the mail service is also not the same as delivered to a person, so do not promise it arrived.`;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const wrap = (value: SendToUserToolCall): ToolCall =>
  new ToolCall({ tool: { case: "sendToUserToolCall", value } });

/** The one string the outline carries. The recipient, and on a refusal the marker in front of it. */
export function sendEmailProtoArgs(to: string, outcome: "sent" | "failed"): SendToUserArgs {
  const recipient = to.trim();
  return new SendToUserArgs({
    message: outcome === "failed" ? `${MAIL_SEND_FAILED_PREFIX}${recipient}` : recipient,
  });
}

/**
 * MAIL-4. One field of addresses, as the model typed it, split on the commas it was told to use.
 *
 * The splitting happens HERE and not in the relay because a string holding commas is exactly what
 * the relay refuses: one string is one address there, so that the shape MAIL-3 has been sending for
 * days keeps its meaning. Nothing is validated here on purpose -- the relay validates every address
 * against one rule and names the field that was wrong, and a second opinion in the box would be a
 * second rule to drift.
 */
export const sendEmailAddresses = (value: string | undefined): string[] =>
  String(value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);

/**
 * MAIL-4. The recipients as the ROW ON THE PERSON'S SCREEN names them.
 *
 * Two addresses, then a count. The row is one muted line with nothing to expand (the console has no
 * detail for this tool call), it is read on a phone as often as a desktop, and twenty addresses in it
 * would push everything else off the line. Who exactly the rest were is on the Sent table of the
 * workspace's own Email card, which holds every recipient of every send.
 */
export function sendEmailRecipientChip(addresses: readonly string[]): string {
  const shown = addresses.slice(0, 2);
  const rest = addresses.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** MAIL-4. The same people in the words the model reads back, copies named as copies. */
export function sendEmailRecipientWords(
  to: readonly string[], cc: readonly string[], bcc: readonly string[],
): string {
  return to.join(", ")
    + (cc.length > 0 ? `, copying ${cc.join(", ")}` : "")
    + (bcc.length > 0 ? `, blind copying ${bcc.join(", ")}` : "");
}

/** The sentence the model reads back on a send that the relay confirmed. */
export function sendEmailAck(to: string, from: string, id: string | undefined): string {
  return `Sent to ${to} from ${from}.${id == null ? "" : ` The mail service's id for it is ${id}.`}`
    + " Tell the person in one line what you sent and to whom. It has been accepted for delivery,"
    + " which is not the same as read, so do not promise it arrived.";
}

export function createSendEmailTool(dependencies: SendEmailDependencies) {
  const execute = async (
    context: Context,
    interactionHandler: {
      executeToolCall: (
        context: Context,
        toolCall: ToolCall,
        id: string,
        run: (context: Context) => Promise<SendToUserResult>,
        merge: (result: SendToUserResult) => ToolCall,
      ) => Promise<SendToUserResult>;
    },
    args: SendEmailArgs,
    meta: { readonly toolCallId: string },
  ): Promise<SendToUserResult> => {
    // MAIL-4. Three fields of addresses, each split on its commas. The relay decides whether any of
    // them is an address, how many are too many and which field was wrong; what is decided here is
    // only what the row on the page and the sentence to the model say.
    const toList = sendEmailAddresses(args.to);
    const ccList = sendEmailAddresses(args.cc);
    const bccList = sendEmailAddresses(args.bcc);
    const everyone = [...toList, ...ccList, ...bccList];
    // A `to` that split to nothing still has to draw a row and name something, so the raw string is
    // the fallback: the relay is the one that refuses it, and the row has to say which send failed.
    const shown = everyone.length > 0 ? sendEmailRecipientChip(everyone) : args.to.trim();
    // What the row says while the call is in flight. The completed row is minted below from the
    // outcome, so a refusal never leaves "Sent an email to ..." on the page.
    const pending = sendEmailProtoArgs(shown, "sent");
    let outcome: "sent" | "failed" = "failed";
    const refuse = (why: string): SendToUserResult => new SendToUserResult({
      result: { case: "error", value: new SendToUserError({ error: why }) },
    });
    return interactionHandler.executeToolCall(
      context,
      wrap(new SendToUserToolCall({ args: pending })),
      meta.toolCallId,
      async () => {
        const agentId = dependencies.getAgentId();
        if (agentId == null || agentId.length === 0) {
          return refuse("send_email was called outside an agent run.");
        }
        const own = dependencies.readMail(agentId);
        if (own == null || own.address.length === 0) {
          return refuse(
            "you do not have an email address of your own yet, so there is nothing to send from."
              + " Say that plainly rather than trying another way.",
          );
        }
        const relay = dependencies.resolveRelay();
        if (relay == null || relay.token.length === 0) {
          return refuse(
            "this box has no mail service in front of it, so nothing can be sent from here."
              + " Say so plainly and offer to draft the message instead.",
          );
        }
        let answer: RelaySendAnswer;
        try {
          answer = await dependencies.post(relay, {
            agentId,
            // One address goes as the string MAIL-3 sent, so the common send is byte for byte the
            // request the relay has been answering since that wave; several go as a list.
            to: toList.length === 1 ? toList[0] as string : toList,
            ...(ccList.length === 0 ? {} : { cc: ccList }),
            ...(bccList.length === 0 ? {} : { bcc: bccList }),
            subject: args.subject,
            text: args.text,
            ...(args.html == null || args.html.length === 0 ? {} : { html: args.html }),
            ...(args.in_reply_to == null || args.in_reply_to.length === 0
              ? {}
              : { inReplyTo: args.in_reply_to }),
            idempotencyKey: `${agentId}:${meta.toolCallId}`,
          }, dependencies.timeoutMs);
        } catch (error) {
          // postMailSend does not throw; a dependency that did would otherwise read to the model
          // as a send whose outcome is unknown, which is the one thing it may not conclude.
          return refuse(`the mail was not sent: ${errorMessage(error)}`);
        }
        if (!answer.sent) {
          // The relay's own sentence, verbatim. The model repeats the true reason -- the cap it
          // hit, the address it does not have, the workspace that is switched off -- and cannot
          // dress a refusal up as a send.
          return refuse(answer.message);
        }
        outcome = "sent";
        const done = new SendToUserResult({
          result: { case: "success", value: new SendToUserSuccess() },
        });
        ACK_BY_RESULT.set(done, sendEmailAck(
          // The model reads every recipient back, copies and blind copies named, because it has to
          // tell the person in one line who the mail went to. The ROW on the page is the short form.
          sendEmailRecipientWords(toList, ccList, bccList) || args.to.trim(),
          own.address, answer.id,
        ));
        return done;
      },
      (result) => wrap(new SendToUserToolCall({ args: sendEmailProtoArgs(shown, outcome), result })),
    );
  };

  return createZodAgentTool(SEND_EMAIL_TOOL_ID, {
    name: SEND_EMAIL_TOOL_NAME,
    descriptionGenerator: () => DESCRIPTION,
    parameters: sendEmailParameters,
    // `emitInitialPartialToolCall: false`, the same as every sand tool: a half-built row that says
    // an email is going somewhere while the model is still typing the address, and then changes
    // the address under the reader, is worse than no row until the call is made.
    execute: withSafeParsedArgs(
      sendEmailParameters,
      execute,
      wrap(new SendToUserToolCall()),
      { emitInitialPartialToolCall: false },
    ),
    render: async (_context: Context, result: SendToUserResult) => {
      if (result.result.case === "error") {
        return createStringResult(`The email was not sent: ${result.result.value.error}`);
      }
      if (result.result.case === "success") {
        return createStringResult(
          ACK_BY_RESULT.get(result)
            // A success this process did not mint has no ack to read back. It still may not be
            // narrated as a confirmed send with an id, so it says exactly what is known.
            ?? "The mail service accepted the message. Say in one line what you sent and to whom,"
              + " and do not promise it arrived.",
        );
      }
      return createStringResult("The email was not sent.");
    },
    // A throw -- unparseable arguments, an execution timeout -- still produces a row, and its args
    // carry the marker with no address after it. Without that the row would serialize to `{}`, the
    // console would find no recipient, and its fallback sentence is "Sent an email": a tool that
    // never ran drawing a send that never happened, on the one screen this whole item exists for.
    serializeError: (error: unknown) => wrap(new SendToUserToolCall({
      args: new SendToUserArgs({ message: MAIL_SEND_FAILED_PREFIX }),
      result: new SendToUserResult({
        result: { case: "error", value: new SendToUserError({ error: errorMessage(error) }) },
      }),
    })),
  });
}
