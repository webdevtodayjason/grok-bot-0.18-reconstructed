import{clampBlock,clampLine}from"../../../shared/sand-text.js";export const SECRET_REQUEST_MAX_LABEL_LENGTH=120,SECRET_REQUEST_MAX_DESCRIPTION_LENGTH=400;
export const clampSecretLabel=(v:string):string=>clampLine(v,120);export const clampSecretDescription=(v:string):string=>clampBlock(v,400);
export const summarizeSecretRequest=(r:{label:string}):string=>`Requested a secret from the user securely: ${r.label}`;
/**
 * CP-10. The beat the model reads after a secret lands has to be TRUE about where the value went.
 * A connector env secret goes into the connector process and the server is restarted; a chat
 * credential goes to the channel store and links a moment later. Saying "restarted" when nothing
 * restarted is the kind of confident wrong beat the model then repeats to the user. `restarted`
 * means the config push returned, NOT that the stdio server is back up -- the restart is a stop
 * plus a respawn on next discovery -- so the beat says the tools pick it up on their next call
 * rather than promising it is live this instant.
 *
 * SECRET-1 adds a third destination: the agent's OWN box shell. That beat has to name the variable
 * and say whether the live box took the update, because "stored" and "your next command sees it"
 * are two different claims and only the second is what the agent was asking for.
 */
export function buildSecretProvidedAck(r:{label:string;target:{kind:string}},outcome?:{destination:string;server?:string;restarted?:boolean;shellField?:string;applied?:boolean;pendingWindows?:readonly string[]}):string{
  const destination=outcome?.destination??r.target.kind;
  // ENV-1: the box runs one exec daemon per open desktop window, each with its own environment, so
  // "the live box took it" is a claim about several shells. A window that did not take the update
  // is NAMED here, because the shell that missed it may be the very one this agent runs.
  const pending=outcome?.pendingWindows==null||outcome.pendingWindows.length===0?"":` The desktop window(s) ${outcome.pendingWindows.join(", ")} did not take it, and your own shell may be one of them.`;
  const tail=outcome?.shellField!=null
    ? `It is set in your shell's environment as $${outcome.shellField}; commands you run from now on see it (applied: ${outcome.applied===true?"yes":"no"}).${outcome.applied===true?" Confirm to the user that it is set, then continue.":`${pending} The store has it but the live box did not take the update everywhere, so tell the user it lands when the box next comes up; do not report it usable yet.`}`
    :outcome?.server!=null
    ? outcome.restarted===true
      ? `The "${outcome.server}" connector was restarted with it; its tools pick the value up on their next call, so check before reporting it live. Confirm to the user that it is set, then continue.`
      : `It is stored for the "${outcome.server}" connector, but the connector did not restart, so tell the user it may need a restart before its tools can use it.`
    : "Confirm to the user that it is set, then continue. For a connector credential, the connection links within a few seconds, so you can check and report its status.";
  // SECRET-1: the head has to take the outcome too. It used to end "you never see the value and it
  // is not in this conversation" on every route, and on the shell route the second half is true and
  // the first half is false: the value IS the agent's own environment from here on, so `echo $FIELD`
  // returns it. A head that denies what the tail then grants is the confident wrong beat the model
  // repeats to the user, so the shell head claims only what holds.
  const head=outcome?.shellField!=null
    ?`[The user securely provided the requested secret: "${r.label}". It was written straight to its destination (${destination}); it is not in this conversation, and the only place you can reach it is your own shell environment.]`
    :`[The user securely provided the requested secret: "${r.label}". It was written straight to its destination (${destination}); you never see the value and it is not in this conversation.]`;
  return[head,tail].join("\n");
}

