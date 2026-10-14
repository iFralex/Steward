import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFetch } from '@/lib/auth';

type Snapshot = {
  connectors:Record<string,{state:string}>;
  tasks:Record<string,{state:string}>;
};
export function PreparationBanner({httpBase,token,connected,onUnauthorized,onDetails}:{
  httpBase:string;token:string;connected:boolean;onUnauthorized:()=>void;onDetails:()=>void;
}) {
  const {t}=useTranslation();
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const unauthorized=useRef(onUnauthorized);unauthorized.current=onUnauthorized;
  useEffect(()=>{
    setSnapshot(null);
    if(!connected)return;
    let stopped=false;
    let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      let complete=false;
      try {
        const response=await authFetch(`${httpBase}/system/preparation`,token,()=>unauthorized.current());
        if(response.ok) {
          const next=await response.json() as Snapshot;
          if(stopped)return;
          setSnapshot(next);
          const connections=Object.values(next.connectors),tasks=Object.values(next.tasks);
          complete=(connections.length>0||tasks.length>0)&&connections.every(item=>item.state!=='connecting')&&tasks.every(item=>!['queued','running'].includes(item.state));
        }
      } catch { /* retry while the connection is active */ }
      if(!stopped&&!complete)timer=setTimeout(poll,1000);
    };
    void poll();
    return()=>{stopped=true;clearTimeout(timer);};
  },[httpBase,token,connected]);
  if(!connected||!snapshot)return null;
  const connections=Object.values(snapshot.connectors),tasks=Object.values(snapshot.tasks);
  const busy=connections.some(item=>item.state==='connecting')||tasks.some(item=>['queued','running'].includes(item.state));
  const failed=connections.some(item=>item.state==='error')||tasks.some(item=>item.state==='error');
  if(!busy&&!failed)return null;
  return <div role="status" className="bg-muted/60 text-muted-foreground flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs">
    <span>{t(busy?'app.preparation.running':'app.preparation.failed')}</span>
    <button type="button" onClick={onDetails} className="shrink-0 underline underline-offset-2">{t('app.preparation.details')}</button>
  </div>;
}
