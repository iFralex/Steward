import { gatewayCredential } from "@steward/protocol";
import type { McpBridge, ConnectorState } from '@steward/mcp-bridge';
import type { HostConfig } from '../config.ts';

export type PreparationTask = {state:'queued'|'running'|'ready'|'skipped'|'error';detail?:string;durationMs?:number};
export type PreparationSnapshot = {connectors:Record<string,ConnectorState>;tasks:Record<string,PreparationTask>};
let current:StartupPreparation|undefined;

/** One heavy preparation at a time; ready MCP tools are never held behind this queue. */
export class StartupPreparation {
  private stopped=false;
  private controller=new AbortController();
  private tasks:Record<string,PreparationTask>={};
  constructor(private bridge:McpBridge, private prepareModel:(signal:AbortSignal)=>Promise<{skipped?:string}>,
    private pause:(signal:AbortSignal)=>Promise<void>=signal=>new Promise(resolve=>{
      if(signal.aborted){resolve();return;}
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,100);signal.addEventListener('abort',done,{once:true});
    })) {
    const connectors=bridge.connectorStates?.()??{};
    for(const id of ['mail','local-embed','calendar','contacts']) {
      this.tasks[id]=id==='local-embed'||connectors[id]?{state:'queued'}:{state:'skipped',detail:'Connector is not configured'};
    }
  }
  snapshot():PreparationSnapshot {return {connectors:this.bridge.connectorStates?.()??{},tasks:structuredClone(this.tasks)};}
  async run() {
    for(const id of ['mail','local-embed','calendar','contacts']) {
      if(this.stopped)return;
      if(this.tasks[id].state==='skipped')continue;
      while(this.bridge.activeCalls&&!this.stopped)await this.pause(this.controller.signal);
      if(this.stopped)return;
      this.tasks[id]={state:'running'};
      const started=Date.now();
      try {
        const result=id==='local-embed'?await this.prepareModel(this.controller.signal)
          :await this.bridge.prepareSearch!(id);
        this.tasks[id]={state:result.skipped?'skipped':'ready',detail:result.skipped,durationMs:Date.now()-started};
      } catch(error) {
        this.tasks[id]={state:'error',detail:error instanceof Error?error.message:String(error),durationMs:Date.now()-started};
      }
    }
  }
  stop(){this.stopped=true;this.controller.abort();}
}
export async function prepareLocalEmbedding(gateway:HostConfig['gateway'],signal:AbortSignal,fetchImpl:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env):Promise<{skipped?:string}> {
  const mailEndpoint=env.MAIL_EMBED_ENDPOINT??'http://127.0.0.1:4000/v1/embeddings';
  const mailModel=env.MAIL_EMBED_MODEL??'local-embed';
  const candidates=[
    {endpoint:mailEndpoint,model:mailModel,key:env.MAIL_EMBED_API_KEY},
    {endpoint:env.DOCUMENT_EMBED_ENDPOINT??mailEndpoint,model:env.DOCUMENT_EMBED_MODEL??mailModel,key:env.DOCUMENT_EMBED_API_KEY??env.MAIL_EMBED_API_KEY},
  ];
  const seen=new Set<string>();
  for(const candidate of candidates) {
    if(candidate.model!=='local-embed'||!candidate.endpoint||candidate.endpoint==='off')continue;
    let url:URL;
    try {url=new URL(candidate.endpoint);}catch{continue;}
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)
      ||url.username||url.password||url.search||url.hash||url.pathname!=='/v1/embeddings')continue;
    if(seen.has(url.href))continue;
    seen.add(url.href);
    const hostEndpoint=gateway.baseUrl.replace(/\/$/,'')+'/embeddings';
    const key=gatewayCredential(url.href,candidate.key,env.GATEWAY_API_KEY,Number(env.GATEWAY_PORT??4000))
      ?? (url.href===hostEndpoint?gateway.apiKey:undefined);
    const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json',
      ...(key?{authorization:`Bearer ${key}`}:{ }),'x-usage-service':'host','x-usage-action':'startup-embedding'},
      body:JSON.stringify({model:'local-embed',input:'Steward startup preparation.'}),
      signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)])});
    if(!response.ok)throw new Error(`Local embedding preparation returned HTTP ${response.status}`);
    const result=await response.json() as {data?:{embedding?:number[]}[]};
    const vector=result.data?.[0]?.embedding;
    if(!Array.isArray(vector)||!vector.length||!vector.every(Number.isFinite))throw new Error('Local embedding preparation returned an invalid vector');
  }
  return seen.size?{}:{skipped:'No enabled local-embed endpoint is configured'};
}
export function beginStartupPreparation(bridge:McpBridge,config:HostConfig):StartupPreparation {
  current?.stop();
  current=new StartupPreparation(bridge,signal=>prepareLocalEmbedding(config.gateway,signal));
  void current.run();
  return current;
}
export function startupPreparationSnapshot():PreparationSnapshot {return current?.snapshot()??{connectors:{},tasks:{}};}
