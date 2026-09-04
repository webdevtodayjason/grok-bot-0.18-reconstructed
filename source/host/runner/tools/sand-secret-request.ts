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
 */
export function buildSecretProvidedAck(r:{label:string;target:{kind:string}},outcome?:{destination:string;server?:string;restarted?:boolean}):string{
  const destination=outcome?.destination??r.target.kind;
  const tail=outcome?.server!=null
    ? outcome.restarted===true
      ? `The "${outcome.server}" connector was restarted with it; its tools pick the value up on their next call, so check before reporting it live. Confirm to the user that it is set, then continue.`
      : `It is stored for the "${outcome.server}" connector, but the connector did not restart, so tell the user it may need a restart before its tools can use it.`
    : "Confirm to the user that it is set, then continue. For a connector credential, the connection links within a few seconds, so you can check and report its status.";
  return[`[The user securely provided the requested secret: "${r.label}". It was written straight to its destination (${destination}); you never see the value and it is not in this conversation.]`,tail].join("\n");
}

