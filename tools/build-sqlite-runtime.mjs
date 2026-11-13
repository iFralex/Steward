/** Build a scoped runtime override when a full signed app rebuild is impractical.
 * Install first: npm install --prefix .local-models/sqlite-runtime better-sqlite3@13.1.1
 * Requires esbuild in root node_modules or .local-models/mail-gate-dev/node_modules.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=resolve(root,'.local-models/sqlite-runtime');
const require=createRequire(import.meta.url);
let esbuild;
try { esbuild=require('esbuild'); }
catch { esbuild=require(resolve(root,'.local-models/mail-gate-dev/node_modules/esbuild')); }
const app=process.env.STEWARD_APP_PATH ?? '/Applications/Steward.app';
const resources=resolve(app,'Contents/Resources');
const moduleEntry=resolve(runtime,'node_modules/better-sqlite3/lib/index.js');
const Database=require(moduleEntry), db=new Database(':memory:');
const sqliteVersion=db.prepare('SELECT sqlite_version() v').get().v;db.close();
const packageVersion=JSON.parse(readFileSync(resolve(runtime,'node_modules/better-sqlite3/package.json'))).version;
if(packageVersion!=='13.1.1'||sqliteVersion!=='3.54.1')throw Error('Unexpected SQLite package; review before deployment');
mkdirSync(resolve(runtime,'lib'),{recursive:true});
for(const name of ['usage-summary','usage-summary-worker','gateway']) await esbuild.build({
  entryPoints:[resolve(root,name==='gateway'?'apps/llm-gateway/src/gateway.ts':`apps/host/src/core/${name}.ts`)],outfile:resolve(runtime,`lib/${name}.mjs`),
  bundle:true,platform:'node',format:'esm',target:'node22',external:['better-sqlite3'],
  banner:{js:"import { createRequire as _cr } from 'node:module'; const require=_cr(import.meta.url);"},
  plugins:[{name:'workspace',setup(b){b.onResolve({filter:/^@steward\//},a=>({path:resolve(root,'packages',a.path.split('/')[1],'src/index.ts')}));}}],
});
const hostEntry=resolve(resources,'services/host/index.js');
const gatewayEntry=resolve(resources,'services/llm-gateway/gateway.js');
const gatewayBundle=resolve(runtime,'lib/gateway.mjs');
const peerHelper=resolve(runtime,'bin/gateway-peer');
mkdirSync(dirname(peerHelper),{recursive:true});
execFileSync('cc',['-O2','-Wall','-Wextra',resolve(root,'tools/gateway-peer.c'),'-o',peerHelper]);
const manifest={schemaVersion:1,packageVersion,sqliteVersion,moduleEntry,
  bundledModuleEntry:resolve(resources,'node_modules/better-sqlite3/lib/index.js'),
  activationLog:resolve(runtime,'activations.jsonl'),
  allowedEntryRoots:[resolve(resources,'services'),realpathSync(resolve(resources,'services')),
    resolve(root,'.local-models/mail-gate/releases'),resolve(runtime,'lib')],
  preload:resolve(root,'tools/sqlite-runtime-preload.mjs'),hostEntry,
  hostSha256:createHash('sha256').update(readFileSync(hostEntry)).digest('hex'),
  summaryClient:resolve(runtime,'lib/usage-summary.mjs'),summaryWorker:resolve(runtime,'lib/usage-summary-worker.mjs'),
  peerHelper, gateway:{entry:gatewayEntry,bundle:gatewayBundle,
    originalSha256:createHash('sha256').update(readFileSync(gatewayEntry)).digest('hex'),
    bundleSha256:createHash('sha256').update(readFileSync(gatewayBundle)).digest('hex')}};
writeFileSync(resolve(runtime,'runtime.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Built better-sqlite3 ${packageVersion} / SQLite ${sqliteVersion}. Config activation is separate.`);
