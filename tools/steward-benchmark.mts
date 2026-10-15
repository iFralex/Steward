/** Read-only, aggregate-only search benchmarks. Document cases use disposable synthetic fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { Store } from '../apps/mail-mirror/src/store.ts';
import { searchDb } from '../apps/mail-mcp/src/db-search.ts';
import { extractDocument } from '../apps/documents-mcp/src/extraction.ts';
import { clearDocumentCache } from '../apps/documents-mcp/src/cache.ts';
import { searchDocument } from '../apps/documents-mcp/src/search.ts';
import { readDocumentPage } from '../apps/documents-mcp/src/output-budget.ts';
import type { ExtractedDocument } from '../apps/documents-mcp/src/types.ts';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const args = process.argv.slice(2);
const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const support = join(homedir(), 'Library/Application Support');
const paths = {
  mail: process.env.BENCH_MAIL_DB ?? join(process.env.MAIL_MIRROR_DIR ?? join(support, 'mail-mirror'), 'mail.db'),
  calendar: process.env.BENCH_CALENDAR_DB ?? process.env.CALENDAR_INDEX_DB ?? join(support, 'steward/calendar-index.sqlitedb'),
  contacts: process.env.BENCH_CONTACTS_DB ?? process.env.CONTACTS_INDEX_DB ?? join(support, 'steward/contacts-index.sqlitedb'),
};
const QUERY = 'project';
const ABSENT = 'stewardbenchmarkabsent9e7318fd';
const SQL_SAMPLES = 31; // One first-process operation, then 30 warm observations.
const DOCUMENT_SAMPLES = 11;
const EMBED_SAMPLES = 11;

type Observation = { count: number; chunks?: number; selectedChunks?: number; embeddedChunks?: number; semantic?: string };
function summarize(samples: number[]) {
  assert.ok(samples.length >= 3 && samples.every(n => Number.isFinite(n) && n >= 0));
  const warm = samples.slice(1).sort((a,b) => a-b);
  const middle = Math.floor(warm.length / 2);
  return { samplesMs: samples, firstMs: samples[0], warmMedianMs: warm.length % 2 ? warm[middle] : (warm[middle-1]+warm[middle])/2,
    warmP95Ms: warm[Math.ceil(warm.length*0.95)-1], warmMinMs: warm[0], warmMaxMs: warm.at(-1)! };
}
function readonly(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only=ON');
  assert.equal(db.pragma('query_only', {simple:true}), 1);
  return db;
}
function gatewayUrl() {
  const url = new URL(process.env.BENCH_GATEWAY_URL ?? 'http://127.0.0.1:4000/v1/embeddings');
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/v1/embeddings' || url.search || url.hash) {
    throw new Error('Benchmark embeddings require a plain HTTP loopback /v1/embeddings endpoint');
  }
  return url.toString();
}
async function embed() {
  const response = await fetch(gatewayUrl(), {method:'POST', headers:{'content-type':'application/json',
    'x-usage-service':'benchmark','x-usage-action':'readonly-embedding',
    ...(process.env.GATEWAY_API_KEY ? {authorization:`Bearer ${process.env.GATEWAY_API_KEY}`} : {})},
    body:JSON.stringify({model:'local-embed',input:QUERY}),signal:AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`Local embedding returned HTTP ${response.status}; configure GATEWAY_API_KEY if required`);
  const body = await response.json() as {data?:{embedding?:number[]}[]};
  const vector = body.data?.[0]?.embedding;
  if (!vector?.length || !vector.every(Number.isFinite)) throw new Error('Invalid local embedding response');
  return vector;
}
function pdfFixture(pages: number) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids: string[]=[];
  for(let i=0;i<pages;i++) {
    const pageId=objects.length+1, streamId=pageId+1;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    const stream=`BT /F1 12 Tf 72 720 Td (Synthetic benchmark page ${i+1}. No personal data.) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let body='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(body);
  body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
  return Buffer.from(body+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
async function documentFixture(caseName: string, directory: string) {
  if(caseName.includes('pdf')) {const path=join(directory,'synthetic.pdf');writeFileSync(path,pdfFixture(20));return path;}
  if(caseName.includes('pptx')) {
    const {default:JSZip}=await import('jszip');const zip=new JSZip();
    for(let i=1;i<=20;i++)zip.file(`ppt/slides/slide${i}.xml`,`<p:sld><a:t>Synthetic benchmark slide ${i}: ${'Generic project text. '.repeat(100)}</a:t></p:sld>`);
    const path=join(directory,'synthetic.pptx');writeFileSync(path,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));return path;
  }
  const size=caseName.includes('2m')?2_000_000:100_000;
  const line='Generic project planning and document retrieval. benchmarktarget marks a synthetic fact.\n';
  const path=join(directory,'synthetic.txt');writeFileSync(path,line.repeat(Math.ceil(size/line.length)).slice(0,size));return path;
}
async function measure(run:()=>Promise<Observation>|Observation, repetitions:number, warmup?:()=>Promise<unknown>|unknown, observeLoop=false) {
  const preparationStart=performance.now();
  await warmup?.();
  const preparationMs=warmup?performance.now()-preparationStart:undefined;
  const samples:number[]=[],counts:number[]=[];let detail:Observation={count:0};
  let firstEventLoop: {intervalMs:number;ticks:number;maxGapMs:number}|undefined;
  for(let i=0;i<repetitions;i++) {
    const start=performance.now();let last=start,ticks=0,maxGapMs=0;
    const timer=observeLoop&&i===0?setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;ticks++;},10):undefined;
    try {detail=await run();samples.push(performance.now()-start);counts.push(detail.count);}
    finally {if(timer){clearInterval(timer);firstEventLoop={intervalMs:10,ticks,maxGapMs:Math.max(maxGapMs,performance.now()-last)};}}
  }
  return {...summarize(samples), preparationMs, firstEventLoop, count:detail.count, counts, ...Object.fromEntries(Object.entries(detail).filter(([key])=>key!=='count'))};
}
async function child(caseName:string, working:string) {
  let db:Database.Database|undefined;
  let mailStore:Store|undefined;
  try {
    if(caseName==='gateway.embed')return await measure(async()=>({count:(await embed()).length}),EMBED_SAMPLES);
    if(caseName.startsWith('documents.')) {
      const path=await documentFixture(caseName,working);
      if(caseName.includes('extract'))return {...await measure(async()=>{clearDocumentCache();const d=await extractDocument(path);if(caseName.includes('pdf')||caseName.includes('pptx'))assert.equal(d.pages.length,20);return {count:d.pages.reduce((n,p)=>n+p.text.length,0)};},DOCUMENT_SAMPLES), inputBytes:statSync(path).size};
      let doc:ExtractedDocument=await extractDocument(path);
      if(caseName.includes('cache'))return await measure(async()=>({count:(await extractDocument(path)).pages.reduce((n,p)=>n+p.text.length,0)}),SQL_SAMPLES);
      if(caseName.includes('read'))return await measure(()=>({count:readDocumentPage(doc,{}).content.length}),SQL_SAMPLES);
      const mocked=caseName.includes('semantic');
      const vector=Array.from({length:1024},(_,i)=>i===0?1:0);
      const config=mocked?{endpoint:'http://synthetic.invalid',model:'benchmark-fixed-vector',outputDimensionality:1024}:null;
      return await measure(async()=>{
        const result=await searchDocument(doc,'benchmarktarget',{},config,mocked?{embedText:async()=>vector,embedTexts:async texts=>texts.map(()=>vector.slice())}:{});
        return {count:result.matches.length,chunks:result.search.totalChunks,selectedChunks:result.search.selectedChunks,embeddedChunks:result.search.embeddedChunks,semantic:result.search.semantic};
      },SQL_SAMPLES);
    }
    const kind=caseName.split('.')[0] as keyof typeof paths;
    db=readonly(paths[kind]);
    const count=(sql:string,...params:unknown[])=>({count:db!.prepare(sql).all(...params).length});
    if(kind==='mail') {
      const store=mailStore=new Store(db,{readonly:true});
      if(caseName==='mail.fts')return await measure(()=>count('SELECT m.message_id FROM messages_fts f JOIN messages m ON m.rowid=f.rowid WHERE messages_fts MATCH ? AND m.deleted=0 ORDER BY rank LIMIT 50',`"${QUERY}"`),SQL_SAMPLES);
      if(caseName==='mail.trigram.subject'||caseName==='mail.trigram.body') {
        const field=caseName.endsWith('subject')?'subject':'body_text';
        return await measure(()=>count(`SELECT m.message_id FROM messages_trig f JOIN messages m ON m.rowid=f.rowid WHERE f.${field} MATCH ? AND m.deleted=0 ORDER BY rank LIMIT 500`,`"${QUERY}"`),SQL_SAMPLES);
      }
      if(caseName==='mail.structured')return await measure(()=>count('SELECT message_id FROM messages WHERE deleted=0 AND unread=1 ORDER BY date DESC LIMIT 20'),SQL_SAMPLES);
      if(caseName==='mail.negative.trigram')return await measure(()=>count('SELECT rowid FROM messages_trig WHERE body_text MATCH ? LIMIT 1',`"${ABSENT}"`),SQL_SAMPLES);
      if(caseName==='mail.negative.like')return await measure(()=>count('SELECT message_id FROM messages WHERE body_text LIKE ? LIMIT 1',`%${ABSENT}%`),SQL_SAMPLES);
      if(caseName==='mail.lexical')return await measure(async()=>({count:(await searchDb(store,{query:QUERY,limit:12,perMessage:true})).length}),SQL_SAMPLES);
      if(caseName==='mail.substring')return await measure(async()=>({count:(await searchDb(store,{bodyContains:QUERY,limit:12,perMessage:true})).length}),SQL_SAMPLES);
      if(caseName.startsWith('mail.knn')||caseName==='mail.hybrid'||caseName==='mail.hybrid.cached-vector'||caseName==='mail.hybrid.unprepared.cached-vector') {
        assert.ok(store.enableVectors(),'sqlite-vec is unavailable');
        const vector=JSON.parse(readFileSync(join(working,'query-vector.json'),'utf8')) as number[];
        assert.equal(vector.length,Number(store.getState('vec_dim')),'Query/index dimension mismatch');
        if(caseName==='mail.knn')return await measure(()=>({count:store.knn(vector,50).length}),SQL_SAMPLES,undefined,true);
        if(caseName.startsWith('mail.knn.worker.'))return await measure(async()=>({count:(await store.knnAsync(vector,50)).length}),SQL_SAMPLES,
          caseName.endsWith('.prepared')?()=>store.prepareSearch():undefined,true);
        // Isolate query embedding cost from the same production retrieval path.
        const queryEmbed=caseName.endsWith('cached-vector')?async()=>vector:embed;
        return await measure(async()=>({count:(await searchDb(store,{query:QUERY,limit:12,perMessage:true},queryEmbed)).length}),caseName.endsWith('cached-vector')?SQL_SAMPLES:EMBED_SAMPLES,
          caseName.includes('.unprepared.')?undefined:()=>store.prepareSearch());
      }
    } else {
      const table=kind==='calendar'?'events':'contacts', limit=kind==='calendar'?500:200;
      if(caseName.endsWith('.fts') || caseName==='contacts.fts.match') {
        const query=kind==='calendar'?'meeting':caseName==='contacts.fts.match'?'università':'university';
        return await measure(()=>count(`SELECT ${table}.uid FROM ${table}_fts f JOIN ${table} ON ${table}.rowid=f.rowid WHERE ${table}_fts MATCH ? ORDER BY rank LIMIT ?`,`"${query}"`,limit),SQL_SAMPLES);
      }
      if(caseName.endsWith('.knn')) {
        sqliteVec.load(db);
        const vector=JSON.parse(readFileSync(join(working,'query-vector.json'),'utf8')) as number[];
        const dim=(db.prepare('SELECT value FROM state WHERE key=?').get(`vec_${table}_dim`) as {value:string}|undefined)?.value;
        assert.equal(vector.length,Number(dim),'Query/index dimension mismatch');
        return await measure(()=>count(`SELECT rowid,distance FROM vec_${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,JSON.stringify(vector),limit),SQL_SAMPLES);
      }
    }
    throw new Error(`Unknown benchmark case: ${caseName}`);
  } finally {if(mailStore)mailStore.close();else db?.close();clearDocumentCache();}
}
function dataset(kind:keyof typeof paths) {
  if(!existsSync(paths[kind]))return {available:false};
  const db=readonly(paths[kind]);
  try {
    const scalar=(sql:string)=>Object.values(db.prepare(sql).get() as Record<string,number>)[0];
    const stateTable=kind==='mail'?'sync_state':'state',key=kind==='mail'?'vec_dim':`vec_${kind==='calendar'?'events':'contacts'}_dim`;
    const dimension=Number((db.prepare(`SELECT value FROM ${stateTable} WHERE key=?`).get(key) as {value:string}|undefined)?.value??0);
    return {available:true,mainBytes:statSync(paths[kind]).size,walBytes:existsSync(paths[kind]+'-wal')?statSync(paths[kind]+'-wal').size:0,
      records:scalar(kind==='mail'?'SELECT count(*) FROM messages WHERE deleted=0':`SELECT count(*) FROM ${kind==='calendar'?'events':'contacts'}`),
      embeddings:scalar('SELECT count(*) FROM embed_state'),dimension,
      ...(kind==='mail'?{threads:scalar('SELECT count(*) FROM threads'),attachments:scalar('SELECT count(*) FROM attachments'),incompleteBodies:scalar("SELECT count(*) FROM messages WHERE deleted=0 AND body_state IN ('partial','none')")}:{}),
      queryOnly:db.pragma('query_only',{simple:true})};
  } finally {db.close();}
}
async function main() {
  if(args.includes('--self-test')) {
    assert.deepEqual(summarize([20,8,2,6,4]).warmMedianMs,5);
    assert.equal(summarize([20,8,2,6,4]).warmP95Ms,8);
    assert.equal(summarize([20,8,2,6,4]).firstMs,20);
    assert.throws(()=>summarize([1]));
    const directory=mkdtempSync(join(tmpdir(),'steward-benchmark-check-'));
    const previous=process.env.BENCH_GATEWAY_URL;
    try {
      const path=join(directory,'fixture.db'),writer=new Database(path);
      writer.exec('CREATE TABLE probe(value INTEGER)');writer.close();
      const reader=readonly(path);
      try {assert.throws(()=>reader.exec('INSERT INTO probe VALUES (1)'),/readonly/i);} finally {reader.close();}
      process.env.BENCH_GATEWAY_URL='https://example.com/v1/embeddings';
      assert.throws(gatewayUrl,/loopback/);
      process.env.BENCH_GATEWAY_URL='http://127.0.0.1:4000/v1/embeddings';
      assert.equal(gatewayUrl(),'http://127.0.0.1:4000/v1/embeddings');
    } finally {
      if(previous===undefined)delete process.env.BENCH_GATEWAY_URL;else process.env.BENCH_GATEWAY_URL=previous;
      rmSync(directory,{recursive:true,force:true});
    }
    console.log('Benchmark statistics/read-only/loopback self-tests passed');return;
  }
  const caseName=option('case'),working=option('working');
  if(caseName&&working){console.log(JSON.stringify(await child(caseName,working)));return;}
  const full=args.includes('--with-local-embeddings'),documentsOnly=args.includes('--documents-only');
  const workspace=mkdtempSync(join(tmpdir(),'steward-benchmark-'));
  const results:Record<string,unknown>={},failures:Record<string,string>={};
  const started=new Date().toISOString();
  try {
    const cases:string[]=[];
    if(!documentsOnly) {
      for(const kind of ['mail','calendar','contacts'] as const) {
        if(!existsSync(paths[kind])){failures[kind]='Index unavailable';continue;}
        cases.push(...(kind==='mail'?['mail.fts','mail.trigram.subject','mail.trigram.body','mail.structured','mail.lexical','mail.substring','mail.negative.trigram','mail.negative.like']:[`${kind}.fts`]));
      }
    }
    if(full&&!documentsOnly) {
      // Only fixed generic text reaches the local model. Query vectors stay temporary.
      writeFileSync(join(workspace,'query-vector.json'),JSON.stringify(await embed()),{mode:0o600});
      cases.unshift('gateway.embed');
      if(existsSync(paths.mail))cases.push('mail.knn','mail.knn.worker.unprepared','mail.knn.worker.prepared','mail.hybrid.unprepared.cached-vector','mail.hybrid.cached-vector','mail.hybrid');
      for(const kind of ['calendar','contacts'] as const)if(existsSync(paths[kind]))cases.push(`${kind}.knn`);
    }
    if(!documentsOnly&&existsSync(paths.contacts))cases.push('contacts.fts.match');
    cases.push('documents.extract.100k','documents.extract.2m','documents.extract.pdf','documents.extract.pptx',
      'documents.cache.2m','documents.read.2m','documents.lexical.100k','documents.lexical.2m','documents.semantic.2m');
    for(const name of cases) {
      console.error(`Benchmarking ${name}...`);
      try {
        const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',script,`--case=${name}`,`--working=${workspace}`],{cwd:root,timeout:120_000,maxBuffer:4*1024*1024});
        results[name]=JSON.parse(stdout.trim());
      } catch(error) {failures[name]=(error as Error).message.split('\n')[0];console.error(`Failed: ${name}`);}
    }
    const report={version:2,benchmarkSha256:createHash('sha256').update(readFileSync(script)).digest('hex'),startedAt:started,finishedAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
      system:{cpu:cpus()[0]?.model,memoryBytes:totalmem(),arch:process.arch,node:process.version,platform:platform(),kernel:release(),
        osVersion:platform()==='darwin'?execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim():undefined},
      method:{sqlSamples:SQL_SAMPLES,documentExtractionSamples:DOCUMENT_SAMPLES,embeddingSamples:EMBED_SAMPLES,
        first:'First timed operation in a fresh child process; OS page cache is not flushed; process/import/connect overhead excluded.',
        warmP95:'Nearest-rank empirical p95 of samples after the first; 10-sample extraction/embedding tails are descriptive only.',
        queries:{mail:QUERY,calendar:'meeting',contactsMiss:'university',contactsMatch:'università',absent:ABSENT},
        preparation:'Prepared worker/hybrid cases await production Store.prepareSearch(); preparationMs is reported separately. Unprepared cases include worker startup in the first timed query. Raw mail.knn remains synchronous for comparison.',
        responsiveness:'Mail KNN first-operation heartbeat uses a 10 ms interval; ticks and maximum observed gap include the final partial interval, exclude preparation, and are descriptive rather than an event-loop percentile.',
        localEmbeddings:full&&!documentsOnly,modelPriming:'When local embeddings are enabled, an untimed generic embedding validates the query vector before measured cases; no model-cold claim.',documents:'Disposable synthetic files; semantic case uses fixed synthetic vectors and does not measure model latency or relevance.',
        privacy:'Read-only/query-only databases; output contains counts/times only. Local gateway requests add benchmark/readonly-embedding usage records.',
        concurrency:'Existing background services were not stopped. Each case is sequential, with one fresh process per case; no forced OS-cold claim.'},
      datasets:documentsOnly?{}:Object.fromEntries((['mail','calendar','contacts'] as const).map(kind=>[kind,dataset(kind)])),results,failures};
    const output=resolve(option('output')??join(root,'tmp/benchmarks',started.replace(/[:.]/g,'-')+'.json'));
    mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(`Aggregate benchmark report: ${output}`);
    console.log(`Completed ${Object.keys(results).length} cases; failures: ${Object.keys(failures).length}`);
    if(Object.keys(failures).length)process.exitCode=1;
  } finally {rmSync(workspace,{recursive:true,force:true});}
}
await main();
