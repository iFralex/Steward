#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync, readdirSync, lstatSync, chmodSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

function hash(path) {
  const h = createHash('sha256'), fd = openSync(path, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = readSync(fd, buffer)) > 0;) h.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return h.digest('hex');
}
function configValues(path) {
  const values = {};
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
function nested(parent, child) { const r = relative(resolve(parent), resolve(child)); return !r || (!r.startsWith('..') && !isAbsolute(r)); }

/** Each SQLite file uses its backup API. Sessions/configuration remain explicit primary artifacts. */
export async function backupData({ destination, configFile, homeDirectory = process.env.STEWARD_BACKUP_HOME ?? homedir(), full = false, wikiPath } = {}) {
  if (!destination || !configFile) throw new Error('Backup requires destination and configFile');
  const values = { ...configValues(configFile) };
  const support = join(homeDirectory, 'Library', 'Application Support');
  const steward = join(support, 'Steward');
  const chats = values.CHATS_DIR || join(support, 'steward-chats');
  const wikiState = join(support, 'com.llmwiki.app');
  if (full && !wikiPath) {
    wikiPath = values.WIKI_PROJECT_PATH || process.env.WIKI_PROJECT_PATH;
    if (!wikiPath && existsSync(join(wikiState, 'app-state.json'))) {
      const state = JSON.parse(readFileSync(join(wikiState, 'app-state.json'), 'utf8'));
      wikiPath = state.lastProject?.path ?? state.currentProject?.path;
    }
    if (!wikiPath) throw new Error('Full backup requires --wiki=PATH or WIKI_PROJECT_PATH');
  }
  if (full && (!existsSync(wikiPath) || !lstatSync(wikiPath).isDirectory())) throw new Error('Wiki vault does not exist or is not a regular directory');
  const final = resolve(destination), staging = `${final}.pending-${randomUUID()}`;
  if (existsSync(final)) throw new Error('Backup destination already exists; choose a new directory');
  for (const source of [steward, chats, wikiState, ...(wikiPath ? [wikiPath] : [])]) {
    if (nested(source, final) && source !== steward) throw new Error('Backup output must be outside the source being copied');
  }
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, kind: full ? 'full' : 'operational', createdAt: new Date().toISOString(), databases: [], files: [], roots: [], missing: [], credentials: 'Keychain credentials are external; recover them through macOS Keychain/Time Machine.', consistency: 'SQLite-consistent per database; stop writers for a common cross-store point in time.' };
  const dbs = [
    ['chats', join(chats, 'chats.db')],
    ['audit', join(values.AUDIT_DIR || join(support, 'steward-audit'), 'audit.db')],
    ['usage', join(values.USAGE_DIR || join(support, 'steward-usage'), 'usage.db')],
    ['watches', values.WATCH_DB || join(steward, 'watches.db')],
    ['actions', values.ACTION_CENTER_DB || join(values.ACTION_CENTER_DIR || join(support, 'action-center'), 'actions.db')],
    ['write-ops', join(values.WRITE_OPS_DIR || join(support, 'write-ops'), 'ops.db')],
    ['mail', join(values.MAIL_MIRROR_DIR || join(support, 'mail-mirror'), 'mail.db')],
    ['promotion', join(support, 'mail-promoter', 'state.db')],
    ['calendar', values.CALENDAR_INDEX_DB || join(support, 'steward', 'calendar-index.sqlitedb')],
    ['contacts', values.CONTACTS_INDEX_DB || join(support, 'steward', 'contacts-index.sqlitedb')],
  ];
  for (const [name, source] of dbs) {
    if (!existsSync(source)) { manifest.missing.push({ name, source }); continue; }
    const db = new Database(source, { readonly: true, fileMustExist: true });
    const target = join(staging, `${name}.db`);
    try { await db.backup(target); } finally { db.close(); }
    chmodSync(target, 0o600);
    manifest.databases.push({ name, source, backup: `${name}.db`, sha256: hash(target) });
  }
  const copy = (source, targetRel, filter = () => true) => {
    if (!existsSync(source)) { manifest.missing.push({ source, backup: targetRel }); return; }
    if (nested(source, staging) && source !== steward) throw new Error('Recursive backup destination');
    const target = join(staging, targetRel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const transfer = (from, to) => {
      if (!filter(from)) return;
      if (lstatSync(from).isDirectory()) {
        mkdirSync(to, { recursive: true, mode: 0o700 });
        for (const name of readdirSync(from)) transfer(join(from, name), join(to, name));
      } else cpSync(from, to, { dereference: false });
    };
    transfer(source, target);
    manifest.roots.push({ source, backup: targetRel });
    const walk = path => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return; // preserve link itself, never export an external target
      chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
      else manifest.files.push({ backup: relative(staging, path), sha256: hash(path) });
    };
    walk(target);
  };
  const noDatabase = path => !/\.(?:db|sqlitedb)(?:-wal|-shm)?$/.test(path);
  copy(configFile, 'config.env');
  copy(chats, 'sessions', noDatabase);
  // Include explicitly referenced session files outside CHATS_DIR as well.
  const chatDb = join(chats, 'chats.db');
  if (existsSync(chatDb)) {
    const db = new Database(chatDb, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'").all();
      if (tables.length) for (const row of db.prepare('SELECT id,session_file FROM chats WHERE session_file IS NOT NULL').all()) {
        if (!nested(chats, row.session_file)) copy(row.session_file, join('external-sessions', `${createHash('sha256').update(String(row.id)).digest('hex')}.jsonl`));
      }
    } finally { db.close(); }
  }
  const excluded = new Set(['deploy', 'backups', 'ringback', 'calendar-bridge']);
  copy(steward, 'settings', path => {
    const rel = relative(steward, path);
    return !nested(staging, path) && !nested(final, path) && !excluded.has(rel.split('/')[0]) && noDatabase(path) && !/voice-call-settings\.json$/.test(path);
  });
  copy(wikiState, 'wiki-settings', path => !/\/(?:logs|cache|Cache|WebKit)(?:\/|$)/.test(path));
  for (const key of ['STEWARD_VOICE_SETTINGS_FILE', 'STEWARD_VOICE_NETWORK_SETTINGS_FILE']) {
    if (values[key] && !nested(steward, values[key])) copy(values[key], join('external-settings', key));
  }
  if (full) {
    copy(wikiPath, 'wiki-vault');
    const sources = values.MAIL_PROMOTER_WIKI_SOURCES_DIR || values.WIKI_SOURCES_DIR;
    if (sources && !nested(wikiPath, sources)) copy(sources, 'wiki-source-override');
    copy(values.UPLOAD_DIR || join(support, 'steward-uploads'), 'uploads');
    copy(join(values.MAIL_MIRROR_DIR || join(support, 'mail-mirror'), 'blobs'), 'mail-blobs');
  }
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  renameSync(staging, final); // incomplete snapshots never look complete
  return { destination: final, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const kind = process.argv[2];
  if (!['operational', 'full'].includes(kind)) throw new Error('Usage: steward-backup.mjs operational|full --output=PATH [--wiki=PATH]');
  const config = process.env.STEWARD_CONFIG_FILE ?? join(homedir(), 'Library/Application Support/Steward/config.env');
  const output = option('output') ?? join(dirname(config), 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  backupData({ destination: output, configFile: config, full: kind === 'full', wikiPath: option('wiki') }).then(result => {
    console.log(`Created ${result.manifest.kind} backup: ${result.destination}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
