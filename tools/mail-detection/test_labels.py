"""Regression checks for audited labels; fixtures contain no real mail."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_v2', Path(__file__).with_name('prepare-v2.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class AuditedLabels(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mail-labels-')
        self.home = Path(self.temporary.name)
        self.content_hash = hashlib.sha256(b'Subject\nbody\n').hexdigest()
        for name in ['steward-audit', 'mail-promoter', 'mail-mirror']:
            (self.home / name).mkdir()
        with self.db('steward-audit/audit.db') as c:
            c.execute('CREATE TABLE audit_events(id INTEGER PRIMARY KEY,ts INTEGER,event_type TEXT,payload_json TEXT)')
        with self.db('mail-promoter/state.db') as c:
            c.execute('CREATE TABLE promote_state(message_id TEXT,decision TEXT,categories TEXT,classify_model TEXT,distill_model TEXT,wiki_filename TEXT,source_hash TEXT,promoted_at INTEGER)')
        with self.db('mail-mirror/mail.db') as c:
            c.executescript('''CREATE TABLE accounts(emails TEXT);
                INSERT INTO accounts VALUES ('user@example.org');
                CREATE TABLE messages(message_id TEXT,thread_id INTEGER,date INTEGER,subject TEXT,from_name TEXT,from_addr TEXT,to_addrs TEXT,cc_addrs TEXT,body_text TEXT,deleted INTEGER);
                CREATE INDEX idx_messages_thread ON messages(thread_id);
                INSERT INTO messages VALUES ('m1',1,100,'Subject','Sender','sender@example.org','[]','[]','body',0);
                CREATE TABLE attachments(message_id TEXT,filename TEXT,mime TEXT,size INTEGER,sha256 TEXT);''')

    def tearDown(self):
        self.temporary.cleanup()

    def db(self, relative):
        return sqlite3.connect(self.home / relative)

    def state(self, decision='promoted'):
        with self.db('mail-promoter/state.db') as c:
            c.execute('INSERT INTO promote_state VALUES (?,?,?,?,?,?,?,?)',
                      ('thread:1', decision, '[]', 'test', None, 'mail-thread-1.md', self.content_hash, 1000))

    def event(self, event_type, ts, payload):
        with self.db('steward-audit/audit.db') as c:
            c.execute('INSERT INTO audit_events(ts,event_type,payload_json) VALUES (?,?,?)', (ts, event_type, json.dumps(payload)))

    def export(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            prepare.export(self.home)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def verdict(self, promote):
        return {'schemaVersion': 1, 'threadId': 1, 'sourceHash': self.content_hash,
                'promote': promote, 'promoteMail': promote, 'promoteAttachments': False,
                'attachmentInputHash': hashlib.sha256(b'[]').hexdigest(), 'model': 'test', 'policyHash': 'a'*64}

    def test_retained_old_note_is_not_a_new_positive(self):
        self.state()
        self.event('wiki.promoted', 500000, {'filename': 'mail-thread-1.md'})
        result = self.export()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['excludedCounts']['ambiguous_historical_positive'], 1)

    def test_millisecond_rounding_preserves_same_call_evidence(self):
        self.state()
        self.event('wiki.promoted', 1000900, {'filename': 'mail-thread-1.md'})
        evidence = self.export()[1]['state']['labelEvidence']
        self.assertTrue(evidence['promoteMail'])
        self.assertEqual(evidence['kind'], 'wiki_audit_same_decision_second')

    def test_explicit_negative_overrides_retained_positive_state(self):
        self.state()
        self.event('mail.triage_decided', 1000100, self.verdict(False))
        self.assertFalse(self.export()[1]['state']['labelEvidence']['promote'])

    def test_valid_verdict_survives_missing_downstream_state(self):
        self.event('mail.triage_decided', 1000100, self.verdict(True))
        row = self.export()[1]['state']
        self.assertTrue(row['labelEvidence']['promoteMail'])
        self.assertEqual(row['source_hash'], self.content_hash)

    def test_negative_with_unverified_attachment_snapshot_is_excluded(self):
        self.state('skipped')
        with self.db('mail-mirror/mail.db') as c:
            c.execute("INSERT INTO attachments VALUES ('m1','document.pdf','application/pdf',10,?)", ('b'*64,))
        result = self.export()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['excludedCounts']['negative_attachment_snapshot_unverified'], 1)


if __name__ == '__main__':
    unittest.main()
