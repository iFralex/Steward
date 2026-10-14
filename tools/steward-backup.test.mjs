import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupData } from './steward-backup.mjs';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'steward-backup-'));
  const home=join(dir,'home'), support=join(home,'Library/Application Support');
  const chats=join(support,'steward-chats'), writes=join(support,'write-ops');
  mkdirSync(chats,{recursive:true}); mkdirSync(writes,{recursive:true});
  const db=new Database(join(chats,'chats.db'));
  db.exec('CREATE TABLE chats(id TEXT,session_file TEXT)');
  const session=join(chats,'session.jsonl');writeFileSync(session,'{"private":"conversation"}\n');
  db.prepare('INSERT INTO chats VALUES (?,?)').run('one',session);db.close();
  const ops=new Database(join(writes,'ops.db'));ops.exec('CREATE TABLE write_ops(id TEXT,status TEXT)');ops.exec("INSERT INTO write_ops VALUES ('op','started')");ops.close();
  const config=join(support,'Steward/config.env');mkdirSync(join(support,'Steward'),{recursive:true});
  writeFileSync(config,'STEWARD_AUTH_TOKEN=private-key\n');writeFileSync(join(support,'Steward/voice-settings.json'),'{"rate":175}');
  return {dir,home,support,config};
}

test('operational backup preserves journal, sessions and configuration with restrictive permissions',async()=>{
  const f=fixture(), destination=join(f.dir,'snapshot');
  const result=await backupData({destination,configFile:f.config,homeDirectory:f.home});
  assert.ok(result.manifest.databases.some(db=>db.name==='write-ops'));
  const db=new Database(join(destination,'write-ops.db'),{readonly:true});
  assert.equal(db.prepare('SELECT status FROM write_ops').get().status,'started');db.close();
  assert.match(readFileSync(join(destination,'sessions/session.jsonl'),'utf8'),/conversation/);
  assert.ok(existsSync(join(destination,'settings/voice-settings.json')));
  assert.equal(statSync(join(destination,'config.env')).mode & 0o777,0o600);
  assert.equal(statSync(destination).mode & 0o777,0o700);
});

test('full backup adds vault, blobs and uploads without recursing into its own output',async()=>{
  const f=fixture(),wiki=join(f.dir,'vault');mkdirSync(wiki,{recursive:true});writeFileSync(join(wiki,'page.md'),'knowledge');
  const blobs=join(f.support,'mail-mirror/blobs'),uploads=join(f.support,'steward-uploads');
  mkdirSync(blobs,{recursive:true});mkdirSync(uploads,{recursive:true});writeFileSync(join(blobs,'blob'),'bytes');writeFileSync(join(uploads,'file.pdf'),'pdf');
  const destination=join(f.support,'Steward/backups/full');
  await backupData({destination,configFile:f.config,homeDirectory:f.home,full:true,wikiPath:wiki});
  assert.equal(readFileSync(join(destination,'wiki-vault/page.md'),'utf8'),'knowledge');
  assert.ok(existsSync(join(destination,'mail-blobs/blob')));assert.ok(existsSync(join(destination,'uploads/file.pdf')));
  assert.equal(existsSync(join(destination,'settings/backups')),false);
  await assert.rejects(backupData({destination:join(wiki,'recursive'),configFile:f.config,homeDirectory:f.home,full:true,wikiPath:wiki}),/outside/);
});
