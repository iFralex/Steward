"""Read-only historical dataset extraction. Run the pipeline documented in README."""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import sys


def readonly(path):
    connection = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    return connection


def export():
    home = Path.home() / 'Library/Application Support'
    state = readonly(home / 'mail-promoter/state.db')
    labels = {int(r['message_id'].split(':', 1)[1]): dict(r) for r in state.execute(
        "SELECT * FROM promote_state WHERE decision IN ('promoted','skipped') AND message_id LIKE 'thread:%'")}
    state.close()
    mail = readonly(home / 'mail-mirror/mail.db')
    own = sorted({a.strip().lower() for r in mail.execute('SELECT emails FROM accounts') for a in (r['emails'] or '').replace(';', ',').split(',') if a.strip()})
    files = collections.defaultdict(list)
    for row in mail.execute('SELECT m.thread_id,a.filename,a.mime,a.size FROM attachments a JOIN messages m ON m.message_id=a.message_id WHERE m.deleted=0'):
        if row['thread_id'] in labels:
            files[row['thread_id']].append(dict(row))
    batch = []

    def emit(messages):
        tid = messages[0]['thread_id']
        if tid in labels:
            print(json.dumps({'messages': messages, 'state': labels[tid], 'attachments': files[tid], 'userAddrs': own}, ensure_ascii=True))

    for row in mail.execute('SELECT thread_id,date,subject,from_name,from_addr,to_addrs,cc_addrs,body_text FROM messages INDEXED BY idx_messages_thread WHERE deleted=0 AND thread_id IS NOT NULL ORDER BY thread_id'):
        if batch and row['thread_id'] != batch[0]['thread_id']:
            emit(batch)
            batch = []
        batch.append(dict(row))
    if batch:
        emit(batch)
    mail.close()


def finish(output, train_limit, eval_limit):
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    excluded = collections.Counter()
    groups = collections.defaultdict(list)
    for line in sys.stdin:
        row = json.loads(line)
        if 'excluded' in row:
            excluded[row['excluded']] += 1
        else:
            groups[row['groupHash']].append(row)
    unique = []
    for group in groups.values():
        if len({r['label'] for r in group}) > 1:
            excluded['conflicting_template_labels'] += len(group)
            continue
        excluded['duplicate_template'] += len(group) - 1
        unique.append(max(group, key=lambda r: (r['decisionAt'], r['threadId'])))
    unique.sort(key=lambda r: (r['decisionAt'], r['threadId']))
    n = len(unique)
    partitions = {'train': unique[:int(n * .7)], 'validation': unique[int(n * .7):int(n * .85)], 'test': unique[int(n * .85):]}
    report = {'labels': 'LLM weak labels, not human ground truth', 'excluded': dict(excluded), 'uniqueEligibleThreads': n,
              'splitPolicy': 'chronological 70/15/15 by latest decision; deduplicated normalized templates', 'splits': {}}
    selected = []
    randomizer = random.Random(20261103)
    for split, rows in partitions.items():
        original = collections.Counter(r['label'] for r in rows)
        if split == 'train':
            # Balanced training only. Validation/test preserve their class priors.
            rows = [r for label in [0, 1] for r in randomizer.sample([r for r in rows if r['label'] == label], min(train_limit // 2, original[label]))]
        elif len(rows) > eval_limit:
            count_pos = round(eval_limit * original[1] / len(rows))
            rows = randomizer.sample([r for r in rows if r['label'] == 1], count_pos) + randomizer.sample([r for r in rows if r['label'] == 0], eval_limit - count_pos)
        rows.sort(key=lambda r: (r['decisionAt'], r['threadId']))
        for row in rows:
            row['split'] = split
        selected.extend(rows)
        report['splits'][split] = {'population': dict(original), 'selected': dict(collections.Counter(r['label'] for r in rows)),
                                   'decisionRange': [min(r['decisionAt'] for r in rows), max(r['decisionAt'] for r in rows)]}
    path = output / 'dataset.jsonl'
    with path.open('w') as stream:
        os.chmod(path, 0o600)
        for row in selected:
            stream.write(json.dumps(row, ensure_ascii=True) + '\n')
    report['datasetSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    (output / 'dataset-summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['export', 'finish'])
    parser.add_argument('--output', type=Path, default=Path('.local-evals/mail-detection'))
    parser.add_argument('--train-limit', type=int, default=3000)
    parser.add_argument('--eval-limit', type=int, default=1500)
    args = parser.parse_args()
    if args.command == 'export':
        export()
    else:
        finish(args.output, args.train_limit, args.eval_limit)
