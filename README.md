# Saka Fleet — Backend

WhatsApp-native fleet operating system: vehicles, expenses, reminders, driver &
vehicle compliance, reports, subscriptions and an autonomous Sentinel supervisor.

**Release v1.25.2.** Recent highlights:
- **Conversational-first onboarding** (v1.25.0): sales-crafted welcome (`sakaIntroText`),
  VOICE LAW at the top of the core prompt, warm quiz copy, five-line help tour.
- **Product Q&A** (v1.25.0): `src/services/productQa.js` answers cost, trial, privacy,
  countries, limits and resale questions deterministically — prices are bound to
  `subscriptionTiers.js`, so they can never go stale.
- **Stale prompt refinement gate** (v1.25.1): only a refinement carrying the current
  `SAKA-PROMPT-SCHEMA` version may augment the trained prompt.
- **Slow-turn ack** (v1.25.1): 8 s threshold, rotating copy, 60 s anti-spam floor.
- **Operator probes** (v1.24.4): `GET /api/health` and `/internal/status` mirror `/healthz`;
  a secret header (`x-saka-secret`) returns the live Cloud Run revision.
- **Reply-speed telemetry** (v1.24.1): `turn_latency_logs` + `admin latency` (p50/p95/p99
  plus per-phase averages), and `admin ai-stats` shows reply speed.

## Quick start
```bash
npm install
cp .env.example .env      # fill secrets (never commit .env)
npm start                 # Fastify on :3000, GET /healthz is DB-free
```

## Tests
```bash
npm test                  # targeted suites (always cleans up test rows)
npm run test:all          # EVERY test_*.js suite, pass/fail table + cleanup sweep
npm run health            # stateless suites + workflow lint + doc-sync + DB/CI snapshot
```

## Database migrations
```bash
npm run migrate:vin                 # VIN immutability trigger
npm run migrate:subscriptions       # tiers, trial_sessions, usage_counters
npm run migrate:trial-unbind        # account-only trials (coupons.owner_id)
npm run migrate:driver-profile      # owner driver-profile flags
npm run migrate:vehicle-compliance  # vehicle_compliances ledger
npm run migrate:followups           # background follow-up lane
npm run migrate:dunning             # dunning + re-engagement bookkeeping
npm run migrate:welcome-trial       # trial_sessions.source (welcome | upgrade)
npm run migrate:remediation         # Sentinel audit + proposals tables
npm run migrate:sessions            # chat session snapshots
npm run migrate:receipts            # receipt vault (OCR dedupe + history)
npm run migrate:feature-notice      # profiles.feature_notice (What's new digest)
npm run rollout:features            # existing-user backfill (dry-run; -- --apply writes)
```

## Architecture
- `SAKA_FLEET_ARCHITECTURE.md` is the master design + schema + flow reference.
- `.clinerules` holds the permanent engineering rules (compliance separation,
  account-only billing, VIN immutability, targeted tests, docs sync).
- Saka = WhatsApp agent · Sentinel = background supervisor · Cline = approved
  executor (CI, nonce-gated, test-gated).

## Autonomous remediation (GitHub Actions)
Two workflows, both bound to the `Saka-Fleet-Staging` environment:
- `remediation_pipeline.yml` — drafts a plan from the Sentinel audit.
- `remediation_execute.yml` — implements an APPROVED proposal (nonce gate).

Required Actions secrets (repository or environment scope): `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `SUPERADMIN_PHONE`, `SUPERADMIN_EMAIL`,
`META_PHONE_NUMBER_ID`, `META_WHATSAPP_TOKEN`, `RESEND_API_KEY`, `DEEPSEEK_API_KEY`.

Governance: add **Required reviewers** to the `Saka-Fleet-Staging` environment
(Settings → Environments) so the execute leg pauses for the Superadmin; the plan
leg stays automatic.

## Superadmin quick reference
`adminstart` → session, then `admin report`, `admin alerts`, `admin remediations`,
`admin ai-stats`, `admin trial-stats`, `admin models`, `admin model scout`,
`admin rollout`, `admin model adopt <model_id> [split]`, `admin model rollback [tier_1]`,
`admin accept fix <CODE> [override]`,
`admin modify fix <CODE> <guidance>`, `admin decline fix <CODE>`.

## Reports quick reference (v1.18.0)
Ask Saka: `fleet status report`, `financial report`, `compliance report`,
`maintenance report`, `fuel economy report`, `driver daybook`, `vehicle health`,
`compliance card`, `year review`, `eco footprint`, or a one-line bespoke report:
`custom report: fuel economy, total spend and distance for last 3 months`.
Owners receive every report for their vehicles; assigned drivers receive their
driver lane only. Every report can arrive as a branded Saka Pro PDF (link + email).
Conversations run on **Claude Sonnet 5.5** when premium routing is enabled
(`PREMIUM_MODEL_ENABLED=on`, `CONVERSATIONAL_PROVIDER=anthropic`).

## Tone & first contact (v1.18.1)
Saka introduces itself on the first message with a localized greeting
(Namaste 🙏 in India, Habari in East Africa, time-of-day elsewhere), then asks
one next step. Conversations use **emoji artistry**: semantic anchors per line,
a 🔔→⏰→⚠️→🚨 reminder ladder, 🟢🟡🔴 status chips, figures kept emoji-free, and
at most 3 emojis per message (4 on the welcome message).

## Human Saka 2.0 (v1.28.0)
- **Typo tolerance:** deterministic routers normalize transpositions, doubled
  letters, missing spaces and punctuation before matching — plates, VINs and
  amounts are never rewritten (`src/services/textNormalizer.js`).
- **No re-greeting:** a GREETING LAW plus a reply-linter opener check stop Saka
  opening every reply with Hi/Habari once the conversation is underway.
- **Local currency only:** pricing and add-on answers show the user's currency,
  converted with the same cached rate Paystack charges at checkout — no dollar
  figures anywhere (a hard scrubber enforces it). Fleet-size questions get the
  computed local total.
- **Complaint recovery:** "your last reply was incomplete" is acknowledged and
  recovered (with the full local-currency answer when a fleet count is given),
  never answered with the welcome.
- **Save-my-number:** one warm, milestone-anchored contact-save line after the
  first vehicle (or a lost-chat moment), stamped per profile, never a nag
  (`src/services/contactNudge.js`).
- **Append-only learning:** Sentinel can only add bounded, content-gated
  learnings to the trained prompt — it can never rewrite it.
- **Generated knowledge:** `docs/PRODUCT_QA.md` and `docs/SAKA_TRAINING.md` are
  generated from the live registries (`npm run docs:gen`) and drift-guarded in
  the Rules Gate.
- **Complete replies (v1.28.2):** Sonnet extended thinking is disabled by
  default, and a `max_tokens` stop falls back to DeepSeek — a cut-off sentence
  can never be sent. The retired "intelligent WhatsApp vehicle & asset
  management assistant" identity is blocked, and "let's start again" gets the
  warm welcome.
- **No phantom plates (v1.28.3–1.28.4):** paragraph intake only accepts
  plate-shaped values; "A 1991 80 series…" can no longer be saved as a plate, a
  real registration volunteered later in the same answer is captured
  immediately, and confirmation refuses to write a non-plate-like value.
  Fuel messages that give spend + price per litre ("1000kes @227kes per liter")
  derive the litres (4.41 L) instead of asking for them.
- **Mileage reminders save (v1.28.5):** a distance reminder ("due at 370,000 km")
  persists without a date, and the trigger sentence fills both type and
  threshold in one turn.
- **Report requests stay reports (v1.28.6):** "Give me a fuel report" routes to
  the report engine instead of starting the expense quiz.

## Receipt intelligence (v1.19.0)
Send a photo of a **fuel receipt, logbook, insurance policy or driver licence**:
Saka classifies it, reads the amount/ litres/odometer/VIN/plate/policy/expiry,
prefills the confirmation summary and asks only what is missing. Duplicate
photos are recognised, every read lands in the receipt vault, and
`receipts` shows your last five with 🟢/🟡/🔴 status chips. Low-confidence reads
ask you to double-check before saving; nothing is ever written without your YES.

## Intent resilience, summary PDF & rollout (v1.19.1)
- `send me my registration summary as a PDF to my email` builds a Saka Pro
  **Vehicle Registration Summary** (specs, VIN, countdowns, reminders, owner +
  driver), uploads it and emails it. Owners only; drivers get the health lane.
- `intent_classify` / `question_render` get one extra attempt when a provider
  returns an empty body — recorded inside the same `ai_usage_logs` row.
- Cloud Run revision-conflict chatter is filtered from Sentinel alerts.
- Existing users receive a once-only ✨ **What's new** digest on their next
  normal turn (never during a quiz), version-stamped by `FEATURE_NOTICE_VERSION`.
  Run `npm run rollout:features -- --apply` to backfill, and `admin rollout` for status.

## Sonnet-first front conversations (v1.23.0)
- Every **front user conversation** (intent, extraction, quiz questions, prose, small talk, nudges, admin parsing) runs on **Claude Sonnet** whenever `ANTHROPIC_API_KEY` is set - free and paid plans alike; vehicles remain the only subscription limit.
- Background/system work (Sentinel synthesis, model benchmarking/research) stays on DeepSeek. Failover: **Sonnet -> GPT-4o** when `OPENAI_API_KEY` is set -> **DeepSeek** (always terminal).
- Cloud Run needs `ANTHROPIC_API_KEY` and optionally `OPENAI_API_KEY`; `AI_TIER1_PROVIDER` / `AI_MODEL_TIER_1_ANTHROPIC` pin or override the front provider/model. Without keys the app degrades to DeepSeek automatically.
## Snappy Saka — latency & OCR pause (v1.22.0)
- **Photo OCR is paused by default** (`OCR_ENABLED=off`): photo turns answer
  instantly with clear guidance to type the details or send a PDF. PDF text
  extraction stays on (local, instant, provider-free).
- When Vision is re-enabled, media turns **ack first** ("Reading your photo…")
  and the parsed result arrives as a follow-up — no more 60–86 s silences.
- `question_render` caps at 10 s (deterministic fallback) and empty-retries only
  fire after a fast failed attempt, so one slow provider call can't double the wait.

## Country Bucket & global assets (v1.21.0)
- Every user gets a **country bucket** from their WhatsApp number, confirmed at
  onboarding: currency, units, dates, compliance rules and document examples.
- Onboarding now asks **what kind of asset it is** (car, motorcycle, truck, bus,
  machinery, heavy equipment, generator, boat): road assets use plate + VIN,
  generators and machinery use a serial and the hour meter.
- Deterministic commands: `my country`, `country <name>` to switch buckets,
  `my rules`, `required documents` and `example compliance` — sourced from
  official transport authorities, versioned and always disclaimer-tagged.
- Bundled knowledgebase ships for Kenya, Tanzania, Uganda, Rwanda, Nigeria,
  South Africa, the UK, US, Canada, UAE, India, Australia and Belgium, with a
  global fallback and superadmin overrides in `country_kb`.
- Official-source updates: `npm run kb:ingest` fetches allow-listed government
  sources into **draft** rules (never live), `npm run kb:ingest -- --review`
  lists them, and superadmin `admin kb approve <id>` publishes a verified rule.
  `admin kb stale` shows rules due for re-verification (90-day window).
- **Traffic-act deep-links:** verified national laws are registered per country
  (Kenya Traffic Act Cap 403, SA National Road Traffic Act 93/1996, UK Road
  Traffic Act 1988, US 49 CFR 390, Canada MVSA, India MV Act 1988, Belgium
  Wegcode). Legislation is fetched first so drafts carry the exact law
  reference; pending laws (TZ, UG, RW, NG, AE, AU) are listed by name but never
  fetched until an official link is verified.

## Doc Lens — documents by photo or PDF (v1.20.0)
- Send **any photo or PDF**: logbook/registration certificate, fuel or service
  receipt, insurance, inspection, road-service licence, driver licence/PSV/PDP
  or a purchase invoice. Saka reads it, shows what she found, and only saves
  after you confirm — then asks only for the fields the document did not have.
- PDFs are read locally (no extra service): digitally generated documents give
  their text instantly; a scanned PDF asks you to send the pages as photos.
- Every uploadable quiz question advertises the upload (e.g. the VIN question
  offers the logbook), and `what documents can I send?` lists the menu.

## Live-chat hardening (v1.19.2)
- **Document scans get a 25 s Vision budget** (`OCR_VISION_TIMEOUT_MS`) and one
  retry on timeout; blank reads now report *"No text detected"* instead of an
  empty error. Fixes the 3-of-4 certificate timeouts seen in production.
- After two unreadable photos on one quiz step, Saka appends a plain
  typed-or-*Skip* escape — the same question never repeats a third time.
- Saka never re-introduces itself mid-conversation: a failed classification
  degrades to one short clarifying question, never a fresh welcome.
- `list my cars` with an empty garage answers deterministically (plate example
  + REGISTER), and the stale unversioned `system_config.saka_core_prompt` was
  cleared.
