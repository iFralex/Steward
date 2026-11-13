# Local mail detection evaluation

Offline comparison of a frozen GTE encoder, the existing BGE-M3 Ollama service,
SetFit, and direct supervised fine-tuning. The evaluation tools do not call a paid LLM
or modify mail and promotion state. The selected GTE gate was subsequently deployed;
see [mail promoter operation](../../apps/mail-promoter/README.md) and the
[engineering investigation](../../docs/gte-model-selection.md).

## Direct supervised fine-tuning with checkpoint selection

`direct.py` compares frozen controls with a GTE encoder and linear decision head
trained jointly using binary cross entropy. It reuses the frozen second dataset,
but splits its original training fold into optimization (2,056), calibration
(300), and checkpoint selection (450). The four previously reviewed training
cases remain in optimization. Original validation/test results are exploratory
because those cohorts were already examined in previous experiments.

Each depth starts independently from the pinned base and the same initial head.
The schedule contains 1,024 unique optimization documents; no calibration or
selection labels enter the loss. Checkpoints at 0/256/512/1,024 documents are
ranked by selection false negatives, then true negatives, then log loss. Two
consecutive non-improving checkpoints stop training after at least 512 documents.
Calibration sets the threshold independently. The exported FP16 encoder is
recalibrated and checked using MPS embeddings before choosing whether to deepen from the last
2 layers to 6 and then all 12 contextual layers. Input embeddings stay frozen.

The frozen controls fit exactly the same optimization data. Their regularization
and optional metadata weight use calibration, not the final evaluation cohorts.
The selected candidate is recorded before final exploratory evaluation.

```bash
.local-evals/mail-detection/venv/bin/python -u tools/mail-detection/direct.py run
.local-evals/mail-detection/venv/bin/python tools/mail-detection/verify-direct.py
python3 tools/mail-detection/report-direct.py
```

Reports and resumable stages live under `.local-evals/mail-detection-direct/`.
The two-layer run uses AdamW. After a six-layer attempt hit the disk reserve due
to memory/swap pressure, deeper runs restart using factorized Adafactor states
and one-document CPU evaluation batches. Learning rates, data, schedule, and
selection criteria are unchanged. This comparison changes both optimizer and
depth; it does not isolate depth alone. The runtime keeps a 512-MiB disk reserve, plus projected checkpoint size,
and stores only updated layers. No context is shortened to save resources.
When checkpoint zero wins, an empty tensor checkpoint proves the encoder is
identical to the pinned frozen base. Its existing MPS embeddings can be reused
after checking dataset, revision, context, and empty layer/tensor identities.
Checkpoints with any updated layers still require fresh exported-model inference.
The twelve-layer retry also keeps the frozen vocabulary table in its original
FP16 storage and converts only lookup rows to FP32. Every parameter is checked
for exact FP32/FP16/FP32 round-trip before compaction; attention masks and all
trainable layers stay FP32. This saves 384 MB without changing vocabulary values.

Unused optional dependencies (SetFit, datasets, evaluate, pyarrow, and isolated
Node test dependencies) were removed from the task's private environment to
recover disk space. Direct training does not need them. To rerun the old SetFit
workflow, reinstall `requirements.txt` in that environment first.

## Followup: encoder versus decision head, metadata and lexical control

`followup.py` replays only the twelve-layer checkpoint at 256 documents. It keeps
the original 1,024-document learning-rate schedule and verifies loss/gradient
norms against all 16 logged reference points. It retains the updated encoder even
though the previous conservative selector preferred checkpoint zero.

The followup compares the original joint head with independently refitted
logistic heads, with and without metadata, on frozen and updated embeddings. A
word/bigram TF-IDF classifier supplies a separate paradigm without downloading
new model weights. Vocabulary/IDF and metadata scalers fit optimization only;
head hyperparameters and operational thresholds use calibration only. Historical
folds remain exploratory. Oracle 99%/100% recall curves are diagnostic and never
replace calibrated thresholds for new mail.

```bash
.local-evals/mail-detection/venv/bin/python -u tools/mail-detection/followup.py run
.local-evals/mail-detection/venv/bin/python tools/mail-detection/verify-followup.py
.local-evals/mail-detection/venv/bin/python tools/mail-detection/report-followup.py
```

Embedding extraction resumes from completed rows and uses a fresh GPU process
per padding bucket to release MPS graph caches. Artifacts are private under
`.local-evals/mail-detection-followup/`. The blind review packet contains no
teacher label or score; its separate debugging packet retains weak labels. No
human labels are fabricated and none are applied automatically.

The same folder contains `decision-models.md`: a dated primary-source review of
OpenJev variants, Rizzo Flow, Laya, AnyJev, SemIf and TypeSafe Jev. Published
benchmarks, measured local candidates and resource estimates are kept distinct.
No private mail is uploaded to any vendor and no hosted API call is performed.

`calibration-backtest.py` is a separate post-hoc analysis: it uses the combined
calibration/selection bank for thresholds while freezing every trained head and
the primary selection. Its old outer folds remain exploratory. Preview that
threshold explicitly using `predict.py --directory
.local-evals/mail-detection-followup --name tuned-head --calibration expanded-bank`;
the default artifact threshold and promoter remain unchanged. Review guidance
also distinguishes the mail target from independent attachment decisions.

## Policy-conditioned decision models

`laya-benchmark.py run` uses the pinned Laya multilingual checkpoint and runtime
under `.local-models/`. Outputs live in `.local-evals/mail-detection-laya/`.
It reads the complete thread plus an adapted binary retention policy, measures
both option orders and their fixed mean, and compares with the existing GTE
scores using identical forced-forward coverage. All inference is local. FP16
produced nonfinite logits, and a BF16 probe diverged from FP32; the retained
experiment uses FP32 without autocast. The rejected FP16 attempt is archived
separately. `proof` runs a bounded CPU numerical check; it is not a quality or
8k benchmark. `verify` compares cached scores with the public runtime API.
Fixed masked padding bounds MPS graph variants; long orders run sequentially.
After a real 4k GPU ENOSPC, the remaining long cohort uses
`LAYA_BENCHMARK_DEVICE=cpu`. CPU uses natural full sequence lengths and lossless
FP16 storage for the frozen vocabulary table, converting lookup values back to
FP32 before computation. Every vocabulary value is round-trip checked and the
mask dtype remains FP32. A full 4k CPU/GPU parity probe is saved separately.
`proof-8k` evaluates just the longest outstanding eligible thread, allowing a
bounded worst-case resource check before completing the long cohort.

The superseded v1/v2 SetFit weight files were retired to recover disk; their
feature caches, checksums and historical reports remain. Current GTE weights
and the selected fine-tuned checkpoint are preserved. See
`mail-detection-laya/retired-artifacts-cleanup.json` for the exact removals.

`openjev-benchmark.py run` prepares/reports with the existing evaluation venv,
but executes its worker with `.local-evals/mail-detection-mlx-venv/bin/python`.
The separately pinned OpenJev runtime and Qwen3.5-0.8B MLX 4-bit checkpoint must
already exist locally. It compares full-vocabulary yes-token support with
yes/no normalization, averages swapped A/B labels as a separate fixed readout,
and evaluates one positive hypothesis (Noul). These are readouts of one model,
not six independently trained models. Inference never downloads dependencies
or weights, generates tokens, or uploads mail. Output is under
`.local-evals/mail-detection-openjev/`. Run model workers sequentially to avoid
competing for unified memory and disk-backed swap.

Both studies preserve the existing historical cohorts and weak labels. The
combined calibration/selection bank is a secondary exploratory analysis; it
does not create a new held-out test. Neither script activates a mail filter.

`resume-decision-benchmarks.py` is the sequential persistent runner: finish and
verify Laya, prepare/run OpenJev, then generate the common-coverage comparison.
It holds an exclusive lock and records its PID and progress under
`.local-evals/mail-detection-decisions/`. Launch it in a new process session with
stdout/stderr redirected to `runner.log` to survive a chat interruption. The
recorded PID is also its process group ID, so the whole benchmark tree can be
stopped together. It never enables production routing or paid inference.

## Second experiment: audited labels and independent holdouts

`prepare-v2.py` exports only explicit `mail.triage_decided` audit verdicts,
historical negative terminal states, and mail positives with a matching
`wiki.promoted` event for the exact thread in the same decision second (or the
previous second to allow rounding). Historical retained-note positives without
that evidence are excluded. Negative examples with current attachments are also
excluded unless an explicit verdict includes a matching attachment fingerprint.
Historical positive attachment decisions remain unknown when only the mail
promotion is proven. All these labels remain LLM weak labels, not human truth.

The promoter now records actual mail and attachment booleans, content hash,
attachment metadata hash, policy hash and model immediately after successful
triage, before downstream writes or canonical-note preservation. Audit contains
no mail body or attachment content. The code must be deployed by the normal
application workflow before the running service starts producing these events;
the experiment does not deploy it or run paid triage calls.

```bash
set -o pipefail
python3 tools/mail-detection/prepare-v2.py export \
  | node tools/mail-detection/prepare-thread.mjs \
  | python3 tools/mail-detection/prepare-v2.py finish
```

The second dataset is frozen separately under `.local-evals/mail-detection-v2/`.
Validation and test contain only normalized template groups absent from every
split of the first experiment, stratified across email quarters. The sampler
deliberately increases positive and rare-period coverage. Its raw discard rate
is a diagnostic comparison, not an estimate of production cost savings.
Decision dates span multiple runs, but this is still a retrospective study, not
a future-incoming-mail test. Human review remains pending.

`seed-cache.py` reuses frozen embeddings only when the rendered text is byte
identical and token lengths agree. No other encoder's vectors are substituted.
`run-v2.py` runs the fixed second study: 1,024 requested training examples,
600 contrastive steps, final two layers updated, native 8k context. Pairs mix
random same-class pairs, random cross-class pairs, and nearest cross-class
negatives computed only from the selected training embeddings. The pair manifest
records every source row so split isolation can be verified.
Hard-pair runs export only the updated layers in `adapter.safetensors`, about
38 MB for two FP16 layers, with the pinned frozen base reused on load. This is
a partial transformer checkpoint, not LoRA. The encoder loader validates the
base revisions and the exact set of updated parameter names. Legacy full-model
exports remain supported. `--no-adapter-only` requests a full export explicitly.

The decision to add metadata features uses validation only: SetFit must improve
the diagnostic discard rate by at least three percentage points over the best
frozen encoder while retaining all validation positives. Test metrics are not
used for that decision. Logs and artifacts are private and resumable.

```bash
.local-evals/mail-detection/venv/bin/python tools/mail-detection/seed-cache.py \
  --directory .local-evals/mail-detection-v2 --name gte
.local-evals/mail-detection/venv/bin/python tools/mail-detection/seed-cache.py \
  --directory .local-evals/mail-detection-v2 --name bge
.local-evals/mail-detection/venv/bin/python -u tools/mail-detection/run-v2.py
```

On this Mac the expanded GPU training stopped at step 14 because MPS graph
memory exceeded 6 GB and macOS expanded swap. The dataset and baselines were
preserved. The second run restarts the same 600-step recipe on CPU:

```bash
.local-evals/mail-detection/venv/bin/python -u tools/mail-detection/run-v2.py \
  --start-at setfit-train --training-device cpu
```

CPU partial-export runs require 1.4 GiB free at startup and retain the 1.25-GiB
runtime guard. SetFit 1.1.3 does not expose `use_cpu` to its internal ST trainer;
the script temporarily supplies explicit CPU training arguments during trainer
construction and verifies the actual device before training. This does not
modify the installed library or future inference device selection.

The first pilot's redundant full checkpoint was compacted to its updated layers
after verifying all 114 frozen tensors against the pinned base, preserving all
22 updated tensors, and checking normalized tokenizer definitions. This freed
about 573 MB without changing effective weights. Its classifier/cache/report
provenance was migrated together, with original small metadata backups and the
equivalence record under `gte-setfit/artifact-migration/`. No user mail or
documents were removed.

`python3 tools/mail-detection/test_labels.py` exercises five critical audited-label
cases using synthetic readonly fixtures. The promoter's own tests also cover
retained notes, attachment-only decisions, missing results and wiki failures.

The second study triggered metadata work using validation only. `metadata.py`
adds 30 numeric features observable in the rendered input: participation,
automatic-sender markers, thread/attachment sizes and types, account/transaction
identifiers, document/payment/request/notification markers and relative mail age.
It never consumes labels, audit evidence, teacher model names or promotion state.
The scaler fits training rows only; feature weight and logistic regularization
use validation only. A lower-weight grid, including a zero-weight control, was
added after poor initial validation results, before consulting test results.
The final choice is frozen in `selection.json` before final test review.

```bash
.local-evals/mail-detection/venv/bin/python tools/mail-detection/metadata.py
.local-evals/mail-detection/venv/bin/python tools/mail-detection/verify-v2.py
python3 tools/mail-detection/report-v2.py
```

`predict.py --directory .local-evals/mail-detection-v2 --name gte-meta` previews
the validation-selected conservative model. Its `primary` policy previews the
separately validation-selected 99% target. Neither changes mail or calls an LLM.
The final report requires all encoder latency profiles. Profiles use a real
sample not exceeding each target length so padding boundaries do not distort
the comparison. New partial exports and the compacted first pilot use the same
loader and are checked by actual end-to-end preview routing.

## Data and labels

Historical `promoted` is label 1; `skipped` is label 0. Deterministic `filtered`
records are excluded. These are LLM weak labels, not human ground truth.
An existing `promoted` state can also be preserved when the latest triage decides
not to update its canonical note, so it is not always the latest LLM verdict.
The exporter opens both SQLite databases with `mode=ro` and checks the exact
subject/body thread hash used by mail-promoter before accepting an example.
Changed threads are excluded. Repeated normalized templates stay together;
conflicting template labels are excluded. Splits follow the latest historical
decision time (70/15/15). Training is sampled toward balanced classes;
validation and test preserve the class proportions of their respective periods.

Text includes full cleaned messages, subject, historical decision date, user
participation and attachment metadata. The existing per-message 4,000-character
and per-thread 14,000-character truncations are not applied. Historical labels
were made with those truncations, which is a source of label noise. Source hashes
do not cover attachments or all header metadata, another historical limitation.

Inputs over the selected encoder's actual 8,192-token budget are forwarded to
the LLM in the simulated routing policy. They are never silently truncated or
auto-discarded. This evaluation does not execute the forwarding call.

Private examples, weights and reports live in Git-ignored `.local-evals/` and
`.local-models/`. The dataset directory is owner-only. Do not commit or upload it.

## Prepare

Run from the repository root with Python 3.12 and Node 24 (native TypeScript import):

```bash
set -o pipefail
python3 tools/mail-detection/prepare.py export \
  | node tools/mail-detection/prepare-thread.mjs \
  | python3 tools/mail-detection/prepare.py finish
```

The defaults select up to 3,000 training examples and 1,500 examples per held-out
split. `dataset-summary.json` records exclusions, class counts and date ranges.
Normalized template grouping does not eliminate every near duplicate.

## Environment and models

Use the existing workspace PyTorch installation via a system-site-packages venv:

```bash
python3 -m venv --system-site-packages .local-evals/mail-detection/venv
.local-evals/mail-detection/venv/bin/python -m pip install -r tools/mail-detection/requirements.txt
```

Download only `*.json` and `model.safetensors` for GTE revision
`9bbca17d9273fd0d03d5725c7a4b0f6b45142062`, plus `*.py` from its implementation
repository `Alibaba-NLP/new-impl` revision
`40ced75c3017eb27626c9d4ea981bde21a2662f4`, to `.local-models/hub` with
`huggingface_hub.snapshot_download`. The implementation was inspected before use.
GTE uses CLS pooling and normalized 768-dimensional vectors.

BGE uses the existing loopback Ollama `bge-m3:latest` endpoint and records its
digest. Only its tokenizer is downloaded from `BAAI/bge-m3`; no second set of
BGE weights is needed. Tokenizer cache revision used initially:
`5617a9f61b028005a4858fdac845db406aefb181`.
The request sets both `num_ctx=8192` and `num_batch=8192`: this Ollama version
otherwise rejects pooled encoder inputs above its default 2,048-token physical
batch even when the loaded context is 8k. `truncate=false` exposes that mismatch
instead of silently shortening the input. Outputs must be finite and unit norm;
all-zero embeddings are rejected.

## Frozen encoder baselines

To run or resume the entire comparison and SetFit pilot sequentially:

```bash
python3 tools/mail-detection/run-all.py
```

The orchestrator requires 10 GiB free before starting and plays the macOS Glass
sound on completion, error or interruption. `--baseline-only` skips fine-tuning.
`--start-at bge` or `--start-at gte-setfit` resumes after already completed stages.

With limited disk space, use the smaller adaptation below. It requires 2.5 GiB
free to start, freezes all but the final two transformer layers (18,888,192
trainable parameters), and checks for at least 1.25 GiB free during training.
It keeps the native 8,192-token budget; training padding uses 512-token buckets
to avoid rounding a 4,769-token example up to 8,192. This is a different training
configuration from updating every transformer layer, and its quality must be
judged by the held-out comparison. The output manifest records the layer count.

```bash
python3 -u tools/mail-detection/run-all.py --start-at gte-setfit \
  --train-last-layers 2 --min-free-gib 2.5
```

```bash
python3 -u tools/mail-detection/run.py embed --name gte
python3 tools/mail-detection/run.py fit --name gte
python3 -u tools/mail-detection/run.py embed --name bge
python3 tools/mail-detection/run.py fit --name bge
```

The embedding cache is resumable and tied to the dataset hash/model revision.
GTE uses seven fixed padding buckets, SDPA attention and MPS when available.
Fixed buckets prevent MPS graph caches from growing with every distinct length.
The runner flushes vectors before atomically updating metadata. Unit-normalized
vectors can be recovered if a metadata write was interrupted.

The classifier's regularization and threshold are chosen on validation only.
The threshold maximizes skipped LLM calls subject to at least 99% recall of
historical positive labels on validation. Test reports include false negatives,
the number of positives, and a Wilson confidence bound. A point estimate of
99–100% on a small test set does not establish 99% production recall.
An exploratory conservative policy targets zero misses on validation, with its
own validation-selected threshold/regularization and separate test metrics.
It is saved as `classifier-conservative.joblib` and is the preview CLI default.
Neither policy is chosen by tuning a threshold against test labels.

## SetFit pilot

Allow ample free disk for checkpoints, temporary files and macOS swap before
training. Updating every transformer layer requires 10 GiB free; 15 GiB is
preferable. The last-two-layer alternative above requires 2.5 GiB instead.
The initial 4-GiB preflight proved insufficient on this Mac: the pilot completed
10 optimizer steps, macOS expanded swap by about 2 GiB, and the 2-GiB runtime
disk guard stopped it. No fine-tuned encoder was exported from that run.
The smaller adaptation reduces the trainable parameters from about 113 million
to 19 million, reducing optimizer state and retained activations.

```bash
.local-evals/mail-detection/venv/bin/python -u tools/mail-detection/finetune.py
python3 -u tools/mail-detection/run.py embed --name gte-setfit \
  --fine-tuned .local-evals/mail-detection/setfit-model
python3 tools/mail-detection/run.py fit --name gte-setfit
```

The pilot uses only training examples: 256 sampled examples, up to 80 contrastive
steps, native 8k context, gradient checkpointing, batch size 1 and no intermediate
optimizer checkpoints. The large input embedding matrix stays frozen; transformer
layers are fine-tuned. Non-reentrant checkpointing preserves their gradients with
frozen input embeddings. Padding buckets also apply during training. Final weights
are saved in FP16. The classification head is then refit on the same training
split and compared on the same validation/test sets as the frozen baseline.

Production activation requires a separate implementation and evaluation of human
labels, especially missed useful mail and attachments. No activation is performed
by these scripts.

Once a classifier exists, `predict.py --name gte` reads one JSON object with a
`text` field per stdin line and previews routing. It returns `discard_candidate`
or `llm`; it never changes a mail or skips a real job. The preview checks the
evaluated encoder identity, fine-tuned weight hash and the actual token budget.

`run.py profile --name gte` measures warm single-request latency at approximately
128, 512, 2k, 4k and 8k tokens on local thread samples. `bge` uses the same
procedure via loopback Ollama. These profiles run with the Mac's other services
still active and do not claim isolated benchmark conditions.

`python3 tools/mail-detection/report.py` collects completed stages into
`comparison.json` and `comparison.md`, including partial results after an
interruption. It checks that reports and profiles refer to the same dataset and
encoder. BGE token counting uses the native tokenizer (verified identical on all
5,387 initial examples) so prediction need not load PyTorch in the client.

## Gemma artifact on Orico

`gemma-benchmark.py` evaluates the original `gemma-4-E2B-it.litertlm`
file on Orico using `litert-lm-api==0.19.1` and the native GPU backend.
It does not download or convert another model. The exact artifact hash,
embedded chat template and dataset/split identities are pinned in
`.local-evals/mail-detection-gemma/plan.json`. Its isolated Python environment
is `.local-evals/mail-detection-gemma-venv`; compiled GPU caches remain on
Orico in `.mail-detection-gemma-cache` beside the model.

The benchmark uses the same full Noul prompt as the Qwen experiment.
Independent session clones score the single-token `yes` and `no`
continuations after a shared prefill; no answer is freely generated.
Both unconditional yes probability and its yes/no normalization are reported.
The file's default context is 4096 with dynamic context support: an 8192-token
engine is required, and preflight proves actual prefill beyond 4096 on the
longest eligible real thread. Over-budget threads are forwarded intact.

Run `gemma-benchmark.py run` with that environment to resume. The runner
locks its output, flushes each completed row, records stages/status, verifies
repeatability and continuation-order independence, hashes the original model
again, and updates the common comparison only after verification/reporting.
Launch with a detached subprocess to survive chat interruptions. The runner
plays the Mac Glass sound on completion or failure. No production routing or
paid API calls are enabled.
