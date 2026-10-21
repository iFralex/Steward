// Read-only evaluation by default. --apply-plan=PATH applies a reviewed audit.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../apps/mail-mirror/src/store.ts";
import { dbPath } from "../apps/mail-mirror/src/paths.ts";
import { parseEmlxFile, sliceMessageBytes } from "../apps/mail-mirror/src/emlx.ts";
import { BODY_EXTRACTOR_VERSION, looksLikeHtml, alternativeRanges, type BodyExtraction } from "../apps/mail-mirror/src/body.ts";
import { readDb } from "../apps/mail-mcp/src/db-read.ts";

const option = (name: string) => process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const reference = option("reference");
const applyPlan = option("apply-plan");
const pending = process.argv.includes("--pending");
if (!reference && !applyPlan && !pending) throw new Error("Use --pending [--limit=500], --reference=before.json [--controls=100], or --apply-plan=plan.json");
type Before = { message_id:string; body_text:string; body_extraction:string|null; body_state:string; size:number; snippet:string; updated_at:number; emlx_path:string; from_addr:string; subject:string };
type Planned = { before:Before; text:string; extraction:BodyExtraction; group:string; coverage:number };
const store = applyPlan ? Store.open(dbPath()) : Store.openReadonly(dbPath());
const dir = join(process.cwd(), "tmp", `mail-body-v${BODY_EXTRACTOR_VERSION}-${Date.now()}`);
mkdirSync(dir,{recursive:true,mode:0o700});
const write = (name:string,value:unknown) => writeFileSync(join(dir,name),JSON.stringify(value,null,2),{mode:0o600});

function content(text:string):string {
  return text.replace(/https?:\/\/\S+/g, "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
function coverage(before:string,after:string):number {
  const a=[...content(before)], b=[...content(after)];
  if(!a.length) return 1;
  if(a.length<5) return b.join("").includes(a.join("")) ? 1 : 0;
  const available=new Set<string>();
  for(let i=0;i<=b.length-5;i++)available.add(b.slice(i,i+5).join(""));
  let found=0,total=0;
  for(let i=0;i<=a.length-5;i++){total++; if(available.has(a.slice(i,i+5).join("")))found++;}
  return Math.round(found/total*1000)/1000;
}

try {
  if (applyPlan) {
    const plan=JSON.parse(readFileSync(applyPlan,"utf8")) as Planned[];
    if(plan.some(p=>p.extraction.version!==BODY_EXTRACTOR_VERSION || !p.extraction.sourceHash)) throw new Error("Wrong extractor version or missing source hash");
    for(const p of plan) {
      const hash=createHash("sha256").update(p.text).digest("hex");
      if(p.extraction.textHash && p.extraction.textHash!==hash)throw new Error("Plan text does not match extraction provenance");
      p.extraction.textHash=hash;p.extraction.textBytes=Buffer.byteLength(p.text);
      p.extraction.alternatives ??= alternativeRanges(p.text,p.extraction);
    }
    write("before.json",plan.map(p=>p.before));
    let updated=0, changed=0, skipped=0, verified=0;
    for(const p of plan) {
      try {
        const bytes=sliceMessageBytes(await readFile(p.before.emlx_path));
        if(createHash("sha256").update(bytes).digest("hex")!==p.extraction.sourceHash){skipped++;continue;}
      } catch {skipped++;continue;}
      if(!store.updateBody(p.before.message_id,p.before.body_text,p.text,p.extraction)){skipped++;continue;}
      updated++;
      if(p.before.body_text!==p.text)changed++;
      const detail=await readDb(store,{messageId:p.before.message_id},async()=>{throw new Error("Unexpected live fallback");});
      if(detail.body!==p.text || detail.bodyExtraction?.sourceHash!==p.extraction.sourceHash)throw new Error(`Read mismatch: ${p.before.message_id}`);
      verified++;
      if(updated%100===0)console.log(JSON.stringify({updated,changed,verified}));
    }
    const summary={updated,changed,skipped,verified,backup:join(dir,"before.json")};
    write("summary.json",summary);console.log(JSON.stringify(summary));
  } else {
    const original = reference ? JSON.parse(readFileSync(reference,"utf8")) as Before[] : [];
    const targets: {row:Before;group:string}[]=[];
    const ids=new Set<string>();
    if (pending) {
      const columns=store.raw.prepare("PRAGMA table_info(messages)").all() as {name:string}[];
      const stale=columns.some(c=>c.name==='body_extraction') ? "AND (COALESCE(json_extract(body_extraction,'$.version'),0) < ? OR json_extract(body_extraction,'$.textHash') IS NULL)" : "";
      const limit=Number(option("limit")??500);
      if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error("--limit must be between 1 and 1000");
      const query=store.raw.prepare(`SELECT * FROM messages WHERE deleted=0 AND source='emlx' ${stale} ORDER BY date DESC LIMIT ?`);
      const rows=(stale?query.all(BODY_EXTRACTOR_VERSION,limit):query.all(limit)) as Before[];
      for(const row of rows){targets.push({row,group:"migration"});ids.add(row.message_id);}
    }
    for(const old of original){
      const row=store.raw.prepare("SELECT * FROM messages WHERE message_id=? AND deleted=0").get(old.message_id) as Before|undefined;
      if(!row)continue;
      ids.add(row.message_id);
      targets.push({row,group:!old.body_text.trim()?"previously-empty":looksLikeHtml(old.body_text)?"mislabeled-html":"plain-fallback"});
    }
    const controls=Number(option("controls")??(pending?0:100));
    if(!Number.isSafeInteger(controls)||controls<0||controls>1000)throw new Error("--controls must be between 0 and 1000");
    const recent=store.raw.prepare("SELECT * FROM messages WHERE deleted=0 AND source='emlx' ORDER BY date DESC LIMIT ?").all(controls+ids.size) as Before[];
    let selected=0;
    for(const row of recent)if(!ids.has(row.message_id)&&row.body_text.trim()&&selected<controls){targets.push({row,group:"control"});selected++;}
    console.log(JSON.stringify({targets:targets.length,controls:selected}));
    const plan:Planned[]=[], failures:{messageId:string;group:string;reason:string}[]=[];
    const knownChecks:Record<string,string[]>={
      "202610061626.23793139709@smtp-relay.mailin.fr":["le fatture relative al risparmio","quietanza di pagamento","ultimare il tuo modello redditi"],
      "202609210933.85220980051@smtp-relay.mailin.fr":["non siamo riusciti ad addebitare","Paga ora"],
    };
    for(let start=0;start<targets.length;start+=4){
      await Promise.all(targets.slice(start,start+4).map(async({row,group})=>{
        try {
          const parsed=await parseEmlxFile(row.emlx_path);
          if(parsed.messageId!==row.message_id)throw new Error("Message-ID mismatch");
          if(!parsed.bodyExtraction)throw new Error("Missing extraction provenance");
          if(!parsed.bodyText.trim() && row.body_text.trim())throw new Error("New extraction empty; retained existing body");
          for(const phrase of knownChecks[row.message_id]??[])if(!content(parsed.bodyText).includes(content(phrase)))throw new Error(`Missing expected content: ${phrase}`);
          plan.push({before:row,text:parsed.bodyText,extraction:parsed.bodyExtraction,group,coverage:coverage(row.body_text,parsed.bodyText)});
        } catch(error){failures.push({messageId:row.message_id,group,reason:String(error)});}
      }));
      if(start%100===0)console.log(JSON.stringify({processed:Math.min(start+4,targets.length),accepted:plan.length,failures:failures.length}));
    }
    const groups:Record<string,Record<string,number>>={};
    const senders:Record<string,number>={};
    for(const p of plan){
      const group=groups[p.group]??={total:0,changed:0,usable:0,ambiguous:0,limited:0,unavailable:0,lowCoverage:0};
      group.total++;group[p.extraction.quality]++;
      if(p.text!==p.before.body_text)group.changed++;
      if(p.coverage<0.9)group.lowCoverage++;
      if(p.group==="plain-fallback")senders[p.before.from_addr]=(senders[p.before.from_addr]??0)+1;
    }
    const summary={version:BODY_EXTRACTOR_VERSION,targets:targets.length,accepted:plan.length,failures:failures.length,groups,senders,knownChecks:"passed for all present examples"};
    write("summary.json",summary);write("failures.json",failures);write("plan.json",plan);
    write("review.json",plan.filter(p=>p.coverage<0.9||p.extraction.quality==="limited").map(p=>({messageId:p.before.message_id,subject:p.before.subject,group:p.group,coverage:p.coverage,extraction:p.extraction})));
    console.log(JSON.stringify({...summary,report:join(dir,"summary.json"),plan:join(dir,"plan.json")}));
  }
} finally {store.close();}
