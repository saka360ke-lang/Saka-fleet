# Changelog

All notable changes to Saka Fleet. Versions mirror the release tracker at the top
of `SAKA_FLEET_ARCHITECTURE.md`; every entry names the commit it shipped in.
Generated from the real git history — never from memory.

## [1.28.4] - 2026-10-31
- **Write-time plate guard:** a registration confirmation carrying a non-plate-like plate (live confirmation showed `Plate: 1991 80`) is refused — the plate is cleared, the question is re-asked and nothing is written. This protects quiz sessions created before v1.28.3.
- **Fuel volume derived from spend ÷ price:** "Topped up fuel; 1000kes @227kes per liter, @367365km" now logs **4.41 L** immediately (spend ÷ price-per-litre) instead of asking "how many litres?"; an explicit volume is never overwritten.
- **Money answers must carry a figure:** `hasLocalFigure()` requires a numeric local amount ("KES 1,298") — merely naming the currency falls back to the complete local fact lines.
- **Proof:** quiz engine 77 assertions (confirmation-refusal case) · natural intake 19 (adds the live fuel message) · product Q&A 147.

- **No phantom plates:** a plate must now contain ≥2 letters, 1–6 digits and a real letter/digit shape — "1991 80", "367359KM", "20TH", "HDJ810007675" and bare numbers are rejected. The live registration paragraph can no longer bank a year/odometer fragment as the plate.
- **Windowed paragraph scan:** plate capture tests 1–4-word candidates instead of a greedy character scan that swallowed `KAS` into the previous word, so "Car Registration KAS 628T" banks **KAS 628T** in the same turn it answers the asset kind.
- **Registration self-heal:** a previously banked non-plate-like plate is dropped before scanning, so a phantom can never block the real plate or reach the confirmation summary.
- **Proof:** quiz engine 74 assertions (incl. the exact live two-turn sequence) · natural intake 15.

- **Truncated replies fixed at the root:** Sonnet 5.5 was spending the whole 420-token output budget on hidden thinking blocks, so real replies were cut mid-word ("…I also remind you before insur", live 19:09). Anthropic calls now turn thinking off with the gateway-supported `thinking: { type: 'between_tools' }` by default (the gateway rejects `disabled` with HTTP 400; `ANTHROPIC_THINKING_MODE` overrides it and `ANTHROPIC_THINKING_ENABLED=on` opts into thinking for deliberate reasoning work).
- **A truncated answer can never ship:** the provider `stop_reason` is surfaced and a `max_tokens` stop throws, so the chain falls back to DeepSeek (which completes the answer) instead of sending half a sentence.
- **Retired identity copy blocked:** the regex classifier's canned "I'm your intelligent WhatsApp vehicle & asset management assistant" is removed; `isLegacyWelcomeCopy()` guards all four route passthroughs; the core prompt carries an IDENTITY LAW (machine's memory, money-saver, paperwork wizard).
- **"Let's start again" is a restart:** it now routes to the warm sales welcome instead of a generic greeting.
- **Proof:** new `test_anthropic_payload.js` 13 assertions (health + Rules Gate) · greetings 81 · flow adds the restart turn.

- **Local currency only:** when a user's currency is not USD, money answers never contain a dollar figure. Local facts are the only money facts passed to the composer, the instruction forbids `$`/`USD`, and `stripUsdFigures()` scrubs any leak (including bracketed `($83.92)` and `USD 9.99`). `formatUsdInLocalCurrency()` now returns "KES 519", not "KES 519 (≈ $3.99)".
- **Computed local fleet totals:** `buildLocalPricingFacts(..., fleetCount)` answers "What if I have 7 vehicles?" with `For 7 vehicles: Fleet Command ≈ KES 4,676/month (5 included + 2 extra slots)` — the live pure-USD card is gone.
- **Reply-complaint recovery:** "Your last reply was incomplete" is now recognised as a complaint, acknowledged, logged (`INCOMPLETE_REPLY_COMPLAINT`), and answered — with the full local-currency fleet answer when a count is present. It never re-introduces Saka or shows the welcome.
- **"Tell me a little about Saka":** now routes to the warm intro facts instead of the generic greeting fallback.
- **Proof:** product Q&A 142 · greetings 75 · answer oracle 31 · `npm run test:flow` extended with local-only annual/7-vehicle turns and the complaint turn.

- **Typo & omission tolerance:** new `src/services/textNormalizer.js` normalizes transpositions, doubled letters, missing spaces, diacritics and punctuation for ROUTING only — `matchProductQa`, the regex intent fallback, stop detection and quiz arbitration now understand "Howmuch is the pricimg?", "Habbari" and "sotp". Plates, VINs, amounts and emails are never rewritten (confirmation still gates writes).
- **GREETING LAW + linter:** the core prompt and composer forbid opening a reply with Hi/Habari/Good morning once a conversation is underway; `sanitizeSakaReply` replaces a repeated greeting opener with the fact fallback (first contact keeps its greeting).
- **Local-currency payment answers:** `buildLocalPricingFacts()` converts tier and add-on prices with the same cached FX rate Paystack charges at checkout; product answers lead with KES/INR/etc. and keep the USD list price in brackets. Add-on cards now show the local amount too.
- **Save-my-number nudge:** one warm, milestone-anchored line after the first vehicle/passbook (or a lost-chat moment), composed from facts, once per profile (`profiles.contact_save_nudged_at`, 30-day cooldown), never during quizzes, frustration or pause.
- **Learning framework hardened:** `runConversationRefinement()` is now APPEND-ONLY — Sentinel adds bounded `LIVE LEARNINGS` bullets and can never rewrite the trained prompt; `refinementIsSafe()` rejects banned phrases (unless negated), missing schema markers and oversized payloads.
- **Generated knowledge docs:** `scripts/gen_kb_docs.js` renders `docs/PRODUCT_QA.md` and `docs/SAKA_TRAINING.md` from the live registries; `npm run docs:check` and `test_kb_docs.js` fail on drift.
- **Scoped multi-part banking:** `applyTextExtraction()` now scopes fragments per field, so "5000 for 40 litres at 366900 km, full tank" banks ₹/KES 5000, 40 L, 366,900 km and Full tank instead of reading 5000 for everything; banked details are acknowledged once.
- **Per-user memory:** the answer snapshot adds relationship stage and remembered preferences (language, units, timezone, preferred vehicle) without a schema change.
- **Proof:** text normalizer 24, contact nudge 24, greetings 70, product Q&A 134, agent training 102, quiz engine 60, knowledge docs 36, answer oracle 30.

- **Answer Oracle:** Saka answers any question about Saka Fleet *and* the user's own data, composed fresh every time — no pre-made replies on the happy path.
- **Facts, not answers:** `productQa` is a fact registry (annual prices, features, packages, limits); the reply is always composed.
- **Annual pricing** is in the facts (the hedge "I don't have annual details" is impossible).
- **Computed capacity:** "I have 8 cars" → Fleet Command + 3 add-ons, with the exact total.
- **Realtime user-data snapshot:** plan, vehicles, this month's spend/fuel, next reminders — numbers computed in code.
- **Universal question path** + **farewell path** + **feedback path** (no canned apology for opinions).
- **Personality v2** and a **reply linter** that blocks corporate hedging and broken placeholders.
- **Proof:** product Q&A 128, answer-oracle 26 (seeded DB, cleaned), flow suite extended (features, packages, 8-car math, annual, goodbye).

## [1.26.2] - 2026-10-31
- **"Is this a free service?" now answers pricing** — `free` was missing from the pricing matcher.
- **Hard no-plate invariant:** outside the registration quiz, any reply mentioning "plate" is replaced by a warm "tell me what you drive" line — the model can never re-add the plate ask.
- **Proof:** `npm run test:flow` 37 assertions (every turn asserts no "plate"); product Q&A 105.

## [1.26.1] - 2026-10-31
- **Generic answers removed:** product replies are now composed fresh from verified facts (cards only as an outage fallback); the nudge family is banned at the prompt level; a repeat asks for a different, warmer phrasing instead of a canned line.
- **No plate ask outside registration:** welcome, greeting and default prompts now ask "What do you drive?", and the welcome no longer mentions sending a plate.
- **Small talk tolerance:** "Nice. Tell me more about Saka" now reaches the intro answer.
- **Proof:** `npm run test:flow` 30 assertions · product Q&A 103 · agent training 92.

## [1.26.0] - 2026-10-31
- **Conversational Answer Engine:** answer-first rule in the AI context, anticipated-question matrix (how-to-use, tier details, add-ons, subscribe steps, why-VIN/plate/email, mistakes, progress, WhatsApp-only, data control), plural pricing coverage.
- **Friction resolver fixed:** "why do you need my VIN?" and similar questions are answered instead of triggering an apology + pause.
- **Trust lines** on plate/VIN/email/OTP asks; a recognised question always outranks the apology.
- **Proof:** `npm run test:flow` now runs today's full conversation (28 assertions) — no answer may contain the plate script unless registration is happening.

## [1.25.8] - 2026-10-31
- **Root-cause fix (proven by local reproduction):** the anti-repeat guard compared the reply with ITSELF (`lastAssistantPrompt` was overwritten with the current reply before the guard ran), so the sales welcome, pricing card, trial card and every FAQ answer were replaced by nudges. The guard now compares against the previous turn.
- **Placeholder name fixed:** new profiles start with `full_name = null` (no more "Habari! 👋 WhatsApp I'm Saka").
- **New e2e regression:** `npm run test:flow` drives the real WhatsApp handler through "Hi", pricing, trial and FAQ turns.

## [1.25.7] - 2026-10-31
- **Two deploy notifications:** a "building" WhatsApp alert on push and an app-emitted **`🚀 Saka is LIVE`** alert per revision (`src/services/deployLiveAlert.js`) — works for local pushes, cline.bot and manual deploys.
- **Rules-gate failure alert:** `notify_git_push.js --failure` + `.github/workflows/rules_gate.yml`.
- **Field-work protocol:** `npm run sync:origin`, `.clinerules` rules 32-34, and a health warning when the checkout is behind origin/main.
- **GitHub CLI** installed locally for deploy/run inspection.

## [1.25.6] - 2026-10-31
- **The sales welcome now survives the zero-vehicle plate guard** (`shouldReplacePlateAsk`) — plain "Hi" shows the welcome, not "Let's set up your first asset".
- **"Tell me more about …" routes to the Product Q&A intro** (saka fleet, sakafleet, you).

## [1.25.5] - 2026-10-31 — cf9e51d (shipped via cline.bot)
- Newcomers never receive the "Let's keep moving" nudge; they get onboarding-oriented copy (`NEWCOMER_NUDGES`).
- First-time phrases ("this is my first time", "where do I start") trigger the full welcome; first contact clears stale in-memory repeat state.

## [1.25.4] - 2026-10-31
- **"Tell me about sakafleet" now routes to the Product Q&A intro** (`sakafleet`/`saka fleet` recognised as phrases) instead of falling into a guard.
- **Repeat nudges rotate** (`pickRepeatNudge`) and reset on progress, so a stuck or confused user never sees the same line twice.
- Both bugs were observed live on 2026-10-31 09:01–09:02 UTC.

## [1.25.3] - 2026-10-31
- **Deploy alerts carry the commit id in the title** (`✅ Saka update is live - v1.25.3 - <hash>`) plus a GitHub commit link, so every release is identifiable at a glance.
- **This changelog added** and guarded by `test_doc_sync.js` (its newest entry must equal `package.json`).
- **Sentinel prompt refinements now stamp the schema marker** (`SAKA-PROMPT-SCHEMA:<current>`), so the weekly refinement is actually accepted by the core-prompt gate instead of being silently ignored (and it can never reintroduce the old corporate prompt).
- **Admin help aliases:** `list commands`, `list superadmin commands` and `show admin commands` route to the deterministic command list instead of the conversational nudge.
- Clean-slate wipe re-run for a fresh onboarding.

## [1.25.2] - 2026-10-31 — ff82636
- Full app audit: `npm run test:all` exhaustive runner (53 suites), env-safe suites, four legacy suites retired (`legacy_*`), deterministic stop/pause restored (`isStopRequest`, `PAUSE_REPLY`), doc-sync guard, `package.json` aligned.

## [1.25.1] - 2026-10-31 — 4774e21
- Stale prompt refinements retired (`SAKA-PROMPT-SCHEMA:2026.11.0`); the 2026-10-28 refinement was overriding the new VOICE LAW.
- Slow-turn ack tuned: 8 s threshold, rotating copy, 60 s anti-spam floor (`src/services/turnAck.js`).

## [1.25.0] - 2026-10-31 — 4a7932c
- Conversational-first onboarding: sales welcome, VOICE LAW in the core prompt, warm quiz copy, five-line help tour.
- Product Q&A engine (`productQa.js`) with prices bound to `subscriptionTiers.js` and a statement guard so log lines never trigger the pricing card.

## [1.24.4] - 2026-10-31 — 2c14201
- Status-probe aliases `/api/health` and `/internal/status` (Google's edge intercepts `/healthz` on the run.app host).
- First-time-user onboarding loop fixed (`shouldReplaceIntroCopy`, `isRepeatedReply`).

## [1.24.3] - 2026-10-31 — 42136c7
- Silent superadmin sessions (no session emails; audit rows remain).
- `/healthz` revision probe, first-contact race fix, per-turn phase telemetry (`phase_ms`).

## [1.24.2] - 2026-10-31 — 245357c
- Provider-outage hardening: billing-aware breaker (`AI_CB_BILLING_OPEN_MS`), per-leg timeout shaping and hard deadlines, slow-turn ack, deterministic `admin help`.
- Clean-slate reset truncates `turn_latency_logs`; health guards the reset scope.

## [1.24.1] - 2026-10-30 — 08f1b84
- Reply-speed telemetry (`turn_latency_logs`, `admin latency`, `admin ai-stats` footer) and the `NATURAL_INTAKE` kill switch.

## [1.24.0] - 2026-10-30 — b6c2fac
- Conversation-first Saka: natural intake prompts, instant paragraph acks, sharper paragraph parsing; onboarding upload hints off.

## [1.23.3] - 2026-10-30 - ce021bb, 2daead7
- Backend incident registry (resolve/silence/admin commands); incidents included in the slate wipe.

## [1.23.2] - 2026-10-30 - 849b3d0
- Plain-English superadmin alerts, deploy-noise decoder, quieter startup.

## [1.23.1] - 2026-10-30 - 88a4cc6
- Pricing v2 (annual discounts), free-tier vault gating, OCR hard pause, release tracker.

## [1.23.0] - 2026-10-30 - 8083a06
- Sonnet-first front conversations with GPT fallback; production env hardening.

## [1.22.0] - 2026-10-30 - 8ff545f
- Snappy replies: OCR pause, ack-first media handling, AI latency trims.

## [1.21.3] - 2026-10-30 - 84c7afc
- Wipe-aware first contact; zero-vehicle plate routing.

## [1.21.2] - 2026-10-30 - 80488dd
- Country-wise traffic-act deep links with law references.

## [1.21.1] - 2026-10-30 - 79c3913
- Country KB ingest, draft review and the superadmin approval gateway.

## [1.21.0] - 2026-10-30 - c11cb98 (+ f781001, 7db86cf)
- Country buckets, jurisdiction knowledgebase, global asset kinds.

## [1.20.0] - 2026-10-30 - 663786c
- Document Lens: photo and PDF intake with confirm-before-save.

## [1.19.2] - 2026-10-30 - a2441c7
- OCR Vision resilience, no-repeat welcome, empty-garage reply.

## [1.19.1] - 2026-10-30 - d2fc1bb
- Intent resilience, registration summary PDF, deploy-noise filter, existing-user feature rollout.

## [1.19.0] - 2026-10-30 - f74c99b
- OCR receipt intelligence, document classifier, receipt vault with dedupe.

## [1.18.1] - 2026-10-30 - afb09b9
- Emoji Artistry, Saka first-contact introduction, Sonnet 5.5 temperature fix.

## [1.18.0] - 2026-10-30 - dce780b
- Saka Pro PDF reports, bespoke metrics, role-scoped report lanes, Claude Sonnet 5.5.

## [1.17.1] - 2026-10-30 - b2d48b1
- Full-tank-aware fuel economy engine and fill-type capture.

## [1.17.0] - 2026-10-30 - 5f8724b
- Model Watchdog self-updating AI pipeline; Tone Compass and Mirror Engine.

## [1.16.4] - 2026-10-30 - c75e4b7
- Driver unassignment WhatsApp notices; free-tier full-featured welcome trial.

## [1.16.3] - 2026-10-30 - a762cdc
- PAST_DUE dunning ladder, 14-day re-engagement nudge, executed-env governance, health snapshot.

## [1.16.2] - 2026-10-30 - 2ce6f5e
- OTP loop closure, audited remediation overrides, friction dedupe, cancel save-offer, cached discovery, passbook snapshot, health audit.

## [1.16.0] - 2026-10-30 - 19fd7b0
- Owner driver profiles, vehicle/driver compliance separation, paragraph intake, account-only trial binding, background follow-ups, remediation pipeline repair.

## [1.15.x] - 2026-10-30 - 3e1dcff, a9d2d1e, fdd1315
- Tier matrix, recurring Paystack billing, 30-day trial engine, entitlement gates; Meta webhook signature hardening and env parity diagnostics.

## [1.14.x] - 2026-10-30 - b8e65af, 2f5a376, 40f6331
- Multi-provider failover, circuit breakers, Tier-3 reasoning and budget guardrails; WhatsApp-only deployment alerts; hardened slate reset (26 tables, preserved-table guard, backups).

## [1.13.0] - 2026-10-30 - 6f9e318
- AI telemetry analytics, admin ai-stats digest, escalation tuning, env standards.

## Earlier milestones
- v1.12.0 - multi-model router with purpose registry.
- v1.11.x - Sentinel continuous auditing, remediation plans, adaptive digests.
- v1.10.0 - autonomous Sentinel to Cline remediation with a Superadmin approval gate.
- v1.9.x - driver OTP assignment, compliance onboarding, four core fleet reports, staging schema transport.
- v1.8.1 - instant webhook ACK with background dedup, flow-playbook agent training (c2e1c0b).
- v1.8.0 - maintenance reminders (km/mi/hours), natural parsing, Cloud Run triage (3510de9).
- v1.7.6 - global date parser with Nairobi normalization, Sentinel stall recovery (a639b32).
- v1.7.0 - quiz fast path, batched question prefetch, prompt cache, parallel DB I/O.
- Initial production release - ada131b (2026-10-23).
