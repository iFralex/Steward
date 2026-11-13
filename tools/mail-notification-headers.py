"""Read only MIME headers for long threads and arrivals in the past 30 days."""
import collections
import datetime as dt
from email.parser import BytesHeaderParser
from email import policy
import json
import re
from pathlib import Path
import sqlite3
import time

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.local-evals/mail-backlog'
BASE=Path.home()/'Library/Application Support'
now=time.time(); cutoff=now-30*86400
db=sqlite3.connect((BASE/'mail-mirror/mail.db').as_uri()+'?mode=ro',uri=True)
db.row_factory=sqlite3.Row;db.execute('BEGIN')
long_ids={r[0] for r in db.execute('SELECT thread_id FROM messages WHERE deleted=0 GROUP BY thread_id HAVING count(*)>=10')}
groups=collections.defaultdict(list)
roles={(r[0],r[1]):r[2] for r in db.execute('SELECT account_uuid,mailbox_name,role FROM mailbox_roles')}
for r in db.execute('SELECT message_id,thread_id,ingested_at,date,emlx_path,from_addr,subject,body_state,account,mailbox FROM messages WHERE deleted=0 ORDER BY thread_id,ingested_at'):
    groups[r['thread_id']].append(dict(r))
db.close()
noise=re.compile(r'^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|newsletter|bounce|postmaster)\b',re.I|re.ASCII)
otp1=re.compile(r'\bOTP\b|\bone[-\s]?time\s+(?:password|code|pin)\b',re.I|re.ASCII)
otp2=re.compile(r'\b(?:verification|one[-\s]?time|security|login|access|codice)\b',re.I|re.ASCII)
code=re.compile(r'\b\d{3,8}\b',re.ASCII)
def eligible(row):
    subject=row['subject'] or ''
    return roles.get((row['account'],row['mailbox'] or '')) not in {'junk','spam','bulk'} and (row['body_state'] or 'none')!='none' and not noise.search((row['from_addr'] or '').split('@')[0]) and not (otp1.search(subject) or (otp2.search(subject) and code.search(subject)))
parser=BytesHeaderParser(policy=policy.default)
cache={};counters=collections.Counter();threads=collections.defaultdict(set)
def headers(row):
    if row['message_id'] in cache:return cache[row['message_id']]
    result={'status':'ok','automated':False,'mailingListOrBulk':False,'platformNotification':False}
    try:
        with open(row['emlx_path'],'rb') as f:
            f.readline();raw=f.read(128*1024)
        if b'\r\n\r\n' not in raw and b'\n\n' not in raw:raise ValueError('headerIncomplete')
        msg=parser.parsebytes(raw)
        auto=str(msg.get('Auto-Submitted','')).strip().lower()
        result['automated']=bool(auto and auto!='no')
        result['mailingListOrBulk']=bool(msg.get('List-Id') or msg.get('List-Unsubscribe') or str(msg.get('Precedence','')).lower() in {'bulk','list','junk'})
        result['platformNotification']=bool(msg.get('X-GitHub-Reason') or msg.get('X-Discourse-Topic-Id'))
    except Exception as exc:result['status']=type(exc).__name__
    cache[row['message_id']]=result;return result

for position,(tid,rows) in enumerate(groups.items()):
    recent=[r for r in rows if cutoff <= (r['ingested_at'] or 0) <= now]
    if tid not in long_ids and not recent:continue
    for row in rows if tid in long_ids else recent:
        h=headers(row)
        scopes=[]
        if tid in long_ids:scopes.append('longThreads')
        if cutoff <= (row['ingested_at'] or 0) <= now:scopes.append('last30Days')
        for scope in scopes:
            counters[scope+'/messagesExamined']+=1;threads[scope+'/threadsExamined'].add(tid)
            if h['status']!='ok':counters[scope+'/headerReadFailed']+=1;continue
            for name in ['automated','mailingListOrBulk','platformNotification']:
                if h[name]:
                    counters[scope+'/'+name]+=1;threads[scope+'/'+name].add(tid)
                    if any((prior['ingested_at'] or now+1) < row['ingested_at'] for prior in rows):
                        counters[scope+'/'+name+'AfterEarlierThreadMessage']+=1;threads[scope+'/'+name+'AfterEarlierThreadMessage'].add(tid)
                    if any((prior['ingested_at'] or now+1) < row['ingested_at'] and eligible(prior) for prior in rows):
                        counters[scope+'/'+name+'AfterEarlierEligibleMessage']+=1;threads[scope+'/'+name+'AfterEarlierEligibleMessage'].add(tid)
    if len(cache)%1000<10:print(json.dumps({'headersRead':len(cache)}),flush=True)
frequency=json.loads((OUT/'notification-frequency.json').read_text())
append_cases=[]
for candidate in frequency.get('appendOnlyCandidates',[]):
    ids={item['messageId'] for item in candidate['newMessages']}
    selected=[row for row in groups.get(candidate['threadId'],[]) if row['message_id'] in ids]
    selected_headers=[headers(row) for row in selected]
    append_cases.append({'threadId':candidate['threadId'],'messages':candidate['messages'],
        'newMessages':len(selected),'newAttachmentCount':candidate['newAttachmentCount'],
        'allNewAutomatedOrPlatformHeaders':bool(selected_headers) and all(h['status']=='ok' and (h['automated'] or h['platformNotification']) for h in selected_headers),
        'allNewListOrBulkHeaders':bool(selected_headers) and all(h['status']=='ok' and h['mailingListOrBulk'] for h in selected_headers)})
result={'snapshotUtc':dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat(),'method':'MIME header evidence; automated does not imply irrelevant; mailing-list messages can be human replies; first ingestion time is not historical thread assignment',
    'counts':dict(counters),'distinctThreads':{k:len(v) for k,v in threads.items()},'longThreads':len(long_ids),'headersRead':len(cache),'currentAppendOnlyCases':append_cases}
(OUT/'notification-headers.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
