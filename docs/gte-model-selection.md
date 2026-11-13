# From a growing backlog to a local email filter

This document reconstructs the engineering process I followed to reduce remote calls in Steward's email distillation pipeline. It covers the problem, experimental choices and results that led to GTE. The measurements are snapshots of experiments performed through November 12, 2026; they do not automatically predict performance on future email.

## The operational problem

The `mail-distill` job periodically examines new or modified threads to decide whether they contain durable information worth promoting to the wiki. The cost of a remote decision can depend on context length. The number of threads examined is not the number of paid calls: I separated requests with a positive recorded cost from failed attempts and local operations.

The November 11 snapshot contained 44,915 active threads: 35,131 had an unchanged hash, and 9,784 awaited evaluation because they had no state or their hash differed. I also investigated whether repeated notifications explained the backlog. Most differences instead involved existing threads: the hash includes the subject and extracted body of every message, so it can change when the MIME representation changes. For 2,952 threads I reproduced the exact previous hash using the old plain-text alternative; in a targeted sample of 88 originals, the previous algorithm reproduced 86 hashes. That targeted sample does not justify extrapolating the percentage to the entire backlog.

Thread length informed the model choice. In those 2,952 selected cases, the median extracted body increased from 4,340 to 12,680 characters, and the 95th percentile from 9,976 to 33,664. Extracted characters and tokens actually sent to the model are different measurements. A classifier with a 128-token window would nevertheless exclude substantial context, so I investigated multilingual encoders with an 8,192-token window and routed longer cases onward.

## Objective and success criterion

I framed the task as a binary decision: identify threads that **might contain durable knowledge** and forward them to the existing triage. A false negative can lose useful information; a false positive incurs an additional remote call. I therefore prioritized recall in the conservative operating region while measuring the share of threads filtered at the chosen threshold.

The local model predicts `promoteMail`. Attachment usefulness is a separate decision: threads with attachments bypass the gate. Inputs exceeding the context window and inference errors follow the normal triage path; truncated input is never treated as a complete classification.

## Data and methodology

I constructed the dataset from historical system decisions: `promoted` as positive and `skipped` as negative, excluding deterministically filtered cases. These are **weak labels produced by an LLM**, not independent human judgments. A promotion retained in state may also differ from the latest verdict, introducing label noise.

To limit information loss and contamination between splits, I:

- reconstructed complete threads and compared source hashes with historical state, excluding changed threads;
- grouped normalized templates and excluded groups with conflicting labels;
- split examples by time, preserving class proportions in the evaluation sets;
- used training data to adapt the model and separate sets to calibrate thresholds and select checkpoints;
- forwarded overflow cases in simulations without assigning a local decision;
- measured latency and memory constraints on a Mac mini M4 with 16 GB of RAM.

These safeguards reduce some sources of bias; they do not remove every semantic duplicate or correct noisy labels. Once folds had been inspected in subsequent experiments, they were no longer an independent unseen test.

## From initial baselines to fine-tuning

I compared frozen multilingual GTE and BGE-M3 encoders, then SetFit on GTE. In the first pilot, using an exploratory threshold with no validation positives missed, GTE missed 1 of 54 test positives and filtered 64.1% of threads; BGE missed none in that sample and filtered 51.0%. SetFit missed 1 of 54 and filtered 64.5%. These small-sample results guided further experiments; they do not guarantee future recall.

Warm latency on the Mac was a second criterion. Near 8,000 tokens, measured medians were approximately 1.88 seconds for GTE and 4.62 for BGE, using representative examples while other services were running. Tokenizers and profiling inputs differ, so the measurements are not perfectly matched comparisons.

I then investigated supervised fine-tuning, comparing updates to the final 2, 6 and 12 layers against frozen controls. The selection criterion first minimized missed positives, then maximized discarded negatives. At all three depths, checkpoint zero won: training had run, but later checkpoints did not improve the selected conservative trade-off. The depth comparison also changed optimizer, so it does not isolate the effect of depth alone.

That result led me to separate encoder quality from decision-head quality. I reproduced an updated checkpoint and independently refitted logistic heads, comparing them with observable metadata, TF-IDF and a consensus rule. With the initial calibration, the main selection favored the frozen control with metadata; the refitted head on the updated encoder filtered more but missed more positives on selection. A later expanded calibration suggested a potential advantage for `tuned-head` in the conservative region. Because it included selection and the final folds had already been inspected, I treated it as an exploratory analysis.

## Comparing other paradigms

I also compared GTE with local decision readouts based on OpenJev, Laya and Gemma 4 E2B. In the common-coverage comparison with the exploratory expanded bank, GTE `tuned-head` missed none of the 214 observed positives and filtered 43.8% of threads; Gemma `noul-full` missed none and filtered 22.9%. OpenJev variants in the same scenario filtered between 0% and 3.7%, depending on the readout, with zero or more false negatives. These percentages describe simulated routing on that sample, not measured monetary savings.

Gemma 4 E2B ran from the file on ORICO with the LiteRT-LM GPU runtime; the effective 8k context was verified. Warm medians were approximately 0.70 seconds at 1,023 prompt tokens, 2.82 at 4,079 and 6.13 at 8,008. Rizzo Flow and AnyJev were researched as alternatives, but were not benchmarked on the emails in these experiments; I did not assign them estimated results.

I chose GTE `tuned-head` for its observed trade-off between retaining positives, filtering threads, multilingual context and local operating cost. Its threshold comes from the expanded bank: this is an engineering decision informed by exploratory analysis, not proof of perfect recall on new email.

## From evaluation to production

I retained remote triage as the reference path and inserted GTE before it for eligible threads without attachments. The model receives the same full-thread serialization used during evaluation; cases above 8,192 tokens are forwarded. Errors, timeouts and unrecognized policies also route to normal triage, subject to cycle limits and backoff.

Local decisions are cached separately from remote model verdicts. A local result does not become a training label or delete an existing note. Cache identity accounts for content, participants, model and policy; attachment presence is checked before the cache.

To make the backlog manageable, I introduced independent limits of 500 new local checks and 100 gateway requests per cycle. Global gateway errors trigger persistent backoff from 15 minutes up to six hours; deferred cases stay pending and local checks can continue. Gateway request count is not a precise spending cap: one request can involve multiple upstream attempts.

Verification included 70 promoter tests, a TypeScript check, exact comparison of 100 historical serializations and 224 worker scores against the reference. The initial release exposed a pipe-handling issue during the scan; the subsequent revision corrected event-loop yielding. In the verified cycle, 500 new checks ran, 497 cached results were reused and no GTE errors were recorded; 9,512 threads remained deferred. The zero gateway requests in that cycle resulted from backoff after an HTTP 402 error; they do not measure monetary savings.

## What remains to be verified

The priority is a prospective evaluation on new email, with human review of discarded cases and false-negative monitoring. Actual billed requests, tokens and costs need separate measurement against a comparable baseline. Incremental thread updates and classification of only the new message require their own evaluation: metrics obtained on complete threads do not automatically transfer to partial input.

## Materials and reproducibility

Operational documentation is in [apps/mail-promoter/README.md](../apps/mail-promoter/README.md); experimental procedures and constraints are in [tools/mail-detection/README.md](../tools/mail-detection/README.md). Detailed local reports cover the [paradigm comparison](../.local-evals/mail-detection-decisions/comparison.md), [direct fine-tuning](../.local-evals/mail-detection-direct/comparison.md), [refitted heads](../.local-evals/mail-detection-followup/comparison.md), [Gemma](../.local-evals/mail-detection-gemma/comparison.md), [backlog and hashes](../.local-evals/mail-backlog/report.md), and [GTE activation](../.local-evals/mail-detection-decisions/production.md). The `.local-evals/` and `.local-models/` artifacts are local and ignored by Git: they may contain private data and are not required to read this summary.
