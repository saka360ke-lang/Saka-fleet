# Conversation eval corpus

This folder feeds the DeepEval-style judge (`src/services/convEval.js`). Cases are scored on five criteria — loop avoidance, Persona v4 tone, shorthand precision, one question, boundary safety — and every criterion must clear the bar.

## Files

| File | Purpose |
|---|---|
| `cases/conversation_cases.json` | The hand-written regression corpus (14 cases). Loaded into `CONVERSATION_CASES`; main-corpus invariants are pinned by `test_conv_eval.js`. |
| `cases/syn_<cc>_<stamp>.json` | Global synthetic batches generated on demand. Loaded into `SYNTHETIC_CASES` (separate from the hand-written corpus) and only included in a run with `--synth`. |

## Commands

```bash
# Score the hand-written corpus
npm run eval:conv

# Score live PENDING friction transcripts + corpus fill
npm run eval:conv -- --live

# Include every synthetic batch
npm run eval:conv -- --synth

# Generate new regional scenarios (reasoning tier, on demand)
npm run synth:cases -- --countries=KE,NG,ZA,GLOBAL --batch=4 --preview
npm run synth:cases -- --countries=BR,MX,PH --batch=4

# Export DeepEval-compatible JSONL (no provider call)
npm run eval:export
```

## Country buckets

`country_bucket` is either a real ISO country code (`KE`, `NG`, `ZA`, `GH`, `BR`, `MX`, `PH`, `IN`, `AE`) or `GLOBAL` for neutral international English. The bucket is **metadata on the case**: regional lessons stay inside the batch file for review, and the generator never writes `country_learnings` (that table is derived from live chats by Sentinel, rule 41).

## Safety rules baked into every case

- No real phone numbers, emails, VINs or people; plates are obviously fictional.
- The final `reply` is the *ideal* Persona v4 answer; a case never asks the judge to invent facts.
- `expected` (`pass`/`fail`) is calibration metadata — a judge that disagrees with many expectations needs attention.
- Synthetic cases may carry `expected_metrics.min_loop_avoidance_score`, which becomes a per-case `minScore` bar (clamped 0.5–1.0).
