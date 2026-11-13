"""Read-only analysis of notification-triggered thread invalidation.

Mirror/state have no complete decision history: distinguish observed current
invalidations, structural notification arrivals, and positive-only audit events.
No network calls, message writes or LLM completions.
"""
import collections
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.local-evals/mail-backlog'
BASE = Path.home() / 'Library/Application Support'
NOW = dt.datetime.now(dt.timezone.utc).timestamp()
COUNTS = collections.Counter()
PERIODS = {days: {'counts': collections.Counter(), 'threads': collections.defaultdict(set)} for days in [7, 30]}
THREADS = []
NOISE = re.compile(r'^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|newsletter|bounce|postmaster)\b', re.I | re.ASCII)
OTP1 = re.compile(r'\bOTP\b|\bone[-\s]?time\s+(?:password|code|pin)\b', re.I | re.ASCII)
OTP2 = re.compile(r'\b(?:verification|one[-\s]?time|security|login|access|codice)\b', re.I | re.ASCII)
CODE = re.compile(r'\b\d{3,8}\b', re.ASCII)


def connect(name):
    db = sqlite3.connect((BASE / name).as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('BEGIN')
    return db


mirror = connect('mail-mirror/mail.db')
state = connect('mail-promoter/state.db')
states = {int(r['message_id'][7:]): dict(r) for r in state.execute(
    "SELECT * FROM promote_state WHERE message_id LIKE 'thread:%'")}
roles = {(r[0], r[1]): r[2] for r in mirror.execute('SELECT account_uuid,mailbox_name,role FROM mailbox_roles')}
attachments = {r[0]: r[1] for r in mirror.execute('SELECT message_id,count(*) FROM attachments GROUP BY message_id')}


def reason(row):
    # Same priority and ASCII word boundaries as shouldConsider in prefilter.ts.
    if roles.get((row['account'], row['mailbox'] or '')) in {'junk', 'spam', 'bulk'}:
        return 'noiseMailbox'
    if (row['body_state'] or 'none') == 'none':
        return 'bodyUnavailable'
    if NOISE.search((row['from_addr'] or '').split('@')[0]):
        return 'notificationSender'
    subject = row['subject'] or ''
    if OTP1.search(subject) or (OTP2.search(subject) and CODE.search(subject)):
        return 'otpSubject'
    return 'consider'


def thread_hash(rows):
    result = hashlib.sha256()
    for row in rows:
        result.update(((row['subject'] or '') + '\n' + (row['body_text'] or '') + '\n').encode())
    return result.hexdigest()


def mark_period(period, key, tid, value=1):
    period['counts'][key] += value
    period['threads'][key].add(tid)


def process(rows):
    tid = rows[0]['thread_id']; saved = states.get(tid)
    classifications = [reason(row) for row in rows]
    eligible = [row for row, kind in zip(rows, classifications) if kind == 'consider']
    notices = [row for row, kind in zip(rows, classifications) if kind in {'notificationSender', 'otpSubject'}]
    count = len(rows); band = '1' if count == 1 else '2-9' if count < 10 else '10-49' if count < 50 else '50+'
    COUNTS['threads'] += 1; COUNTS['messages'] += count
    COUNTS['threadsBySize/' + band] += 1
    COUNTS['messagesRejectedByPrefilter'] += sum(kind != 'consider' for kind in classifications)
    COUNTS['notificationSenderOrOtpMessages'] += len(notices)
    if notices: COUNTS['threadsWithNotifications'] += 1
    if eligible and notices:
        COUNTS['mixedThreads'] += 1
        if count >= 10: COUNTS['mixedThreadsAtLeast10Messages'] += 1
    earliest_eligible_ingestion = min((r['ingested_at'] or NOW+1 for r in eligible), default=NOW+1)
    prior_notice_count = 0
    for row, kind in zip(rows, classifications):
        ingested = row['ingested_at'] or 0
        is_notice = kind in {'notificationSender', 'otpSubject'}
        has_prior_eligible = earliest_eligible_ingestion < ingested
        if is_notice and has_prior_eligible: prior_notice_count += 1
        for days, period in PERIODS.items():
            if not NOW-days*86400 <= ingested <= NOW: continue
            mark_period(period, 'allArrivingMessages', tid)
            if count >= 10: mark_period(period, 'allArrivingMessagesInLongThreads', tid)
            if any((other['ingested_at'] or NOW+1) < ingested for other in rows):
                mark_period(period, 'messagesAfterEarlierThreadMessage', tid)
            if is_notice:
                mark_period(period, 'notificationSenderOrOtp', tid)
                if has_prior_eligible:
                    mark_period(period, 'notificationAfterEarlierEligibleMessage', tid)
                    if count >= 10: mark_period(period, 'notificationAfterEarlierEligibleMessageInLongThread', tid)
                    if saved and (saved['promoted_at'] or 0) < ingested:
                        mark_period(period, 'notificationAfterCurrentSavedDecisionAndEarlierEligibleMessage', tid)
    pending = bool(saved and eligible and saved['source_hash'] != thread_hash(rows))
    new_messages = []; appended_only = False; all_new_notice = False; new_attachment_count = 0
    if pending:
        COUNTS['pendingChangedEligibleThreads'] += 1
        previous = [row for row in rows if (row['ingested_at'] or 0) <= (saved['promoted_at'] or 0)]
        new_messages = [(row, kind) for row, kind in zip(rows, classifications)
                        if (row['ingested_at'] or 0) > (saved['promoted_at'] or 0)]
        if new_messages:
            COUNTS['pendingWithMessagesIngestedAfterDecision'] += 1
            appended_only = thread_hash(previous) == saved['source_hash']
            if appended_only: COUNTS['pendingAppendOnlyOldHashExactlyVerified'] += 1
            all_new_notice = all(kind in {'notificationSender', 'otpSubject'} for _, kind in new_messages)
            all_new_rejected = all(kind != 'consider' for _, kind in new_messages)
            new_attachment_count = sum(attachments.get(row['message_id'], 0) for row, _ in new_messages)
            if all_new_notice:
                COUNTS['pendingOnlyNewNotificationSenderOrOtp'] += 1
                if count >= 10: COUNTS['pendingOnlyNewNotificationSenderOrOtpLongThreads'] += 1
                if appended_only:
                    COUNTS['verifiedAppendOnlyNotifications'] += 1
                    COUNTS['verifiedAppendOnlyNotificationMessages'] += len(new_messages)
                    if new_attachment_count == 0: COUNTS['verifiedAppendOnlyNotificationsNoNewAttachments'] += 1
                    if count >= 10: COUNTS['verifiedAppendOnlyNotificationsLongThreads'] += 1
            if all_new_rejected and appended_only:
                COUNTS['verifiedAppendOnlyPrefilterRejected'] += 1
            if not appended_only: COUNTS['pendingNewMessagesButOldContentAlsoChangedOrMembershipUnknown'] += 1
        elif notices:
            COUNTS['pendingHasNotificationsButNoMessagesIngestedAfterDecision'] += 1
    THREADS.append({'threadId': tid, 'messages': count, 'notifications': len(notices),
        'notificationsAfterEarlierEligibleMessage': prior_notice_count,
        'currentDecision': saved['decision'] if saved else None,
        'pending': pending, 'newMessagesSinceDecision': len(new_messages),
        'onlyNewNotifications': all_new_notice, 'oldContentHashExactlyVerified': appended_only,
        'newAttachmentCount': new_attachment_count,
        'newMessages': [{'messageId': row['message_id'], 'prefilterReason': kind,
            'attachmentCount': attachments.get(row['message_id'], 0)} for row, kind in new_messages],
        'noticeArrivalTimes': [r['ingested_at'] for r in notices],
        'messageArrivalTimes': [r['ingested_at'] for r in rows]})


current = None; group = []
for row in mirror.execute('''SELECT thread_id,message_id,subject,body_text,body_state,account,
    mailbox,from_addr,ingested_at,date FROM messages WHERE deleted=0 AND thread_id IS NOT NULL
    ORDER BY thread_id,date ASC'''):
    if current is not None and row['thread_id'] != current:
        process(group); group = []
    current = row['thread_id']; group.append(row)
if group: process(group)
mirror.close(); state.close()

# Positive-only audit evidence. It does not record every skipped/failed triage.
audit = connect('steward-audit/audit.db')
events = collections.defaultdict(list)
for row in audit.execute("SELECT ts,payload_json FROM audit_events WHERE event_type='wiki.promoted' ORDER BY ts"):
    payload = json.loads(row['payload_json']); name = payload.get('filename', '')
    match = re.fullmatch(r'mail-thread-(\d+)\.md', name)
    if match: events[int(match[1])].append(row['ts']/1000)
audit.close()
by_id = {r['threadId']: r for r in THREADS}
repeat_intervals = []
for tid, times in events.items():
    thread = by_id.get(tid)
    for first, second in zip(times, times[1:]):
        new_count = sum(first < t <= second for t in thread['messageArrivalTimes']) if thread else None
        notice_count = sum(first < t <= second for t in thread['noticeArrivalTimes']) if thread else None
        repeat_intervals.append({'threadId': tid, 'firstUtc': first, 'secondUtc': second,
            'newMessagesStillInMirror': new_count, 'newNotificationMessagesStillInMirror': notice_count})
result = {'snapshotUtc': dt.datetime.fromtimestamp(NOW, dt.timezone.utc).isoformat(),
    'notificationDefinition': 'Rejected by current prefilter because sender local part matches noise regex or subject is OTP; not a semantic classifier',
    'limitations': ['Current state contains only last decision, not complete triage history.',
        'First ingestion time is not necessarily time of association with current thread.',
        'A current prior hash match proves old input subset unchanged; no match does not prove a specific edit.',
        'Counts of arriving notifications and pending candidates are not counts of billed LLM calls.',
        'No provider calls made; usage ledger already found corrupt.',
        'An automatic sender may still convey important documents or personal facts; measured candidates are not an approved skip policy.'],
    'counts': dict(COUNTS), 'periods': {str(days): {'counts': dict(p['counts']),
        'distinctThreads': {key: len(value) for key, value in p['threads'].items()}} for days, p in PERIODS.items()},
    'positiveAudit': {'canonicalThreadPromotionEvents': sum(map(len, events.values())),
        'distinctThreads': len(events), 'repeatedThreads': sum(len(t)>1 for t in events.values()),
        'repeatIntervals': repeat_intervals},
    'threadExamples': sorted(THREADS, key=lambda r: r['messages'], reverse=True)[:30],
    'verifiedNotificationCandidates': [r for r in THREADS if r['pending'] and r['onlyNewNotifications'] and r['oldContentHashExactlyVerified']]}
result['appendOnlyCandidates'] = [r for r in THREADS if r['pending'] and r['newMessagesSinceDecision'] and r['oldContentHashExactlyVerified']]
OUT.mkdir(exist_ok=True)
(OUT/'notification-frequency.json').write_text(json.dumps(result, indent=2))
print(json.dumps({k: v for k, v in result.items() if k not in {'threadExamples', 'positiveAudit', 'appendOnlyCandidates'}}, indent=2))
print('positiveAudit', {k: v for k,v in result['positiveAudit'].items() if k!='repeatIntervals'})
print('repeatIntervals', len(repeat_intervals))
