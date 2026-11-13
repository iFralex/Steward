import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require('esbuild'); } catch { esbuild = require('../../.local-models/mail-gate-dev/node_modules/esbuild'); }
const { build } = esbuild;
import { resolve } from 'node:path';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
const root=process.cwd();
const common={bundle:true,platform:'node',format:'esm',target:'node20',nodePaths:[resolve('.local-models/mail-gate-dev/node_modules')],external:['better-sqlite3','sqlite-vec','ws','fsevents'],banner:{js:"import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);"},plugins:[{name:'workspaces',setup(b){b.onResolve({filter:/^@steward\//},args=>({path:resolve(root,'packages',args.path.split('/')[1],'src/index.ts')}));}}]};
const out=resolve('.local-models/mail-gate/build');mkdirSync(out,{recursive:true});
await build({...common,entryPoints:['apps/mail-promoter/src/cli.ts'],outfile:resolve(out,'mail-promoter.mjs')});
await build({...common,entryPoints:['apps/mail-promoter/src/triage.ts'],outfile:resolve(out,'triage-policy.mjs')});
await build({...common,entryPoints:['apps/mail-promoter/src/gte-input.ts'],outfile:resolve(out,'gte-input.mjs')});
for(const name of readdirSync('apps/mail-promoter/test').filter(x=>x.endsWith('.test.ts')))await build({...common,entryPoints:[resolve('apps/mail-promoter/test',name)],outfile:resolve(out,name.replace('.ts','.mjs'))});
console.log('Built mail-promoter and test bundles');
