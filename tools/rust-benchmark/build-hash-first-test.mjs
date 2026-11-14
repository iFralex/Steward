import{build}from'../../.local-models/mail-gate-dev/node_modules/esbuild/lib/main.js';import{resolve}from'node:path';import{readFileSync}from'node:fs';
const target=resolve('apps/mail-promoter/src/run.ts');
const before=`  const input = buildThreadInput(deps.store, threadId);\n  if (!input) return "skipped";\n  const hash = threadHash(input.messages);\n  if (!deps.state.needsProcessing(key, hash)) { deps.control?.count("unchanged"); return "skipped"; }`;
const after=`  const raw = deps.store.raw.prepare("SELECT subject, body_text FROM messages WHERE thread_id=? AND deleted=0 ORDER BY date ASC").all(threadId) as {subject:string|null;body_text:string|null}[];\n  if (!raw.length) return "skipped";\n  const firstHash = threadHash(raw.map(m => ({subject:m.subject ?? "", bodyText:m.body_text ?? ""})));\n  if (!deps.state.needsProcessing(key, firstHash)) { deps.control?.count("unchanged"); return "skipped"; }\n  const input = buildThreadInput(deps.store, threadId);\n  if (!input) return "skipped";\n  const hash = threadHash(input.messages);\n  if (!deps.state.needsProcessing(key, hash)) { deps.control?.count("unchanged"); return "skipped"; }`;
const guarded = `  const raw = deps.store.raw.prepare("SELECT subject, body_text, date, to_addrs, cc_addrs, reference_ids, to_names, cc_names, body_extraction FROM messages WHERE thread_id=? AND deleted=0 ORDER BY date ASC").all(threadId) as Record<string, unknown>[];
  if (!raw.length) return "skipped";
  let safe = true;
  for (const m of raw) {
    try {
      for (const k of ["to_addrs", "cc_addrs", "reference_ids", "to_names", "cc_names"]) JSON.parse((m[k] as string) || "[]");
      if (m.body_extraction) JSON.parse(m.body_extraction as string);
      new Date(((m.date as number) ?? 0) * 1000).toISOString();
      if (m.body_text != null && (typeof m.body_text !== "string" || m.body_text.includes("&#"))) safe = false;
    } catch { safe = false; }
  }
  const firstHash = threadHash(raw.map(m => ({ subject: (m.subject as string) ?? "", bodyText: (m.body_text as string) ?? "" })));
  if (safe && !deps.state.needsProcessing(key, firstHash)) { deps.control?.count("unchanged"); return "skipped"; }
  const input = buildThreadInput(deps.store, threadId);
  if (!input) return "skipped";
  const hash = threadHash(input.messages);
  if (!deps.state.needsProcessing(key, hash)) { deps.control?.count("unchanged"); return "skipped"; }`;
for(const variant of ['baseline','hash-first','guarded'])await build({entryPoints:[process.env.STEWARD_HASH_TEST_ENTRY ?? 'apps/mail-promoter/test/run.test.ts'],outfile:resolve(`.local-evals/mcp-rust-benchmark/tests/promoter-${variant}.mjs`),bundle:true,platform:'node',format:'esm',target:'node24',nodePaths:[resolve('.local-models/mail-gate-dev/node_modules')],external:['better-sqlite3','sqlite-vec'],banner:{js:"import {createRequire as _cr} from 'node:module';const require=_cr(import.meta.url);"},plugins:[{name:'workspace-and-prototype',setup(b){b.onResolve({filter:/^@steward\//},a=>({path:resolve('packages',a.path.split('/')[1],'src/index.ts')}));b.onLoad({filter:/run\.ts$/},a=>{if(a.path!==target||variant==='baseline')return;const contents=readFileSync(a.path,'utf8');if(contents.split(before).length!==2)throw Error('unsupported source');return{contents:contents.replace(before,variant==='guarded'?guarded:after),loader:'ts',resolveDir:resolve('apps/mail-promoter/src')};});}}]});
