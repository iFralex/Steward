# Mail promoter: local GTE production gate

The backfill can use the evaluated `gte-multilingual-base/tuned-head` encoder
and refitted logistic head before the gateway-backed triage. This gate predicts
`promoteMail`; it does not predict attachment usefulness. Threads admitted by
the existing deterministic prefilter that contain any attachment bypass GTE
and retain the independent remote mail/attachment triage path.

## Routing and state

Unchanged teacher inputs retain the existing early skip. Other eligible threads
without attachments are serialized exactly like the evaluated dataset: complete
per-message cleaned text, dates, sender, user participation and subject. GTE sees
the complete text up to its native 8192-token budget. It never classifies a
truncated input; overflow, unavailable runtime, changed policy, timeout, invalid
response or inference error forward to the normal triage path, subject to batch
limits and retry backoff.

Low scores are cached in `mail_gate_cache`, separately from `promote_state`.
High scores and deterministic overflow results are also cached to avoid repeated
inference when a downstream request is deferred. One row per thread bounds
storage. Cache identity includes the model manifest, policy, input version and
actual stable serialized context (including participants). Attachment presence
is checked before consulting the cache. The moving decision-day header is not
used as a daily invalidation trigger, matching the existing content-triggered
promoter behavior; temporal review of unchanged notes remains a separate task.

A GTE discard does not delete an existing note and does not overwrite a prior
LLM verdict. It is not a new teacher label. Policy/model/content changes
invalidate it. Worker failures are not cached as decisions.

`mail_runtime` stores gateway and per-thread retries. Availability/authentication/
credit errors (401/402/403/429/5xx or network failure) suspend gateway requests
for 15 minutes, doubling up to six hours on failed probes. Other already-in-flight
requests may finish. Invalid remote triage replies also receive per-thread
backoff; deferrals caused only by limits/backoff do not count as thread failures.

## Configuration

The default GTE mode is `off`; deployment explicitly selects `enforce`.

| Variable | Meaning |
|---|---|
| `MAIL_PROMOTER_GTE_MODE` | `off` or `enforce` |
| `MAIL_PROMOTER_GTE_PYTHON` | Isolated production Python executable |
| `MAIL_PROMOTER_GTE_WORKER` | Frozen local worker file |
| `MAIL_PROMOTER_GTE_MANIFEST` | Pinned model, runtime, head and threshold manifest |
| `MAIL_PROMOTER_MAX_GTE_SCORES` | Maximum new gate checks per batch, default 500; actual scored count excludes overflow/errors |
| `MAIL_PROMOTER_MAX_GATEWAY_CALLS` | Maximum gateway requests per batch, default 100 |
| `MAIL_PROMOTER_CONCURRENCY` | Backfill pool; local inference is serialized |

Cached decisions do not consume the new-check budget. Unsatisfied work remains
pending. The gateway may make more than one upstream attempt for a request, so
the request limit is not an exact monetary cap.

`mail.gte_decided` records local routing and `teacherLabel:false`.
`mail.triage_decided` records actual remote verdicts before downstream writes.
`mail.batch_completed` records gated/new/cached counts, actual local scores,
overflows/bypasses, gateway requests, failures, backoff and budget deferrals.
These are routing/request counts, not independently reconciled provider charges.
`status` also prints cached local routes separately from teacher decisions.

## Local release and rollback

Build: `node tools/mail-detection/build-production.mjs`. This uses the repository
esbuild installation or the isolated `.local-models/mail-gate-dev` build tools.
Run the bundled tests and TypeScript check before activation.

Export the selected encoder/head with `export-production.py` using the pinned
production Python. The export copies fine-tuned weights out of `.local-evals`,
pins all base/custom-code/tokenizer files and library versions, and exports the
logistic coefficients without a production pickle dependency. The expanded-bank
threshold is lowered by 0.000001 toward forwarding to avoid last-bit boundary
errors; the exporter verifies that this does not change historical backtest
routes. Calibration remains exploratory and based on historical LLM labels.

The deployment release is under `.local-models/mail-gate/releases/`. Preserve
that folder, its Python environment, and the base/cache files listed in its
manifest. The environment uses pinned packages from the existing Miniconda
installation; changing them disables the gate and forwards to normal triage.

`activate-production.py --release PATH` verifies the concrete release.
`--apply` additionally backs up configuration and promoter state, sets the
launcher's supported `MAIL_PROMOTER_CLI` override, and restarts only the managed
scheduler after other child jobs finish. The signed app bundle remains intact.

Rollback:

```sh
python3 tools/mail-detection/activate-production.py \
  --release .local-models/mail-gate/releases/2026-11-12-gte-v1 --rollback
```

Rollback restores the previous managed configuration keys while preserving other
settings, and restarts the scheduler. It does not overwrite subsequent user data
or erase audit/cache tables. The state backup is for manual recovery, not routine
rollback. App updates must consider this CLI override: rebuild/revalidate the
gate release or remove the override to use the app's bundled promoter.

The GTE model is evaluated on whole threads. Incremental note updates or using
GTE on only a new message require a separate evaluation; this release does not
assume that the whole-thread metrics apply to a delta-only classifier.

For the problem investigation, evaluation methodology, model comparisons and rationale for this deployment, see [the engineering investigation](../../docs/gte-model-selection.md). Experiment reports are private local artifacts and describe historical measurements.
