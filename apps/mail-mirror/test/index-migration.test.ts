import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { Store, ensureMailIndexes } from '../src/store.ts';

const stale = `SELECT message_id FROM messages WHERE deleted=0 AND source='emlx' AND emlx_path IS NOT NULL
 AND (COALESCE(json_extract(body_extraction,'$.version'),0) < ? OR json_extract(body_extraction,'$.textHash') IS NULL)
 ORDER BY date DESC LIMIT 50`;
const recent = `SELECT message_id FROM messages WHERE deleted=0 AND date>=? AND junk=0
 AND length(trim(coalesce(body_text,'')))>0 ORDER BY date DESC LIMIT 300`;
const names = (db: Database.Database, sql: string, value: number) => (db.prepare(sql).all(value) as {message_id:string}[]).map(r=>r.message_id);
const indexes = (db: Database.Database) => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {name:string}[]).map(r=>r.name));
function insert(db: Database.Database, id: string, date: number, extraction: string | null, body='body'): void {
  db.prepare("INSERT INTO messages(message_id,account,body_state,source,emlx_path,date,deleted,junk,body_extraction,body_text) VALUES(?, 'a','full','emlx',?, ?,0,0,?,?)").run(id,`/${id}`,date,extraction,body);
}

test('mail indexes preserve ordered results and stay correct after writes and version upgrade', () => {
  const store=Store.open(':memory:'); const db=store.raw;
  try {
    db.exec('DROP INDEX idx_messages_stale_v2; DROP INDEX idx_messages_action_recent');
    insert(db,'a',10,JSON.stringify({version:1})); insert(db,'b',10,JSON.stringify({version:2,textHash:'ok'})); insert(db,'c',20,null,'');
    const s=names(db,stale,2), a=names(db,recent,0);
    ensureMailIndexes(db,2); ensureMailIndexes(db,2);
    assert.deepEqual(names(db,stale,2),s);assert.deepEqual(names(db,recent,0),a);
    assert.match(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN '+stale).all(2)),/idx_messages_stale_v2/);
    assert.match(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN '+recent).all(0)),/idx_messages_action_recent/);
    db.prepare("UPDATE messages SET body_extraction=?,body_text='updated' WHERE message_id='a'").run(JSON.stringify({version:2,textHash:'ok'}));
    db.prepare("UPDATE messages SET deleted=1 WHERE message_id='b'").run();
    insert(db,'d',30,JSON.stringify({version:1}));
    const expected2=names(db,stale,2), expected3=names(db,stale,3), expectedRecent=names(db,recent,0);
    ensureMailIndexes(db,3); assert.ok(indexes(db).has('idx_messages_stale_v2'));assert.ok(indexes(db).has('idx_messages_stale_v3'));
    assert.match(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN '+stale).all(3)),/idx_messages_stale_v3/);
    db.exec('DROP INDEX idx_messages_stale_v2; DROP INDEX idx_messages_stale_v3; DROP INDEX idx_messages_action_recent');
    assert.deepEqual(names(db,stale,2),expected2);assert.deepEqual(names(db,stale,3),expected3);assert.deepEqual(names(db,recent,0),expectedRecent);
  } finally { store.close(); }
});

test('malformed historical extraction does not stop store migration or create a broken stale index', () => {
  const store=Store.open(':memory:'); const db=store.raw;
  try {
    db.exec('DROP INDEX idx_messages_stale_v2'); insert(db,'bad',10,'{');
    ensureMailIndexes(db,2); assert.equal(indexes(db).has('idx_messages_stale_v2'),false);
    assert.equal(indexes(db).has('idx_messages_action_recent'),true);
    db.prepare("UPDATE messages SET body_extraction=? WHERE message_id='bad'").run(JSON.stringify({version:2,textHash:'ok'}));
    ensureMailIndexes(db,2);assert.equal(indexes(db).has('idx_messages_stale_v2'),true);
  } finally { store.close(); }
});

test('invalid extractor versions are rejected without creating indexes', () => {
  const store=Store.open(':memory:');try{for(const n of [0,-1,NaN,1.5]) assert.throws(()=>ensureMailIndexes(store.raw,n),/Invalid/)}finally{store.close()}
});
