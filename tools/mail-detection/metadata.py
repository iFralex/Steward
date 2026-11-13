"""Conditional observable-text metadata study; fit/tune on train/validation only."""
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import re

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from run import ROOT, atomic_json, load_dataset, metrics

FEATURE_NAMES = [
    'log_chars', 'log_words', 'log_messages', 'log_links', 'sender_fraction', 'recipient_fraction',
    'indirect_fraction', 'automatic_sender_fraction', 'reply_subject', 'log_attachment_count',
    'log_attachment_bytes', 'pdf_attachment', 'office_attachment', 'image_attachment',
    'account_identifier', 'iban', 'transaction_reference', 'invoice_receipt', 'financial_terms',
    'currency_amount', 'document_terms', 'cv_terms', 'legal_terms', 'personal_request',
    'deadline_terms', 'notification_terms', 'marketing_terms', 'html_text_alternatives',
    'log_email_age_days', 'future_email_date',
]
HEADER = re.compile(r'^--- ([\d-]+); user is (sender|recipient|not directly addressed); from .*? <([^>]*)> ---$', re.M)


def metadata_features(text):
    """Only information present in rendered input; never labels/audit/model state."""
    lower = text.lower()
    headers = HEADER.findall(text)
    count = max(1, len(headers))
    subject = re.search(r'^Subject: (.*)$', text, re.M)
    subject = subject.group(1) if subject else ''
    attachment_text = text.rsplit('\n\nAttachments:\n', 1)[1] if '\n\nAttachments:\n' in text else ''
    files = [line for line in attachment_text.splitlines() if ';' in line]
    sizes = [int(m.group(1)) for line in files if (m := re.search(r'; (\d+) bytes$', line))]
    age, future = 0, 0
    as_of = re.search(r'^Decision date: ([\d-]+)$', text, re.M)
    if as_of and headers:
        today = dt.date.fromisoformat(as_of.group(1))
        latest = max(dt.date.fromisoformat(date) for date, _, _ in headers)
        days = (today - latest).days
        age, future = min(36525, max(0, days)), int(days < 0)

    def has(pattern, source=lower):
        return float(bool(re.search(pattern, source, re.I)))

    values = [
        math.log1p(len(text)), math.log1p(len(text.split())), math.log1p(len(headers)),
        math.log1p(len(re.findall(r'https?://|\[\[', lower))),
        sum(role == 'sender' for _, role, _ in headers)/count,
        sum(role == 'recipient' for _, role, _ in headers)/count,
        sum(role == 'not directly addressed' for _, role, _ in headers)/count,
        sum(bool(re.search(r'no.?reply|notification|newsletter|do.?not.?reply', addr, re.I)) for _, _, addr in headers)/count,
        has(r'^\s*(?:re|r|fw|fwd|aw|sv):', subject), math.log1p(len(files)), math.log1p(sum(sizes)),
        has(r'\.pdf\b|application/pdf', attachment_text),
        has(r'\.(?:docx?|xlsx?|pptx?|odt|ods)\b', attachment_text),
        has(r'\.(?:png|jpe?g|gif)\b|image/', attachment_text),
        has(r'\bid\s*(?:cliente|account|utente)|\b(?:customer|client|user|account)\s*(?:id|number)|codice\s*(?:cliente|utente|contratto|fiscale)|partita\s*iva'),
        has(r'\biban\b|\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b'),
        has(r'id\s*(?:della\s*)?transazion|transaction\s*(?:id|reference)|numero\s*di\s*riferimento'),
        has(r'fattur|ricevut|\binvoice\b|\breceipt\b|estratto\s*conto|\bstatement\b'),
        has(r'addebit|pagament|\bpayment\b|\bcharge[ds]?\b|\bfinancial\b|\bbonifico\b'),
        has(r'€|\b(?:EUR|USD|GBP)\b|\$\s*\d'),
        has(r'certificat|document|diploma|attestat|\btranscript\b'),
        has(r'\bcv\b|curriculum|\br[eé]sum[eé]\b|cover\s*letter'),
        has(r'contratt|\bcontract\b|assicurazion|\binsurance\b|\blegal\b|polizza'),
        has(r'mi\s*serv|ti\s*invio|le\s*invio|come\s*concordato|in\s*allegato|richied|my\s*application|your\s*application|tua\s*candidatur'),
        has(r'scadenz|entro\s+(?:il\s+)?\d|\bdeadline\b|\bappointment\b|appuntamento|scheduled'),
        has(r'notifica|notification|status\s*update|presa\s*in\s*carico|richiesta\s*chiusa|\bticket\b|promemoria|\breminder\b'),
        has(r'newsletter|offerta|sconto|unsubscribe|disiscriv|promozion|discount|special\s*offer|scopri\s*di\s*pi[uù]'),
        float('[versione html]' in lower and '[versione testuale]' in lower),
        math.log1p(age), float(future),
    ]
    assert len(values) == len(FEATURE_NAMES)
    result = np.asarray(values, dtype=np.float32)
    assert np.isfinite(result).all()
    return result


def fit(directory, name):
    rows, digest = load_dataset(directory)
    source = directory / name
    base = json.loads((source / 'report.json').read_text())
    assert base['datasetSha256'] == digest
    embeddings = np.load(source / 'features.npy')
    lengths = np.load(source / 'token-lengths.npy')
    overflow = lengths > 8192
    labels = np.asarray([r['label'] for r in rows])
    train = np.asarray([r['split'] == 'train' for r in rows]) & ~overflow
    validation = np.asarray([r['split'] == 'validation' for r in rows])
    test = np.asarray([r['split'] == 'test' for r in rows])
    raw_metadata = np.stack([metadata_features(r['text']) for r in rows])
    scaler = StandardScaler().fit(raw_metadata[train])
    transformed = scaler.transform(raw_metadata)
    candidates, strict_candidates = [], []
    for weight in [0., .01, .03, .1, .3, 1.]:
        features = np.concatenate([embeddings, transformed * weight], axis=1)
        for c in [.1, 1., 10., 100.]:
            classifier = LogisticRegression(C=c, max_iter=2000, random_state=20261104).fit(features[train], labels[train])
            scores = classifier.predict_proba(features)[:, 1]
            scores[overflow] = 1.
            positives = np.sort(scores[validation & (labels == 1)])
            for container, errors in [(candidates, math.floor(len(positives)*.01 + 1e-9)), (strict_candidates, 0)]:
                threshold = float(positives[errors])
                measured = metrics(labels[validation], scores[validation], threshold)
                container.append((measured['llmCallsAvoidedFraction'], -c, -weight, classifier, threshold, scores, measured, weight))
    target = directory / (name + '-meta')
    target.mkdir(exist_ok=True, mode=0o700)
    chosen = max(candidates, key=lambda item: item[:3])
    strict = max(strict_candidates, key=lambda item: item[:3])
    report = {'datasetSha256': digest, 'encoder': base['encoder'], 'trainExamples': int(train.sum()),
              'targetValidationRecall': .99, 'datasetPolicy': base.get('datasetPolicy'),
              'limitations': base['limitations'], 'productionEnabled': False,
              'metadataRecipe': {'version': 1, 'featureNames': FEATURE_NAMES, 'featuresObservableFromTextOnly': True,
                                 'scalerFittedOnTrainingOnly': True, 'gridChosenOnValidationOnly': True,
                                 'weightGrid': [0., .01, .03, .1, .3, 1.],
                                 'validationRefinement': 'Lower weights and the zero-weight control added after the first validation-only study; test not consulted.'},
              'encoderLatencyInheritedFrom': name, 'overflowExamplesForwardedToLlm': int(overflow.sum())}
    for item, filename, conservative in [(chosen, 'classifier.joblib', False), (strict, 'classifier-conservative.joblib', True)]:
        _, _, _, classifier, threshold, scores, validation_metrics, weight = item
        result = {'targetValidationRecall': 1. if conservative else .99, 'classifierC': classifier.C,
                  'threshold': threshold, 'metadataScale': weight,
                  'validation': validation_metrics, 'test': metrics(labels[test], scores[test], threshold)}
        if conservative:
            report['conservativeValidationPolicy'] = result
        else:
            report.update(result)
        joblib.dump({'classifier': classifier, 'threshold': threshold, 'encoder': base['encoder'],
                     'maxTokens': 8192, 'overflowPolicy': 'forward_to_llm', 'datasetSha256': digest,
                     'metadata': {'version': 1, 'featureNames': FEATURE_NAMES, 'scaler': scaler, 'weight': weight}}, target / filename)
    atomic_json(target / 'report.json', report)
    print(json.dumps({'event': 'metadata_fit_complete', 'model': name + '-meta',
                      'validation': report['conservativeValidationPolicy']['validation'],
                      'metadataScale': report['conservativeValidationPolicy']['metadataScale']}, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=ROOT / '.local-evals/mail-detection-v2')
    args = parser.parse_args()
    decision = json.loads((args.directory / 'metadata-decision.json').read_text())
    if not decision['metadataRequired'] or decision['testUsedForThisDecision']:
        raise RuntimeError('This study was not requested by the validation-only gate')
    for name in ['gte', 'bge', 'gte-setfit']:
        fit(args.directory, name)
