// Private thread contents travel through pipes only; the Python consumer saves
// accepted examples under the Git-ignored .local-evals directory.
import readline from 'node:readline';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cleanBody } from '../../apps/mail-promoter/src/clean-body.ts';
import { attachmentDecisionId } from '../../apps/mail-promoter/src/attachments.ts';

for await (const line of readline.createInterface({ input: process.stdin })) {
  let result;
  try {
    const payload = JSON.parse(line);
    if (payload.excludedCounts) {
      process.stdout.write(JSON.stringify(payload) + '\n');
      continue;
    }
    const { messages, state, attachments, userAddrs } = payload;
    messages.sort((a, b) => a.date - b.date);
    // Exact definition of threadHash in apps/mail-promoter/src/run.ts.
    const hash = createHash('sha256');
    for (const m of messages) hash.update(`${m.subject ?? ''}\n${m.body_text ?? ''}\n`);
    if (hash.digest('hex') !== state.source_hash) {
      result = { excluded: 'source_hash_changed' };
    } else {
      if (state.labelEvidence?.attachmentInputHash) {
        const snapshot = attachments.map(a => [attachmentDecisionId(a), a.filename, a.mime, a.size, a.message_id])
          .sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
        if (createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') !== state.labelEvidence.attachmentInputHash) {
          process.stdout.write(JSON.stringify({excluded:'attachment_snapshot_changed'}) + '\n');
          continue;
        }
      }
      const own = new Set(userAddrs.map(s => s.toLowerCase()));
      const rendered = messages.map(m => {
        const recipients = [...JSON.parse(m.to_addrs || '[]'), ...JSON.parse(m.cc_addrs || '[]')];
        const participation = own.has((m.from_addr || '').toLowerCase()) ? 'sender' : recipients.some(a => own.has(a.toLowerCase())) ? 'recipient' : 'not directly addressed';
        return `--- ${new Date(m.date * 1000).toISOString().slice(0, 10)}; user is ${participation}; from ${m.from_name || ''} <${m.from_addr || ''}> ---\n${cleanBody(m.body_text || '')}`;
      });
      const body = rendered.join('\n\n');
      const subject = messages[0].subject || messages.at(-1).subject || '';
      const files = attachments.map(a => `${a.filename || '(unnamed)'}; ${a.mime || ''}; ${a.size || 0} bytes`);
      const text = `Decision date: ${new Date(state.promoted_at * 1000).toISOString().slice(0, 10)}\nSubject: ${subject}\n\n${body}${files.length ? '\n\nAttachments:\n' + files.join('\n') : ''}`;
      // Keep repeated templates together even if addresses, dates or URLs differ.
      const normalized = body.toLowerCase()
        .replace(/^---.*---$/gm, '')
        .replace(/https?:\/\/\S+/g, '<url>')
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]+/g, '<email>')
        .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
      result = { threadId: messages[0].thread_id, label: state.decision === 'promoted' ? 1 : 0,
        decisionAt: state.promoted_at, sourceHash: state.source_hash, text,
        groupHash: createHash('sha256').update(normalized).digest('hex'),
        messages: messages.length, attachments: files.length,
        weakLabel: true, labelModel: state.classify_model,
        latestMessageAt: messages.at(-1).date,
        ...(state.labelEvidence ? { labelEvidence: state.labelEvidence,
          label: state.labelEvidence.promote ? 1 : 0,
          promoteMail: state.labelEvidence.promoteMail,
          promoteAttachments: state.labelEvidence.promoteAttachments } : {}) };
    }
  } catch (error) { result = { excluded: `prepare_${error.name}` }; }
  if (!process.stdout.write(JSON.stringify(result) + '\n')) await once(process.stdout, 'drain');
}
