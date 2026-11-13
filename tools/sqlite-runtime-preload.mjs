/** Scoped Node preload: use patched SQLite without changing the signed app. */
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, '.local-models/sqlite-runtime/runtime.json');
const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const configured = JSON.parse(readFileSync(manifestPath, 'utf8'));
const allowed = configured.allowedEntryRoots.some(path => entry.startsWith(path + sep));
// Do not change unrelated Node programs launched by a shell tool.
if (allowed || process.env.STEWARD_SQLITE_RUNTIME_TEST === '1') {
  const require = createRequire(import.meta.url);
  const Database = require(configured.moduleEntry);
  const probe = new Database(':memory:');
  const version = probe.prepare('SELECT sqlite_version() version').get().version;
  probe.close();
  if (version !== configured.sqliteVersion) throw new Error('Unexpected SQLite runtime version');
  const target = pathToFileURL(configured.moduleEntry).href;
  const bundled = pathToFileURL(realpathSync(configured.bundledModuleEntry)).href;
  const hostUrl = pathToFileURL(configured.hostEntry).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'better-sqlite3') return { url: target, shortCircuit: true };
      const result = nextResolve(specifier, context);
      return result.url === bundled ? { url: target, shortCircuit: true } : result;
    },
    load(url, context, nextLoad) {
      if (configured.gateway && url === pathToFileURL(configured.gateway.entry).href) {
        const original = readFileSync(configured.gateway.entry);
        const source = readFileSync(configured.gateway.bundle);
        if (createHash('sha256').update(original).digest('hex') !== configured.gateway.originalSha256 ||
            createHash('sha256').update(source).digest('hex') !== configured.gateway.bundleSha256)
          throw new Error('Gateway bundle changed: review Usage origin override before starting');
        return { format: 'module', source: source.toString('utf8'), shortCircuit: true };
      }
      if (url !== hostUrl) return nextLoad(url, context);
      const original = readFileSync(configured.hostEntry);
      if (createHash('sha256').update(original).digest('hex') !== configured.hostSha256)
        throw new Error('Host bundle changed: review SQLite runtime override before starting');
      let source = original.toString('utf8');
      const replacements = [
        ['gatewayRatesMap(config3.gateway.baseUrl).then((ratesMap) => {',
         'gatewayRatesMap(config3.gateway.baseUrl).then(async (ratesMap) => {'],
        ['const summary = usageLedger().summary(days);',
         'const summary = await globalThis.__stewardUsageSummary(days);'],
        ['ledger.summary().byTool.map((row)',
         'ledger.raw.prepare("SELECT tool, COUNT(*) calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors FROM tool_calls GROUP BY tool").all().map((row)'],
      ];
      for (const [from, to] of replacements) {
        if (source.split(from).length !== 2) throw new Error('Unsupported host Usage implementation');
        source = source.replace(from, to);
      }
      return { format: 'module', source, shortCircuit: true };
    },
  });
  process.env.STEWARD_USAGE_SUMMARY_WORKER = configured.summaryWorker;
  if (configured.peerHelper) process.env.STEWARD_GATEWAY_PEER_BIN = configured.peerHelper;
  globalThis.__stewardUsageSummary = (await import(pathToFileURL(configured.summaryClient).href)).usageSummary;
  // The MCP SDK intentionally filters the host environment. Forward only this
  // runtime flag to Node children whose entry is a trusted Steward service;
  // never widen the connector environment or affect shell/external commands.
  const spawn = childProcess.spawn;
  childProcess.spawn = function(command, args, options) {
    if (command === process.execPath && Array.isArray(args) && args.some(arg =>
      configured.allowedEntryRoots.some(path => typeof arg === 'string' && arg.startsWith(path + sep)))) {
      const flag = '--import=' + pathToFileURL(configured.preload).href;
      const existing = (options?.env ?? process.env).NODE_OPTIONS ?? '';
      options = { ...options, env: { ...(options?.env ?? process.env),
        NODE_OPTIONS: existing.includes(flag) ? existing : [existing, flag].filter(Boolean).join(' ') } };
    }
    return spawn.call(this, command, args, options);
  };
  syncBuiltinESMExports();
  appendFileSync(configured.activationLog, JSON.stringify({ utc: new Date().toISOString(), pid: process.pid,
    threadId, entry, sqliteVersion: version, packageVersion: configured.packageVersion }) + '\n', { mode: 0o600 });
}
