import type { DebouncePolicy } from "../../../internal/scheduling.js";
import { readSandBoxSetting, resolveMemoryDreamingEnabled, SAND_MEMORY_DREAMING_SETTING } from "../../sand-box-setting.js";
import { AgentProjectMembership } from "./project-membership.js";
import { createSandAgentState, type AgentStateDeps } from "./agent-state.js";
import { MemoryService } from "./memory-service.js";
export interface MemoryExtensionContext {
  sandRoot:string;agentsRootDir:string;debounce:DebouncePolicy;
  deps:{experiments:{pinGateOnAuthenticatedBootstrap(name:string,listener:(enabled:boolean)=>void):void};inference:{port:{createSession(onRequestId:(requestId:string)=>void,options:{modelId:string;isSummarizationSession:boolean;skipLabeling:boolean}):{getExecutor():import("../../../packages/chat-inference/base.js").PromptExecutor<Record<string,any>>}}};telemetry:{logs:{reportMemorySynthesis(event:unknown):void}}};
  createSynthesis(service:MemoryService):{start():void;dispose():void;recordTurn?(agentId:string,exchange:unknown):void};
  onStop(fn:()=>void):void;
}
export const memoryExtension={id:"memory",dependencies:["experiments","inference","telemetry"]as const,start(context:MemoryExtensionContext){
  const service=new MemoryService({sandRoot:context.sandRoot,agentsRootDir:context.agentsRootDir,debounce:context.debounce});
  // Arming is what makes a turn count as evidence: the memory store only hands the runner a
  // recordMemoryEvidence hook while a synthesis service exists, so an unarmed host silently
  // records nothing at all. Say which way it went and why, once, at start.
  const arm=(enabled:boolean,source:string)=>{
    console.log(`[sand][memory] synthesis ${enabled?"armed":"off"} (${source})`);
    if(!enabled){context.deps.telemetry.logs.reportMemorySynthesis({outcome:"skipped_gate"});return}
    service.enableMemorySynthesis(context.createSynthesis(service));
  };
  // The gate only ever pins at an authenticated Statsig bootstrap, which needs a Cursor login, so
  // on this box the listener never fired and durable memory could not be written by construction.
  // A host switch that is actually set decides here instead, at start, without waiting for it.
  const override=readSandBoxSetting(SAND_MEMORY_DREAMING_SETTING);
  if(override!==undefined)arm(resolveMemoryDreamingEnabled(override,()=>false),`host setting ${SAND_MEMORY_DREAMING_SETTING}`);
  else context.deps.experiments.pinGateOnAuthenticatedBootstrap("sand_memory_dreaming",(enabled)=>arm(enabled,"gate sand_memory_dreaming"));
  context.onStop(()=>service.dispose());
  return Object.assign(service,{createAgentState:(options:Omit<AgentStateDeps,"sandRoot"|"membership">&{agentDir:string})=>createSandAgentState({...options,sandRoot:context.sandRoot,membership:new AgentProjectMembership(options.agentDir)})})}};
