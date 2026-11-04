# SAKA FLEET - Master Architecture & System Audit

**Status:** Production Ready / Active  
**Version:** 1.58.15  
**Efficiency Policy:** Consult this document and `.clinerules` first before inspecting codebase files.
## Release History (single source of truth)

Every shipped release is tracked HERE and nowhere else. Newest first.

| Version | Headline | Detail |
|---|---|---|
| **1.58.15** | Production knobs off (REMEDIATION_AUTONOMY / CONVERSATION_DIAGNOSIS_ENABLED) + multi-asset landing branding (cars, trucks, boats, generators, excavators, EVs) + document retention (receipt delete, bucket-object wipes, OCR telemetry prune) | 144 |
| **1.58.14** | Duplicate-signup block (phone variants + email + owner notice) + Sentinel log-only policy (no autonomous proposals; errors clear when tended) + Resend inbound email with Svix verification and admin inbox | 143 |
| **1.58.13** | Pending-only remediation alerts (threshold = pending backlog) + unverified-gate confusion clarification (PROP-2026-11-04-01) + phantom 90-day trial fix (legacy default dropped, data remediated) | 142 |
| **1.58.12** | Zero-vehicle owner: the snapshot no longer offers a driver-licence fill step before a vehicle exists (snapshot noise fix) | 141 |
| **1.58.11** | Fresh-signup fix: verified users are never re-welcomed, the GREETING lane advances a verified vehicle-less user to their first vehicle, and the greeting is English-first / language-aware | 140 |
| **1.58.10** | Self-documenting superadmin commands (registry + clarify) + autonomous customer care (tickets, inbound-email→WhatsApp, superadmin escalation) + driver/trial/coupon/nudge audit | 139 |
| **1.58.9** | Profile-wipe phone-variant fix (bare 254… rows) + ops CLI + live reset of +254734852529 | 138 |
| **1.58.8** | Cloud Run auto-deploy pipeline + OTP-gated profile wipe (`admin wipe`) + verified earnings save + post-signup conversion directive | 137 |
| **1.58.7** | Verified saves (no false "Saved"), "switch to X" works mid-draft, "Stop" pause TDZ fixed | 136 |
| **1.58.6** | Chat fixes: past-tense expense statements logged (not answered as queries), "pull/show … records" routed as queries (not log flows), ambiguous multi-vehicle reads ask which vehicle | 135 |
| **1.58.5** | Bi-weekly Sentinel deep audit (deterministic code-integrity scan → deduped PENDING_APPROVAL PROP-* proposals, Mon/Thu 03:00 EAT, env-gated) | 134 |
| **1.58.4** | Deep-audit reliability fixes (mojibake purge, crash fallback, Nairobi/currency auto-audit, record-lane scoping, pinned ledger edit, Sentinel boundary lock, Meta v21.0, dead-code) | 133 |
| **1.58.3** | Cross-vehicle ledger scoping + one-line plate routing (live plate_number/make_model matcher + which-vehicle safe gate) | 132 |
| **1.58.2** | Field-value pollution guard (notes/labels never overwrite make/model) + edit-field alias normalization + live KBJ row cleaned | 131 |
| **1.58.1** | Reminder menu is numbered + bare number selects the Nth option (fixes reply-3 loop) | 130 |
| **1.58.0** | Registration confirm loop fix (field-correction lane + note strip) + Sentinel friction auto-close (DEPLOYED) + proposals triaged | 129 |
| **1.57.1** | Coupon false-positive fix, trial capacity fix (growth welcome trial + reconcile), superadmin trial cleanup, clear chat | 128 |
| **1.57.0** | Country learning buckets (Uganda != Italy) + superadmin-can-never-be-driver rectification | 127 |
| **1.56.5** | admin friction done resolves short id prefixes (tracker polish) | 126 |
| **1.56.4** | Friction tracker (pending/deployed + 4h auto-clear + log) + whole-conversation memory (20-40 turns) + E.164 friction phones | 126 |
| **1.56.3** | Maintenance-schedule questions ("when should I replace my tyres?") answer from the user's reminders, never a generic menu | §125 |
| **1.56.2** | Plain-English admin backlog — "show me [all] pending proposals" maps to the remediation list (PROP-2026-11-03-07) | §124 |
| **1.56.1** | "You deleted the wrong entry" is a complaint (not a ledger edit) + readable empty record answers | §123 |
| **1.56.0** | Existing owners add another asset (registration starts for them) + "current mileage" answers read the vehicle, not the ledger | §122 |
| **1.55.1** | Sentinel response-mismatch → code diagnosis → PROP-* proposal (flag-gated, read-only, review-in-chat) | §121 |
| **1.55.0** | Conversation working memory: the submitted-but-unsaved draft (fields + extra notes + pending) is visible to the model, secret-free | §120 |
| **1.54.5** | Draft-correction lane fixed: a "wrong field" correction to an unsaved entry no longer gets stolen by the saved-ledger edit command | §119 |
| **1.54.4** | Engine-owned patience ladder: same-field repeats climb deterministically (2nd → simplest typed path, 3rd → human lane), reset on progress | §118 |
| **1.54.3** | Conversational-first completion: all 19 remaining canned replies composed (ratchet ≤ 4), persona conversation-compliance harness shipped | §117 |
| **1.54.2** | Country parsing profiles as plug-in data + data-driven resilience loop (`admin ocr-profile`, OCR watchlist in the Sentinel digest) | §116 |
| **1.54.1** | Global OCR hardening: universal normalization (locale amounts, CLDR currency symbols, country plates) + flag-gated zero-shot extraction top-up; purchase-invoice classification fixed | §115 |
| **1.54.0** | ANSWER LAW v2: full own-data snapshot (recent ledger + one populate step per missing field), widened access-refusal ban, own-data on data-sensitive turns | §114 |
| **1.53.2** | Onboarding fixed: KE NTSA PARTICULARS parsing (correct plate), registration correction/edit lane, verified-email answer | §113 |
| **1.53.1** | Governance v2: autonomous execution decommissioned → PROP-* proposal registry, review-in-chat workflow | §112 |
| **1.53.0** | Personality v3: tone-dimension lock, plain-language floors, every-demographic pacing (research-backed) | §111 |
| **1.52.1** | Conversational-first: prose replies composed from facts (gates, acks, cancellations, duplicate receipt, pause) + no-canned-replies ratchet lint | §110 |
| **1.52.0** | Own-data snapshot (expiries, trial, compliance) + OWN-DATA LAW — Saka never withholds the user's data | §109 |
| **1.51.11** | NTSA registration certificate → registration prefill; receipt pipeline receipt-only; empty-expense guard; git auto-sync hooks | §108 |
| **1.51.10** | Interactive quick-edit payload builder (`admin quick-edit` preview); SUG-2026-11-03-01 clause 7 only | §107 |
| **1.51.9** | Cloud Run deploy-noise classifier + cut-off reply recovery (completeness complaints get the finished answer) | §106 |
| **1.51.8** | Registration email/OTP removed from chat (verified profile email used) | §105 |
| **1.51.7** | Document-turn resilience (lens try/catch + telemetry-before-lens) | §104 |
| **1.51.6** | Unverified media gate (no OCR ack/Vision for unverified numbers) | §103 |
| **1.51.5** | Unverified numbers hard-gated to website signup (single choke point) | §102 |
| **1.51.4** | Unverified greeting → website-only (no vehicle-registration ask) | §101 |
| **1.51.3** | FEAT adoption: `admin adopt <FEAT-code>` → SUG- work order | §100 |
| **1.51.2** | FEAT-* approval dead-end → review-only reply | §99 |
| **1.51.1** | Short links enabled (SHORT_LINK_DOMAIN_READY=on + PUBLIC_APP_URL) | §98 |
| **1.51.0** | Unified admin backlog + gentle website signup push + changelog refresh | §97 |
| **1.50.1** | Homepage changelog moved to /status; `PREMIUM_MODEL_ENABLED=on` | §96 |
| **1.50.0** | True two-tier AI routing (Tier-1 Haiku / Tier-2 Sonnet) + superadmin-only | §95 |
| **1.49.6** | Superadmin remediation view: grouped pending/deployed + `admin remediations pending|deployed` filters | §94 |
| **1.49.5** | Mandatory website signup (write-path guards on both registration flows, legacy WhatsApp auth endpoints removed) | §93 |
| **1.49.4** | English-first welcome + explicit language-switch confirmation | §92 |
| **1.49.3** | Signup conversion tracking (`successful_signup` dataLayer) + cookie-choice gate before account creation | §91 |
| **1.49.2** | Website-only signup + OTP (in-chat 6-digit fallback removed), `web_onboard_otps` added to the clean-slate reset scope | §90 |
| **1.49.1** | Fix: superadmin exempted from the website registration gate + natural-language "Status of FIX-<code>" remediation status lookup | §89 |
| **1.49.0** | Website-first onboarding (point of entry = sakafleet.com), WhatsApp registration gated on email verification, consent-gated Google Tag Manager (GTM-TGR68X2X), targeted reset clears owner_id-keyed rows | §88 |
| **1.48.0** | `UPDATE-SUGGEST>` superadmin command (Model A capture → remediation approval gate), WhatsApp `message_status` delivery receipts, build-notification diagnosis | §87 |
| **1.42.0** | Extensionless URLs (301 + internal rewrite in .htaccess), clean links site-wide, always-sent {{1}} welcome-template parameter | §86 |
| **1.44.0** | Timezone-first + overridable country detection (fixes wrong-flag on en-GB devices), "Not you? Change" picker | §86 |
| **1.45.0** | National-flag badge on every page (timezone auto-detect + manual fallback), ≥3 compliance cards per locale (universal insurance + inspection cards), locale-neutral driver copy | §86 |
| **1.46.0** | Local-currency pricing on the homepage (timezone-resolved), monthly FX refresh + one-sided revenue ratchet (never down, ratchet up >=2%), BRL added, META welcome template enabled | §86 |
| **1.47.0** | Web signup captures the browser language + English default (never Swahili uninvited); signup no longer offers a manual chat button; CHANGELOG is now app-only | §86 |
| **1.43.0** | First-load flag (inline locale bootstrap), no-cache HTML/JSON + version-stamped assets, PNG og/favicons, font preload | §86 |
| **1.41.0** | Country-aware website: locale-detected compliance/lingo personalization from a catalog-mirroring dataset (drift-guarded), flag confidence chip, compact cookie banner | §86 |
| **1.40.0** | Website refinement: vendor/Apex/app-host sweep, one-car language, /status page with plain-language incident ticker, cookie consent, self-hosted fonts, locale-based country codes, already-registered signup path, proactive Saka welcome, Sentinel-tracked web-onboarding failures + OTP prune, surgical training sync | §86 |
| **1.39.4** | wa.me deep links point at the verified Saka business number (+1 940-440-7252); placeholder regression-tested | §86 |
| **1.39.3** | Explicit `subscription_tier: 'free'` on both profile-creation paths — the live schema's legacy `SOLO` default + null status resolved to paid entitlements for brand-new accounts | §86 |
| **1.39.2** | Hostinger deploy workflow fix: secrets guard moved from job-level `if` (unsupported context — zero-job failures) to a step-output check | §86 |
| **1.39.1** | Landing deploy prep: GFE-safe `/api/health` uptime probe (with `/healthz` fallback), Data Deletion page, footer/sitemap/llms links | §86 |
| **1.39.0** | Marketing website + web onboarding (`landing/`, `/api/onboard`, Hostinger FTP deploy) + research-backed odometer policy (full-tank fuel required, zero-signal types never asked, hours-led assets use engine hours) | §85, §86 |
| **1.38.0** | Multi-record paragraphs (D4): one message → numbered plan card (1 Save all / 2 Edit one / 3 Cancel), per-row audited writes, additive lines never split, no invented dates | §84 |
| **1.37.0** | Corrections 2.0 (D1): ledger edits are delete & re-log — fresh row, original entry date, DELETE audit consumed via `relogged_entry_id` so `restore` can never duplicate a corrected row | §83 |
| **1.36.0** | Record Answers + `QUERY_RECORDS` (intent 42): "how much did I spend on fuel last week?" is answered deterministically from the ledger (sum/count/average/list, Nairobi date ranges, zero AI tokens) | §82 |
| **1.35.0** | Draft Cards: narrative pre-fills confirm through an engine-rendered card (1 Save / 2 Change / 3 Cancel, zero AI tokens) with live re-render on corrections, optional-field auto-skip, and a narrative eligibility threshold (D5) | §81 |
| **1.34.0** | Narrative Intake: one free-text sentence is deterministically parsed (money lexicon, past dates, vendor, volume, odometer) and pre-fills the log quiz; stated past dates land in `created_at` on the fresh write — zero AI tokens, never a guessed figure | §80 |
| **1.33.0** | Editable ledger: `my entries` → `edit 2` / `delete 2` (DELETE confirm) → before/after diff, hard delete + `admin_audit_logs` snapshot + 30-minute `restore`, whitelist-locked fields (VIN/plate/date never editable), fresh-log safety and PIN/OTP guard | §79 |
| **1.32.4** | Report legibility (paint-scoped alpha, real KPI rows, no-wrap cells, 722 pt cover), self-verifying short links (`/r/__saka_probe__`, honest 404), env/secret parity audit (`admin env`, `/internal/status` env block, `npm run env:audit`), chat friction rules (pdf = report, no empty replies, real receipt vendors) | §78 |
| **1.32.3** | Stale-state hijack fix: 45-min chat-history window, 20-min quiz expiry + auto-parking drafts, read commands always answered, coupon gated on a prior offer, dedicated compliance PDF layout | §77 |
| **1.32.2** | Short links gated on the verified `app.sakafleet.com` subdomain, deterministic compliance/reminder answers, typed expiry corrections, days-left confirmations, deploy LIVE-alert fix | §76 |
| **1.32.1** | OCR audit remediation: silent-crash fix, insurance≠logbook + expiry-label precedence, Kenya e-TIMS profile (Rule 36), three-layer duplicate guard, `ocr_requests` telemetry + `admin ocr-stats`, HEIC | §75 |
| **1.32.0** | Presentation polish from the real KAS 628T PDF (plate cover, honest zero tones, 6-card grid, vehicle snapshot, clean callouts) + self-hosted short links for every report/checkout URL | §74 |
| **1.31.0** | Populate the variables: asset-aware reminder catalog, typed earnings (+ migration), 17 global compliance catalogs, driver compliance registry, expanded vehicle attributes, guarded demo fleet seeder | §73 |
| **1.30.0** | Expense DNA: exhaustive 19-type catalog across all 8 asset kinds, asset-aware quiz menus, real-chat alias resolution (puncture/filters/parts), unified report classifiers and ledger badges | §72 |
| **1.29.0** | Saka Apex PDF design system: vehicle deep-dive, owner portfolio, driver performance, itemized ledgers, type badges, segmented/vs bars, insight callouts, zero-transparency contract | §47.2–§47.7 |
| **1.28.9** | Asset metric registry: all 8 kinds populated (odometer vs engine hours, litres vs kWh, L/h, MPG, km/kWh) and wired into reports, summaries, bespoke menus, prompt and QA facts | §71.18 |
| **1.28.8** | OCR unpaused end to end, always-on self-learning tick, country communication styles, abandoned-checkout recovery (30 min/24 h/T-2d), post-expiry benefit nudges (D+7/D+30) | §71.17 |
| **1.28.7** | Reports always deliver (guaranteed fallback + storage self-heal), PDF glyph-safe rendering, locale/currency-correct trial reward with the coupon attached, operations list in the welcome + on demand, "in 5,000 km" vs "at 370,000 km" | §71.16 |
| **1.28.6** | Report requests never become logging flows: "Give me a fuel report" routes to the report engine, not the expense quiz | §71.15 |
| **1.28.5** | Mileage reminders save: `reminders.due_date` relaxed to NULL, trigger sentence banks type + threshold, threshold insert proven by tests | §71.14 |
| **1.28.4** | Write-time plate guard + fuel volume derivation: confirming a phantom plate re-asks; "1000kes @227kes per liter" logs 4.41 L instead of asking | §71.12, §71.13 |
| **1.28.3** | No phantom plates: structural plate check, windowed paragraph scan, registration self-heal — the real plate volunteered in a later turn is captured | §71.11 |
| **1.28.2** | Complete replies: Sonnet thinking disabled by default, `max_tokens` truncation falls back to DeepSeek, retired identity copy blocked, "start again" gets the warm welcome | §71.10 |
| **1.28.1** | Local-currency-only money answers (no dollar figures anywhere), computed local fleet totals, reply-complaint recovery, "tell me a little about Saka" routing | §71.3, §71.9 |
| **1.28.0** | Human Saka 2.0: typo-tolerant routing, GREETING LAW + linter, local-currency payment answers, save-my-number nudge, append-only Sentinel learning, generated QA/training docs, scoped multi-part banking | §71 |
| **1.27.0** | Answer Oracle: facts-only registry (annual prices, features, packages, computed capacity), realtime user-data snapshot, universal question path, farewell + feedback paths, reply linter, personality v2 | §70 |
| **1.26.2** | Free-service pricing routing + a hard no-plate invariant outside registration | §69.7 |
| **1.26.1** | Human Saka: generic answers removed (AI-composed replies, banned canned lines, no plate ask outside the quiz) | §69.6 |
| **1.26.0** | Conversational Answer Engine: answer-first rule, anticipated-question matrix, friction resolver fix, trust lines on sensitive asks | §69 |
| **1.25.8** | Root-cause fix: repeat guard compared the reply with itself (every real answer became a nudge); placeholder-name greeting; e2e flow test | §65.11 |
| **1.25.7** | Deploy telegraph: "building" alert + app-emitted LIVE alert, field-work sync protocol, Rules Gate | §68 |
| **1.25.6** | Welcome survives the plate guard; "tell me more about…" FAQ routing | §65.10 |
| **1.25.4** | Flow fixes: "sakafleet" FAQ routing + rotating repeat nudges (no more nudge loop) | §65.9 |
| **1.25.3** | Commit ID in deploy alerts, generated CHANGELOG.md + doc-sync guard, fresh clean slate | §67.6 |
| **1.25.2** | Full app audit: exhaustive suite runner, doc-sync guard, package version alignment | §67 |
| **1.25.1** | Stale prompt-refinement gate + slow-ack polish (8s, rotating, 60s floor) | §65.7 |
| **1.25.0** | Conversational-first onboarding: sales welcome, VOICE LAW, warm quiz copy, Product Q&A | §65, §66 |
| **1.24.4** | Status probe aliases (`/api/health`, `/internal/status`) + first-time-user onboarding-loop fix | §64.2, §64.5 |
| **1.24.3** | Operator tooling + chat-log fixes: silent admin sessions, revision probe, first-contact race, phase telemetry | §64 |
| **1.24.2** | Provider-outage hardening: billing breaker, per-leg timeouts, slow-turn ack, admin help | §63 |
| **1.24.1** | Reply-speed telemetry + NATURAL_INTAKE kill switch | §62 |
| **1.24.0** | Conversation-first Saka: natural intake, instant acks, paragraph parsing | §61 |
| **1.23.3** | Incident registry: track, resolve and silence backend issues | §60 |
| **1.23.2** | Plain-English admin alerts and deploy-noise decoder | §59 |
| **1.23.1** | Pricing v2, free-tier vault gating, OCR flow hard-paused | §58 |
| 1.23.0 | Sonnet-first front conversations with GPT-4o fallback | §57 |
| 1.22.0 | Snappy replies: ack-first media, OCR kill switch, AI latency trims | §56 |
| 1.21.3 | Wipe-aware first contact + zero-vehicle routing | §55 |
| 1.21.2 | Countrywise traffic-act deep-links | §54 |
| 1.21.1 | Country KB ingest, drafts & superadmin approval | §54 |
| 1.21.0 | Country buckets, jurisdiction KB & global asset kinds | §53 |
| 1.20.0 | Document Lens: photos + PDFs, confirm-before-save | §52 |
| 1.19.2 | OCR resilience (Vision retry, no-repeat welcome) | §51 |
| 1.19.1 | Intent retry, registration-summary PDF, feature rollout | §50 |
| 1.19.0 | Receipt intelligence (vault, dedupe, low-confidence) | §49 |
| 1.18.1 | Tone compass, greetings & emoji artistry | §48 |

---

## 1. Executive Overview & Tech Stack

Saka Fleet is an intelligent vehicle asset management and conversational fleet operating system designed to run frictionlessly over WhatsApp, backed by an autonomous AI agent, enterprise database, and cloud messaging services.

### Core Technology Stack
- **Runtime & Server:** Node.js (ES Modules), Fastify 5 (`@fastify/formbody`, `@fastify/rate-limit`)
- **AI Engine:** DeepSeek (`deepseek-chat` / DeepSeek-V3) via the `openai` SDK pointed at `https://api.deepseek.com`, with structured JSON intent triage, conversational memory, and Sentinel runtime micro-rules
- **Database & Storage:** Supabase (PostgreSQL 15+ with Row-Level Security, B-Tree Indexes, REST & direct SQL query endpoints)
- **Messaging & Channels:** Meta WhatsApp Cloud API (Graph API v17.0+) with HMAC SHA-256 signature verification
- **OCR:** Google Cloud Vision `DOCUMENT_TEXT_DETECTION` (receipts, logbooks, odometer photos) via `src/services/ocrService.js`; Meta Graph media download with 5 MB / 15 s guards
- **Email Infrastructure:** Resend SDK (`resend`) for transactional MFA codes, OTP verification, PDF audit reports, passbook issuance, support escalation, and admin alerts
- **Payments & Subscriptions:** Paystack API (KES, USD, ZAR, NGN multi-currency checkout & subscriptions)
- **Document Generation:** PDFKit (`pdfkit`) for automated monthly fleet financial audits and compliance reports
- **Worker & Self-Healing:** Saka Sentinel background supervisor with health checks, conversational friction analysis (`evaluateConversationalFriction`), and runtime prompt self-tuning
- **Autonomous Remediation (v1.11.1):** continuous Sentinel scanning over a configurable rolling window (default 60s ticks, 4h window, deterministic + throttled AI synthesis) → threshold-triggered Cline headless plan drafting in GitHub Actions → twice-daily adaptive Superadmin digests (08:00/20:00 EAT) → nonce-gated CI execution with before/after tests and automatic deployment alerts. See §35.
- **Legacy providers removed (v1.7.3):** SendGrid (`@sendgrid/mail`), Twilio (`twilio`) and the unused `supabase` CLI package were fully removed — zero code imports, zero env keys. **Resend** + **Meta WhatsApp Cloud API** are the only outbound channels.

### 1.1 LLM Provider Hub — Purpose Router (DeepSeek default, v1.13.0)

All LLM traffic flows through **`src/services/aiClient.js`**. No service talks to a provider directly. A purpose → tier router sends every tier to DeepSeek until `PREMIUM_MODEL_ENABLED=on`; Phase 2 (v1.13.0) adds telemetry analytics and the Superadmin `admin ai-stats` digest (see §36–§37).

| Setting | Value |
| :--- | :--- |
| Base URL | `https://api.deepseek.com` |
| Primary model | `deepseek-chat` (DeepSeek-V3) |
| Tier-3 opt-in | `deepseek-reasoner` via `AI_MODEL_TIER_3` |
| SDK | `openai` (OpenAI-compatible surface) |
| API key env | `ANTHROPIC_API_KEY` (Tier 1 front + Tier 2) + `DEEPSEEK_API_KEY` (background + terminal fallback) + optional `OPENAI_API_KEY` (GPT fallback leg) |
| Tier-2 provider | Anthropic Messages API via native `fetch` (`anthropic-version: 2023-06-01`, `AI_TIMEOUT_MS_PREMIUM` timeout) |
| Optional model override | `DEEPSEEK_MODEL`, `AI_MODEL_TIER_1/2/3` |
| Purpose registry | `AI_PURPOSES` (tier + default params per purpose) |
| Kill switch | `PREMIUM_MODEL_ENABLED` (off; gates the Tier-2 escalation canary - Tier 1 is Sonnet-first for front conversations, v1.23.0) |
| Telemetry analytics | `getAiUsageSummary()` (1–168 h window) → Superadmin `admin ai-stats` digest (§37) |
| Tier-2 failover chain | `anthropic → openai → deepseek`; per-provider circuit breakers; DeepSeek never skipped (§38) |
| Model Watchdog | `ai_model_registry` + `model_eval_runs`; weekly discovery, deterministic benchmark, canary adoption, auto-rollback (§45) |
| Web search/fetch | capability-probed per model, `AI_WEB_SEARCH_ENABLED=off` by default; research evidence only (§45) |
| Budget guardrail | `AI_DAILY_BUDGET_USD` (unset = off) skips premium legs at 100%; alerts at `AI_BUDGET_ALERT_PCT` + 100% (§38) |

**Exports**
- `getAIClient()` — lazily created, cached `OpenAI` instance bound to the DeepSeek baseURL.
- `getProviderClient(provider)` — lazy, cached per provider + key (`deepseek`, `openai`; Anthropic is invoked through `runAnthropicAttempt`).
- `runAnthropicAttempt({ model, system, messages, jsonMode, maxTokens, temperature, timeoutMs })` — fetch-based Anthropic Messages API call with `AbortSignal` timeout; throws so `chatCompletion()` can fall back to DeepSeek.
- `toAnthropicMessages()` / `normalizeAnthropicResponse()` — pure request/response translation (system hoisting, role merging, text-block + token normalization).
- `resolveTier(purpose, { tier })` / `routeModelForPurpose(purpose, ctx)` — purpose → `{ tier, provider, model, candidates[] }`.
- `chatCompletion({ system, messages, jsonMode, maxTokens, temperature, model, provider, purpose })` → `{ ok, text, model, error }`. **Never throws.**
- `generateText({ system, prompt, jsonMode, maxTokens, temperature, provider, purpose })` → `string | null`.
- `setAiUsageSink(fn)` / `getAiUsageSink()` — fire-and-forget telemetry seam wired by `aiUsageLog.js`.
- `normalizeHistory(history)` — converts Saka's internal `{ role: 'user'|'model', parts: [{ text }] }` shape into OpenAI `{ role, content }` messages (`model` → `assistant`).
- `parseJsonSafely(raw)` — strips ``` fences, parses JSON, and falls back to first-`{`/last-`}` extraction.

**Reliability behaviour**
- `jsonMode: true` sets `response_format: { type: 'json_object' }`, and auto-appends *"Respond with valid JSON only."* when the prompt lacks the word "json" (a DeepSeek requirement).
- On any provider error or empty completion, callers degrade deterministically:
  - `processSakaMessage` → `classifyIntentWithRegex()`
  - Sentinel workers → deterministic fallback patch / diagnosis text
  - Superadmin → static telemetry summary
- Gemini (`@google/genai`, `GEMINI_API_KEY`, `gemini-3.8-flash`, `gemini-flash-latest`) has been **fully removed** from code, dependencies, and environment.
- **Null-safe attribute merge:** DeepSeek always emits every schema key (usually as explicit `null`). `processSakaMessage` therefore only lets **non-empty** AI values override the regex heuristic — otherwise a bare plate like `KBC 456X` would be wiped to `null` and onboarding would never start.
- **Fail-fast AI:** the OpenAI SDK is called with `maxRetries: 0` and `AI_TIMEOUT_MS` (12 s default); slow or empty completions fall through to the deterministic fallbacks above instead of blocking the message queue.
- **Purpose tagging & telemetry (v1.12.0):** every runtime AI call declares a `purpose` from `AI_PURPOSES`; each outcome emits one fire-and-forget record to `ai_usage_logs` (purpose, tier, provider, model, latency, tokens). `AI_USAGE_LOGGING_ENABLED=off` disables writes — see §36. Aggregation lives in `getAiUsageSummary()` and powers the Superadmin `admin ai-stats` digest (§37).
- **Verify connectivity** any time with `node scripts/test_deepseek_connection.js` (plain text + JSON mode + conversation history).

### 1.2 Conversational Engine (v1.7 — pure AI, quiz-first)

- **`src/services/conversationEngine.js`** — every user-facing reply is rendered by Saka AI from a structured FACTS payload (`composeMessage`, `renderQuizQuestion`, `renderConfirmationSummary`, `renderOutcome`, `renderActionDiscovery`). The provider is tier-routed: every front user conversation (intent, extraction, questions, prose, small talk, nudges, admin parse) is Sonnet-first since v1.23.0 on every plan; background/system work stays DeepSeek; the system prompt carries explicit **VOICE & TONE COMPASS** guardrails (including UX & Inclusion) so tone stays consistent across providers and failover legs. Hard-coded conversational prose has been removed from the WhatsApp route; deterministic fallbacks remain only for provider outages. Quiz questions are cached per field/language (`seedQuizQuestions`, `isQuizQuestionCacheWarm`) and prefetched in one batch per flow.
- **`src/services/quizEngine.js`** — one-piece-at-a-time wizard engine: declarative flow definitions, per-field validators/extractors, deterministic multi-field fast-forward (`applyTextExtraction`), two-pass conditional extraction (`applyExtraction`), background question prefetch, Cancel/Restart/Help navigation, and a **mandatory confirmation summary before any database write**. VIN and passbook token are never editable.
- **`src/services/naturalParser.js` (v1.8)** — natural conversational extraction: deterministic field parsing plus a DeepSeek JSON top-up for missing fields, "extra notes" compilation for details that do not map to a database column, missing-field computation for dynamic prompts, and graceful degradation when the provider is unavailable.
- **`src/services/maintenanceReminders.js` (v1.9)** — universal reminder engine: distance (canonical km), operating hours **and date-based expiries** (insurance, inspection/MOT, licensing, permits, driver licences, general deadlines). Explicit `remaining_value` tracking, 75/25/5/due-now/overdue threshold tiers, 30d/14d/7d/24h/overdue expiry tiers, `due_at` timestamps in the user's confirmed timezone, driver-licence promotion, `expiry_notification_log` audit trail, and a single background sweep worker.
- **`src/services/fleetReports.js` (v1.9)** — four core report builders returning structured JSON + localized WhatsApp text: Fleet Status, Compliance & Expiry, Maintenance & Service and Financial & Cost. Every figure is derived from the database; currency/units/dates come from `globalization.js`.
- **`src/services/globalization.js`** — single source of truth for country detection (E.164), metric/imperial conversion, currency + locale formatting, plate examples and unit labels. Every AI prompt and quiz question receives this context.
- **`src/services/ocrService.js`** — Meta media download + Google Cloud Vision `DOCUMENT_TEXT_DETECTION`, with deterministic receipt hints (`extractReceiptHints`). See §24.
- **`src/services/messageQueue.js`** — per-phone serialization + bounded global concurrency + retry/backoff + graceful drain on shutdown.
- **`src/services/sessionStore.js`** — durable `chat_sessions` snapshots (session + onboarding + active quiz + OTP state), hydrated at the start of every message and persisted write-through.
- **`src/services/supabaseClient.js`** — cached Supabase client with a 15-second per-request timeout (`SUPABASE_TIMEOUT_MS`).

---

## 2. Supabase Database Schema

### 2.1 `profiles`
User accounts identified by WhatsApp mobile phone number.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `phone_number`: `varchar` (Unique, E.164 formatted, e.g. `+254712345678`)
- `email`: `varchar`
- `email_verified`: `boolean` (Default `false`)
- `full_name`: `varchar`
- `preferred_language`: `varchar` (Default `English`, supports Swahili, French)
- `subscription_tier`: `varchar` (`free`, `solo_pro`, `growth`, `scale`, `fleet_starter`, `enterprise`, `unlimited`)
- `subscription_status`: `varchar` (`TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELED`, `CANCELLED`, `TRIAL`)
- `unit_system`: `varchar` (`metric` | `imperial`)
- `country`: `varchar` (e.g. `Kenya`, `United States`)
- `country_code`: `varchar` (e.g. `KE`, `US`)
- `is_active`: `boolean` (Default `true`)
- `deleted_at`: `timestamptz` (Soft deletion)
- `created_at` / `updated_at`: `timestamptz`

### 2.2 `vehicles`
Vehicle asset records tied to owners or assigned drivers.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `owner_id`: `uuid` (Foreign Key -> `profiles.id`)
- `assigned_driver_id`: `uuid` (Foreign Key -> `profiles.id`, strictly 1-to-1 active driver constraint)
- `plate_number`: `varchar` (Unique per active fleet, uppercase, e.g. `KDA 123A`)
- `make_model`: `varchar` (e.g. `Toyota Land Cruiser 80 series`)
- `yom` / `year_of_manufacture`: `integer` (e.g. `1991`, `2020`)
- `fuel_type`: `text` (`Petrol`, `Diesel`, `Hybrid`, `Electric`)
- `current_mileage` / `odometer_reading`: `integer`
- `owner_email`: `text` (Verified owner email)
- `owner_phone`: `text`
- `vin`: `text` (**Immutable Core Identifier**, permanently tied to passbook — protected by `trg_prevent_vin_mutation`; see §18.2)
- `qr_passbook_token`: `varchar` (e.g. `SK-PASSBOOK-9B3E2F1A`, tied to VIN)
- `trial_start_at`: `timestamptz` (One-time 30-day trial start)
- `trial_end_at`: `timestamptz` (One-time 30-day trial end, extensible via coupons)
- `trial_status`: `text` (`active`, `extended`, `expired`, `subscribed`)
- `transfer_count_current_year`: `integer` (Default `0`, tracking annual transfer quota)
- `last_transfer_year`: `integer` (Calendar year of most recent transfer)
- `engine_number`, `color`, `transmission`, `tire_size`: `text`
- `insurance_policy`: `text`, `insurance_expiry`: `date`, `inspection_expiry`: `date`
- `purchase_cost`: `numeric`
- `status`: `text` (Default `ACTIVE`)
- `custom_attributes`: `jsonb` (Custom modifications, accessories, equipment)
- `metadata`: `jsonb` (Onboarding metadata, role, audit dates)
- `deleted_at`: `timestamptz` (Soft deletion)
- `created_at` / `updated_at`: `timestamptz`

### 2.3 `vin_registry` (Asset-Bound Trial Ledger)
System-wide ledger ensuring every unique VIN receives exactly one 30-day free trial on initial registration.
- `vin`: `text` (Primary Key, uppercase alphanumeric logbook chassis number)
- `first_registered_at`: `timestamptz` (Default `now()`)
- `first_owner_id`: `uuid` (Foreign Key -> `profiles.id`)
- `trial_granted`: `boolean` (Default `true`)
- `trial_start_at`: `timestamptz`
- `trial_end_at`: `timestamptz` (Default `now() + 30 days`)
- `trial_extended`: `boolean` (Default `false`)
- `trial_extension_coupon_id`: `uuid`
- `trial_status`: `text` (`active`, `extended`, `expired`)
- `current_vehicle_id`: `uuid`
- `updated_at`: `timestamptz`

### 2.4 `coupons`
Trial extensions and promotional discounts.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `code`: `text` (Unique, e.g. `EXT30-XXXXXX` or `WINBACK40-XXXX`)
- `discount_percent`: `numeric` (e.g. 100 for extension, 40 for annual discount)
- `trial_extension_days`: `integer` (Default `30`)
- `max_uses`: `integer` (Default `1`)
- `current_uses`: `integer` (Default `0`)
- `vin`: `text` (Tied vehicle chassis)
- `assigned_to_phone`: `text`
- `applicable_to`: `text` (`trial_extension` | `annual_subscription`)
- `scheduled_dispatch_at`: `timestamptz` (Exactly 3 days before trial ends)
- `dispatched_at`: `timestamptz`
- `email_notified`: `boolean`
- `whatsapp_notified`: `boolean`
- `status`: `text` (`scheduled`, `dispatched`, `applied`, `expired`)
- `expires_at`: `timestamptz`
- `created_at`: `timestamptz`

### 2.5 `passbook_transfers`
Multi-step cryptographic passbook ownership transfer records.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `vehicle_id`: `uuid` (Foreign Key -> `vehicles.id`)
- `vin`: `text` (Vehicle logbook chassis number)
- `from_owner_id`: `uuid` (Foreign Key -> `profiles.id`)
- `to_owner_phone`: `varchar` (Buyer WhatsApp number)
- `to_owner_email`: `text` (Buyer verified email)
- `to_owner_id`: `uuid` (Foreign Key -> `profiles.id`, resolved upon completion)
- `release_otp`: `text` (6-digit PIN emailed to seller)
- `release_otp_expires_at`: `timestamptz` (10-minute TTL)
- `buyer_otp`: `text` (6-digit OTP emailed to buyer)
- `buyer_otp_expires_at`: `timestamptz` (10-minute TTL)
- `is_free_transfer`: `boolean` (True for 1st transfer per calendar year)
- `fee_amount`: `numeric` (USD 3.00 equivalent for subsequent transfers)
- `fee_currency`: `text` (Default `USD`)
- `transfer_fee_paid`: `boolean` (Default `false`)
- `payment_reference`: `varchar`
- `status`: `text` (`PENDING_TARGET_DETAILS`, `PENDING_OWNER_RELEASE_OTP`, `PENDING_BUYER_ACCEPTANCE`, `PENDING_BUYER_OTP`, `COMPLETED`, `CANCELLED`)
- `initiated_at` / `completed_at`: `timestamptz`

### 2.6 `chat_friction_logs`
Sentinel's real-time detection of conversational drop-offs and user friction.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `user_phone`: `text`
- `session_id`: `text`
- `friction_type`: `text` (`LOOPING_PROMPTS`, `USER_FRUSTRATION`, `INTENT_AMBIGUITY`)
- `transcript_snippet`: `text`
- `detected_at`: `timestamptz` (Default `now()`)

### 2.7 `saka_dynamic_rules`
Active runtime micro-rule patches generated by Sentinel and injected into the DeepSeek system prompt.
- `id`: `serial` (Primary Key)
- `rule_key`: `text` (Unique, e.g. `clarify_vin_entry`)
- `rule_description`: `text`
- `patch_instruction`: `text`
- `is_active`: `boolean` (Default `true`)
- `created_at`: `timestamptz` (Default `now()`)
- `updated_at`: `timestamptz` (Default `now()`)

### 2.8 `chat_history` (Conversational Memory)
Stores persistent multi-turn conversational transcripts for contextual memory injection.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `user_phone`: `text` (Indexed on `user_phone`, `created_at DESC`)
- `role`: `text` (`user` | `assistant` | `system`)
- `message`: `text`
- `created_at`: `timestamptz` (Default `now()`)

### 2.9 `processed_webhooks` (Idempotency Cache)
Cluster-wide message deduplication store tracking Meta message IDs (`wamid`) to prevent webhook replay storms.
- `wamid`: `text` (Primary Key, Meta message ID)
- `phone_number`: `text`
- `processed_at`: `timestamptz` (Default `now()`, indexed for time-based cleanup)

### 2.10 `weekly_feature_proposals` (Sentinel Horizon)
Driver-centric feature blueprints synthesized weekly by Sentinel from live conversation logs.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `proposal_code`: `text` (Unique, e.g. `FEAT-2026-W44-01`)
- `title`: `text`
- `target_persona`: `text` (e.g. `Everyday Driver`, `Fleet Owner`)
- `driver_value_proposition`: `text`
- `evidence_quotes`: `text` (Anonymized clusters from real chat logs)
- `technical_spec`: `text`
- `impact_score`: `integer` (1–10)
- `status`: `text` (Default `pending`)
- `created_at`: `timestamptz` (Default `now()`)

### 2.11 `sentinel_audit_runs` (Autonomous Remediation — Continuous Audit Artifact)
One continuously-updated rolling-window scan per Nairobi calendar date; the anchor for plan triggers and digests.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `run_date`: `date` (UNIQUE — Nairobi calendar date)
- `window_start` / `window_end`: `timestamptz` (rolling analysis window, default 4h via `REMEDIATION_AUDIT_WINDOW_HOURS`, upper-bounded by the scan instant)
- `error_count` / `friction_count` / `stall_count`: `integer`
- `clusters`: `jsonb` (deterministic clusters: `signature`, `category`, `count`, `severity`, `evidence_ids`, `sample`)
- `summary`: `jsonb` (AI narrative: `title`, `overview`, `clusters`, `source`)
- `health_score`: `integer` (0–100; `100 − errors*2 − friction*1 − stalls*1.5`, clamped)
- `scan_count`: `integer` (increments every deterministic scan tick)
- `last_scanned_at` / `last_synthesis_at`: `timestamptz`
- `plan_dispatches`: `jsonb` (signature → last CI plan dispatch ISO; cooldown ledger + daily cap)
- `plan_dispatched_at`: `timestamptz` (legacy marker, retained for compatibility)
- `created_at`: `timestamptz`

### 2.12 `remediation_proposals` (Autonomous Remediation — Approval-Gated Work Orders)
Cline-authored, Superadmin-approved fix plans consumed by the CI executor.
- `id`: `uuid` (Primary Key, default `gen_random_uuid()`)
- `proposal_code`: `text` (UNIQUE, e.g. `FIX-2026-10-30-01`)
- `audit_run_id`: `uuid` (Foreign Key -> `sentinel_audit_runs.id`, `ON DELETE SET NULL`)
- `target_signature`: `text` (cluster signature this plan addresses; drives trigger dedupe)
- `title`, `category`, `root_cause`: `text`
- `evidence`: `jsonb` (clusters/ids from the audit)
- `proposed_changes`: `jsonb` (`{ overview, changes: [{ file, function, change, rationale }], tests, rollback, violations }`)
- `risk_level`: `text` (`low` | `medium` | `high`)
- `status`: `text` (`PENDING_APPROVAL` → `APPROVED` → `EXECUTING` → `VALIDATED` → `DEPLOYED`; or `DECLINED` / `NEEDS_MODIFICATION`)
- `feedback`: `text` (Superadmin MODIFY guidance)
- `approval_nonce` / `nonce_expires_at`: single-use execution gate (24h TTL, NULLed after success)
- `attempts`: `integer` (execution dispatch attempts, server-owned, capped by `REMEDIATION_MAX_ATTEMPTS`)
- `dispatched_at`: `timestamptz` (approval request sent)
- `digest_sent_at`: `timestamptz` (included in the latest twice-daily digest)
- `execution_dispatched_at`: `timestamptz` (CI execution dispatched)
- `execution`: `jsonb` (`{ started_at, finished_at, commit_sha, failure }`)
- `created_at` / `reviewed_at` / `executed_at`: `timestamptz`

---

## 3. WhatsApp Webhook, Reliability & Circuit Breaker Architecture

1. **Endpoint Routing:**
   - Handshake: `GET /webhook`, `GET /webhook/whatsapp`, `GET /api/whatsapp/webhook`
   - Messages: `POST /webhook`, `POST /webhook/whatsapp`, `POST /api/whatsapp/webhook`

2. **Cryptographic Validation (v1.15.1 hardening):**
   - Meta Cloud API sends `x-hub-signature-256` (`sha256=<hex>`; prefix matching is case-insensitive).
   - `verifyMetaWebhookSignature()` (`src/routes/whatsapp.js`, exported) verifies HMAC-SHA-256 with `META_APP_SECRET` against the **exact raw bytes** captured by the Fastify `application/json` `parseAs: 'buffer'` parser (`index.js`) and falls back to the re-serialized JSON body only when the raw bytes are unavailable or differ — so unicode-escaping/serialization drift can never cause a false 403. Constant-time compare via `crypto.timingSafeEqual`.
   - Failures emit **masked diagnostics** (`event: meta_webhook_signature_failed`): secret presence/length, `secretIsPlaceholder`, header presence, provided/expected 4-char hash prefixes, raw vs re-serialized body lengths. Secrets are never logged.
   - Boot emits `[ENV] META_APP_SECRET: …` (masked) and warns loudly when the value is the test placeholder (`meta_app_secret_sakafleet_2026`) or missing (missing ⇒ verification disabled, fail-open). A placeholder in Cloud Run means every real webhook 403s — align the Cloud Run env with the Meta App Secret.
   - Suite: `test_meta_signature.js` — 16 stateless assertions (raw/fallback verification, tampering, secret drift, missing inputs, non-hex, masked diagnostics).

3. **Message ID Deduplication (cross-instance idempotency):**
   - Extracts Meta Message ID (`wamid`) from `entry[0].changes[0].value.messages[0].id`.
   - The in-memory `processedWebhooksCache` (10-minute TTL, <0.1ms) is backed by a **synchronous** `public.processed_webhooks` upsert check performed **before** any processing begins, closing the multi-instance race that previously allowed duplicate replies.
   - Duplicate `wamid` → immediate `HTTP 200 OK` (`{ status: 'success', deduplicated: true }`) and no execution.

4. **Immediate 200 + Per-Phone Message Queue:**
   - Fastify immediately sends `HTTP 200 OK` to Meta after signature and deduplication checks.
   - Background work is dispatched through `src/services/messageQueue.js`: **strict per-phone serialization** (no interleaved session writes), a bounded global semaphore (`MESSAGE_MAX_CONCURRENCY`, default 8), retry with exponential backoff for transient failures (`MESSAGE_MAX_ATTEMPTS`, default 3), and `drainQueue()` on SIGTERM/SIGINT.
   - Durable `chat_sessions` snapshots are hydrated at message start and persisted write-through, so any Cloud Run instance can continue an onboarding/quiz/OTP flow.

5. **Two-Stage Self-Healing Circuit Breaker (Strike-Based):**
   - Sessions track `loopSignature`, `consecutivePromptCount`, `circuitBreakerStage`, `lastAssistantPrompt`.
   - The `loopSignature` is the actual generated reply text; breaker messages never overwrite it, so strikes accumulate correctly across grace retries.
   - **Strike 3 → `SOFT_TRIP`:** logs `LOOPING_PROMPTS` friction and sends a short AI-rendered retry invitation (one clean retry while Sentinel synthesizes a micro-rule).
   - **Strike 4 → `HARD_TRIP`:** logs `SYSTEM_ERROR` friction, emails `support@sakafleet.com` via Resend with the profile, repeated prompt and last user input, then sends an AI-rendered escalation message (deterministic fallback if the provider is down).
   - **Navigation Freedom (no permanent lockout):** `cancel|exit|stop|reset|restart|start over|start again|1..5` or `log|update|set|request|help` clears the breaker stage, strike count and loop signature instantly. The `restart` variant is explicitly covered (Oct-2026 onboarding incident).

6. **Unregistered / Idle User Conversational Model (AI-rendered):**
   - First-time introductions, Swahili greetings, pause acknowledgements, friction apologies and default prompts are all rendered by Saka AI from structured facts; only one next step is requested at a time.

7. **Superadmin Intercept (multi-role coexistence):**
   - Only explicit admin directives (`admin*`, `adminrules*`, `check health`, `system status`, `sentinel …`, `profiles report`, `coupon …`, `horizon`, `proposals`, `admin ai-stats` / `admin usage [Nh]`) are claimed by `handleSuperadminFlow`.
   - All other messages from the superadmin phone fall through to the normal Saka AI conversation so the admin can also operate as Owner/Driver.
   - `admin sentinel diagnose` (also `sentinel diagnose`, `superadmin to sentinel …`) runs live health + friction analysis and returns an AI diagnostic report in chat.

---

## 4. Conversational Memory & DeepSeek Agent-in-the-Middle Architecture

1. **Agent-in-the-Middle Architecture:**
   - Saka (powered by DeepSeek `deepseek-chat`) sits directly between the WhatsApp user and the Supabase database.
   - Saka parses user requests, writes data (expenses, fuel, mileage, earnings, reminders) with explicit vehicle attribution, and queries analytics (e.g. km/L fuel consumption, fleet summaries) on demand.
   - When required data points are missing (e.g., need second fill-up with odometer reading to compute exact km/L), Saka conversational prompts the user to supply them.

2. **Active Vehicle Context & Vehicle Switching:**
   - Multi-vehicle sessions maintain `active_vehicle_id` in `chatSessions`.
   - Dynamic prompt injection feeds the user's entire fleet roster (`allVehicles`) and currently selected vehicle (`activeVehicle`) into DeepSeek runtime context.
   - Users can seamlessly switch vehicles using natural commands: `"switch to Demio"`, `"manage KBC 456X"`, or `"switch to 2"`.
   - **Explicit Attribution Safeguard:** Every data submission confirmation explicitly states the vehicle plate and make/model under which data was recorded, preventing cross-vehicle misattribution.

3. **Persistent History Logging & Context Window:**
   - All incoming user WhatsApp messages are stored to `chat_history` (`role: 'user'`) and `chat_transcripts`; both writes run in parallel and overlap AI processing.
   - Outgoing assistant responses are stored to both tables after the WhatsApp send completes, in the same `Promise.all` as the durable session snapshot.
   - The last ~10 turns are injected as `{ role: 'user' | 'model', parts: [{ text }] }`. Warm sessions use the in-memory `session.history` directly; the `chat_history` fetch happens only when the session is cold or empty.
   - **Quiz fast path:** while a quiz is active (except PIN/OTP phases), the DeepSeek intent call is skipped entirely — the instant regex classifier plus deterministic field parsing drive the turn (see §25).

4. **Intent Classification & Autonomous Actions:**
   - Supported intents (single source of truth: `sakaAi.js` `DEFAULT_SAKA_CORE_PROMPT`): `GREETING`, `ACTION_DISCOVERY`, `TRANSFER_PASSBOOK`, `APPLY_COUPON`, `REGISTER_VEHICLE`, `ONBOARDING_INPUT`, `ONBOARDING_SKIP`, `VERIFY_OTP`, `RESEND_OTP`, `UPDATE_EMAIL`, `APP_HELP`, `MANAGE_VEHICLE`, `VIEW_PROFILE`, `LIST_VEHICLES`, `SWITCH_VEHICLE`, `QUERY_FUEL_EFFICIENCY`, `QUERY_FLEET_SUMMARY`, `LOG_EXPENSE`, `UPDATE_MILEAGE`, `LOG_EARNINGS`, `SET_REMINDER`, `COMPLETE_REMINDER`, `REQUEST_REPORT`, `CONTACT_SUPPORT`, `REACTIVATE_ACCOUNT`, `EDIT_VEHICLE`, `DELETE_VEHICLE`, `EDIT_PROFILE`, `DELETE_ACCOUNT`, `GENERAL_CHAT`, `ASSIGN_DRIVER`, `UNASSIGN_DRIVER`.
   - Hybrid extraction merges DeepSeek structured JSON with smart regex heuristics (including currency exclusion to prevent false plate matches, phone-vs-VIN disambiguation, and odometer-safe OTP parsing).
   - **Active-quiz extraction is deterministic and AI-free:** `applyTextExtraction` captures safe volunteered fields from the same message (year, odometer only with a km/mi marker, fuel type, volume only with a litre/gallon marker), and `applyExtraction` runs two passes so conditional fields (e.g. fuel volume once `expense_type = Fuel`) fill from one payload.
   - **Expense-vs-Odometer disambiguation:** messages containing fuel/expense wording (`fuel`, `liters`, `refuel`, `paid`, `cost`, `receipt`, `maintenance`) are classified as `LOG_EXPENSE` even when an odometer value is also present (e.g. *"Logged 30L fuel at 50350 km for KES 5500"*).

5. **Fleet Analytics & Reporting Engine (`src/services/analytics.js`, `src/services/fleetReports.js`):**
   - `calculateFuelConsumption`: v1.17.1 DB wrapper over the pure `src/services/fuelEconomy.js` engine. Fuel economy is measured **only between full-tank fills** (brim-to-brim); top-ups and unlabelled fills between them are counted in the fuel used automatically. Returns exact segments, a labelled span estimate when no full pair exists, current-tank progress, cost/km, skipped-segment warnings and a deterministic localized reply (no hard-coded currency).
   - `getVehicleSummaryReport`: per-vehicle financial breakdown (fuel, maintenance, net profit) used by legacy branches.
   - `fleetReports.buildFleetReport`: the four core reports (fleet status, compliance & expiry, maintenance & service, financial & cost) — see §32. `REQUEST_REPORT.report_type` selects the report; `QUERY_FLEET_SUMMARY` always renders the Fleet Status report.

---

## 5. Sentinel Real-Time Conversational Optimization Loop

Sentinel executes an autonomous 4-stage optimization loop to detect conversational friction and dynamically patch system prompts:

1. **Capture & Detect:**
   - Background worker routine `evaluateConversationalFriction` continuously analyzes conversational exchanges in `chat_history`.
   - Detects friction signatures:
     - *Looping Prompts:* Bot or user repeating same question/answer 3+ times.
     - *User Frustration Keywords:* "stuck", "confused", "looping", "loop", "broken", "bug", "repeating", "already told", "help me", "stupid", "not working".
     - *Intent Ambiguity:* Repeated fallbacks or unresolvable natural language input.
   - Saves detected events into `chat_friction_logs` (`user_phone`, `session_id`, `friction_type`, `transcript_snippet`, `detected_at`).

2. **Analyze & Mutate:**
   - Evaluates failing transcripts using `deepseek-chat`.
   - Synthesizes micro-rule behavioral patches formulated to remove ambiguity or tone friction.

3. **Store & Version:**
   - Upserts micro-rule patches into `saka_dynamic_rules` (`rule_key`, `rule_description`, `patch_instruction`, `is_active: true`).

4. **Runtime Injection:**
   - In `sakaAi.js`, `getSakaCorePrompt()` retrieves active rules (`is_active = TRUE`) and appends them as real-time behavioral guidance. The assembled prompt is cached for 60 s (`SAKA_PROMPT_CACHE_MS`) and the two reads run in parallel; call `clearSakaPromptCache()` after changing prompt config or rules (e.g. after `adminrules reset`).
   - **Stored refinement guard (v1.9.3):** a `system_config.saka_core_prompt` refinement is only appended when it is ≤ `SAKA_MAX_PROMPT_REFINEMENT_CHARS` (2000) **and** carries the current `SAKA-PROMPT-SCHEMA:<version>` marker. Legacy pre-v1.7 mega-prompts are ignored (and logged) so they can never contradict the trained core prompt.

### Function Boundary Lock & Admin Kill Switch
- **Function Boundary Lock:** Sentinel is strictly restricted to tone, phrasing, clarification flows, and entity hints. It cannot alter core hardcoded logic, database schemas, VIN locks, OTP verification, or security rules.
- **Admin Kill Switch:** Superadmin can instantly override Sentinel rules via WhatsApp:
  - `adminrules reset`: Deactivates all dynamic micro-rules (`is_active = FALSE`).
  - `adminrules toggle [key]`: Toggles activation status for a specific rule key.

### 5.1 Onboarding Friction Audit (28 Oct 2026)

**Evidence reviewed:** 24 `chat_friction_logs` rows, 66 `chat_history` messages, 2 `error_logs` rows.

| Finding | Root cause | Resolution (v1.7) |
| :--- | :--- | :--- |
| User **KAS 628T** answered Step-2 fields one at a time; the bot re-sent the identical 7-field mega-prompt, then "I already indicated above" → SOFT_TRIP → HARD_TRIP; "Restart" kept returning the snag message | All-or-nothing Step-2 capture + breaker reset regex did not match `restart` | Quiz engine asks ONE field per turn; breaker reset covers `restart|start over|start again` |
| Superadmin asked a general product question and received the admin hub; "Superadmin to sentinel … diagnose" received support boilerplate | AI intent parser claimed any superadmin message; no Sentinel chat command | Explicit admin-directive gate + `admin sentinel diagnose` |
| Two identical "message overload" apologies 40s apart; a legitimate question got the canned apology | In-memory-only dedupe raced across instances; loose friction keywords | Synchronous `processed_webhooks` check before processing + tightened friction branch |
| 2 INFO/200 webhook logs stored as "AI-diagnosed errors" | Empty `{}` errors serialized into `error_logs` | `logSystemError` skips empty/benign errors; Cloud Run poller ignores INFO/2xx |

**Sentinel response:** friction was captured (LOOPING_PROMPTS / USER_FRUSTRATION / SYSTEM_ERROR) and a micro-rule was synthesized, but the Function Boundary Lock prevented it from repairing state-machine logic — hence the structural fixes above. Sentinel now also logs `MULTI_QUESTION_PROMPT` whenever any assistant turn asks 3+ questions.

### 5.2 Real-Time Conversation Recovery (v1.7.7)

`monitorActiveConversations(supabase)` runs every 5 minutes (`SENTINEL_STALL_INTERVAL_MS`) and is also exposed via `POST /api/sentinel/run`:

1. Scans durable `chat_sessions` rows whose `updated_at` is older than `SENTINEL_STALL_MINUTES` (default 15) and whose snapshot contains an active `session.quiz`.
2. Resolves the pending question with `getCurrentQuizField()` and composes an AI-rendered recovery nudge (fallback text if the provider is down).
3. Sends ONE proactive WhatsApp message via the Meta Graph API, records it in `chat_transcripts`, logs `CONVERSATION_STALL` in `chat_friction_logs`, and increments `state.recovery.nudges` (max `SENTINEL_MAX_NUDGES`, default 2; rate-limited to one per stall window).
4. Never claims data was saved; offers `Restart` / `Cancel`.

This is the live counterpart to the post-hoc friction evaluator — it rescues users trapped mid-quiz (the Oct-2026 "Set reminder → expense trap" class of bug) instead of waiting for ten minutes of looped prompts.

---

## 6. Superadmin Command Center & System Boundaries

### 6.1 WhatsApp Superadmin Hub Commands
Requires active session (`adminstart`, 30-min inactivity TTL) from verified `SUPERADMIN_PHONE`:
- `admin report`: Executive fleet digest (total vehicles, owners, drivers, error counts, active dynamic rules).
- `admin audit [Plate or VIN]`: Detailed audit of a vehicle (passbook history, owner contact, driver, mileage, compliance dates, custom attributes).
- `admin alerts`: Current system warnings, unresolved errors, and detected friction logs.
- `adminrules reset` / `adminrules toggle [key]` / `adminrules list`: Dynamic rule management.
- `admin horizon`: Manually triggers Sentinel Horizon weekly feature synthesis on demand.
- `admin backlog`: Lists fixes + feature proposals together (pending/deployed filters; feature blueprints are review-only).
- `admin proposals`: Lists the latest pending Sentinel Horizon feature blueprints.
- `admin remediations`: Lists the latest autonomous remediation proposals (`FIX-*`) with status and risk.
- `admin accept fix [CODE]`: Approves a proposal, mints the single-use execution nonce and dispatches the CI execution workflow.
- `admin decline fix [CODE]`: Declines a proposal (no code change).
- `admin modify fix [CODE] [guidance]`: Stores guidance and asks Cline to re-draft the plan.
- `adminstop`: Terminates the admin session immediately.

### 6.2 Automated 8:00 AM Morning Executive Briefing
- Daily at 8:00 AM, Sentinel automatically synthesizes a fleet-wide status digest and pushes it directly to `SUPERADMIN_PHONE` via WhatsApp.

### 6.3 Strict Scope Bounds & System Protection
- Sentinel is strictly a superadmin and system-level supervisor.
- Sentinel **must not** receive general vehicle reminders, compliance alerts, or delayed owner notifications unless the superadmin is actively operating in Owner or Driver mode for a vehicle they personally own or is assigned to.

### 6.4 Sentinel Full-Authority Self-Healing & Evolution Framework

Sentinel operates under a **"fix first, escalate last"** doctrine: it autonomously repairs every issue it is capable of fixing, and only pages human support when a boundary is hit.

**A. Guaranteed Deployment Notifications (WhatsApp-only, v1.14.1)**
- `scripts/notify_git_push.js` dispatches **WhatsApp-only** deployment alerts. Deployment **emails are muted by policy (v1.14.1)** to protect the daily Resend quota for customer-critical mail (auth OTPs, passbooks, remediation digests). The function still returns `emailSuccess: false` so callers keep a stable contract.
- `.github/workflows/deploy_notify.yml` installs dependencies before invoking `node scripts/notify_git_push.js`; it no longer passes `SUPERADMIN_EMAIL`/`RESEND_API_KEY`, and `notify_git_push.js` loads `dotenv` lazily so the primary WhatsApp channel can never be blocked by a missing optional SDK.
- `package.json` runs `notify:deploy` on `postinstall`, so every container build on Cloud Build / GitHub Actions fires the alert.
- `index.js` boot hook detects the revision from `K_REVISION` || `COMMIT_SHA` || `RENDER_GIT_COMMIT`, compares it to `system_config.last_deployed_revision`, and only announces genuinely new revisions (idempotent, no duplicates).

**B. Autonomous Repair Loop (`evaluateConversationalFriction` + `scanCloudRunAnomalies`)**
- Sentinel runs every 10 minutes over `chat_history` / `chat_transcripts`, and every 2 minutes over Google Cloud Run logs.
- Detected friction is auto-patched into `saka_dynamic_rules` and hot-injected into the live DeepSeek prompt by `getSakaCorePrompt()` — no deploy required.
- Systemic errors (`ERROR`/`CRITICAL`, HTTP ≥ 500, latency ≥ 5s) are logged as `SYSTEM_ERROR` in `chat_friction_logs` and `error_logs`, deduplicated for 15 minutes, and pushed to `SUPERADMIN_PHONE`.

**C. Guardrails (Immutable Boundaries)**
Sentinel may never instruct or perform any of the following; `processFrictionPatches` blocks patches matching `/\b(bypass vin|ignore vin|skip otp|disable auth|drop table|modify schema)\b/i`:
1. VIN immutability or passbook re-anchoring outside the approved transfer flow.
2. Weakening the strict 1-to-1 driver/vehicle mapping.
3. Bypassing email OTP verification.
4. Altering subscription-tier limits or Paystack payment math.
5. Any destructive schema or data operation.
- **Admin Kill Switch:** `adminrules reset` instantly deactivates every Sentinel-generated rule.
- **Anti-flood:** `recentlyAlertedLogHashes` (15-min TTL) and per-session strike counters prevent alert storms.

**D. Sentinel Horizon — Autonomous Weekly Feature Evolution**
- Worker: `generateWeeklyFeaturePlan(supabase)` in `src/workers/sentinel.js`.
- Ingests the last 7 days of `chat_transcripts` (user messages) and `chat_friction_logs`, then asks DeepSeek to synthesize the single highest-value feature that would make Saka Fleet the #1 vehicle manager for everyday drivers.
- Persists to `public.weekly_feature_proposals` (`proposal_code`, `title`, `target_persona`, `driver_value_proposition`, `evidence_quotes`, `technical_spec`, `impact_score`, `status`).
- Schedule: every Sunday 20:00 EAT (`checkHorizonSchedule`) plus a manual `POST /api/cron/sentinel-horizon` endpoint.
- Delivery: WhatsApp blueprint summary to `SUPERADMIN_PHONE`; Superadmin can then run `admin proposals` to list pending blueprints.

### 6.5 Google Cloud Logging Integration & Telemetry Polling
- **Log Ingestion:** `saka-fleet` on Google Cloud Run auto-ingests access logs, stdout/stderr, and HTTP status codes (500, 504) to Google Cloud Logging.
- **Sentinel Background Worker (`scanCloudRunAnomalies`):**
  - Uses `@google-cloud/logging` to poll recent logs for `resource.type="cloud_run_revision"` every 2 minutes.
  - Filters for `severity >= ERROR` or high latency (`latency >= "5.000s"`).
  - Deduplicates events using a strict 15-minute sliding window cache (`recentlyAlertedLogHashes`) to prevent alert flooding.
  - Logs critical anomalies into `public.chat_friction_logs` (with `friction_type: 'SYSTEM_ERROR'`) and `public.error_logs`.
  - Immediately pushes real-time diagnostic alerts to `SUPERADMIN_PHONE` via WhatsApp with timestamp, severity, HTTP status, and log snippet.
  - Service: `src/services/sentinelCloudLogs.js` (`fetchCloudRunLogs(minutesAgo)`), which degrades gracefully to `[]` outside GCP.

---

## 7. Subscription-Tier Ownership & Strict 1-to-1 Assignments

### 7.1 Subscription-Tier Ownership Limits (v1.15.0)
Vehicle ownership capacity is bound to the active subscription tier and is
resolved **only** through `src/services/subscriptionTiers.js` (no local copies):
- `free`: 1 vehicle — basic passbook, essential expense logs, 1 report/month, Tier-1 AI
- `solo_pro`: 1 vehicle — 100% features, full Tiers 0–3 AI, unlimited reports
- `team_fleet`: 3 vehicles — 100% features
- `growth`: 5 vehicles — 100% features (anchor plan)
- `fleet_command`: 5 vehicles + per-vehicle add-on quantity (`fleet_command.addon_quantity`)
Legacy tiers resolve through aliases (`solo`/`pro` → solo_pro; `scale`, `fleet_starter`, `enterprise`, `unlimited` → fleet_command) and are remapped once by `npm run migrate:subscriptions`.
Owners exceeding capacity are prompted with the next-tier upgrade checkout (or the add-on checkout on Fleet Command). See §39.

### 7.2 Strict 1-to-1 Driver Assignments
- A driver can only be assigned to **one vehicle at any given time** across the platform.
- A vehicle can only have **one active driver**.
- Enforced at database level:
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_unique_active_driver ON public.vehicles(assigned_driver_id) WHERE assigned_driver_id IS NOT NULL AND deleted_at IS NULL;`
- Validated via webhook checks before assigning any driver.

---

## 8. Support Escalation Flow (`support@sakafleet.com`)

1. **Trigger Condition:** User asks for admin intervention, human help, agent assistance, or reaches an unresolvable issue.
2. **Escalation Prompt:** User is prompted to write out their issue as a single paragraph description.
3. **Automated Dispatch:** Format an email containing the paragraph, user phone number, email, and account details and send directly to **`support@sakafleet.com`** via Resend.
4. **WhatsApp Confirmation:** Reply to user:
   *"I've forwarded your message to our support team at support@sakafleet.com. They will reach out to you shortly!"*
5. Return conversation state to normal active mode.

---

## 9. Mandatory Core Onboarding, Email OTP & VIN-Locked Passbook

1. **Mandatory Core Data:** Plate Number, Make & Model, YOM, Fuel Type, Mileage, VIN (immutable logbook chassis number), and Verified Email.
2. **Email OTP Verification:** 6-digit OTP sent via Resend email.
3. **Passbook Issuance:** Digital QR passbook token (`SK-PASSBOOK-XXXXXX`) permanently locked to VIN and emailed to verified address.
4. **Stage 2 Optional Specs:** Insurance expiry, inspection expiry, engine number, color, transmission, tire size, purchase cost, and custom attributes.

---

## 10. Token Efficiency Directive

- **Token Efficiency:** Consult `SAKA_FLEET_ARCHITECTURE.md` and `.clinerules` first on every prompt. Target reads/writes and batch all independent operations.
- The database slate reset utility is documented once in **§15** (`npm run reset:db` / `reset:slate` → `scripts/reset-db.js`).

---

## 11. VIN-Tied Trials & Subscription Tier Limits

### 11.1 Asset-Bound 30-Day Free Trial — **RETIRED (v1.16.0)**
- The asset-bound (VIN/passbook) trial is **retired**. Commercial state — trial, tier, billing, coupons, quotas — binds to the **OWNER ACCOUNT** (`profiles.id`) only; see §39.4.
- `vin_registry` is now a **provenance ledger**: `first_registered_at`, `first_owner_id`, `current_vehicle_id`. New rows are written with `trial_granted = false` and `trial_status = 'account_bound'`.
- Legacy `trial_*` columns on `vehicles` and `vin_registry` are **frozen history** — never written again, never deleted (VIN immutability). `getOrCreateVinTrial()` is a deprecated shim that returns `trialStatus: 'account_bound'` with no trial clock (`LEGACY_VIN_TRIALS=on` only for historical replays).
- No VIN-bound extension coupon is scheduled at registration. `EXT30-*` `trial_extension` rows are superseded by `npm run migrate:trial-unbind`; live offers are `ACCT30-*` `account_trial_extension` coupons scheduled by `trialEngine` at account-trial start (T-3).
- Capacity always comes from the account tier + `addon_quantity` (§39), never from a vehicle trial clock.

### 11.2 Slot-Based Capacity & Upgrade Prompt (v1.15.0)
- Capacity comes from `subscriptionTiers.js` + the owner's Fleet Command add-on quantity:
  - `free`: 1 active vehicle slot
  - `solo_pro`: 1 active vehicle slot (all features)
  - `team_fleet`: 3 active vehicle slots
  - `growth`: 5 active vehicle slots
  - `fleet_command`: 5 active vehicle slots + `profiles.addon_quantity`
- When an owner reaches capacity and attempts to add another vehicle:
  - Registration is halted before database insertion.
  - Non-add-on tiers: Saka returns the next-tier Paystack checkout link.
  - Fleet Command: Saka returns the per-vehicle add-on checkout (`$4.99/mo` unit) and the slot activates on `charge.success` (`type: fleet_addon`).
  - Account upgrading expands available slots without altering any vehicle's VIN trial countdown.
- The same capacity gate protects passbook transfers: an over-capacity buyer is paused at `PENDING_BUYER_UPGRADE` (see §39.6).

---

## 12. Email Confirmation & Trial Extension Coupon Flow

### 12.1 Pre-Expiry Coupon Generation
- When a user confirms their email via OTP during onboarding (or account update), Saka schedules an auto-generated extension coupon:
  - Format: `EXT30-XXXXXX` (stored in `coupons`).
  - Scheduled dispatch time: Exactly 3 days before the vehicle's 1-month trial ends (`scheduled_dispatch_at = trial_end_at - 3 days`).

### 12.2 Dual-Channel Pre-Expiry Notification (3 Days Out)
- Background worker `processImpendingTrialReminders` runs periodically:
  1. **Transactional Email:** Dispatches reminder via Resend (`sendTrialExtensionReminderEmail`) with coupon code and vehicle details.
  2. **Proactive WhatsApp Message:** *"Hi [Name]! 👋 Your trial for VIN [X] ends in 3 days! Would you like me to apply your extension coupon to add 30 free days? Reply 'Yes' to activate!"*
- If the user replies `"Yes"`, Saka automatically applies the coupon, extends `trial_end_at` by 30 days on both `vehicles` and `vin_registry`, and sends a WhatsApp confirmation.

### 12.3 Lapse Reminders & 15-Day Overdue Win-Back Offer
- **7 Days & 1 Day Reminders:** Proactive WhatsApp alerts regarding impending trial expiration.
- **15-Day Overdue Win-Back Offer:**
  - If an account/vehicle has been overdue for 15 days, Sentinel generates a 40% OFF annual subscription coupon (`WINBACK40-XXXX`, 15-day TTL).
  - Pushes a WhatsApp win-back message with a Paystack annual subscription link.


---

## 13. Conversational Action Discovery (`Driver`, `Owner`, `Superadmin`)

### 13.1 Dynamic Role & Context Indexing
- Users can ask Saka at any time: *"What can I do?"*, *"Show my actions"*, *"Show my actions as an owner"*, or *"Show my actions as a driver"*.
- Saka dynamically detects user permissions:
  - **Superadmin:** Displays executive fleet commands (`admin report`, `admin audit [Plate or VIN]`, `admin alerts`, `adminrules`, `admin ai-stats`).
  - **Superadmin Multi-Role Coexistence:** `handleSuperadminFlow` intercepts only explicit admin directives; all other messages fall through so the superadmin phone can simultaneously register vehicles as an **Owner** and be assigned as a **Driver** without losing admin access.
  - **Owner:** Displays Owner Command Center (`my vehicles`, `switch to [plate]`, `register`, `transfer passbook [plate]`, `assign driver [phone] to [plate]`, fuel/odometer logging, revenue tracking, monthly PDF reports).
  - **Driver:** Displays Driver Hub (`Odometer [km]`, `Logged [L] fuel`, `Earned [amount]`, `Oil change needed`, `passbook details`). Strictly prevents driver from transferring passbooks or deleting vehicles.
  - **Dual Role (Owner + Driver):** Combines both sections with clear visual segregation.
  - **Unregistered:** Provides a quick-start guide to register a vehicle or accept a transferred passbook.
- **Shared first-time guide:** `buildFirstTimeWelcome({ swahili, senderPhone })` in `src/routes/whatsapp.js` is the single source of truth for brand-new users; it renders region-specific plate/unit/currency data via `detectCountryFromPhone` and is reused by `generateRoleBasedActionDiscovery` and the idle/greeting branches.
- **Help routing:** `Help` (`APP_HELP`) and `What can I do?` (`ACTION_DISCOVERY`) both route through `generateRoleBasedActionDiscovery`, so every user receives a role-aware command center (or the first-time guide when unregistered).

---

## 14. Secure Passbook Transfer Flow & Fee Structure

### 14.1 5-Step WhatsApp Transfer State Machine
1. **Step 1 (Initiation):** Current owner texts `transfer passbook [VIN or Plate]`. Saka checks ownership, active status, and annual transfer quota.
2. **Step 2 (Target Capture):** Saka prompts owner for buyer's WhatsApp number (E.164) and email. Generates 6-digit release PIN with 10-minute TTL.
3. **Step 3 (Security Check):** Saka emails the release PIN to the current owner via Resend (`sendTransferReleasePinEmail`). Owner replies with the PIN to authorize releasing the asset.
4. **Step 4 (Buyer Handshake):** Saka messages buyer on WhatsApp: *"🚗 [Owner Name] initiated a passbook transfer for [Vehicle/VIN]. Reply 'ACCEPT' to claim ownership."*
   - Buyer replies `'ACCEPT'`.
   - Fee Check: If 1st transfer in calendar year -> FREE ($0). If subsequent transfer -> prompts flat USD 3.00 equivalent fee via Paystack checkout before continuing.
5. **Step 5 (Execution & Re-Anchoring):** Saka sends a 6-digit OTP to buyer's verified email.
   - Buyer replies with OTP.
   - System re-anchors passbook:
     - Unlinks VIN from old owner; assigns to buyer profile.
     - Unassigns any previous assigned driver (preserving strict 1-to-1 security).
     - Generates a new cryptographic QR passbook token: `SK-PASSBOOK-[NEW-HEX]`.
     - Dispatches new passbook welcome email to buyer.
     - WhatsApp confirmation sent to both buyer and seller.

### 14.2 Transfer Fee & Annual Quota Rule
- **1 Free Transfer per Calendar Year:** Each vehicle passbook receives 1 free transfer between Jan 1 and Dec 31.
- **USD 3.00 Equivalent Fee for Subsequent Transfers:** Flat USD 3.00 equivalent in local currency (e.g. ~KES 390, ~NGN 4,500, ~ZAR 55) computed via `getEffectiveExchangeRate(supabase, currency)`.
- Paystack checkout link generated with metadata `{ type: 'passbook_transfer_fee', transfer_id: '...' }`, automatically verified via webhook.


---

## 15. Database Slate Reset Utility & Operational Safeguards

### 15.1 Reset Script (`scripts/reset-db.js`)
- Standardized command aliases: `npm run reset:db` and `npm run reset:slate`.
- Clears test and operational data to establish a pristine slate for onboarding audits.
- **v1.15.0 scope:** 30 operational tables, codified in the exported `RESET_TABLES` registry:
  - Onboarding & assets: `vehicles`, `vin_registry`, `profiles`, `coupons`, `driver_assignments`, `driver_compliances`
  - Subscriptions & trials: `subscriptions`, `trial_sessions`, `usage_counters`, `paystack_webhook_events`
  - Sessions: `chat_sessions`, `superadmin_sessions`
  - Conversation & telemetry: `chat_history`, `chat_transcripts`, `chat_friction_logs`, `processed_webhooks`, `conversation_analytics`, `error_logs`, `ai_usage_logs`
  - Dynamic rules: `saka_dynamic_rules` (Sentinel re-patches on its next scan)
  - Fleet ops: `pending_owner_notifications`, `passbook_transfers`, `private_earnings`, `expenses`, `expense_logs`, `expiry_notification_log`, `reminders`, `admin_audit_logs`
  - Support/cache: `support_tickets`, `exchange_rates_cache` (self-repopulates on demand via `paystack.js`)
- **Preserved (`PRESERVED_TABLES`):** `system_config` (boot-critical `saka_core_prompt`, `last_deployed_revision`, remediation scheduling markers), `compliance_catalog` (bundled + superadmin legal overrides), **`country_kb` (v1.21.0 jurisdiction knowledgebase overrides)**, `weekly_feature_proposals`, `sentinel_audit_runs` and `remediation_proposals` (governance ledger for autonomous changes), plus `ai_model_registry` and `model_eval_runs` (runtime model governance — a slate wipe must never silently downgrade the serving model).
- **Scope regression test:** `test_db_reset_scope.js` (stateless) asserts the wipe/preserve registries are disjoint and that the global `TRUNCATE` block matches `RESET_TABLES` exactly.

### 15.2 Production & Execution Safeguards
- **Production Block:** If `NODE_ENV === 'production'` or `APP_ENV === 'production'`, the script aborts immediately unless `--force-production-wipe` is explicitly supplied.
- **Confirmation Flag:** Requires `--confirm` (e.g. `node scripts/reset-db.js --all --confirm`). Without `--confirm`, execution is safely aborted with an informational warning.
- **Explicit Scope Required:** The script now also requires either `--all` (global slate wipe) or `--phone <number>` (targeted). A bare `--confirm` can no longer wipe the database.
- **Targeted Reset:** Supports phone-specific clearing: `node scripts/reset-db.js --phone +254712345678 --confirm`. It resolves vehicles by `owner_phone` **and** `owner_id`, releases any driver assignment held by the phone, and clears dependent logs/transfers/notifications.
- **Fallback Safety:** The Supabase-JS fallback uses per-table primary keys (`processed_webhooks.wamid`, `vin_registry.vin`, `chat_sessions.phone_number`, `superadmin_sessions.phone_number`, `saka_dynamic_rules.rule_key`, otherwise `id`). **v1.20.0:** an invalid/expired Management API token no longer aborts the wipe — it logs a warning and falls back to the Supabase JS client automatically.
- **Sentinel repopulation:** the background Sentinel scan can write a fresh `admin_audit_logs` governance row within a minute of a wipe; that is expected telemetry, not residual user data.
- **Backup Flag (`--backup`):** writes a git-ignored `reset-backup-<ISO>.json` containing pre-wipe row counts plus full `system_config` + `compliance_catalog` rows; aborts before any truncation if the export fails.
- **Post-Reset Verification (v1.14.2):** asserts every `RESET_TABLES` entry is at zero rows and every `PRESERVED_TABLES` count is unchanged from the pre-wipe baseline, printing clean/intact tables.
- **Import-safe module:** the production/confirmation guards run only on direct CLI invocation, so `RESET_TABLES` / `PRESERVED_TABLES` are importable by tests without side effects.

---

## 16. First-Time User Conversational Flow (Quiz-Based Onboarding)

### 16.1 AI-Rendered First-Time Introduction
- `src/routes/whatsapp.js` still exports `buildFirstTimeWelcome(...)` and `generateRoleBasedActionDiscovery(...)` as offline/legacy helpers (covered by `test_first_time_flow.js`), but the live greeting / idle / help branches now call Saka AI via `composeMessage(..., purpose: 'first_time_welcome')` and `renderRoleActions(...)`.
- The first-time introduction is one short paragraph followed by **exactly ONE question** (the plate number); it renders the user's plate example, units and currency from `globalization.js`.
- Recovery affordances remain available at every turn: **Help**, **What can I do?**, **Restart**, **Cancel**, buyer **ACCEPT**.

### 16.2 One-Piece-at-a-Time Registration (quiz engine)
- Registration is a `vehicle_registration` quiz (§20): plate → make/model → YOM → fuel → odometer → VIN → email → OTP → optional specs → **confirmation summary** → save.
- No mega-prompt and no fixed "Step X of 4" labels; progress is conversational and each turn asks exactly one question.
- Email OTP is generated/verified inside the quiz (10-minute TTL, `resend` supported); VIN remains permanently locked to the passbook.
- Optional specs (insurance, inspection, colour, transmission, engine, tires, purchase cost, custom mods) are asked one at a time and can be skipped as a group with `Skip`/`Done`.

### 16.3 Help & Action Discovery Routing
- `Help` / `What can I do?` → role-aware command overview rendered by Saka AI from `buildRoleContext()` (permissions) via `renderRoleActions`.
- Mid-quiz help pauses the quiz, answers helpfully, then returns to the pending question (§20.1).
- `Restart` / `Reset` / `Start over` restarts the quiz; `Cancel` / `Exit` / `Stop` aborts cleanly.

---

## 17. Known Operational Observations (Operational Review 2026-10-28)

1. **Tier-limit source drift (RESOLVED in v1.15.0):**
   - The v1.14.x drift (`SUBSCRIPTION_TIERS.solo_pro = 2` vs `vehicles.js TIER_LIMITS.solo_pro = 3`) is gone: `src/services/subscriptionTiers.js` is the single frozen matrix consumed by paystack, vehicles, subscriptions, trialEngine, whatsapp and the AI clamp. `checkOwnerVehicleTierLimit` now reads the registry + `profiles.addon_quantity`.
2. **Intermittent DeepSeek empty completions:** Under high-frequency test runs, `deepseek-chat` occasionally returns an empty completion. `aiClient.chatCompletion` now calls the SDK with `maxRetries: 0` and a 12 s timeout, so callers deterministically fall back to `classifyIntentWithRegex` / template-free fallback text instead of retrying and stalling the queue.
3. **Test isolation:** Root-level `test_*.js` suites depend on live Supabase + Resend + DeepSeek. Per the permanent rule (§19), every run must clear its own data via `runWithCleanup` / `npm test`. A transient Supabase `fetch failed` can still leave stale rows; run `node scripts/reset-db.js --phone <number> --confirm` for an ad-hoc targeted reset.
4. **Test runner & cleanup:** All suites are standalone `node test_*.js` scripts (no Jest/Mocha/Vitest). Use `npm test` (`scripts/run_tests.js`) for targeted runs — it always performs a final auto-cleanup sweep. `npm run test:cleanup` clears test data without running tests. `test_first_time_flow.js` is the offline first-time-flow suite; `test_edit_delete.js` covers edit/delete handlers, VIN immutability, vehicle-deletion cascade, and cleanup.

5. **Cloud Run alert false positives (fixed v1.8):** INFO/200 log entries with 5s+ latency were being classified as `SYSTEM_ERROR`, polluting `chat_friction_logs` and writing empty `"{}"` rows into `error_logs`. `scanCloudRunAnomalies` now ignores INFO/NOTICE/DEBUG + <400 status rows regardless of latency and skips empty payloads. `scripts/audit_logs.js` is the permanent read-only triage tool that cross-references errors, friction, chat records, reminders and vehicle units.
6. **Dead reminder evaluator (fixed v1.8):** the orphaned `evaluateServiceThresholds()` helper in `index.js` was never invoked and referenced a non-existent `notified_overdue` column. It has been removed and replaced by `maintenanceReminders.evaluateVehicleReminders()` plus a 30-minute sweep worker (initial pass 90s after boot).
7. **Confirm-phase stall copy (fixed v1.8):** stall nudges now say "Reply YES to confirm / Cancel to discard" instead of "Pending: n/a". Sessions with repeated extraction failures are logged as `EXTRACTION_ERROR` friction so parsing regressions surface immediately.
8. **Legacy live suite `test_agent_flow.js` (stale since v1.7):** it asserts pre-quiz static strings ("Switched Active Vehicle", "Expense Logged Successfully") that no longer exist because outcomes are AI-rendered and every write is confirmation-gated. It fails at HEAD when run standalone — do not treat that as a regression without checking prompt/flow changes. Maintained coverage lives in `test_quiz_flow.js`, `test_natural_parser.js`, `test_maintenance_reminders.js` and the offline `test_agent_training.js`.
9. **Active-vehicle quiz prefill (fixed v1.8.1):** multi-vehicle fleets now pre-fill `vehicle_id` from the session's active vehicle (honouring the switch promise "subsequent logs apply to this vehicle"). Only genuinely ambiguous turns (no active vehicle, or an out-of-fleet id) re-ask.

---

## 18. Edit, Delete & VIN Immutability

### 18.1 Supported Edits
- **Vehicle edits (`EDIT_VEHICLE`)** — owners only. `src/services/vehicles.js` → `updateVehicleDetails()` whitelists: `plate_number`, `make_model`, `yom`/`year_of_manufacture`, `fuel_type`, `current_mileage`/`odometer_reading`, `color`, `transmission`, `engine_number`, `tire_size`, `insurance_policy`, `insurance_expiry`, `inspection_expiry`, `purchase_cost`, `custom_attributes`, `owner_email`, `owner_phone`, `status`, `metadata`, `other_details`, `is_business`, `opt_in_earnings`, `audit_report_frequency`.
- **Profile / contact / settings edits (`EDIT_PROFILE`)** — `full_name`, `preferred_language`, `unit_system`; email changes continue through the OTP-gated `UPDATE_EMAIL` flow.
- **Drivers** may edit their own profile/settings; vehicle-level edits and deletions are owner-only.

### 18.2 VIN Immutability (three-layer defence)
1. `sanitizeVehicleUpdates()` rejects `vin` and `qr_passbook_token`, returning them in `rejected[]`.
2. `updateVehicleDetails()` refuses to apply a VIN change and surfaces the locked-field message.
3. PostgreSQL `BEFORE UPDATE` trigger `trg_prevent_vin_mutation` (`WHEN OLD.vin IS NOT NULL`) raises `VIN is immutable and cannot be changed once registered` for any VIN mutation — even via direct SQL.
- Apply/refresh the trigger with `npm run migrate:vin` (`scripts/run_vin_immutability_migration.js`).

### 18.3 Owner Vehicle Deletion (`DELETE_VEHICLE`)
- **Confirmation gate:** `session.pendingDeleteVehicle` requires a `YES` reply; `Cancel` aborts.
- **Authorization:** `vehicles.owner_id === requesterProfile.id`; drivers receive an explicit "Owner Authorization Required" reply.
- **Cascading cleanup** (`deleteVehicle()`):
  - Soft-deletes the row (`deleted_at = now()`, `status = 'DELETED'`).
  - Unassigns `assigned_driver_id` (preserves the strict 1-to-1 driver invariant).
  - Cancels in-flight `passbook_transfers` (`status = 'CANCELLED'`).
  - Retires active `reminders` (`status = 'cancelled'`).
  - **Preserves** historical `expense_logs`, `expenses`, `private_earnings`, and `chat_history` for audit.
  - **Preserves** the `vin_registry` ledger entry (one 30-day trial per VIN forever).
- **Account deletion (`DELETE_ACCOUNT`)**: OTP via `sendMfaEmail`, then soft-deletes all owned vehicles + the profile and clears `chat_history` / `chat_transcripts` / `processed_webhooks`.

### 18.4 WhatsApp Command Examples
- `edit vehicle KDA 123A color to White`
- `change mileage for KDA 123A to 52000`
- `delete vehicle KDA 123A` → reply `YES` to confirm
- `edit profile` / `update my name to Jane Doe` / `change my language to Swahili`
- `delete my account`

---

## 19. Automatic Test Data Cleanup (Permanent Rule)

### 19.1 Rule
Every stateful test or check MUST clear the data it created from the database after it runs — pass or fail. No exceptions.

### 19.2 Implementation
- `scripts/testCleanup.js`
  - `cleanupTestData({ phones, vins, vehicleIds })` deletes dependent rows first (`expenses`, `expense_logs`, `private_earnings`, `expiry_notification_log`, `reminders`, `passbook_transfers`, `pending_owner_notifications`, `coupons`), releases driver assignments, then removes `vehicles`, `vin_registry`, chat tables, `superadmin_sessions`, and `profiles`.
  - `runWithCleanup({ testFn, phones, vins })` wraps a suite in `try/finally` so cleanup always runs.
  - `KNOWN_TEST_PHONES` / `KNOWN_TEST_VINS` cover the identifiers used by the repository's suites.
- `scripts/run_tests.js` (exposed as `npm test`) runs the targeted suite(s) and always performs a final cleanup sweep. `npm run test:cleanup` clears test data without running tests.
- `test_quiz_flow.js` — stateless suite for the one-piece-at-a-time quiz engine, multi-field fast-forward, confirmation gate, corrections, Cancel/Restart, quiz↔conversation arbitration, and audit regressions (reminder-vs-intent priority, mid-quiz flow switching, bare "No") — 41 assertions.
- `test_concurrency.js` — stateless suite for per-phone serialization, global concurrency cap, retry/backoff, dead-letter rejection and graceful drain (8 assertions).
- `test_ocr_flow.js` — stateless OCR suite: Meta media download, Vision parsing, size/type guards, document classification, rich hints (receipt/logbook/insurance/licence), receipt-vault replies and quiz prefill (38 assertions).
- `test_date_parser.js` — stateless global date suite: ISO, country-resolved DD/MM vs MM/DD, ordinals, natural language, Nairobi normalization and quiz-field integration (24 assertions).
- `test_sentinel_recovery.js` — stateless Sentinel stall suite with mocked Supabase + Graph API: nudge dispatch, recovery counter, rate limit, nudge cap and idle-session exclusion (15 assertions).
- `test_maintenance_reminders.js` — stateless maintenance reminder suite with an in-memory Supabase mock: metric/imperial/operating-hours parsing, canonical conversion, explicit remaining tracking, exactly-once tier dispatch (75/25/5/due/overdue), odometer + hours monitoring, sweep aggregation and delivery guards (44 assertions).
- `test_natural_parser.js` — stateless natural-parsing suite: deterministic multi-field extraction, extra-notes compilation/dedupe/cap, dynamic missing-field computation and graceful AI degradation (24 assertions).
- `scripts/audit_logs.js` — read-only log/chat/schema audit used for Cloud Run alert triage (SELECT-only; creates no data).

### 19.3 Conventions
- New tests must import `runWithCleanup` and declare every phone/VIN/vehicle they create.
- Never rely on "clean at start" only; cleanup must also run at the end.
- Use `node scripts/reset-db.js --phone <number> --confirm` for ad-hoc targeted resets.

---

## 20. Quiz Flows & Confirmation Gates (v1.7)

All multi-field flows run through `src/services/quizEngine.js`. Each asks exactly one question per turn, accepts multi-field answers, and displays a summary that the user must confirm before any write.

| Flow | Questions (in order) | Odometer capture | Executor |
| :--- | :--- | :--- | :--- |
| `vehicle_registration` | plate → make/model → YOM → fuel → odometer → VIN → optional specs (insurance/inspection/colour/transmission/engine/tires/cost/mods) → confirm | `current_mileage` (canonical km) | inserts `vehicles`, `vin_registry` trial, profile email (website-verified), coupon, passbook email, reminders |
| `email_update` | new email → OTP → confirm | — | `profiles.email`, `vehicles.owner_email` |
| `assign_driver` | vehicle → driver phone → **handover odometer** → confirm | `metadata.odometer_at_assignment` + vehicle odometer | `assignDriverToVehicle` |
| `unassign_driver` | vehicle → **handback odometer** → confirm | `metadata.odometer_at_release` + distance driven | `unassignDriverFromVehicle` |
| `transfer_seller` | vehicle → buyer phone → buyer email → **odometer at sale** → confirm → release PIN | `metadata.odometer_at_transfer` | `initiatePassbookTransfer` → `setBuyerDetailsAndSendReleaseOtp` → `verifyOwnerReleaseOtpAndNotifyBuyer` |
| `log_expense` | vehicle → type → amount → fuel volume → **fill type (full tank/top-up)** → odometer at fill-up → notes → confirm | `expense_logs.odometer_reading` + `expense_logs.fill_type` + vehicle odometer | `expense_logs` + `expenses` |
| `log_earnings` | vehicle → amount → **odometer at trip end** → period → confirm | vehicle odometer + `private_earnings.notes` | `private_earnings` |
| `log_mileage` | vehicle → new odometer → confirm | vehicle odometer + reminder evaluation | `vehicles` + active distance reminders |
| `log_operating_hours` | vehicle → hour-meter reading → confirm | vehicle operating hours + hours reminder evaluation | `vehicles.operating_hours`, `vehicles.hours_updated_at` |
| `edit_vehicle` | vehicle → field → new value → confirm | field-dependent | `updateVehicleDetails` (VIN/token rejected) |
| `edit_profile` | field (name/language/units) → new value → confirm | — | `profiles` |
| `delete_vehicle` | vehicle → confirm (cascade notes) | — | `deleteVehicle` (soft delete + cleanup) |
| `delete_account` | confirm → MFA OTP | — | soft-delete profile/vehicles + clear chat tables |
| `apply_coupon` | code → confirm | — | `applyTrialExtensionCoupon` |
| `set_reminder` | vehicle → type → due date (global parser, Nairobi-normalized), distance (km/miles) or operating-hours threshold → confirm | structured threshold (`threshold_unit`, `target_value`, `last_service_value`, `remaining_value`) + extra notes | `createThresholdReminder` / `reminders` |
| `contact_support` | description → confirm | — | Resend escalation |
| `reactivate_account` | confirm | — | `profiles.is_active = true` |

Navigation: `Cancel` aborts, `Restart` resets the flow, `Skip` is accepted only on optional fields (skips the whole optional group).
Vehicle resolution: quiz flows pre-fill `vehicle_id` from the session's active vehicle when it belongs to the fleet (v1.8.1), so multi-vehicle fleets are not re-asked after a switch; a single-vehicle fleet auto-selects, and genuinely ambiguous turns still prompt with the plate list.

### 20.1 Quiz ↔ Conversation Arbitration (v1.7.1)

While a quiz is active, Saka must still hold a normal conversation. `shouldPauseQuizForChat()` in `quizEngine.js` decides every turn:

- **Engine-owned (never paused):** `Cancel`, `Restart`, `Skip`, `CONFIRM/YES/NO`, 6-digit OTP / release-PIN entry, `resend`.
- **No AI intent call during a quiz:** the route classifies with the instant regex classifier and the quiz owns extraction, so an active quiz turn never pays a second model call for classification.
- **Paused for conversation:** greetings, questions (`?` or openers like "what/how/tell me/brief me/I want to know"), `Help`, and clearly non-quiz intents (action discovery, support, analytics queries).
- On a paused turn the quiz state is **untouched**; the route answers via Saka AI (or role-aware action discovery) and appends ONE AI-rendered resume nudge pointing at the pending question (`getCurrentQuizField`).
- If a field fails validation but the text reads like conversation, the engine returns `pausedForChat: true` instead of nagging.
- `Restart` never re-ingests the control word as data, and question rendering is data-free and cached — previously collected values are never echoed back as stale acknowledgments.

---

## 21. High-Concurrency & Durable Session Architecture

- **Per-phone FIFO queue** (`messageQueue.js`) — same-user messages never interleave; global semaphore caps parallel AI/DB work (`MESSAGE_MAX_CONCURRENCY`, default 8).
- **Retry/backoff** — transient `fetch failed`/timeout/429/5xx retried up to `MESSAGE_MAX_ATTEMPTS` (default 3); exhausted tasks reject to the webhook catcher, which writes to `error_logs`.
- **Durable `chat_sessions`** — `phone_number` PK, `state jsonb` containing `{ session, onboarding }`; hydrated per message, persisted after every turn and on failure. TTL prune: `pruneSessionSnapshots()` (7 days). Migration: `npm run migrate:sessions`.
- **Synchronous cross-instance dedupe** — `processed_webhooks` is checked/upserted before processing, so Meta retries cannot double-send.
- **Supabase timeouts** — `supabaseClient.js` wraps fetch with `AbortSignal` (15s default) and reuses one cached client.
- **Graceful shutdown** — SIGTERM/SIGINT drains the queue before exit.
- **Parallel reads** remain safe; session writes are serialized per phone.

---

## 22. Global Audience (Permanent Rule)

Saka Fleet serves a **global audience**. Every feature, quiz flow and AI prompt must honor:

1. Country detection from the WhatsApp number (`globalization.js`, E.164 longest-prefix).
2. Metric/imperial units for distance and volume (canonical storage: km + litres).
3. Local currency, number and date formatting (`Intl`, per-country locale).
4. Regional plate examples and date formats in prompts and summaries.
5. The AI auto-translator — Saka replies in the user's language, even when no preference is stored.

`buildGlobalContext()` / `describeGlobalContext()` feed this into `sakaAi.js`, `conversationEngine.js` and every quiz question/summary.

---

## 23. Known Gaps (next iteration)

- `complete_reminder` still uses the legacy handler (not yet quiz-based); `request_report` now routes to the four core report builders in `fleetReports.js`. PM completions populate `reminders.completed_at` / `completed_on_time` when a reminder is completed.
- `test_reliability.js` is a legacy suite outside the targeted runner; its breaker assertions were loosened for AI-rendered copy.
- `chat_sessions` pruning is manual (`pruneSessionSnapshots`) until scheduled in the Sentinel worker.
- Free-form chat replies still require one DeepSeek call (~2–4 s); quiz question turns are served from the question cache. PDF OCR is not supported in v1 (images only).


---

## 24. OCR Flow (v1.7.4 — extended by §49 Receipt Intelligence in v1.19.0)

### 24.1 Pipeline
1. The webhook detects `messageObj.image` or `messageObj.document`, capturing `id`, `caption` and `mime_type` (previously image messages were silently ignored).
2. `downloadWhatsAppMedia()` calls `GET graph.facebook.com/{version}/{media-id}` → receives `{ url, mime_type, file_size }`, then downloads the binary from `url` with the same bearer token (`User-Agent: curl/8.0.0`). Direct-binary responses are also supported.
3. `extractTextFromImage()` posts the bytes to Google Cloud Vision `images:annotate` with `DOCUMENT_TEXT_DETECTION` → `{ text, confidence }`. **PDFs (v1.20.0)** skip Vision: `pdfTextExtractor.js` inflates FlateDecode streams with Node `zlib` and decodes `Tj`/`TJ` strings locally; scanned PDFs return a "send the pages as photos" reason.
4. OCR text + caption become the conversation turn:
   - **Active quiz** → the OCR text can answer the pending field (e.g. VIN/plate from a logbook photo).
   - **No quiz** → DeepSeek classifies the OCR text (a receipt naturally becomes `LOG_EXPENSE`).
5. `extractReceiptHints()` deterministically extracts `amount` (prefers a TOTAL line), `fuel_liters`, `odometer` and `notes` (vendor + date). Hints merge into `mergedExt` only when AI/regex did not capture the value.
6. The expense quiz prefills from those hints and still presents the **CONFIRM summary before any database write**.

### 24.2 Configuration
| Env var | Purpose | Default |
| :--- | :--- | :--- |
| `GCP_VISION_API_KEY` | Google Cloud Vision API key (required for OCR) | — |
| `GCP_VISION_ENDPOINT` | Override the Vision endpoint | `https://vision.googleapis.com/v1/images:annotate` |
| `OCR_MAX_MEDIA_BYTES` | Maximum media download size | `5242880` (5 MB) |
| `OCR_TIMEOUT_MS` | Meta lookup/download request timeout | `15000` |
| `OCR_VISION_TIMEOUT_MS` | Vision annotate budget for dense document scans (v1.19.2) | `25000` |
| `OCR_VISION_MAX_ATTEMPTS` | Vision attempts; abort/timeout is retried once (v1.19.2) | `2` (clamped 1–3) |
| `OCR_PDF_MAX_PAGES` | PDF page cap before asking for photos (v1.20.0) | `20` (max 80) |
| `META_GRAPH_VERSION` | Graph API version | `v17.0` |

### 24.3 Failure behaviour & limits
- Missing key, quota errors, unsupported types (PDF in v1) or oversized media never break the turn: Saka AI apologises and asks for a clearer photo or typed details.
- Vision timeouts are retried once (idempotent annotate); HTTP/credential errors are never retried. A blank 200 response returns the explicit reason `No text detected in the document`, so `receipts.error` is never empty.
- After two unreadable photos on the same quiz step, the route appends the deterministic `OCR_UNREADABLE_NOTE` typed-or-skip escape (v1.19.2) — the identical question is never repeated a third time.
- OCR failures are warnings only; no database write occurs.
- Media messages flow through the same per-phone queue, dedupe and durable session store as text.
- Test coverage: `test_ocr_flow.js` (45 stateless assertions — Meta download, Vision parsing + timeout retry, blank-read reason, size/type guards, document classification, rich hints, receipt vault, quiz prefill).


---

## 25. Response Speed Optimizations (v1.7.5)

| Optimization | Effect |
| :--- | :--- |
| **Quiz fast path** | When a quiz is active (except PIN/OTP phases), the DeepSeek intent call is skipped; regex classification is instant and the quiz's deterministic parsers handle the answer. Removes the duplicate AI call per quiz turn. |
| **Batched question prefetch** | On quiz start, one background AI call renders all remaining questions and seeds the per-field cache (`seedQuizQuestions`). Subsequent turns reuse the cached AI-authored question — no per-turn model call. |
| **Core prompt cache** | `getSakaCorePrompt()` caches `system_config` + `saka_dynamic_rules` for 60s, removing 2 DB reads per message. Invalidate with `clearSakaPromptCache()`. |
| **Output cap** | Intent call `maxTokens` 2048 → 800; shorter generations finish faster. |
| **Fail-fast AI** | SDK `maxRetries: 0` plus `AI_TIMEOUT_MS` (12s default) — slow requests fall back deterministically instead of stalling the queue. |
| **Parallel DB I/O** | Vehicles + history fetched with `Promise.all`; user log writes overlap AI processing; assistant logs + session snapshot persisted in one `Promise.all`. History query skipped entirely on warm sessions. |
| **Cache-safe questions** | Cached question text is deliberately data-free (no collected values), preventing stale acknowledgments (e.g. an old plate) from leaking across sessions. |
| **Deterministic fast-forward** | `applyTextExtraction` captures safe volunteered values (year, odometer with a km/mi marker, fuel type, volume with a litre/gallon marker) from the same message without an AI call; `applyExtraction` runs two passes so conditional fields fill from one payload. |
| **Null-reply guard** | Fast-path turns that produce no flow reply fall back to a minimal AI-rendered response, preventing empty sends. |

**Measured live (real DeepSeek):** quiz answer turns dropped from ~3.3–3.7 s to **~2.0–2.4 s** (~40% faster). Remaining time is DB round trips + the Meta send; the first turn of a flow also pays the one-time question render + prefetch.

Tuning env: `AI_TIMEOUT_MS`, `SAKA_PROMPT_CACHE_MS` (60 s), `QUIZ_QUESTION_CACHE_MS` (15 min), `QUIZ_QUESTION_CACHE_MAX` (300).


---

## 26. Rules of Engagement (Codified, v1.8.0)

These rules are permanent and mirrored in `.clinerules`:

1. **Mandatory pre-execution consultation:** before inspecting code, running commands or editing files, read `.clinerules` + `SAKA_FLEET_ARCHITECTURE.md` (and any other relevant project `.md`).
2. **Self-updating documentation:** every code/schema/workflow/config change updates this document immediately.
3. **Global audience:** country detection, mixed date conventions, metric/imperial units, currency/locale formatting and AI auto-translation on every feature, prompt and test.
4. **Date & timezone canonicalization:** all dates are parsed by `src/services/dateParser.js` and normalized to **Africa/Nairobi (UTC+3, `TZ=Africa/Nairobi`)** before any database write.
5. **Automatic test-data cleanup:** every stateful test/check clears what it created (pass or fail) via `runWithCleanup` / `npm test`; `npm run test:cleanup` for ad-hoc sweeps.
6. **Targeted testing only:** run only the suites directly related to the change; no redundant full-suite runs.
7. **Git commit & publish:** once verified, automatically stage, commit and push to `origin/main`; the commit hook dispatches deployment alerts.
8. **App changes & skill synchronization:** every application change simultaneously updates `src/services/flowKnowledge.js`, Saka's prompt definitions (`sakaAi.js`, `conversationEngine.js`) and all project `.md` files — see §31.

---

## 27. Global Date Parsing (v1.7.7)

`src/services/dateParser.js` is the single source of truth for date deciphering:

| Input style | Example | Behaviour |
| :--- | :--- | :--- |
| ISO | `2027-05-15`, `2027-05-15T10:30:00Z` | High confidence |
| Numeric day/month | `15/10/2027`, `15-10-27` | Unambiguous values resolved directly |
| Ambiguous numeric | `05/06/2026` | Country convention: `US/PH` → MM/DD, otherwise DD/MM (medium confidence) |
| Named / ordinal | `15th October 2026`, `Oct 15`, `October 15, 2026` | High confidence |
| Relative | `today`, `tomorrow`, `yesterday`, `in 2 weeks`, `10 days from now`, `next week`, `next month` | Computed from the Nairobi calendar day |
| Weekday | `next Monday`, `this Friday`, `coming Sunday` | Next occurrence in Nairobi time |

Normalization: every result returns `{ ok, localDate (YYYY-MM-DD), iso, timeZone: 'Africa/Nairobi', confidence, source }`. Date-only quiz values are stored as `YYYY-MM-DD`; reminder `due_date` stores the same calendar day. The AI prompt mirrors these rules (ISO/DD-MM/MM-DD, ordinals, relative phrases, Nairobi timezone).

Integration points: `vehicle_registration` insurance/inspection expiry, `edit_vehicle` date fields, `set_reminder` due dates (via `extractDatePhrase()` + `parseExpirySpec()`), and `globalization.formatDate()` (renders in the user's confirmed timezone, Africa/Nairobi by default). `globalization.resolveUserTimezone()` resolves the IANA zone from the WhatsApp number and the user confirms it in the flow summary before any write.



---

## 28. Universal Reminder Engine: Thresholds & Date Expiries (v1.9)

### 28.1 Purpose
Any time-bound or threshold-bound item is a first-class reminder: **insurance, inspection/MOT, licensing, permits, driver licences and general deadlines** alongside distance (km/mi) and operating hours. The engine explicitly tracks the remaining distance, operating hours or days until each item triggers, dispatches proactive WhatsApp alerts exactly once per tier, and writes an audit trail for every expiry dispatch.

### 28.2 Unit & date model (global rule)
- Canonical storage: distance in **kilometres**, time in **decimal operating hours**, dates as ISO `YYYY-MM-DD` plus a `due_at` UTC instant.
- Unit-aware input: "in 5000 km", "3000 miles", "at 45000 km", bare numbers (vehicle unit system), "36 operating hours", "in 36 engine hours", "1250 hrs".
- Miles convert with `userDistanceToKm()` (1 mi = 1.609344 km). Display adapts per vehicle: metric → km, imperial → mi; time always renders as "operating hours".
- Date input: "Insurance expires on 15th Dec 2026", "Inspection due next month", "License renewal in 14 days", "Permit expires 2027-03-31". `dateParser.extractDatePhrase()` finds the date inside a full sentence and `parseExpirySpec()` classifies the item.
- Timezone: `globalization.resolveUserTimezone()` prefers the confirmed `profiles.timezone`, otherwise the country default from `COUNTRY_TIMEZONES` (detected from the E.164 WhatsApp number). The confirmation summary displays the timezone before any write; `due_at` is computed in that zone while canonical storage stays ISO / Africa/Nairobi-normalized.
- Category detection: `detectExpiryCategory()` → `insurance` | `inspection` | `licensing` | `permit` | `driver_license` | `maintenance` | `deadline` | `other`.
- `parseThresholdSpec()`, `parseOperatingHours()`, `parseExpirySpec()` and `buildExpirySpecFromDate()` in `src/services/maintenanceReminders.js` are the single source of truth.

### 28.3 Schema (`reminders` + `vehicles` + `profiles` + `expiry_notification_log`)
| Column | Purpose |
| :--- | :--- |
| `reminders.threshold_unit` | `distance` \| `hours` \| `date` |
| `reminders.kind` | `threshold` \| `expiry` |
| `reminders.category` | `insurance` \| `inspection` \| `licensing` \| `permit` \| `driver_license` \| `maintenance` \| `deadline` \| `other` |
| `reminders.due_date` + `due_at` | Canonical calendar day and UTC expiry instant |
| `reminders.timezone` | User-confirmed IANA timezone used to resolve `due_at` |
| `reminders.linked_column` | Canonical column kept in sync (`vehicles.insurance_expiry`, `vehicles.inspection_expiry`, `vehicles.road_license_expiry`, `vehicles.permit_expiry`, `profiles.driver_license_expiry`) |
| `reminders.subject_type` / `subject_id` | `vehicle` or `driver` subject for owner + driver notifications |
| `reminders.threshold_input_unit` | `km` \| `mi` \| `hours` as entered |
| `reminders.target_value` | Absolute target in canonical km / hours |
| `reminders.last_service_value` | Baseline reading at creation (remaining is computed from here) |
| `reminders.remaining_value` + `remaining_updated_at` | **Explicit remaining distance/time/days tracking**, refreshed on every evaluation |
| `reminders.display_unit` | `km` \| `mi` \| `hours` for rendering |
| `reminders.notes` | Compiled extra notes from the conversation |
| `reminders.notified_75p/25p/5p/0p/overdue` | Exactly-once threshold tier flags |
| `reminders.notified_30d/14d/7d/24h/overdue` + `expiry_tier_at` | Exactly-once expiry ladder flags and last evaluation |
| `reminders.completed_at` / `completed_on_time` | PM completion history used by the Maintenance report |
| `vehicles.operating_hours` + `hours_updated_at` | Canonical hour-meter reading and update time |
| `vehicles.insurance_expiry`, `inspection_expiry`, `road_license_expiry`, `permit_expiry` | Canonical compliance dates (upserted through `linked_column`) |
| `profiles.timezone` + `timezone_confirmed_at` | User-confirmed IANA timezone |
| `expiry_notification_log` | `reminder_id`, `vehicle_id`, `category`, `tier`, `phone`, `channel`, `message`, `sent_at` — feeds the Compliance report |

DDL is applied idempotently by `ensureVehicleTableColumns()` (`src/services/vehicles.js`) at startup (the reminders block is guarded by `to_regclass`). The legacy `notified_30d/7d/48h/1d` reminder cron and the driver-licence cron were retired in v1.9; their tiers are superseded by the 30d/14d/7d/24h/overdue ladder.

### 28.4 Monitoring & dispatch
- `applyOdometerReading()` canonicalizes input, updates the vehicle, then evaluates active distance reminders immediately.
- `applyOperatingHours()` records hour-meter submissions and evaluates hours reminders immediately.
- `evaluateVehicleReminders()` recomputes remaining, persists `remaining_value`, and dispatches once per tier: 75% (approaching), 25% (warning), 5% (urgent), 0% (due now), overdue. Owner + assigned driver are notified (deduped phones; `canDeliver` preserves Sentinel/superadmin boundaries).
- `createExpiryReminder()` upserts linked compliance items by `vehicle_id`/`subject_id` + `linked_column`, keeps the canonical vehicle date column in sync, and resets the full notification ladder whenever a date changes.
- `evaluateExpiryReminders()` computes calendar days remaining (Africa/Nairobi), selects the most urgent un-notified ladder tier, dispatches to owner + assigned driver (driver-linked items notify the driver and every owner of their assigned vehicles), writes `expiry_notification_log`, and persists `remaining_value` (days) + tier flags.
- `syncDriverLicenseReminders()` promotes `profiles.driver_license_expiry` into driver-linked reminders before each sweep.
- `runReminderSweep()` runs every 30 minutes (first pass 90s after boot) from `index.js` and performs all three passes (threshold → driver-licence promotion → expiry ladder), returning `{ threshold, expiry, driverRemindersSynced }`.
- Wiring: `UPDATE_MILEAGE` and `LOG_OPERATING_HOURS` route handlers, `log_mileage` / `log_operating_hours` quiz completions, `set_reminder` quiz creation (date + threshold), vehicle registration insurance/inspection dates, and `edit_vehicle` compliance-date edits.

### 28.5 Expiry tier ladder
| Tier | Window (days remaining) | Flag |
| :--- | :--- | :--- |
| 30 days | 15–30 | `notified_30d` |
| 14 days | 8–14 | `notified_14d` |
| 7 days | 2–7 | `notified_7d` |
| 24 hours | 0–1 | `notified_24h` |
| Overdue | < 0 | `notified_overdue` |

A sweep that missed a window still sends the single most urgent applicable alert, marks all coarser tiers as consumed, and never repeats a tier.

### 28.6 Alert copy
Alerts are WhatsApp-ready and unit-aware, e.g. "Service Warning (KDA 123A): Oil change due soon! Remaining: 850 km. Target: 105,000 km." Imperial vehicles see miles; hour-based reminders see "operating hours". Expiry alerts name the item and countdown, e.g. "Expiry Reminder (KDA 123A): Insurance Renewal expires in 14 days (2026-11-12)." Alerts include remaining value, target/due date and current reading so no follow-up question is needed.


---

## 29. Natural Conversational Parsing & Summary Confirmation (v1.8)

### 29.1 Natural extraction
- `src/services/naturalParser.js` provides:
  - `extractDeterministicFields()` — runs every flow field's parser/validator (instant, AI-free).
  - `extractWithAI()` — DeepSeek JSON extraction over the same sentence, flow-aware (field labels/hints), returning `{ fields, extraNotes, confidence }`; never throws and times out at 8s.
  - `extractEntitiesFromText()` — combined pipeline with missing-field computation.
- The quiz engine remains the state machine: when the strict parser cannot read a message, it calls `extractWithAI()` for ALL remaining fields before re-asking. Multi-detail sentences ("Toyota Hilux 2018 diesel, 88,000 km, serviced at Shell") fill several fields at once and only genuinely missing required fields are prompted.
- Prompts stay one question per turn and data-free (no stale acknowledgments); the AI renders them from facts.

### 29.2 Extra notes catch-all
- Any relevant detail that does not map to a database column is compiled into the quiz draft's `extraNotes` (deduped, capped at 6, ≤280 chars each).
- Sources: AI `extra_notes`, explicit user notes ("Note: always serviced at Shell"), and substantive replies during confirmation.
- On save: registration → `vehicles.other_details` + `metadata.extra_notes`; `log_expense` → `expense_logs.notes`; `log_earnings` → `private_earnings.notes`; `set_reminder` → `reminders.notes`.
- The confirmation summary renders an "Extra notes" section alongside the collected fields.

### 29.3 Summary & confirmation (unchanged invariant)
- No database write happens until the user explicitly confirms (`YES`/`CONFIRM`).
- Corrections re-render the summary; `Cancel` aborts; the draft survives conversational interruptions.
- Confirmation fallback text always includes the extra-notes section, and the AI instruction explicitly renders it.

### 29.4 Sentinel real-time parsing & error monitoring
- `monitorActiveConversations()` runs every 60s, rescues stalled quizzes and now:
  - Sends confirm-phase recovery copy ("Reply YES to confirm / Cancel to discard") instead of "Pending: n/a".
  - Logs `EXTRACTION_ERROR` friction when a session accumulates repeated extraction failures and includes the failure count in the friction snippet.
  - Continues to record `CONVERSATION_STALL` nudges, rate limits and max-nudge caps.
- Cloud Run triage: `scanCloudRunAnomalies()` ignores benign INFO/NOTICE/DEBUG + <400 entries (regardless of latency) and skips empty payloads; `scripts/audit_logs.js` is the read-only cross-reference tool.

### 29.5 Tests
- `test_maintenance_reminders.js` — 44 stateless assertions (unit parsing, canonical conversion, remaining tracking, tier dispatch, overdue, sweep, imperial display).
- `test_natural_parser.js` — 28 stateless assertions (deterministic extraction, extra notes, dynamic missing fields, AI degradation, AI payload bounds).
- `test_agent_training.js` — 24 stateless assertions (flow-playbook injection, all 32 intents and 17 flows trained, mandatory training sections, active-vehicle prefill).
- Regressions kept green: `test_quiz_flow.js` (41) and `test_sentinel_recovery.js` (15).

---

## 30. Latency Architecture & Cloud Run Operations (v1.8.1)

### 30.1 Instant webhook acknowledgement
- `handleWhatsAppWebhook` verifies the Meta HMAC → checks the in-memory wamid cache (`isMessageProcessed`, <0.1 ms) → sends **200 OK immediately** → enqueues the turn.
- **No Supabase I/O remains on the acknowledgement path.** The distributed claim (`checkAndRecordWamid`: memory mark + `processed_webhooks` select/upsert) now runs as the FIRST step inside the per-phone queued task. A per-task `claimed` flag ensures queue retries re-run processing without re-claiming (retry semantics preserved).
- `processed_webhooks` is written **once** per message; the previous duplicate upsert inside `processIncomingWhatsAppMessage` was removed.
- Media turns run OCR (`ocrWhatsAppMedia`) and durable session hydration (`loadSessionSnapshot`) **in parallel** via `Promise.all`; both are side-effect free, so a media turn no longer pays two serial round trips.

### 30.2 Pooling & fail-fast timeouts
- `src/services/supabaseClient.js` caches exactly one client per process (HTTP keep-alive pool) and wraps every request in a `SUPABASE_TIMEOUT_MS` (15 s) AbortController. `index.js`, `whatsapp.js` and the route layer reuse the same pooled client.
- DeepSeek calls are fail-fast: SDK `maxRetries: 0`, `AI_TIMEOUT_MS` 12 s. `naturalParser.extractWithAI` races an 8 s cap and degrades to deterministic extraction.

### 30.3 Bounded AI payloads
- `naturalParser` clamps extraction input to `MAX_EXTRACTION_TEXT_CHARS` (1200 — paragraph intake) and the collected-fields JSON to `MAX_COLLECTED_JSON_CHARS` (800); deterministic parsing still sees the full text.
- `naturalParser.extractWithAI` keeps `maxTokens` 600; intent calls keep `maxTokens` 800. Question rendering is cached (`QUIZ_QUESTION_CACHE_MS` 15 min, max 300).

### 30.4 Cloud Run warm-instance settings (operations)
- Recommended: `gcloud run services update <service> --min-instances=1 --cpu-boost --no-cpu-throttling` to remove cold-start lag and guarantee post-ACK background processing (queue, AI, DB, Meta send) keeps CPU after the 200 OK; keep instance concurrency aligned with `MESSAGE_MAX_CONCURRENCY` (default 8) so a single container never starves the queue.
- `GET /healthz` returns `{ status, uptimeSeconds, queue }` with **no DB I/O** for liveness/warm probes; `GET /` remains the service banner.
- Multi-instance is safe: per-phone serialization is in-process, cross-instance correctness comes from the `processed_webhooks` claim + durable `chat_sessions` snapshots. (The claim is a check-then-upsert, so a simultaneous same-wamid delivery to two cold instances has the same narrow race window as before — acceptable at Meta retry timings.)

### 30.5 Tuning knobs
| Env | Default | Purpose |
| :--- | :--- | :--- |
| `MESSAGE_MAX_CONCURRENCY` | 8 | global parallel AI + DB tasks |
| `MESSAGE_MAX_ATTEMPTS` / `MESSAGE_RETRY_BASE_MS` | 3 / 250 | retry budget + exponential backoff |
| `AI_TIMEOUT_MS` | 12000 | DeepSeek fail-fast timeout |
| `PREMIUM_MODEL_ENABLED` | off | Tier-2 premium routing kill switch |
| `AI_MODEL_TIER_1/2/3` | deepseek-chat | per-tier model overrides (Tier 3 accepts `deepseek-reasoner`) |
| `CONVERSATIONAL_PROVIDER` | deepseek | Tier-2 provider (`deepseek`/`openai`; `anthropic` Phase 1) |
| `AI_TIMEOUT_MS_PREMIUM` | 30000 | primary premium-leg timeout (Anthropic `AbortSignal` / OpenAI SDK) |
| `AI_USAGE_LOGGING_ENABLED` / `AI_USAGE_LOG_MAX_ROWS` / `AI_USAGE_TRIM_EVERY` | on / 10000 / 250 | telemetry writes + retention |
| `SUPABASE_TIMEOUT_MS` | 15000 | per-request DB timeout |
| `SAKA_PROMPT_CACHE_MS` | 60000 | core prompt cache |
| `SAKA_MAX_PROMPT_REFINEMENT_CHARS` | 2000 | max length of a stored `saka_core_prompt` refinement |
| `QUIZ_QUESTION_CACHE_MS` / `QUIZ_QUESTION_CACHE_MAX` | 900000 / 300 | AI question render cache |

---

## 31. Agent Training: Flow Knowledge & Skill Synchronization (v1.8.1)

### 31.1 Single source of truth — `src/services/flowKnowledge.js`
- `SAKA_INTENTS` — every classifier intent (33), matching the JSON schema.
- `SAKA_QUIZ_FLOWS` — every quiz flow (18) with trigger phrases, field order, extracted JSON keys, post-confirmation writes and per-flow rules.
- `SAKA_INTENT_PLAYBOOK` — non-quiz intents (greeting, discovery, analytics, buyer-side transfer, OTP, reminders, onboarding) and the allowed behaviour for each.
- `SAKA_BOUNDARY_RULES` — VIN/passbook-token immutability, owner-only soft delete, strict 1-to-1 driver assignment, never invent OTP/PIN/amounts/dates, confirmation gate, superadmin interception, Saka/Sentinel division.
- `buildFlowPlaybook()` is injected into `DEFAULT_SAKA_CORE_PROMPT` via `${SAKA_FLOW_PLAYBOOK}`, so **the prompt can never drift from the code**.
- `SAKA_TONE_COMPASS` (v1.17.0) — the Tone Compass & Mirror Engine: four poles (Precision/Anchor, Empathy/Healer, Efficiency/Arrow, Warmth↔Professionalism/Weaver), a five-dimension mirror matrix (register, length, emotion, pace, relationship stage), a situation priority matrix, absolute tone floors and role framing. It is rendered by `buildToneCompassBlock()` and appended to the playbook, so the core prompt and `conversationEngine` composer share one voice policy. `test_agent_training.js` asserts `TONE COMPASS`, `MIRROR MATRIX`, `SITUATION PRIORITY MATRIX`, `user_tone`, `relationship_stage` and `MODEL IDENTITY` stay embedded.

### 31.2 Saka vs Sentinel vs Cline (permanent boundary)
- **Saka** = front-facing WhatsApp agent: intent classification, structured extraction, localized prose, step-by-step guidance.
- **Sentinel** = background supervisor: health checks, conversational friction analysis, stall recovery, Cloud Run triage, weekly feature proposals, and the continuous remediation scan (60s deterministic + 15-min AI synthesis). Saka never impersonates Sentinel or superadmin.
- **Cline** = approved code executor: drafts cluster-focused remediation plans headlessly in GitHub Actions when thresholds trigger, and implements them only after a verified Superadmin approval (nonce-gated, test-gated, no force pushes). Saka never mentions, simulates or claims Cline/remediation actions; see §35.

### 31.3 Training coverage added in v1.9.3
- All 18 quiz flows, all 33 classifier intents (including `VIEW_PROFILE`), the universal reminder engine (date expiries / km-mi distance / operating hours), the 30d/14d/7d/24h/overdue expiry ladder, timezone confirmation, natural multi-field parsing + extra-notes compilation, the four core reports, the email-OTP-gated driver assignment handshake and the regional compliance catalog are explicit prompt instructions.
- `extracted_data` gained `reminder_type`, `reminder_category`, `reminder_due_date`, `reminder_threshold`, `timezone`, `report_type`, `driver_email`, `driver_response`, `compliance_type`, `compliance_number`, `compliance_expiry`, `compliance_lifetime` and `extra_notes`.
- `conversationEngine.composeMessage` adds FACTS-contract lines for expiry timezone confirmation, assignment email OTP/ACCEPT, report fidelity and catalog-derived compliance facts.
- `test_agent_training.js` asserts every intent and flow key is embedded in the assembled core prompt, and that stored prompt refinements are versioned, bounded and never able to override the trained prompt.

### 31.4 Permanent governance rule
Whenever the Saka Fleet application changes (feature, flow, intent, field, handler, schema, config or env knob), update **in the same commit**:
1. `src/services/flowKnowledge.js` (skills/flow registry),
2. `sakaAi.js` core prompt + `conversationEngine.js` instructions,
3. `SAKA_FLEET_ARCHITECTURE.md` (version bump + affected sections),
4. the matching `test_*.js` completeness/behaviour assertions.

Mirrored in `.clinerules` rule 13.




---

## 32. Core Fleet Reports (v1.9)

`src/services/fleetReports.js` is the single source of truth for fleet reporting. Every builder returns:

```js
{ ok, type, data /* structured JSON */, text /* WhatsApp markdown */ }
```

`buildFleetReport({ supabase, type, ownerId, vehicleId, countryInfo, profile })` dispatches to the four builders below. `resolveReportType(text)` maps free text (and `extracted_data.report_type`) to `fleet | compliance | maintenance | financial`.

### 32.1 Shared data collection
`loadFleetData()` scopes vehicles by `owner_id` (or a single `vehicle_id`) with `deleted_at IS NULL`, then loads:
`reminders` (vehicle-linked + driver-linked), `expense_logs`, `private_earnings`, `passbook_transfers`, `profiles` (owner/driver phone + timezone) and `expiry_notification_log`.
Every query is bounded (≤2000 rows) and failure-tolerant: a missing/legacy table degrades that section instead of breaking the report.

Expiry items are unified by `collectExpiryItems()`: reminder rows take precedence, and canonical vehicle columns (`insurance_expiry`, `inspection_expiry`, `road_license_expiry`, `permit_expiry`) fill any gaps. Status buckets: `active`, `due_30d`, `due_14d`, `due_7d`, `expired`.

### 32.2 Report 1 — Fleet Status
| Section | Metric |
| :--- | :--- |
| `overview` | Total vehicles, active, unassigned, active drivers, owners |
| `health` | Availability rate %, distance this month (odometer deltas), total odometer, operating hours, expiry items monitored, upcoming 30 days |
| `urgent` | Overdue threshold maintenance, overdue expiries, expired insurance, expired inspections |
| `recentActivity` | Latest registrations, passbook transfers, logged expenses |

### 32.3 Report 2 — Compliance & Expiry
| Section | Metric |
| :--- | :--- |
| `insuranceStatusMatrix` | Active / 30d / 14d / 7d / expired counts + item rows |
| `inspectionAndPermits` | Inspections, permits and licensing summaries |
| `driverLicenses` | Driver-licence summary (driver-linked reminders) |
| `notificationLog` | Last 10 rows from `expiry_notification_log` (tier, plate, phone, sent_at) |
| `actionPrompt` | Owner quick-update prompts, e.g. "Update insurance for KDA 123A to 2026-11-12" |

### 32.4 Report 3 — Maintenance & Service
| Section | Metric |
| :--- | :--- |
| `thresholds` | Per-reminder remaining km/mi/hours, target, current, % remaining, `dueState` (`on_track` / `warning` / `due_now` / `overdue`) |
| `pmCompliance` | Scheduled, completed, completed on time, overdue, compliance rate % |
| `serviceHistory` | Recent maintenance/parts expense logs with workshop notes |
| `extraNotes` | Unstructured catch-all notes from reminders + `vehicles.other_details` |

### 32.5 Report 4 — Financial & Cost
| Section | Metric |
| :--- | :--- |
| `expenses` | Fuel, maintenance, parts, tolls/parking, other, total (owner currency) |
| `earnings` | Total revenue + per-vehicle earnings (`private_earnings`) |
| `net` | Earnings − expenses per vehicle and fleet total |
| `efficiency` | Distance covered this month, operating hours, cost per km/mi, cost per operating hour |

All money uses `formatMoney(amount, ctx.currency, ctx.locale)`, distances honour the owner's metric/imperial system, and dates render in the owner's confirmed timezone. Report text never contains hard-coded KES.

### 32.6 Access paths
- WhatsApp: `QUERY_FLEET_SUMMARY` → Fleet Status; `REQUEST_REPORT` + `report_type` → the selected report (owners/drivers see their own fleet scope).
- `fleetReports` is also reusable by executive dashboards (JSON-first) and the per-vehicle PDF audit path (`reports.js` remains the PDF renderer).

---

## 33. Supabase Connectivity Verification (v1.9.1)

### 33.1 Tooling — `scripts/check_supabase_connection.js`
`npm run check:supabase` (alias: `node scripts/check_supabase_connection.js`).

A **strictly read-only** diagnostic. Every remote call is a `GET`/`HEAD` or a `SELECT` inside an explicit `BEGIN TRANSACTION READ ONLY … ROLLBACK`. It never inserts, updates, deletes, upserts, truncates or runs DDL, and never triggers WhatsApp/Resend/Paystack/DeepSeek traffic.

| Phase | Checks |
| :--- | :--- |
| P1 | Redacted credential inventory, project-ref guard (hard stop on mismatch), JWT role/expiry validation, JWT `ref` vs URL host comparison |
| P2 | `GET /auth/v1/health`, `GET /rest/v1/` OpenAPI root, `createResilientClient()` construction, per-table row counts, column-shape assertions, corrupt-key negative control, client-cache identity |
| P3 | `DATABASE_URL` parse → TCP → `pg` session with TLS negotiation → read-only `SELECT` → `public` schema table count |
| P4 | Application key mapping + `SUPABASE_TIMEOUT_MS` AbortSignal wiring |

Flags: `--with-timeout-test` (asserts the AbortSignal guard), `--with-pooler-discovery` (tries the regional pooler hosts when the direct host is unreachable). Exit codes: `0` all passed, `1` one or more failed, `2` hard stop (wrong project ref or missing credentials).

> **Anti-false-positive rule:** table/schema probes must use `GET`, never `HEAD`. A `HEAD` 404 carries no body, so `supabase-js` reports no error and an empty project can look healthy. Row-count probes therefore fall back to a 1-row `GET` selecting only the table's primary key (`id`, `vin` or `key`) — no PII is transferred.

### 33.2 Credential contract
| Env | Used by | Notes |
| :--- | :--- | :--- |
| `SUPABASE_URL` | all DB paths | Project ref guard compares the host against the expected staging ref |
| `SUPABASE_SERVICE_KEY` | canonical name across the codebase | `resolveServiceKey()` (`src/services/supabaseClient.js`) |
| `SUPABASE_SERVICE_ROLE_KEY` | accepted alias | Dashboard naming; resolved as a fallback so a correctly supplied key is never silently ignored |
| `DATABASE_URL` | verification tooling only | **No runtime code path consumes it** and no `pg` dependency is bundled; install `pg` ad hoc (`npm i --no-save --no-package-lock --ignore-scripts pg`) to exercise P3 |
| `SUPABASE_ACCESS_TOKEN` | Management API SQL (migrations, `ensureVehicleTableColumns`, session store, Sentinel) | `https://api.supabase.com/v1/projects/{ref}/database/query` |
| `SUPABASE_POOLER_REGION` | verification tooling | e.g. `eu-west-1`; builds `postgresql://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com:5432/postgres` |
| `SUPABASE_TIMEOUT_MS` | runtime | 15000 ms per-request AbortController |

**Connection-string rules learned on staging:** `db.<ref>.supabase.co` is not resolvable for this project (no A/AAAA record). Direct/pooler access must use `aws-0-<region>.pooler.supabase.com:5432` with the username form `postgres.<ref>` and `sslmode=require`.

### 33.3 Staging verification result (2026-10-29)
Pre-provisioning state, then post-provisioning state, both verified with `--with-timeout-test` against project `knlxpwiqiqcliprjqjfp`:

**Before provisioning**
- ✅ GoTrue health `200`, PostgREST root `200`, service-role JWT valid (`role=service_role`, exp 2036-10-28), corrupt-key control `401`.
- ✅ Postgres session `postgres as postgres`, TLS `TLS_AES_256_GCM_SHA384`, read-only transaction honoured.
- ❌ `public` schema contained **0 tables** — only `auth.*` and `storage.*` system tables existed, so every domain table returned `PGRST205`.
- The originally supplied `SUPABASE_URL`/`DATABASE_URL` used the ref `knlxpwiqcliprjqjfp` (18 chars, NXDOMAIN); the live ref is `knlxpwiqiqcliprjqjfp` (20 chars), which matches the JWT `ref` claim.

**After provisioning (§33.5)**
- ✅ `25/25` expected tables present; `public schema tables = 25`; checker reports `passed=28 failed=0 skipped=0` and **exit code 0**.
- ✅ `trg_prevent_vin_mutation` present and proven to block `UPDATE vehicles SET vin = …` (verified inside a rolled-back transaction, so zero residue).
- ✅ Repository CRUD suite `test_edit_delete.js` passes end-to-end against the new schema (seed → edit → VIN rejection → owner-only delete → cleanup), leaving `0` rows in all 25 tables.

### 33.5 Provisioning the schema — `scripts/provision_staging_schema.js`
`npm run migrate:staging-schema` (alias: `node scripts/provision_staging_schema.js`).

Provisions a target database from scratch. Idempotent (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) and guarded by the same project-ref check, exiting `2` on a mismatch before writing.

**Two classes of schema:**
1. `BOOTSTRAP_SQL` / `BOOTSTRAP_OPERATIONAL_SQL` — base tables that **no code path creates** (`profiles`, `vehicles`, `passbook_transfers`, `reminders`, `expenses`, `expense_logs`, `private_earnings`, `pending_owner_notifications`, `processed_webhooks`, `exchange_rates_cache`, `support_tickets`, `weekly_feature_proposals`). Columns are derived from §2 + §28.3 and the repository's real insert/select payloads.
2. The existing migrations, executed in dependency order — single source of truth, not duplicated:
   `ensureSuperadminTables()` → `ensureVehicleTableColumns()` → `ensureSentinelTables()` → `ensureRemediationTables()` → `ensureAiUsageLogsTable()` → `ensureChatSessionsTable()` → `applySentinelMigration()` → `applyChatSessionsMigration()` → `applyVinImmutabilityMigration()` → `applyRemediationMigration()`.

**Ordering constraint (critical):** `ensureVehicleTableColumns()` ALTERs `coupons`, `passbook_transfers`, `reminders`, `profiles` and `vehicles`, so those tables must exist first. Because `pg` sends a multi-statement batch as one implicit transaction, a single failure rolls back the whole batch — hence `ensureSuperadminTables()` (which creates `coupons`) must run *before* the vehicles migration.

`GRANTS_SQL` then grants `service_role`/`anon`/`authenticated` access so freshly created tables are visible through PostgREST rather than returning `401/403`.

### 33.6 Transport abstraction — `src/db/sqlRunner.js`
All migrations now call `runSql(sql, { label })` instead of hand-rolling `fetch` calls:
- `SUPABASE_ACCESS_TOKEN` set → Management API (original behaviour, unchanged).
- otherwise `DATABASE_URL` → direct Postgres via the optional `pg` driver.
- neither → `{ ok: false, error: 'No SQL transport configured' }`.

`runSql` never throws; callers keep their existing fail-soft behaviour. Refactored call sites: `ensureVehicleTableColumns`, `ensureSuperadminTables`, `ensureSentinelTables`, `ensureChatSessionsTable`, `run_vin_immutability_migration`, `run_chat_sessions_migration`, `run_sentinel_migration`. The two `run_*` scripts also gained a direct-execution guard so the provisioning script can import them without side effects.

> **`sslmode` gotcha:** `pg-connection-string` maps `sslmode=require` to *full* certificate verification, which fails against the Supabase pooler chain with `SELF_SIGNED_CERT_IN_CHAIN`. `sqlRunner` strips `sslmode` and sets `ssl: { rejectUnauthorized: false }` explicitly — TLS is still negotiated, just without CA pinning.

### 33.4 Safety guarantees
- No test-suite invocation (`npm test` seeds rows, `--cleanup-only` deletes them) and no `reset:db` / `migrate:*` path is ever called by the checker.
- `GET /healthz` is DB-free by design and is **not** accepted as database evidence.
- The script is safe to run against production-like projects because it cannot mutate state; the project-ref guard still refuses unexpected targets.



---

## 34. Chat-Log Audit Findings & Hardening (v1.9.3)

### 34.1 Findings (read-only audit, 2026-10-29)
- **Stale deployment:** `system_config.last_deployed_revision` was `saka-fleet-00045-g6f` (2026-10-28 05:58Z), predating v1.9.0–v1.9.2. Live sessions still showed the pre-OTP driver assignment (including self-assignment), transient "Vehicle not found." on the first status request, and INFO/2xx `SYSTEM_ERROR` noise.
- **Stale prompt override:** `system_config.saka_core_prompt` held the pre-v1.7 mega-prompt (numbered menus, old assignment copy) and was appended after the trained core prompt, creating contradictory instructions.
- **Profile viewing misrouted:** *"My profile details"* started the `edit_profile` wizard / greeting because no view intent existed.
- **Multilingual gap:** Swahili *"lugha"* / *"kingereza"* were not recognized by the `profile_field` choice, producing an apology loop (`CONVERSATION_STALL`).
- **Observability:** legacy `CONVERSATION_STALL` rows had empty snippets; `error_logs` rows had empty `{}` payloads (both fixed in current Sentinel code — deploy resolves).

### 34.2 Fixes shipped in v1.9.3
- **Prompt refinement guard** (`sakaAi.getSakaCorePrompt`): stored refinements are only applied when ≤ `SAKA_MAX_PROMPT_REFINEMENT_CHARS` (2000) **and** tagged with the current `SAKA-PROMPT-SCHEMA:<version>` marker (`PROMPT_REFINEMENT_MARKER`). Legacy overrides are ignored and logged. `clearSakaPromptCache()` remains the invalidation hook.
- **`VIEW_PROFILE` intent (33rd):** read-only profile snapshot — name, phone, email + verified status, language, units, timezone, country, roles, subscription tier, driver compliance status. Never starts a quiz. Added to `SAKA_INTENTS`, the playbook, the JSON schema, regex fallback (`VIEW_PROFILE` wins over edit), `NON_QUIZ_INTENTS` and role command discovery.
- **Multilingual profile aliases:** `profile_field` now recognizes Swahili (`jina`, `lugha`, `vipimo`, …), French (`nom`, `langue`, `unités`) and Spanish (`nombre`, `idioma`, `unidades`, `sistema de unidades`).
- **Fuel-economy nudge:** when only one fill-up exists, the reply now says *"log your **next** fill-up with the odometer reading"* so users know exactly how to unlock km/L or MPG.
- **Audit tool hardening** (`scripts/audit_logs.js`): flags stale/unversioned `saka_core_prompt` overrides, stall rows missing context, plus the existing empty-payload/reminder/operating-hours checks. The script remains SELECT-only.
- **Sentinel context:** `monitorActiveConversations` already records flow/phase/pending question/nudge count in `transcript_snippet`, and `scanCloudRunAnomalies` filters INFO/2xx and stores the raw log text — both take effect once the latest revision is deployed.

### 34.3 Operational follow-ups
1. Redeploy Cloud Run to the latest commit and confirm `system_config.last_deployed_revision` advances.
2. Clear or replace the stale `saka_core_prompt` override with a versioned ≤2000-char refinement (e.g. `SAKA-PROMPT-SCHEMA:2026.10.3`), or delete the row.
3. Expect the insurance reminder due 2026-10-30 to fire the 24h expiry tier once the new revision runs — this is the v1.9 expiry ladder working as designed.


---

## 35. Autonomous Sentinel ↔ Cline Remediation Pipeline (v1.10.0)

### 35.1 Purpose & agent roles
Minimises manual error-log inspection and manual prompt-writing with a continuous, approval-gated self-healing cycle. Boundaries are permanent (`.clinerules` rules 15–19):
- **Saka** — front-facing WhatsApp agent (unchanged; never impersonates the pipeline).
- **Sentinel** — background supervisor: continuous rolling-window scan (`runRemediationScan`) with throttled AI synthesis (`refreshRemediationSynthesis`).
- **Cline** — headless code executor in GitHub Actions: drafts cluster-focused plans when thresholds trigger and implements only approved work orders.
- **Superadmin** — sole approver via `admin accept/decline/modify fix <CODE>`; receives twice-daily adaptive digests plus immediate urgent alerts.

### 35.2 Schema & migration
- `sentinel_audit_runs` (§2.11) — one audit artifact per Nairobi date (`run_date` UNIQUE), clusters + counts + AI overview.
- `remediation_proposals` (§2.12) — the approval-gated work order and its audit trail (status, nonce, attempts, execution result).
- Migration: `npm run migrate:remediation` → `scripts/run_remediation_migration.js` (`applyRemediationMigration`); idempotent boot ensure via `ensureRemediationTables()`.
- Provisioned by `npm run migrate:staging-schema` in the chain `ensureRemediationTables → … → applyRemediationMigration`; both tables are verified in `EXPECTED_TABLES`.
- `scripts/reset-db.js` **preserves** both tables (governance ledger, like `weekly_feature_proposals`).

### 35.3 Scheduling & triggers (continuous — v1.11.0)
Three fail-soft, idempotent tiers run in `index.js`:
- **Tier 1 — deterministic scan (default every 60 s):** `runRemediationScan` collects the rolling, upper-bounded window (default 4h, `REMEDIATION_AUDIT_WINDOW_HOURS`) from `error_logs`, `chat_friction_logs` and quiz-active `chat_sessions`, clusters by `buildSignature`, computes `health_score`, and upserts today's `sentinel_audit_runs` row. It increments `scan_count`, updates `last_scanned_at`, and only rewrites the deterministic summary when counts/clusters changed. No AI call and no watermark races (recompute model).
- **Tier 2 — throttled AI synthesis (default every 15 min):** `refreshRemediationSynthesis` re-runs the reasoning-tier summary only when `last_synthesis_at` is stale or forced; deterministic fallback retained. Since v1.14.0 the model is `deepseek-reasoner` when `REMEDIATION_AUTONOMY=on` (otherwise `deepseek-chat`), or Claude Opus when `AI_REASONING_PROVIDER=anthropic`, with `AI_TIMEOUT_MS_REASONING` (45 s) and DeepSeek failover (see §38.3).
- **Tier 3 — plan triggers (every scan tick):** `checkRemediationPlanTriggers` dispatches `remediation_plan` for clusters that are `severity=high` or `count >= REMEDIATION_PLAN_TRIGGER_COUNT`, with a per-signature cooldown (`REMEDIATION_PLAN_COOLDOWN_MS`), active-proposal dedupe (`target_signature`) and a hard daily cap (`REMEDIATION_MAX_PLANS_PER_DAY`). Gated by `REMEDIATION_AUTONOMY=on`.
- **Digest scheduler (08:00 / 20:00 EAT):** `checkRemediationDigestSchedule` (minute-checker, per-slot key) calls `sendRemediationDigest`; see §35.7.
- **Urgent escalation (every scan tick, 1h cooldown):** `maybeSendUrgentRemediationAlert` pages immediately when unresolved errors ≥ `REMEDIATION_URGENT_ERROR_THRESHOLD` or a high-risk proposal is pending. Notification-only → not autonomy-gated.
- **Every 30 min:** `checkRemediationExecutionRetry` re-dispatches or recovers execution (see §35.6).
- Manual endpoints: `POST /api/cron/remediation-audit` (scan + forced synthesis), `POST /api/cron/remediation-plan` (trigger evaluation), `POST /api/cron/remediation-digest` (forced digest + retry).
- Cloud Scheduler is optional; the in-process timers are primary. No `pg_cron`/`node-cron` dependency was added.

### 35.4 Plan generation in CI (Cline headless)
`repository_dispatch: remediation_plan { audit_run_id, cluster_signature?, feedback? }` → job **plan** in `.github/workflows/remediation_pipeline.yml`:
1. `node scripts/remediation_ci.js fetch-audit <id|date> [feedback] [clusterSignature]` emits the audit context (health score, focused cluster, plan schema, forbidden paths).
2. `cline --auto-approve true -t 1800 -P deepseek -m deepseek-chat "…"` reads `.clinerules`, `SAKA_FLEET_ARCHITECTURE.md` and the audit context, then writes `remediation/work-orders/plan.json` (descriptive JSON only — the plan job never commits).
3. `node scripts/remediation_ci.js submit-plan <auditId> <planFile> [clusterSignature]` validates the shape, runs `sanitizeRemediationPlan` (≤12 changes, repo-relative paths, ≥1 existing `test_*.js`, forbidden paths/keywords blocked), stores `target_signature`, assigns `FIX-YYYY-MM-DD-NN` and inserts the proposal:
   - clean plan → `PENDING_APPROVAL` (rides the next twice-daily digest; high-risk proposals still trigger an immediate urgent alert);
   - blocked plan → `NEEDS_MODIFICATION` + dual-channel alert; never delivered for approval.

### 35.5 Approval gateway & state machine
- Commands (superadmin phone + active 30-minute session): `admin remediations`, `admin accept fix <CODE>`, `admin decline fix <CODE>`, `admin modify fix <CODE> <guidance>`.
- `handleAdminRemediationDecision`:
  - **accept** → `APPROVED`, mints `approval_nonce` (24h TTL, `buildApprovalWindow`), resets attempts, dispatches `remediation_execute` via `src/services/githubDispatch.js`; a dispatch failure leaves it `APPROVED` for the retry poller.
  - **decline** → `DECLINED` (no execution path).
  - **modify** → `NEEDS_MODIFICATION` + stored feedback, then dispatches a fresh `remediation_plan` carrying the guidance.
- Kill switch: every decision and dispatch requires `REMEDIATION_AUTONOMY=on` (default `off`).
- All transitions are written to `admin_audit_logs` (`logAdminAudit` / `logRemediationAudit`).

### 35.6 Execution workflow (GitHub Actions)
`repository_dispatch: remediation_execute { proposal_code, approval_nonce }` → job **execute** in `.github/workflows/remediation_execute.yml` (fixed concurrency, `contents: write` only, 45-minute timeout):
1. **Gate** — `node scripts/remediation_ci.js gate <CODE> <NONCE>` re-reads the proposal from Supabase and requires `status=APPROVED`, matching nonce, unexpired TTL and attempts within `REMEDIATION_MAX_ATTEMPTS`; then marks `EXECUTING`. A wrong/expired/replayed nonce fails the job before Cline starts.
2. **Targeted tests (pre)** — `node scripts/run_tests.js <proposal tests>`; red → no edits.
3. **Work order** — `node scripts/remediation_ci.js fetch <CODE>` writes `remediation/work-orders/<CODE>.md` (scope, evidence, tests, rollback, forbidden paths, execution rules).
4. **Cline headless** — `cline --auto-approve true -t 1800 -P deepseek -m deepseek-chat "…implement EXACTLY the approved work order…"` (Cline reads `.clinerules` + this document natively; it never commits or pushes).
5. **Targeted tests (post)** — same suites; red → no push.
6. **Commit & push** — normal commit (`fix(remediation): <CODE> — approved autonomous remediation`) and `git push origin HEAD:main`; no force push, no history rewrite. A no-diff run aborts.
7. **Report** — `node scripts/remediation_ci.js report <CODE> <sha>` → `DEPLOYED`, nonce consumed, `executed_at`, dual-channel outcome alert. Any earlier failure triggers `fail <CODE> <run-url>` → `NEEDS_MODIFICATION` + alert; nothing was pushed.
- The existing `.github/workflows/deploy_notify.yml` automatically announces the resulting push to `main`.

### 35.7 Twice-daily adaptive digests & notifications (dual-channel)
- **Digest aggregation:** `sendRemediationDigest` collects `PENDING_APPROVAL`/`NEEDS_MODIFICATION` proposals with `digest_sent_at IS NULL` plus a system-health snapshot (health score, rolling-window errors/friction/stalls (default 4h), unresolved errors, active Sentinel rules, scan count) and sends one WhatsApp + `sendRemediationDigestEmail` (Resend) summary. Included proposals get `digest_sent_at`; a digest is sent even with zero proposals. `dispatchTwiceDailyDigests` is a naming-parity alias of `sendRemediationDigest`.
- **Schedule:** 08:00 and 20:00 EAT by default (`REMEDIATION_DIGEST_HOURS_CSV`); the minute-checker uses a per-slot key so each slot fires once.
- **Adaptive frequency:** `computeDigestFrequency` persists `system_config.remediation_digest_frequency` (`twice_daily` → `daily` (08:00 only) → `weekly` (Monday 08:00); `weekly` is the floor). A 7-day trailing event count ≤ `REMEDIATION_DIGEST_DAILY_THRESHOLD` (10) steps down to daily; ≤ `REMEDIATION_DIGEST_WEEKLY_THRESHOLD` (3) steps down to weekly. Scale-down is one step per evaluation; any regression escalates immediately.
- **Urgent escalation:** `maybeSendUrgentRemediationAlert` sends an immediate WhatsApp + email when unresolved errors ≥ `REMEDIATION_URGENT_ERROR_THRESHOLD` or a high-risk proposal is pending, deduped via `system_config.remediation_urgent_last_sent` (`REMEDIATION_URGENT_COOLDOWN_MS`, default 1 h).
- **Outcome alerts:** `reportRemediationResult` still sends WhatsApp + `sendAdminNotificationEmail` per execution result.
- Both channels are independent (one outage never silences the other), mirroring `scripts/notify_git_push.js`.

### 35.8 Safety guardrails & kill switches
- `sanitizeRemediationPlan` (shared by CI submit and server) blocks: VIN/OTP/auth/schema/destructive keywords, `.env`, `.clinerules`, `.github/`, `supabase/`, reset/provision/VIN migrations, `paystack.js`, `transfers.js`, `githubDispatch.js`, `remediation.js`, `remediation_ci.js` and the remediation migration (self-modification guard). Since v1.17.0 it also runs `validateAiModelUpdatePlan` (allowlisted files, mandatory model suites, canary ceiling, documented rollback), and `verifyModelUpdateAgainstRegistry` re-checks the benchmark at submit **and** at the execution gate.
- Execution requires DB-verified approval + fresh single-use nonce (`consumeProposalNonce` nulls it on success).
- Tests gate both sides of the edit; no green, no push.
- **Post-edit diff guard:** after the post-change tests, the execute job runs `node scripts/remediation_ci.js guard <CODE>`; any working-tree change matching `REMEDIATION_FORBIDDEN_PATHS` (via the shared `matchForbiddenRemediationPath`, including untracked files and renames) aborts the run before `git add` — nothing is committed or pushed.
- Attempt ceiling: `REMEDIATION_MAX_ATTEMPTS` (default 2); excess → `NEEDS_MODIFICATION` + alert.
- Frequency/storm guards: per-signature plan cooldown, daily plan cap, per-slot digest key, `digest_sent_at` batching, urgent-alert cooldown, and a scan `inFlight` guard (no overlapping ticks).
- Kill switch: `REMEDIATION_AUTONOMY=off` (default; `on`, `true` or `1` enable) gates plan dispatch, approvals and execution. Continuous scans, digests and urgent health alerts are notification/read-only and keep running so the Superadmin stays informed. `adminrules reset` remains the Sentinel prompt-rule kill switch.
- Exit codes/status are auditable in `remediation_proposals.execution` and `admin_audit_logs`.

### 35.9 Environment & secrets
- **Cloud Run / server:** `REMEDIATION_AUTONOMY` (off; `on`, `true` or `1` enable), `GH_REMEDIATION_TOKEN` (fine-grained PAT: contents write + workflow dispatch on this repo), `GH_REMEDIATION_REPO` (`owner/repo`), `REMEDIATION_MAX_ATTEMPTS`, `REMEDIATION_NONCE_TTL_HOURS`, `REMEDIATION_EXECUTION_RETRY_MS`, `REMEDIATION_DISPATCH_TIMEOUT_MS`, `REMEDIATION_SCAN_INTERVAL_MS` (60 s), `REMEDIATION_AUDIT_WINDOW_HOURS` (4), `REMEDIATION_SYNTHESIS_INTERVAL_MS` (15 min), `REMEDIATION_PLAN_TRIGGER_COUNT` (3), `REMEDIATION_PLAN_COOLDOWN_MS` (6 h), `REMEDIATION_MAX_PLANS_PER_DAY` (4), `REMEDIATION_DIGEST_HOURS_CSV` (`8,20`), `REMEDIATION_DIGEST_SCALE_DOWN_WINDOW_DAYS` (7), `REMEDIATION_DIGEST_DAILY_THRESHOLD` (10), `REMEDIATION_DIGEST_WEEKLY_THRESHOLD` (3), `REMEDIATION_URGENT_ERROR_THRESHOLD` (10), `REMEDIATION_URGENT_COOLDOWN_MS` (1 h).
- **Rolling-window note:** `REMEDIATION_AUDIT_WINDOW_HOURS` is clamped to 1-72h and read at process start; a change applies from the next scan tick. Digest labels always report the currently loaded value while the counts come from the last persisted scan.
- **GitHub repository secrets (used by the workflow):** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DEEPSEEK_API_KEY`, `SUPERADMIN_PHONE`, `SUPERADMIN_EMAIL`, `META_PHONE_NUMBER_ID`, `META_WHATSAPP_TOKEN`, `RESEND_API_KEY` (RESEND_API_KEY remains for remediation outcome/digest mail and auth OTPs; it is no longer consumed by `deploy_notify`).
- Cline CLI: installed in CI with `npm install -g cline`; provider/model pinned with `-P deepseek -m deepseek-chat` (adjust per `cline config` if the provider id differs — the gate fails closed).

### 35.10 Operations & verification
- `npm run migrate:remediation` applies the schema; `npm run migrate:staging-schema` provisions and verifies all tables.
- `npm run remediation:ci -- <subcommand>` is the CI-only runner (`fetch-audit`, `submit-plan`, `tests`, `gate`, `guard`, `fetch`, `report`, `fail`).
- Targeted suite: `node scripts/run_tests.js test_remediation_pipeline.js` (schema, sanitizer, scan idempotency, health score, plan triggers, gate replay/expiry/status, approval state machine, adaptive digest frequency, digest batching, urgent escalation, kill switch) — 68 assertions, always auto-cleans its rows.
- `npm run audit:logs` remains the read-only forensic companion.

### 35.11 Files
- `src/workers/remediation.js` — continuous scan, throttled synthesis, plan triggers, digest/frequency/urgent logic, sanitizer, dispatch, gate helpers, retry poller.
- `src/services/githubDispatch.js` — the sole server → GitHub bridge (kill-switch gated, fail-soft).
- `scripts/remediation_ci.js` + `.github/workflows/remediation_pipeline.yml` (plan) and `.github/workflows/remediation_execute.yml` (execute) — cluster-focused CI lifecycle with a post-edit forbidden-path guard before commit.
- `scripts/run_remediation_migration.js` — schema migration.
- `src/services/superadmin.js` — approval commands, state machine, nonce minting.
- `src/services/mailer.js` — remediation approval + digest emails.
- `test_remediation_pipeline.js` — regression suite (56 assertions).

---

## 36. Multi-Model Router — Phase 0 (v1.12.0)

### 36.1 Purpose → tier architecture
All LLM traffic still flows through `src/services/aiClient.js` (the only provider surface). Phase 0 adds a purpose registry and tier routing with **all tiers resolving to DeepSeek**:

| Tier | Role | Default model | Used by |
| :--- | :--- | :--- | :--- |
| 0 | Deterministic (no model) | — | regex classifier, quiz fast path, date parser, cached question hits |
| 1 | Router / utility | `AI_MODEL_TIER_1` → `DEEPSEEK_MODEL` → `deepseek-chat` | extraction, question render, stall nudge, admin parse |
| 2 | Conversational nuance | `AI_MODEL_TIER_2` → `deepseek-chat` | intent classification, prose rendering (driver handshakes, transfers, complaints) |
| 3 | Reasoning / synthesis | `AI_MODEL_TIER_3` → `deepseek-chat` (`deepseek-reasoner` opt-in) | Sentinel diagnosis, friction patches, prompt refinement, Horizon, remediation synthesis |

`PREMIUM_MODEL_ENABLED` (default **off**) is the master kill switch: while off, every Tier-2 purpose downgrades to Tier 1. `CONVERSATIONAL_PROVIDER` selects the Tier-2 provider (`deepseek` by default; `anthropic` is live via the fetch-based Messages API in v1.12.1; `openai` is supported by the lazy client).

### 36.2 Registry & routing API
- `AI_PURPOSES` — frozen purpose → `{ tier, jsonMode, maxTokens, temperature }` registry (source of truth for defaults).
- `resolveTier(purpose, { tier })` → `{ tier, provider, model }`; Tier 0 returns null provider/model (deterministic, no call).
- `routeModelForPurpose(purpose, ctx)` → `{ tier, provider, model, candidates[] }`; DeepSeek candidate fallbacks are appended for DeepSeek-provider routes.
- `getProviderClient(provider)` — lazy, cached per provider + key. DeepSeek and OpenAI are implemented; Anthropic uses the separate fetch-based `runAnthropicAttempt()` path.
- `runAnthropicAttempt({ model, system, messages, jsonMode, maxTokens, temperature, timeoutMs })` — native `fetch` POST to `https://api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`, `AbortSignal.timeout(AI_TIMEOUT_MS_PREMIUM)`). Throws on non-2xx/timeout so `chatCompletion()` falls back to DeepSeek.
- `chatCompletion({ ..., provider, purpose, tier })` / `generateText({ ..., provider, purpose, tier })` — additive and backward-compatible. An explicit `model` keeps the legacy single-candidate contract; `tier` lets the canary classifier force or suppress escalation.
- Premium concurrency guard: an in-process counter caps Anthropic in-flight calls at `AI_PREMIUM_MAX_CONCURRENCY` (default 2); overflow continues straight to the DeepSeek fallback, which is always the last attempt.
- Canary escalation: `classifyIntentTier()` (sakaAi.js) promotes only high-stakes or complex non-quiz turns to Tier 2 (frustration lexicon, driver handshakes, booking/dispatch, >160 chars, multi-fact actions, deep-history why-questions). Tier-0 quiz fast paths and simple FAQs/greetings stay Tier 1.
- Each outcome (success or terminal failure) emits exactly one usage record to the sink installed by `installAiUsageSink()`; emission is fire-and-forget and can never block a turn.

### 36.3 Purpose tagging (call sites)
| Purpose | Call site |
| :--- | :--- |
| `intent_classify` | `sakaAi.js` `processSakaMessage()` |
| `classifyIntentTier` (canary) | `sakaAi.js` — deterministic Tier-1 vs Tier-2 decision for non-quiz turns |
| `extraction` | `naturalParser.js` `extractWithAI()` |
| `question_render` / `stall_nudge` / `prose_render` | `conversationEngine.js` `composeMessage()` (mapped from the compose purpose) |
| `sentinel_diagnosis` | `sentinel.js` `runHealthCheck()`, `superadmin.js` `SENTINEL_DIAGNOSE` |
| `prompt_refinement` | `sentinel.js` `runConversationRefinement()` |
| `friction_patch` | `sentinel.js` `evaluateConversationalFriction()` |
| `horizon_synthesis` | `sentinel.js` `generateWeeklyFeaturePlan()` |
| `remediation_synthesis` | `remediation.js` `refreshRemediationSynthesis()` |
| `admin_parse` | `superadmin.js` `parseSuperadminCommand()` |
| `health_synthesis` | `superadmin.js` `handleHealthCheckCommand()` |
| `model_benchmark` | `aiModelRegistry.js` benchmark/probe telemetry (v1.17.0) |
| `model_research` | `aiModelRegistry.js` `researchModelLandscape()` — capability-gated web search/fetch |

### 36.4 Telemetry table & retention
`public.ai_usage_logs` — idempotent `ensureAiUsageLogsTable()` at boot, provisioned by `npm run migrate:staging-schema`, verified in `EXPECTED_TABLES`:

| Column | Meaning |
| :--- | :--- |
| `purpose` / `tier` | router purpose + resolved tier (null for legacy untagged calls) |
| `provider` / `model` | provider and model that produced the outcome |
| `latency_ms` / `ok` / `error` | wall-clock latency and outcome |
| `input_chars` | system + message character count (payload-size proxy) |
| `prompt_tokens` / `completion_tokens` | provider-reported usage when available |
| `attempts` | ordered provider legs with outcome (`ok`, `failed`, `skipped_missing_key`, `skipped_circuit_open`, `skipped_budget`, `skipped_concurrency`) — one row per turn (v1.14.0) |
| `created_at` | insert timestamp |

Retention: `AI_USAGE_LOG_MAX_ROWS` (10,000) trimmed every `AI_USAGE_TRIM_EVERY` (250) writes. `AI_USAGE_LOGGING_ENABLED=off` disables writes. The ledger is operational (not governance) and can be truncated without audit impact.

Analytics (v1.13.0): `getAiUsageSummary(supabase, hours = 24)` aggregates a 1–168 h window in JS over paged PostgREST reads (1,000-row pages, capped by `AI_USAGE_LOG_MAX_ROWS`) and returns totals, success/error rates, avg + p50 latency, prompt/completion tokens, approximate cost and `byTier` / `byProvider` / `byPurpose` buckets. `estimateAiUsageCostUsd()` applies `AI_USAGE_COST_RULES` approximate public list prices — informational only, never billing. The helper never throws (returns `{ ok: false, error }`) and makes no provider calls. Since v1.14.0 it also totals `fallbacks` (every leg after the first in `attempts`), so the digest exposes failover volume. See §37–§38.

### 36.5 Env knobs
| Env | Default | Purpose |
| :--- | :--- | :--- |
| `PREMIUM_MODEL_ENABLED` | off | master kill switch for Tier-2 routing |
| `AI_MODEL_TIER_1` | `DEEPSEEK_MODEL` → `deepseek-chat` | router-tier model |
| `AI_MODEL_TIER_2` | env → provider default (`claude-sonnet-5-5` / `gpt-4o` / `deepseek-chat`) | conversational-tier model |
| `AI_MODEL_TIER_2_OPENAI` | `gpt-4o` | OpenAI secondary Tier-2 leg model |
| `AI_MODEL_TIER_3` | `deepseek-chat` (`deepseek-reasoner` when autonomy is on) | reasoning-tier model |
| `AI_REASONING_PROVIDER` | deepseek | Tier-3 provider (`anthropic` = Claude Opus opt-in) |
| `AI_TIMEOUT_MS_REASONING` | 45000 | Tier-3 background timeout |
| `ANTHROPIC_API_KEY` | (unset) | Tier-2/Tier-3 Anthropic key; unset ⇒ DeepSeek-only |
| `OPENAI_API_KEY` | (unset) | enables the OpenAI Tier-2 fallback leg |
| `CONVERSATIONAL_PROVIDER` | deepseek | Tier-2 primary provider |
| `AI_TIMEOUT_MS_PREMIUM` | 30000 | primary premium-leg timeout (Anthropic `AbortSignal` / OpenAI SDK) |
| `AI_TIMEOUT_MS_FALLBACK` | 10000 | secondary premium legs (v1.24.2) |
| `AI_CHAIN_BUDGET_MS` | 45000 | premium-leg wall-clock budget per AI call (v1.24.2); DeepSeek never gated |
| `AI_PREMIUM_MAX_CONCURRENCY` | 8 | Anthropic in-flight cap; overflow → next leg |
| `AI_CB_FAILURE_THRESHOLD` / `AI_CB_WINDOW_MS` / `AI_CB_OPEN_MS` | 3 / 60000 / 30000 | per-provider circuit breaker (DeepSeek exempt) |
| `AI_CB_BILLING_OPEN_MS` | 1800000 | billing/auth failures open the breaker instantly for 30 min (v1.24.2) |
| `AI_DAILY_BUDGET_USD` | (unset = off) | rolling-24 h spend cap; over-budget premium legs are skipped |
| `AI_BUDGET_ALERT_PCT` | 80 | first alert threshold; 100% always alerts |
| `AI_USAGE_LOGGING_ENABLED` | on | telemetry writes kill switch |
| `AI_USAGE_LOG_MAX_ROWS` | 10000 | retention cap |
| `AI_USAGE_TRIM_EVERY` | 250 | writes between retention sweeps |
| `AI_MODEL_SCOUT_ENABLED` | off | Model Watchdog discovery/benchmark cycle kill switch (§45) |
| `AI_MODEL_AUTO_ADOPT` | off | auto-canary only (never full adoption); off ⇒ proposals only (§45) |
| `AI_WEB_SEARCH_ENABLED` | off | web search/fetch research leg (capability-gated) (§45) |
| `AI_MODEL_SCOUT_INTERVAL_HOURS` | 168 | weekly discovery cadence |
| `AI_MODEL_MIN_BENCHMARK_SCORE` / `AI_MODEL_MAX_CANARY_PCT` | 0.85 / 25 | adoption threshold + canary ceiling |
| `AI_MODEL_ROLLBACK_ERROR_RATE` / `AI_MODEL_ROLLBACK_ABSOLUTE_ERROR_RATE` | 3× / 0.25 | health-watchdog auto-rollback triggers |

### 36.6 Files & tests
- `src/services/aiClient.js` — purpose registry, tier resolution, provider clients, telemetry sink, Phase 3 failover chain (`buildProviderChain`), per-provider circuit breakers and the budget-guard seam.
- `src/services/aiUsageLog.js` — `ensureAiUsageLogsTable` (incl. the `attempts` self-migration), `logAiUsage`, `trimAiUsageLogs`, `installAiUsageSink`, Phase 2 analytics (`getAiUsageSummary`, `estimateAiUsageCostUsd`, `AI_USAGE_COST_RULES`) and Phase 3 budget guard (`computeAiBudgetStatus`, `checkAiDailyBudget`, `installAiBudgetGuard`).
- `src/services/superadmin.js` — `ADMIN_AI_STATS` parsing, `handleAiStatsCommand`, `formatAiStatsReply` (v1.13.0) and `maybeSendAiBudgetAlert` (v1.14.0).
- `index.js` — boot chain ensures the table, installs the usage sink **and** the budget guard after `ensureRemediationTables()`; a 5-minute ticker runs `maybeSendAiBudgetAlert`.
- `test_model_router.js` — 71 assertions: tier resolution for every purpose, premium toggle, Tier 0, unknown purpose, missing-key degradation + single telemetry record, provider caching, helper contracts, DB provisioning/insert/cleanup (zero live API calls).
- `test_phase1_canary.js` — 37 assertions: Anthropic translation/normalization, Tier-2 success, 429/timeout fallback to DeepSeek, `AI_PREMIUM_MAX_CONCURRENCY` cap + overflow, escalation matrix, premium-off downgrade, DB telemetry (fetch-stubbed, zero network).
- `test_phase2_analytics.js` — 57 assertions: pricing rules, aggregation math (tier/provider/purpose), window clamping, 1,000-row pagination, fail-soft contract, deterministic digest, escalation precision, offline `admin ai-stats` parsing, DB round-trip with self-cleanup.
- `test_phase3_resilience.js` — 54 assertions: chain order, missing-key skip, autonomy-gated reasoning binding, Anthropic→DeepSeek failover with `attempts`, breaker state machine + bypass, budget gating, budget math/alerts/dedupe, digest fallbacks/budget lines, `attempts` jsonb DB round-trip.
- `test_model_scout.js` — 52 assertions (v1.17.0): version classification, discovery/probe/benchmark with fetch stubs (zero live calls), model-plan guardrails, offline admin parsing, DB registry gate/rollout/canary/rollback, health-watchdog auto-rollback, proposal dedupe + deterministic digest, self-cleaning.

### 36.7 Phase roadmap
| Phase | Scope | Status |
| :--- | :--- | :--- |
| 0 | Router abstraction + usage telemetry (all DeepSeek) | shipped (v1.12.0) |
| 1 | Anthropic canary Tier-2 + escalation rules + concurrency cap | shipped (v1.12.1) |
| 2 | Telemetry analytics + Superadmin AI digest + escalation precision tuning + `.env` standards | shipped (v1.13.0) |
| 3 | Multi-provider failover chain + circuit breakers + Tier-3 autonomy binding + budget guardrails | shipped (v1.14.0) |
| 4 | CI Cline model parameterization + weekly cost/latency report | planned |

### 36.8 Governance rule
Every new LLM call must pass a `purpose` from `AI_PURPOSES`; provider/model changes go through `aiClient.js` only; telemetry must never be bypassed. Tier-2 promotion is deterministic (`classifyIntentTier`) with exported `ESCALATION_RULES` thresholds, and premium-provider failures must always fall back to DeepSeek. `getAiUsageSummary()` is the only analytics aggregator and must stay fail-soft and provider-free. Provider chains are built only by `buildProviderChain()`; DeepSeek is always terminal and never breaker-blocked, and budget enforcement must stay cached + fail-open. Mirrored in `.clinerules` rules 20–22.


---

## 37. Telemetry-Driven Optimization & .env Standards — Phase 2 (v1.13.0)

### 37.1 Scope
Phase 2 closes the loop opened by the Phase 0/1 telemetry seam: `ai_usage_logs` is now queryable as a live cost/performance surface, exposed to the Superadmin over WhatsApp, and the deterministic Tier-2 escalation classifier is precision-tuned. `.env` and `.env.example` are standardized so routing, provider, telemetry, timeout and concurrency knobs are grouped and auditable. No new LLM call sites and no schema changes.

### 37.2 Analytics helper (`src/services/aiUsageLog.js`)
`getAiUsageSummary(supabase, hours = 24)` — fail-soft aggregate over a 1–168 h window (default 24 h):

| Field | Meaning |
| :--- | :--- |
| `totalRequests` / `okRequests` / `errorRequests` | call counts in the window |
| `successRate` / `errorRate` | 0–1 ratios (null for an empty window) |
| `avgLatencyMs` / `p50LatencyMs` | wall-clock latency (lower median for even samples) |
| `promptTokens` / `completionTokens` / `totalTokens` | provider-reported usage summed |
| `approxCostUsd` / `unpricedTokens` | approximate list-price cost; tokens with no pricing rule |
| `fallbacks` | legs after the first in `attempts` (v1.14.0) |
| `byTier` / `byProvider` / `byPurpose` | the same bucket metrics keyed by `0/1/2/3/unknown`, provider and purpose |
| `truncated` | true when the window exceeded the retention cap |
| `ok` / `error` | query outcome; failures return zeroed totals instead of throwing |

- Reads are paged at `AI_USAGE_PAGE_SIZE` (1,000, PostgREST's default max) up to `AI_USAGE_LOG_MAX_ROWS` (10,000) with a stable `created_at` + `id` ordering.
- `estimateAiUsageCostUsd(provider, model, promptTokens, completionTokens)` uses `AI_USAGE_COST_RULES` approximate public prices (USD / 1M tokens): `deepseek-chat` $0.27/$1.10, `deepseek-reasoner` $0.55/$2.19, Claude Sonnet $3/$15, Haiku $1/$5, Opus $15/$75, OpenAI fallback $2.50/$10. Informational only — never billing.
- Unknown providers/models return `null` pricing (the digest shows `n/a`), never a guessed figure.

### 37.3 Superadmin WhatsApp command
- Aliases: `admin ai-stats`, `admin ai stats`, `admin ai usage`, `admin ai telemetry`, `admin usage [Nh]` → intent `ADMIN_AI_STATS`.
- Deterministic regex pre-match (zero LLM calls); optional window `1–168 h` (default 24 h, clamped in both directions). The `admin_parse` fallback also recognizes the intent.
- `handleAiStatsCommand(supabase, hours)` renders a concise digest via `formatAiStatsReply()` — totals + success/error rate, avg/p50 latency, token volumes, approximate cost, per-tier and per-provider breakdowns and the top four purposes. Since v1.14.0 the totals also include fallbacks, and a budget line appears when `AI_DAILY_BUDGET_USD` is configured. No AI synthesis is used, so the digest costs zero tokens and can never fabricate telemetry.
- Routed inside `handleSuperadminFlow` after the 30-minute session gate; every invocation writes `ADMIN_AI_STATS` to `admin_audit_logs`. The command is listed in the default help reply.

---

### 37.4 Escalation precision tuning (`sakaAi.js`)
`ESCALATION_RULES` (exported, frozen) is the single source of truth for deterministic Tier-2 promotion:

| Rule | Value | Rationale |
| :--- | :--- | :--- |
| Long turn | `longTurnChars: 160` | multi-clause requests need conversational nuance |
| Fact-dense action | `minFactDigits: 3` + action verb | e.g. "Log fuel 3000 at 50350 km"; 2-digit turns were noisy |
| Deep-history why | `minHistoryTurns: 6` + why/explain/how come | root-cause questions only |

- `ACTION_VERB_RE` narrowed to `log|set|update|add|register|assign|transfer`; `request` and `complete` were removed because they promoted informational asks (e.g. "request a report") to the premium tier.
- Frustration, high-stakes and dispatch lexicons are unchanged.
- At release `ai_usage_logs` contained 0 rows (verified), so tuning is precision-first and validated by the canary matrix. `admin ai-stats` is the instrument for future data-driven threshold changes; thresholds are exported so tests and tuning stay aligned.

### 37.5 `.env` / `.env.example` standards
Canonical section order (both files):

`Server → Superadmin → Supabase → Paystack → Meta WhatsApp → Resend → Google Vision → AI Router: master kill switches → AI Router: tier & provider → AI Router: telemetry & retention → AI Router: timeout & concurrency → Sentinel & remediation`

- AI Router sections: kill switches (`PREMIUM_MODEL_ENABLED`, `AI_USAGE_LOGGING_ENABLED`); tier/provider (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `CONVERSATIONAL_PROVIDER`, `AI_MODEL_TIER_1/2/3`, `DEEPSEEK_MODEL`, `OPENAI_API_KEY`); telemetry/retention (`AI_USAGE_LOG_MAX_ROWS`, `AI_USAGE_TRIM_EVERY`); timeout/concurrency (`AI_TIMEOUT_MS`, `AI_TIMEOUT_MS_PREMIUM`, `AI_PREMIUM_MAX_CONCURRENCY`).
- Section banners are ASCII (`# ===` / `# ----`) so the files survive any encoding/editor.
- Every optional knob documents its default and stays commented out; kill switches (`PREMIUM_MODEL_ENABLED`, `REMEDIATION_AUTONOMY`) are **off** in the template.
- `.env` is git-ignored (values preserved during reordering); `.env.example` is committed with placeholders only. Unknown/legacy keys are preserved in a trailing section, never dropped.

### 37.6 Files, tests & operations
- `src/services/aiUsageLog.js` — `getAiUsageSummary`, `estimateAiUsageCostUsd`, `AI_USAGE_COST_RULES`, window/pagination constants.
- `src/services/superadmin.js` — `ADMIN_AI_STATS` regex/AI parsing, `handleAiStatsCommand`, `formatAiStatsReply`, routing + audit.
- `sakaAi.js` — `ESCALATION_RULES` + narrowed `ACTION_VERB_RE`.
- `test_phase2_analytics.js` — 57 assertions (offline + self-cleaning DB round-trip).
- `test_model_router.js` — environment-independent premium baseline (unit suites never inherit the local `.env` kill switch).
- `test_superadmin.js` — end-to-end `admin ai-stats` digest + `ADMIN_AI_STATS` audit assertion.
- Targeted verification: `node scripts/run_tests.js test_model_router.js test_phase1_canary.js test_phase2_analytics.js test_superadmin.js test_agent_training.js`.
- Operate: `adminstart` → `admin ai-stats` (24 h) or `admin usage 48h` (custom window) → `adminstop`.

---

---

## 38. Resilient Multi-Provider Failover, Circuit Breakers & Budget Guardrails — Phase 3 (v1.14.0)

### 38.1 Ordered failover chain
Every LLM turn still starts at `chatCompletion()`; Phase 3 replaces the ad-hoc candidate list with `buildProviderChain(routing, { budgetExceeded })`:

| Route | Chain |
| :--- | :--- |
| Tier 1 (router, front conversations) | Sonnet-first (`AI_MODEL_TIER_1_ANTHROPIC` → `AI_MODEL_TIER_2` → Sonnet default) → OpenAI GPT-4o when keyed → DeepSeek (`AI_MODEL_TIER_1` → `DEEPSEEK_MODEL` → `deepseek-chat`) |
| Tier 2 (conversational) | primary `CONVERSATIONAL_PROVIDER` → the other premium provider (OpenAI or Anthropic) → DeepSeek |
| Tier 3 (reasoning) | `AI_REASONING_PROVIDER` (DeepSeek default / Anthropic Opus opt-in) → DeepSeek |
| explicit `model` | that provider/model → DeepSeek fallbacks |

- Premium legs are included only when their API key exists; missing keys are recorded as `skipped_missing_key`.
- `AI_PREMIUM_MAX_CONCURRENCY` still caps in-flight Anthropic calls; overflow is recorded as `skipped_concurrency` and falls through to the next leg.
- **Invariant:** DeepSeek is always the terminal leg and is never skipped, never budget-gated and never breaker-blocked. No single provider can brick a conversation.

### 38.2 Circuit breakers
Per-provider, in-memory, fixed-cooldown breakers in `aiClient.js`:
- `AI_CB_FAILURE_THRESHOLD` (3) failures within `AI_CB_WINDOW_MS` (60 s) open the breaker for `AI_CB_OPEN_MS` (30 s).
- **Billing/auth failures skip the ladder (v1.24.2).** `isBillingError()` recognises 401/402/403 plus quota/credit 429s ("no credits remaining", `insufficient_quota`, billing, payment required, revoked key) and `recordProviderOutcome(provider, false, now, { billing: true })` opens the breaker on the FIRST failure for `AI_CB_BILLING_OPEN_MS` (30 min). Rate-limit 429s and timeouts stay on the transient ladder.
- Any success resets the failure window; cooldown expiry resets the breaker (no half-open probing), so a topped-up provider is picked up automatically on the next turn after the window.
- While open, the provider is omitted from the chain and logged as `skipped_circuit_open`; DeepSeek is exempt.
- Helpers: `isProviderCircuitOpen()`, `recordProviderOutcome()`, `isBillingError()`, `resetProviderBreakers()` (tests/ops).

### 38.3 Tier-3 reasoning binding (autonomy-gated)
- `resolveTier()` Tier 3 resolves provider = `AI_REASONING_PROVIDER` and model = `AI_MODEL_TIER_3`; when `AI_MODEL_TIER_3` is unset the default is `deepseek-reasoner` **only** while `REMEDIATION_AUTONOMY=on`, otherwise `deepseek-chat` (prior behaviour).
- `AI_REASONING_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` binds Claude Opus-class models through the existing fetch adapter, with DeepSeek failover.
- Tier-3 calls use `AI_TIMEOUT_MS_REASONING` (45 s) because they are background-only (Sentinel diagnosis, remediation synthesis, Horizon, prompt refinement). User-facing tiers keep their existing timeouts.
- No call-site changes: every Sentinel/remediation purpose was already tagged Tier 3.

### 38.4 Budget guardrails & alerts
- `AI_DAILY_BUDGET_USD` (unset/0 = **disabled**) caps approximate rolling-24 h spend, computed from `getAiUsageSummary()` list prices.
- Enforcement: `installAiBudgetGuard(supabase)` wires `aiClient.setBudgetGuard()`; the guard is consulted only for **Tier-2** chain construction, cached as a promise for 60 s (concurrent turns share one query), and **fail-open** — a telemetry outage never blocks a conversation. Over-budget premium legs are logged as `skipped_budget` and DeepSeek serves the turn.
- Alerts: `maybeSendAiBudgetAlert()` (superadmin.js) fires once per threshold per Nairobi day at `AI_BUDGET_ALERT_PCT` (80%) and 100%, via WhatsApp + email (injectable senders for offline tests), deduped through `system_config.ai_budget_alert_<pct>_<YYYY-MM-DD>` and audited as `AI_BUDGET_ALERT`. `index.js` checks every 5 minutes; notification-only (enforcement is the chain builder).
- `admin ai-stats` adds `• Fallbacks: N` and, when a budget is configured, `• Budget: $spent / $cap (pct%)`.

### 38.5 Telemetry & `.env` delta
- `ai_usage_logs.attempts` (`jsonb`) stores the ordered legs per outcome; `ensureAiUsageLogsTable()` detects and adds the column on legacy tables (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`). The one-row-per-turn contract is preserved — no per-leg row spam.
- `getAiUsageSummary()` exposes `fallbacks` (legs after the first), aggregated across the window and per bucket.
- `.env` / `.env.example` gain a `FAILOVER, CIRCUIT BREAKERS & BUDGET` block: `AI_CB_FAILURE_THRESHOLD`, `AI_CB_WINDOW_MS`, `AI_CB_OPEN_MS`, `AI_CB_BILLING_OPEN_MS` (v1.24.2), `AI_REASONING_PROVIDER`, `AI_MODEL_TIER_2_OPENAI`, `AI_TIMEOUT_MS_REASONING`, `AI_DAILY_BUDGET_USD` (0 = off in the template), `AI_BUDGET_ALERT_PCT`. The TIMEOUT & CONCURRENCY block gains `AI_TIMEOUT_MS_FALLBACK` and `AI_CHAIN_BUDGET_MS` (v1.24.2).

### 38.6 Files, tests & operations
- `src/services/aiClient.js` — `buildProviderChain`, breaker registry, budget seam, provider-aware tier models, `attempts` emission, reasoning timeout.
- `src/services/aiUsageLog.js` — `attempts` persistence/self-migration, `fallbacks`, `computeAiBudgetStatus`, `checkAiDailyBudget`, `installAiBudgetGuard`.
- `src/services/superadmin.js` — `maybeSendAiBudgetAlert`, digest fallback/budget lines.
- `src/workers/remediation.js` — `getConfigValue` / `setConfigValue` exported for alert dedupe.
- `index.js` — budget-guard install + 5-minute alert ticker.
- `test_phase3_resilience.js` — 54 assertions, zero live network (fetch stub + OpenAI key cleared), DB round-trip self-cleans.
- Regression: `node scripts/run_tests.js test_model_router.js test_phase1_canary.js test_phase2_analytics.js test_phase3_resilience.js test_agent_training.js test_remediation_pipeline.js`.
- Operate: `admin ai-stats` shows fallbacks + budget; set `AI_DAILY_BUDGET_USD` to activate the cap and alerts.

---

_End of document — v1.14.1._



---

## 39. Subscription, Pricing & Trial Engine (v1.15.0)

### 39.1 Tier matrix — single source of truth
`src/services/subscriptionTiers.js` is the ONLY tier registry. Every service, route, prompt and test reads it; nothing re-declares limits.

| Tier | Cars | AI | Reports | Driver/compliance | Price (USD) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `free` | 1 | Tier 1 only | 1 / Nairobi month | ✗ | $0 |
| `solo_pro` | 1 | Tiers 0–3 | Unlimited | ✓ | 7.99 / 67.12 yr |
| `team_fleet` | 3 | Tiers 0–3 | Unlimited | ✓ | 19.99 / 167.92 yr |
| `growth` | 5 | Tiers 0–3 | Unlimited | ✓ | 29.99 / 251.92 yr |
| `fleet_command` | 5 + add-ons | Tiers 0–3 | Unlimited | ✓ | 29.99 base + 4.99 / extra car (41.92 yr) |

- Intervals: `monthly` | `annual` for every paid tier.
- Legacy aliases: `solo`/`pro` → `solo_pro`; `scale`, `fleet_starter`, `fleet_scale`, `enterprise`, `unlimited` → `fleet_command`.
- `getEffectiveVehicleLimit(tier, addonQuantity)` is the only capacity formula.

### 39.2 Entitlement engine (`src/services/subscriptions.js`)
- `getEntitlements({ supabase, ownerId, profile })` → `{ tierKey, isPaid, isTrial, trialDaysLeft, addonQuantity, effectiveVehicleCapacity, maxAiTier, reportsPerMonth, reportsUsedThisMonth, driverAssignment, complianceTracking, cancelAtPeriodEnd, currentPeriodEnd, … }`.
- Cached for `SUBSCRIPTION_CACHE_MS` (60 s); every subscription write calls `invalidateEntitlements(ownerId)`.
- Lazy downgrade: a paid tier past its access window is downgraded to Free on read (data preserved, excess vehicles paused).
- `evaluateVehicleCapacity()` → Simple Rule R1 decision (includes add-on pricing).
- `getReportQuota()` / `recordReportUsage()` → `usage_counters` keyed by the Nairobi month (`YYYY-MM`).
- **AI clamp:** `resolveTier(purpose, { tier, maxTier })` in `aiClient.js` clamps to `maxTier`, so Free (`maxAiTier = 1`) can never reach Tier-2/3 premium legs even with `PREMIUM_MODEL_ENABLED=on`. Background/Sentinel purposes omit `maxTier` (system, not user-facing). `processSakaMessage(..., { maxAiTier, ownerId, planSummary })` threads the clamp + telemetry attribution per turn.

### 39.3 Paystack billing (owner-centric, recurring)
- Subscriptions belong to `profiles.id`. `subscriptions` is the event-sourced ledger (one row per Paystack subscription code); `profiles` keeps the fast-lookup cache.
- `initializePaystackCheckout({ planCode, amountUSDOverride, couponCode, addonQuantity, metadata })` → recurring when a plan code is configured, otherwise the legacy one-time charge (the webhook still activates the tier).
- Plan codes resolve from env: `PAYSTACK_PLAN_<TIER>_<MONTHLY|ANNUAL>_<USD|KES|NGN|ZAR>`; blank codes degrade to one-time checkout.
- `handlePaystackEvent()` is the ONLY webhook state machine and is idempotent on `paystack_webhook_events.event_id`:

| Event | Effect |
| :--- | :--- |
| `subscription.create` | tier/interval/period set, ledger row upserted, trial → `CONVERTED`, WhatsApp confirmation |
| `invoice.create` / `invoice.update` (paid) | period rolls forward, status `ACTIVE`, trial → `CONVERTED` |
| `invoice.payment_failed` | status `PAST_DUE` + card-update nudge; access grace = `SUBSCRIPTION_GRACE_DAYS` (3) |
| `subscription.disable` | period still open → `CANCELING`; else downgrade to Free |
| `subscription.not_renew` | `CANCELING` (cancel at period end) |
| `charge.success` `type=fleet_addon` | `addon_quantity += quantity`, tier → `fleet_command`, Paystack quantity updated when a code exists |
| `charge.success` `target_tier` (legacy) | one-time activation path (no plan configured) |
| `charge.success` `passbook_transfer_fee` | handled by the legacy branch in `index.js` |

- Mid-cycle cancellation (`cancelSubscription`) uses `disablePaystackSubscription` when the email token is stored, otherwise marks `CANCELING` locally. Trials cancel immediately (nothing was billed). `resumeSubscription` re-enables.

### 39.4 Trial engine (`src/services/trialEngine.js`)
- **30 days** (`TRIAL_DAYS`, clamped 7–90), one trial per owner lifetime (`profiles.trial_used_at`), **no card at start** — `startAccountTrial()` makes zero Paystack calls and sets `profiles.subscription_status='TRIALING'` with full paid entitlements.
- `trial_sessions` is the funnel ledger: `ACTIVE → EXTENDED → CONVERTED | EXPIRED | CANCELLED`, with activation data and one-shot nudge timestamps.
- **Activation ("Aha!") — strictly three events:** `vehicle_registered` (vehicle + passbook), `expense_logged`, `report_generated`. Reminders are engagement metrics only and NEVER activate.
- On first activation: `ACTIVATE20-XXXX` coupon (20% off first cycle, 7-day TTL) is issued and delivered by the sweep (deterministic copy).
- **Nudge lifecycle** (`runTrialLifecycleSweep`, 15-min tick in `index.js`): activation reward → T+7d nudge if still un-activated → optional T−14d midpoint (`TRIAL_CONVERSION_LADDER=on`) → T−3d value digest (counts + ≈hours saved + localized price + checkout URL) → T−24h urgent → T−0 expiry. Each stage fires exactly once.
- **Expiry:** trial → `EXPIRED`, account → Free, excess vehicles → `PAUSED` (never deleted), owner prompted to `KEEP_VEHICLE`. The existing 15-day winback worker still fires afterwards.
- **Extensions:** `account_trial_extension` coupons only; cumulative lifetime capped by `TRIAL_MAX_TOTAL_DAYS` (45); nudges re-arm after an extension.
- **Funnel:** `getTrialFunnelStats()` + `admin trial-stats [Nd]` (deterministic, audited `ADMIN_TRIAL_STATS`).
- The legacy VIN-bound asset trial is **retired** (§11.1): trials, subscriptions, extension coupons and quotas bind to the owner account only. `vin_registry` records provenance, never trial state.


### 39.5 The "Simple Rules" engine
| Rule | Behaviour |
| :--- | :--- |
| **R1 Add vehicle mid-cycle** | Within capacity → instant, no billing change. Over capacity → block + next-tier checkout; on Fleet Command → per-vehicle add-on checkout (`type=fleet_addon`), slot activates on payment. |
| **R2 Vehicle transfer** | Seller unlinks → slot freed, **no mid-cycle refund** (capacity retained to renewal). Buyer over capacity → transfer paused at `PENDING_BUYER_UPGRADE` with a 24 h OTP window; upgrade link sent; retry completes the handover. Capacity is re-evaluated before the vehicle re-anchors. |
| **R3 Cancellation** | `subscription_status='CANCELING'` + `cancel_at_period_end`; full access until the paid period ends (no grace for cancellations). Trials cancel immediately. |
| **R4 Expiry / downgrade** | Tier → Free, `addon_quantity=0`, subscription codes cleared, excess vehicles → `PAUSED` (ordered by recent activity, first stays active), `KEEP_VEHICLE` prompt. Nothing is deleted; passbook tokens intact. |
| **R5 Report quota** | Free = 1 `REQUEST_REPORT` per Nairobi month (`usage_counters`); further requests return the upgrade checkout. Paid = unlimited. `QUERY_FLEET_SUMMARY` stays free. |

### 39.6 Schema (migration: `npm run migrate:subscriptions`)
- `subscriptions` — ledger: `owner_id, plan_code, tier, interval, status, quantity, addon_quantity, paystack_subscription_code (unique), paystack_customer_code, paystack_email_token, current_period_start/end, trial_end_at, canceled_at`.
- `paystack_webhook_events` — `event_id UNIQUE` idempotency ledger with the raw payload.
- `usage_counters` — `(owner_id, period_key)` PK, `report_count`, `last_report_at`.
- `trial_sessions` — `owner_id UNIQUE`, `tier, interval, status, started_at, ends_at, activated, activated_at, activation_events jsonb, coupon_code`, one-shot nudge timestamps, `checkout_started_at`, `converted_at`, `paystack_subscription_code`.
- `profiles` += `trial_used_at, addon_quantity, cancel_at_period_end, subscription_period_start/end, downgraded_at, paystack_email_token`.
- `coupons` += `discount_amount, discount_currency, applies_to_tier, applies_to_interval, redeemed_at, redemption_type` (+ `applicable_to='account_trial_extension'`).
- `passbook_transfers` += `blocked_reason` (buyer-upgrade gate).
- `ai_usage_logs` += `owner_id` (per-owner AI attribution; trail engagement + T−3 digest).
- Constraints accept canonical + legacy tier keys and `CANCELING`/`EXPIRED` statuses. Boot calls `ensureSubscriptionSchema()`; the migration also remaps legacy tiers once.

### 39.7 Skills, intents & training
- New intents: `VIEW_SUBSCRIPTION`, `UPGRADE_SUBSCRIPTION`, `CANCEL_SUBSCRIPTION`, `MANAGE_ADDONS`, `KEEP_VEHICLE`, `EXTEND_TRIAL` (registry 39 intents).
- New quiz flows: `subscription_upgrade`, `cancel_subscription`, `keep_vehicles` (registry 21 flows) + deterministic one-turn handling in `src/routes/whatsapp.js` (`maybeHandleSubscriptionTurn`).
- `sakaAi.js` core prompt §7c teaches: engine-owned prices, no-card trial, annual-first conversion, no refunds. `test_agent_training.js` (50 assertions) asserts every intent/flow/section stays trained.

### 39.8 Environment knobs
- `TRIAL_DAYS` (30; 7–90), `TRIAL_MAX_TOTAL_DAYS` (45), `TRIAL_ACTIVATION_COUPON_PCT` (20), `TRIAL_ACTIVATION_COUPON_TTL_DAYS` (7), `TRIAL_ACTIVATION_NUDGE_HOURS` (168), `TRIAL_CONVERSION_LADDER` (off), `TRIAL_MIDPOINT_COUPON_PCT` (15).
- `SUBSCRIPTION_CACHE_MS` (60000), `SUBSCRIPTION_GRACE_DAYS` (3).
- `PAYSTACK_PLAN_<TIER>_<INTERVAL>_<CURRENCY>`, `PAYSTACK_CALLBACK_URL`, `PUBLIC_PRICING_URL`.

### 39.9 Files & tests
- `src/services/subscriptionTiers.js` — frozen matrix, aliases, pricing, plan codes.
- `src/services/subscriptions.js` — entitlements, checkout, webhook state machine, Simple Rules, quotas, formatting.
- `src/services/trialEngine.js` — trial lifecycle, activation, coupons, sweep, funnel digest.
- `src/db/subscriptionSchema.js` + `scripts/run_subscription_migration.js` — idempotent DDL + legacy remap.
- `src/services/paystack.js` — matrix-derived view, plan/coupon checkout, subscription disable/enable/update.
- `src/services/coupons.js` — `validateCouponForCheckout` (percent/flat/scoping) + redemption.
- `test_subscription_billing.js` — 73 assertions (matrix, entitlements, AI clamp, quotas, coupons, webhook state machine, downgrade, add-ons) — mock Supabase, zero network.
- `test_trial_engine.js` — 68 assertions (30-day window, 3-point activation incl. reminder negative control, once-per-lifetime, extension cap, nudge one-shot, expiry → PAUSED, funnel) — mock Supabase, zero network.
- `scripts/mockSupabase.js` — shared in-memory Supabase mock (also enforces `paystack_webhook_events.event_id` uniqueness).

### 39.10 Governance
Subscription math is engine-owned and never AI-generated. No autonomous remediation may edit `paystack.js`, the tier registry, the trial engine or the schema (forbidden-path guard). Migration + schema changes require a human Cline session. `.clinerules` rules 23–28 mirror this section.

---

## 40. v1.16.0 — Compliance Separation, Account-Only Binding & Conversational Speed

### 40.1 Owner driver profiles (every owner, immediately)
- On `vehicle_registration` completion (quiz_v2 + legacy paths) Saka sets `profiles.driver_profile_pending = true` and **immediately starts the `driver_onboarding` flow** for the owner with the verified email prefilled.
- The owner's minimum compliance is **skippable** (`ctx.driverSelfProfile` → optional field); a gated driver's minimum is mandatory. `profiles.driver_profile_completed_at` is stamped when email + minimal compliance are valid.
- `driverOnboardingFields()` skips anything already on file (email/OTP, valid minimal, valid additional) using the live gate state — this fixes the "Already told you earlier" friction cluster.
- The `"driver profile"` command routes deterministically into the flow; idle discovery nudges owners whose profile is pending.

### 40.2 Vehicle compliance vs driver compliance (permanent separation)
- **Vehicle** → `vehicle_compliances` + `VEHICLE_COMPLIANCE_CATALOG` (`src/services/vehicleCompliance.js`): insurance (policy + expiry), inspection/MOT, road service licence (PSL), road tax, speed limiter, registration, emissions… region + asset filtered.
- **Driver** → `driver_compliances` + `COMPLIANCE_CATALOG` (licence, PSV badge, CPC, PDP, operator card).
- One paragraph can save several vehicle items: `parseVehicleComplianceParagraph()` slices per-item segments so numbers/dates never cross-contaminate. `submitVehicleCompliance()` upserts the ledger row, dual-writes `vehicles.insurance_expiry`/`inspection_expiry`, and creates the linked expiry reminder (`subject_type='vehicle_compliance'`).
- Registration seeds vehicle compliance rows for insurance/inspection through the same engine.
- Migration: `npm run migrate:vehicle-compliance` (table + indexes + one-time backfill).

### 40.3 Paragraph intake
- `MAX_EXTRACTION_TEXT_CHARS` is 1200. Quiz turns enter **paragraph mode** (≥80 chars or ≥2 sentence breaks with ≥2 remaining fields): `extractWithAI()` reads all remaining fields first; strict parsing still applies to the current field. `applyTextExtraction()` now captures a plate embedded in a paragraph.

### 40.4 Account-only commercial binding (deep-audit outcome)
- The v1.15.0 engine was correct but the legacy VIN trial still ran in parallel (phantom vehicle clock, orphan `EXT30` coupons, duplicate trial/winback workers). v1.16.0 removes it (see §11.1): provenance-only `vin_registry`, no registration coupon, account-bound `ACCT30` offers, one lifecycle worker (`runTrialLifecycleSweep` now also dispatches account offers + the 15-day winback), `coupons.owner_id` (+ phone backfill via `npm run migrate:trial-unbind`), and a single trial-redemption path (`apply_coupon` → `applyAccountTrialExtensionCoupon`).

### 40.5 Background follow-up lane (Saka never stalls)
- `pending_followups` + `src/services/followups.js`: slow jobs (fleet reports) reply instantly with a deterministic ACK (`followUpAckText`, zero AI tokens) and are executed by a 30s worker, which sends the result as a follow-up while the user keeps chatting. Enqueue failure falls back to the synchronous path.
- Migration: `npm run migrate:followups`.
- Existing wins retained: quiz turns skip the DeepSeek intent call; question renders are cached; the webhook ACKs before processing.

### 40.6 Self-healing pipeline repair (root cause + operational prerequisite)
- **Root cause found:** the legacy `.github/workflows/remediation.yml` was rejected by GitHub Actions (every push produced a 0-job failure run, the workflow list showed the file path instead of its name, and `repository_dispatch` never spawned a run). Two invalid constructs: a **UTF-8 BOM** on line 1 and an artifact `path` entry ending in `/` (`remediation/work-orders/`). Both are fixed by the BOM-free, glob-path rewrite.
- **Split into two workflows:** `.github/workflows/remediation_pipeline.yml` (plan) and `.github/workflows/remediation_execute.yml` (execute). **Verified end-to-end on 2026-10-30:** `workflow_dispatch` accepted (204), the plan job completed every step (secrets gate → audit context → Cline CLI → Cline draft → submit) and wrote the first-ever proposal `FIX-2026-10-30-01` (`PENDING_APPROVAL`) to `remediation_proposals`. No `REMEDIATION_DISPATCH_UNVERIFIED` alerts fired.
- **Operational prerequisite (human action):** the repository must provide the Actions secrets `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPERADMIN_PHONE`, `SUPERADMIN_EMAIL`, `META_PHONE_NUMBER_ID`, `META_WHATSAPP_TOKEN`, `RESEND_API_KEY`, `DEEPSEEK_API_KEY`. They may be **repository secrets** or **environment secrets** — environment-scoped secrets are only visible when the job declares `environment: Saka-Fleet-Staging` (both workflow jobs do since v1.16.0). The environment has no protection rules, so `repository_dispatch` runs start without manual approval. Without the secrets the plan job stops at `Check CI secrets` with an explicit error. Secrets can only be added with an admin token; the remediation PAT is deliberately least-privilege.
- **Runtime:** both jobs run on **Node 22** (the `@supabase/supabase-js` release line requires native WebSocket; Node 20 fails with `Node.js detected but native WebSocket not found` at the first Supabase call).
- **Watchdog:** `checkRemediationDispatchVerification()` (15-min tick) raises `REMEDIATION_DISPATCH_UNVERIFIED` + a Superadmin WhatsApp alert (once per signature) whenever a dispatched plan produces no proposal within 20 minutes.
- Superadmin action discovery now enumerates the FULL command surface (exhaustive render, zero truncation).

### 40.7 Migrations & tests
- `npm run migrate:trial-unbind`, `migrate:driver-profile`, `migrate:vehicle-compliance`, `migrate:followups` (all idempotent; applied on release).
- Suites: `test_trial_unbind.js`, `test_vehicle_compliance.js`, `test_driver_profile_onboarding.js`, updated `test_new_features.js`, `test_agent_training.js`.

---

## 42. v1.16.2 — OTP Loop Closure, Governance Hardening & Revenue Polish

### 42.1 OTP re-ask closure (human session, post-FIX-2026-10-30-01)
- **Same-message banking:** on the OTP turn, the licence/expiry pasted beside the code is captured deterministically (each remaining field's own parser) with an AI top-up only when strict parsing fails — Saka never asks for something already in the message.
- **"Already told you" recovery:** a compliance field asked while the user says *already / as I said / I already sent it* never pauses the quiz or re-asks blindly. The engine answers from the STORED record: valid → "on file … let's move on" (marks it answered); expired/invalid → names the expiry and asks once; nothing stored → one precise example.
- **Owner OTP skip:** an owner self-profile may reply *skip* on the email step (recorded as `emailSkipped`); a gated driver may not.

### 42.2 Governance hardening (closes the loophole the audit found)
- `remediation_proposals.approval_kind` (`standard` | `superadmin_override`). Accepting a sanitizer-blocked `NEEDS_MODIFICATION` plan now requires the explicit word **`override`**: `admin accept fix <CODE> override`. Without it the Superadmin is guided to `modify`/re-plan.
- `verifyProposalGate()` re-runs `sanitizeRemediationPlan` on the **stored** plan before `EXECUTING`; a blocked plan can only execute under an audited override.

### 42.3 Friction metric integrity
- `evaluateConversationalFriction` dedupes by `(user_phone, friction_type, transcript snippet, 24h)`: one frustrating session counts and patches once, so health scores are honest and AI patches are not re-billed.

### 42.4 Revenue
- **Cancel save-offer:** monthly payers asking to cancel first see the annual switch at the engine's own `getAnnualDiscountPercent()` figure (one word to accept, YES still cancels). Trials skip the offer.
- **Annual-first prompts:** the report-quota upsell now states the engine's annual saving.
- `TRIAL_CONVERSION_LADDER=on` (T−14 midpoint nudge + coupon) is the new template default.

### 42.5 Leaner & faster
- **Action discovery cached** per role+commands+locale (`ACTION_DISCOVERY_CACHE_MS` 15 min, max 200) — the most common free-chat turn costs zero tokens.
- **Deterministic passbook snapshot:** *"passbook details"* returns plate(s), odometer, plan/trial line and the last 5 expenses instantly with zero AI.

### 42.6 Professional operations
- `npm run health` — one read-only audit: stateless suites, workflow lint (BOM / non-ASCII / trailing-slash artifact paths), git state, pipeline + DB snapshot.
- `README.md` + `.editorconfig` (LF, UTF-8, no BOM) so the CI-file corruption class cannot recur.

---

## 43. v1.16.3 — Revenue Recovery, Re-engagement & Governance Polish

### 43.1 PAST_DUE dunning ladder
- `processPastDueDunning()` runs inside the same 15-minute `runTrialLifecycleSweep`: **T+1 and T+3** deterministic reminders (two per failed renewal, deduped by `profiles.past_due_notice_count` / `past_due_notified_at`), each carrying the engine's own Paystack renewal link (`initializePaystackCheckout`). Counters heal to 0 automatically once the account is no longer `PAST_DUE`.
- Grace window = `SUBSCRIPTION_GRACE_DAYS` (default 3). Copy never invents an amount and states that extra vehicles are paused, never deleted.
- Migration: `npm run migrate:dunning` (`past_due_notified_at`, `past_due_notice_count`, `reengage_nudged_at`, partial PAST_DUE index).

### 43.2 14-day silence re-engagement
- `processSilentReengagement()` finds owners whose last `chat_transcripts` row is **13–15 days old**, who own ≥1 active vehicle, are not the Superadmin phone and have not been nudged (`profiles.reengage_nudged_at`). One deterministic, zero-token tip per owner (one expense log, or "passbook details"); capped at 10 sends per sweep.

### 43.3 Execute-environment protection (manual step)
- The remediation PAT is deliberately least-privilege: `PUT /repos/.../environments/Saka-Fleet-Staging` returns **403**. Required reviewers must be enabled once in the GitHub UI: **Settings → Environments → `Saka-Fleet-Staging` → Required reviewers → add the Superadmin**. Plan drafting stays automatic; only the execute leg waits for the human approval.

### 43.4 Tests & ops
- `test_dunning_reengagement.js` (15 assertions: T+1/T+3, two-notice cap, counter healing, silence window, dedupe, vehicle/superadmin guards) is part of `npm run health`, which also reports `past-due accounts`.

---

## 44. v1.16.4 — Driver Unassignment Notices & Free-Tier Welcome Trial

### 44.1 Driver unassignment notices (WhatsApp)
- The release is centralised in `vehicles.js`; the driver phone is snapshotted **before** the row is cleared (metadata `assigned_driver_phone` → profile fallback).
- `notifyDriverUnassigned()` queues a `driver_unassigned` job on the existing **follow-up lane** (`pending_followups`, 30s worker) — no new workers or tables. Reasons: `owner` (manual unassign), `vehicle_deleted` (soft delete), `compliance` (3 expired minimal submissions cancelled the assignment).
- Covered call sites automatically: the `unassign_driver` quiz flow, the legacy `unassign driver` handler, `deleteVehicle()`, and `recordInvalidMinimalSubmission()`. Fail-soft: the release never depends on messaging.

### 44.2 Free-tier Welcome Trial (one per account lifetime)
- Every **new** owner account starts a full-featured trial at registration:
  - `startWelcomeTrial()` → `startAccountTrial({ tierKey:'solo_pro', interval:'monthly', source:'welcome' })`.
  - During TRIALING, `getEntitlements()` already grants **all features** (Tiers 0–3 AI, unlimited reports, driver assignment, compliance tracking) — zero entitlement changes.
  - Initiation is idempotent (`profiles.trial_used_at`): a second trial is impossible; existing accounts are NOT backfilled.
- **Lapse = Free:** the existing sweep (`EXPIRED → downgradeToFree`) returns the account to Free and PAUSES excess vehicles (never deletes). Upgrading before lapse converts the trial via `subscription.create`; upgrading after lapse goes straight to checkout.
- Registration hooks: `quizEngine.persistVehicleRegistration` (with `trialDays`/`trialEndsAt` facts) and legacy `onboarding.saveVehicleAssetRecord`; `recordActivationEvent(VEHICLE_REGISTERED)` fires on both.
- Schema: `npm run migrate:welcome-trial` (`trial_sessions.source` + index). `admin trial-stats` now reports **welcome vs upgrade** trial counts.
- Governance: this is the SAME one-time trial — there is no second "upgrade trial" once the welcome trial is consumed (rule 26 updated).

### 44.3 Tests
- `test_followups.js` (12 assertions: queueing from unassign + delete, metadata/profile phone resolution, worker delivery, compliance reason) and extended `test_trial_engine.js` (welcome source, solo_pro tier, lifetime stamp, second-trial block). Both run inside `npm run health`.




---

## 41. v1.16.1 — Single-Contract Driver-Profile OTP Step (remediation FIX-2026-10-30-01)

Every path that renders the driver-profile email OTP now shares ONE contract, closing the `friction_user_frustration` repeat-ask cluster (18/19 rolling-window events: "Great, we're nearly there… enter the 6-digit verification code we just sent to your email").

### 41.1 The OTP step, one contract
- `otpQuestionField(target = null)` names the destination mailbox and the escape hatches ("we emailed it to {email} — reply with the 6 digits, or \"resend\" … or \"change email\" …") and states that one message may carry both the code and the licence details. **The label stays exactly `6-digit verification code`** — it is the question-cache key and is asserted by the training/flow suites. Parse (`\b\d{6}\b`) and validate (`^\d{6}$`) are untouched, as is the 10-minute expiry.
- `driverOnboardingFields()` builds the OTP field through `otpQuestionField(profile.email || null)` and gives the email field a single-turn hint that a 6-digit code follows and that the regional minimal compliance item (`catalog.minimal.label`) comes next. A verified owner still gets no email/OTP field (§40.1).
- `sendQuizOtp()` records `state.otpDispatch = { status: 'sent' | 'failed', target, purpose, attemptedAt }` (plus the existing `state.otpError`), resets `state.otpDispatchAttempts`, and never logs or echoes the code.
- `askOtp()` composes a deterministic turn note: quiet counter (`Verifying your email — code check n of 3`), the mailbox the dispatch actually reached (`otpDispatch.target` → `otp.target`), a failed-dispatch line ("the last email could not be sent — reply \"resend\" or tell me a different address"), the existing branch notes (expired/mismatch), and the next step. The note is data-bearing but secret-free, and because `renderQuizQuestion()` only serves the cache when `turnNote` is null, every re-ask is unique while the cached success path stays data-free.

### 41.2 Idempotent OTP turns
- An already-verified code (`state.otpVerified` + matching digits) is never re-asked: the turn acknowledges and renders the next question, still running `applyExtraction()`/`applyTextExtraction()` so licence number + expiry pasted next to the code ("code 123456, licence D1234567 expires 2027-05-15") fill the following compliance field.
- The resend branch (`isResendRequest()`, also covers "send it again" / "resend it") is offered on every OTP turn — first ask, expired or mismatch. `handleAccountOtp()` and `handleAssignmentOtp()` share the same helper.
- `askCurrent()` no longer mints a second code when this flow already dispatched one: an unexpired `state.otp` is reused and the OTP hint names the known mailbox. A new code is sent only when the dispatch is missing, the code expired, or the destination email actually changed (`currentOtpTarget()`).

### 41.3 Escape hatch & composer contract
- `isChangeEmailRequest()` ("change email", "different email", "wrong email", …) on a pending OTP field re-asks **only** the email field, invalidating `state.otp` / `state.otpDispatch` / the counter so the next render explains the new destination. `detectFlowSwitch()` returns null for that pattern (it is an in-flow control, never a flow switch) and still never abandons `vehicle_registration`.
- `conversationEngine.renderQuizQuestion({ …, dispatchFailed })` gains a boolean FACTS flag (never a raw address, code or step target) and an instruction that states the current question once, forbids repeating an already-answered question, asks nothing beyond it, and phrases a failed dispatch with the resend / different-address offer.
- `sakaAi.js` §7d gains the matching operating rule (OTP is one wizard step: mailbox + 6 digits only, then the compliance item; accept resend/change email/owner skip and embedded codes; never reveal or invent a code; never claim verification before the engine confirms). `flowKnowledge.js` `driver_onboarding` `fields`/`rules` were updated in the same commit (rule 13 of `.clinerules`); the never-re-ask-on-file and owner-skippable/gated-mandatory rules are unchanged.
- Untouched: OTP verification strictness, code expiry, VIN immutability, the driver 1-to-1 gate and all subscription math. Description-only change — no migration, no schema write, no new env knob.
- Suites: `test_driver_profile_onboarding.js`, `test_agent_training.js`.

---

## 45. v1.17.0 — Model Watchdog & Self-Updating Model Pipeline

### 45.1 Purpose & agent boundary
Saka Fleet continuously watches for better LLM models that complement the app (e.g. DeepSeek V4.1 Flash → V4.1-Flash-1017) without ever risking the conversation. The **Model Watchdog** is Sentinel tooling: it discovers, benchmarks, proposes and (only with explicit approval) adopts. Saka never discusses or claims model updates; Sentinel never speaks to users; Cline remains the approved code executor.

### 45.2 Registry (data, not deploy)
- `public.ai_model_registry` — one row per provider model: `model_id`, family, version label, alias, `tier_slot` (`tier_1`/`tier_2`/`tier_3`), `status` (`discovered|benchmarked|active|standby|retired|rejected`), `traffic_split`, `capabilities`, `benchmark`, timestamps. A partial unique index enforces ONE active row per slot.
- `public.model_eval_runs` — every benchmark run (score, cases, latency, tokens, failures).
- Migration: `npm run migrate:model-registry`; idempotent boot ensure via `ensureAiModelRegistryTables()` + seed (stable `deepseek-chat` pointer active on `tier_1`, `deepseek-reasoner` discovered).
- **Adoption is a database flip** (`applyModelRollout`), so a model upgrade needs no deploy; the previous model becomes `standby` and `rollbackModel` reverts instantly. `AI_MODEL_TIER_*` / `DEEPSEEK_MODEL` env overrides always win over the registry (resolver seam in `aiClient.getTierModel`).

### 45.3 Scout cycle (weekly, opt-in)
`runModelScoutCycle()` (scheduled every `AI_MODEL_SCOUT_INTERVAL_HOURS`, gated by `AI_MODEL_SCOUT_ENABLED=off`):
1. **Discovery (zero tokens):** `GET /models` lists provider model IDs; new IDs enter as `discovered`.
2. **Research (optional):** when `AI_WEB_SEARCH_ENABLED=on` AND the probed model advertises `web_search`, one Tier-1 `model_research` call records release-note evidence on the candidate row (never config).
3. **Probe + benchmark:** JSON mode and web-search/fetch support are **verified** (never assumed); the deterministic 10-case suite covers intent triage, JSON contract, VIN/OTP boundaries, global dates and empathy-first tone. Results persist in `model_eval_runs`.
4. **Recommendation:** the highest-scoring `benchmarked` candidate above `AI_MODEL_MIN_BENCHMARK_SCORE` that beats the active model.
5. **Governance:** by default the scout creates an approval-gated `remediation_proposals` row (`category='ai_model_update'`, `PENDING_APPROVAL`) that rides the existing Superadmin gateway. `AI_MODEL_AUTO_ADOPT=on` may only start a canary (`<= AI_MODEL_MAX_CANARY_PCT`); full adoption is always human.

### 45.4 Approval & execution
- `admin models` — deterministic registry digest (active, candidates, pending model approvals, kill switches).
- `admin model scout` — force a cycle now.
- `admin model adopt <model_id> [split]` — direct Superadmin adoption (registry gate enforced; audited `ADMIN_MODEL_ADOPT`).
- `admin model rollback [tier_1|tier_2|tier_3]` — instant revert to standby.
- `admin accept fix <CODE>` on a model proposal applies the rollout directly (data change, no CI dispatch, no deploy) and marks the proposal `DEPLOYED` with `execution.mode='registry_rollout'`; `decline`/`modify` behave as usual. This path is intentionally independent of `REMEDIATION_AUTONOMY` (which governs autonomous CODE execution) but still requires an active Superadmin session and writes `admin_audit_logs`.
- Model work orders are constrained by `validateAiModelUpdatePlan` (allowlisted files, mandatory model suites, canary ceiling, documented rollback) and `verifyModelUpdateAgainstRegistry` (must resolve to a benchmarked row at submit **and** gate time); `scripts/remediation_ci.js` combines both verdicts.

### 45.5 Self-healing loop
`monitorModelHealth()` runs every 30 minutes: it compares the active model's error rate in `ai_usage_logs` against its standby over `AI_MODEL_HEALTH_WINDOW_HOURS`. A relative breach (`AI_MODEL_ROLLBACK_ERROR_RATE`×) or an absolute breach (`AI_MODEL_ROLLBACK_ABSOLUTE_ERROR_RATE`) with at least `AI_MODEL_ROLLBACK_MIN_SAMPLES` samples triggers an automatic rollback, an audited `MODEL_AUTO_ROLLBACK` row and a Superadmin WhatsApp alert. DeepSeek remains the terminal provider leg; the router never depends on the registry (fail-open to env/defaults).

### 45.6 Ops, files & tests
- `npm run model:scout` → `scripts/model_scout.js status|scout|adopt <model> [--split N]|rollback [slot]`.
- Files: `src/services/aiModelRegistry.js`, resolver seam + `model_benchmark`/`model_research` purposes + capability-gated `webSearch` in `src/services/aiClient.js`, scheduling/boot in `index.js`, guards in `src/workers/remediation.js` + `scripts/remediation_ci.js`, commands in `src/services/superadmin.js`, `scripts/run_model_registry_migration.js`, `scripts/model_scout.js`.
- Tests: `test_model_scout.js` (52 assertions, fetch-stubbed, self-cleaning), extended `test_model_router.js` (resolver precedence), `test_remediation_pipeline.js` (model plan guardrails), `test_agent_training.js` (tone + model identity), `test_db_reset_scope.js` (preserved registry).
- Env knobs: see §36.5 and the `MODEL WATCHDOG` section in `.env.example`. Kill switches default OFF.

### 45.7 Tone Compass & Mirror Engine (conversational voice)
The voice policy is data, not prose drift: `SAKA_TONE_COMPASS` in `flowKnowledge.js` renders into the core prompt and mirrors into `conversationEngine`. The classifier now emits `user_tone` (formal/casual/terse/verbose/neutral/frustrated/anxious/celebratory) and the runtime may supply `relationship_stage` (stranger/newcomer/regular/veteran) and `model_label`.
- **Compass poles:** Precision/Anchor (facts are sacred) · Empathy/Healer (acknowledge before instructing, one next step) · Efficiency/Arrow (shortest message that fully serves) · Warmth↔Professionalism/Weaver (mirror register within floors/ceilings).
- **Mirror matrix:** register, length, emotion (validate, never amplify), pace (fragmented vs power user) and relationship stage.
- **Situation matrix:** product error, user mistake, billing anxiety, compliance urgency, routine logging, onboarding, discovery, stalls, escalation.
- **Floors:** no sarcasm/shame; no empty reassurance; emoji situation-gated; no humour in money/legal/compliance; translation-proof sentences; unknown tone → calm professional warmth.
- **Honest self-reporting:** Saka states only the `model_label` supplied by the runtime (registry alias); otherwise it says the model is managed by Saka Fleet and never guesses a version.

---

## 46. v1.17.1 — Fuel Economy Engine (full tank vs top-up)

### 46.1 Why the old math was wrong
The legacy `calculateFuelConsumption` treated **every** fuel log as a full tank: `(odo[i] − odo[i−1]) / litres[i]` for every consecutive pair, averaged over all pairs and always labelled "Average Consumption". A routine top-up ("40 L, half tank") therefore attributed all distance since the previous log to those 40 L, swaying economy by 20–40%. "Full tank" existed only as free text in `notes` and was never stored or parsed.

### 46.2 Data model & capture
- `expense_logs.fill_type` (`'full' | 'partial' | null`). Migration `npm run migrate:fuel-fill` (`scripts/run_fuel_fill_type_migration.js`) adds the column + index and backfills legacy rows from notes (`full tank`/`brim` → full; `top-up`/`half tank`/`partial` → partial). Boot ensures it via `ensureFuelEconomySchema()`; staging provisioning includes it.
- Quiz `log_expense` asks **"Fill type: Full tank or a top-up?"** after fuel volume (skippable → null). Fully-specified one-liners (`Logged 30L fuel at 50350 km …`) still save instantly through the quick path; fill type is read from the text when present and otherwise Saka adds a one-line tip. Fuel-economy queries and vehicle switches are deterministically excluded from quiz starts.
- Classifier schema adds `fill_type`; the core prompt requests it only on `LOG_EXPENSE`.

### 46.3 The engine (`src/services/fuelEconomy.js`, pure)
- **Segments run between consecutive FULL fills:** `distance = odo[B] − odo[A]`, `litres = litres[B] + Σ(all fuel logged between A and B)`. Top-ups, unlabelled fills and even a full fill without an odometer are folded into the denominator. This is physically exact because the tank level is equal at both full fills, so every litre added in between was consumed over that distance.
- Weighted average = Σ segment distance ÷ Σ segment litres; latest full-to-full reported separately; cost/km, latest price/litre and spend derived from the same data.
- Guards: odometer regressions, segments shorter than `FUEL_ECON_MIN_SEGMENT_KM`, implausible economy (> `FUEL_ECON_MAX_PLAUSIBLE_KML`), missing litres, full fills lacking odometers (folded forward) and unlabelled fills (counted + warned). Every skip is reported, never silently averaged.
- No full-to-full pair yet → explicit **span estimate** (never labelled exact) with guidance to mark the next fill FULL; fewer than two usable logs → `NEEDS_MORE_DATA`.
- Current tank = distance since the last full + litres added since; never presented as economy.
- Canonical units: litres/km; display converts to gallons/miles/MPG. Currency comes from the caller (country context) — no hard-coded KES.
- `buildFuelEconomyReply()` renders the WhatsApp digest deterministically; the AI never does math.

### 46.4 Files, tests & knobs
- Files: `src/services/fuelEconomy.js` (engine, reply, schema ensure), `src/services/analytics.js` (thin DB wrapper; same `calculateFuelConsumption` signature plus `currency`), `src/services/quizEngine.js` (fill-type field + executor + routing guards), `src/routes/whatsapp.js` (quick-path fill type + tip + currency), `sakaAi.js`, `flowKnowledge.js`, `scripts/run_fuel_fill_type_migration.js`, `scripts/provision_staging_schema.js`, boot ensure in `index.js`.
- Tests: `test_fuel_economy.js` (47 assertions, pure math), `test_quiz_flow.js` (fill-type turn + routing guards), `test_agent_flow.js` (DB wrapper + one-line quick log), `test_agent_training.js` (`fill_type`, `full-tank`). `scripts/testCleanup.js` now also clears `chat_sessions` for test phones (stale quiz state).
- Knobs (defaults shown): `FUEL_ECON_MIN_SEGMENT_KM=20`, `FUEL_ECON_MAX_PLAUSIBLE_KML=80`, `FUEL_RATING_GOOD_KML=10`, `FUEL_RATING_EXCELLENT_KML=14`.

---

## 47. v1.18.0 — Saka Pro Reports, Report Access Lanes & Sonnet 5.5

### 47.1 Claude Sonnet 5.5 for conversations
Research against Anthropic's current lineup (Oct 2026): **Claude Sonnet 5.5** is "the best combination of speed and intelligence" — USD $2/$10 per MTok, 1M context, 128K output — the correct Tier-2 conversational model for WhatsApp. Opus 5.5 is for long-running knowledge work; Haiku 5.5 for high-volume routing; Fable 5.1 for demanding reasoning.
- Wired via `PREMIUM_MODEL_ENABLED=on` + `CONVERSATIONAL_PROVIDER=anthropic` + `AI_MODEL_TIER_2=claude-sonnet-5-5`; `DEFAULT_ANTHROPIC_TIER2_MODEL` updated.
- Free accounts remain clamped to Tier 1 (DeepSeek) by entitlements; trial/paid receive Tier 2 prose renders. DeepSeek stays the terminal failover leg (anthropic → openai → deepseek) with per-provider breakers, 15 s premium timeout, concurrency 2 and the daily budget guard.
- `AI_USAGE_COST_RULES` updated (Fable/Opus/Sonnet/Haiku current list prices) so `admin ai-stats` stays honest; smoke test: `node scripts/test_anthropic_connection.js`.
- **Temperature:** newer Claude models (Sonnet 5.5+) return HTTP 400 for `temperature`; `runAnthropicAttempt` omits it by default (opt in with `ANTHROPIC_TEMPERATURE_SUPPORTED=on` only for legacy models). Verified live through `chatCompletion()`.

### 47.2 Saka Apex PDF engine (`src/services/pdfEngine.js`)
Premium, deterministic, engine-only numbers:
- **Fonts (vendored OFL, offline):** Manrope (body), Barlow SemiBold (display), JetBrains Mono (figures) under `assets/fonts/`, Helvetica/Courier fallback. `useStandardFonts: true` renders a report with the built-in fonts (used by the test/QA suite to verify drawn text).
- **Palette (v1.29.0 Apex):** Deep Midnight Slate ink `#0F172A`, Tech Teal brand `#0EA5E9`, Emerald positive `#10B981`, Coral negative `#EF4444`, Amber warn `#F59E0B`, neutral panels `#F8FAFC`, hairlines `#E2E8F0`, plus per-report accents and semantic status colours. Money and meter figures use the mono face for tabular alignment.
- **Layout:** full-bleed cover (brand, title, period chips, licence-plate badge for vehicle-scoped reports, "prepared for" owner card, driver cards), KPI grid with semantic value tones, vector charts — bar, donut, line/area, progress runway, **segmented proportional bar**, **earnings-vs-expenses bars** — zebra tables, sections, **insight callouts**, notes, header band and "Page X of Y" footer on every page.
- **Itemized ledger (v1.29.0):** Date · Type badge · Description · Odometer · Unit cost · Total (plus an optional Vehicle column for multi-asset ledgers); month groups with subtotals, zebra rows, a bold TOTAL band and a transparent footer ("All N record(s) … shown — nothing hidden"). No truncation: pagination handles size and re-draws the column header after each page break.
- **Full transparency contract:** a real numeric zero renders an explicit amount (`KES 0`, `0.00`); only missing/unpopulated values render `—`. Every Apex builder also emits a **Data completeness** panel (records scanned, rows shown, lane exclusions) and engine-owned totals.
- **People & Roles panel:** owner profile (name, email, phone, plan, language) + assigned driver cards (name, plate, licence label, status) wherever data exists.
- **Determinism:** figures come only from structured report data; the AI never draws or computes charts. Every string passes through `pdfSafeText()` (emoji stripped, symbols mapped), and fixed cover/footer text draws with a zeroed bottom margin so pdfkit never spawns phantom pages.

### 47.3 Report catalog & bespoke reports
- Core: Fleet Status, Compliance & Expiry, Maintenance & Service, Financial & Cost (all PDF-capable; fleet/financial carry a fleet financial-health block and the full ledger).
- Creative: Fuel Economy Deep-Dive (full-tank segments/trend), Compliance Radar-style expiry runway, Driver Scorecard, Year-in-Review, Eco-Footprint (est. CO₂ at 2.68 kg/L, labelled estimate), Driver Daybook (now with its own activity ledger), Vehicle Health Check-in, My Compliance Card.
- **Apex set (v1.29.0):** Vehicle Deep-Dive (`vehicle_deep_dive` — one asset, plate badge, cost/km or cost/hour, fuel economy, earnings vs expenses, compliance runway, full ledger), Owner Portfolio (`owner_portfolio` — every owned asset, multi-vehicle distribution, per-vehicle performance table, consolidated ledger, net payouts) and Driver Performance & Compliance (`driver_performance` — activity, active-day adherence, fill-type discipline, compliance verification, daily activity log, driver ledger). Owner-lane only.
- **Itemized ledger everywhere:** every vehicle, driver, fleet/financial and bespoke report carries the month-grouped transaction ledger built by `src/services/reportLedger.js` (`buildLedgerGroups`), with type badges (FUEL · SERVICE · PARTS · TOLLS · EARNING · OTHER · COMPLIANCE), unit cost derivation for fuel, and `scanned === shown` transparency totals.
- **Bespoke reports:** one sentence names metrics + period — `"custom report: fuel economy, total spend and distance for last 3 months"`. `src/services/reportMetrics.js` holds the declarative metric registry (access-tagged, formatter-tagged); missing metrics trigger a short access-aware menu (zero tokens). Range presets: this month, last 3 months, this year. Bespoke PDFs now include the filtered ledger and an earnings-vs-expenses chart.
- **Delivery:** `src/services/reportDelivery.js` resolves → enforces the lane → builds structured data → renders the Saka Apex PDF → uploads to the `fleet-reports` bucket → emails it (Resend) → returns the WhatsApp text plus the link. The background follow-up lane carries it (and the active plate) so the chat never blocks.
- **Routing keys:** aliases resolve to `vehicle_deep_dive` ("deep dive", "vehicle report", "car report"), `owner_portfolio` ("portfolio", "my assets", "asset report") and `driver_performance` ("driver performance"). Underscore registry keys resolve exactly (e.g. `report_type = vehicle_deep_dive`); fuel aliases still win for "fuel deep dive".

### 47.4 Report access lanes (`src/services/reportAccess.js`)
One pure choke point used by the WhatsApp route, the follow-up worker and the PDF builder:
- **Owner:** every report for vehicles they own — including the Apex set (`vehicle_deep_dive`, `owner_portfolio`, `driver_performance`). **Driver:** Driver Daybook, Vehicle Health Check-in, My Compliance Card, Maintenance, Fuel Economy — assigned vehicle only. **Admin:** everything.
- Drivers are denied Fleet Status, Financial & Cost, Driver Scorecard, Year-in-Review, Eco-Footprint, the Apex owner set, and other drivers' data; denial copy is warm and offers the driver lane.
- **Report Passes:** `driver_assignments.report_grants` (jsonb, migration `npm run migrate:report-grants`) lets the owner/superadmin grant a driver extra lane reports (e.g. compliance); financials can never be granted. Grants are read automatically by the report worker.
- Driver custom reports are automatically filtered to driver-safe metrics (no earnings/net profit/total spend).

### 47.5 UX & Inclusion (permanent rule 31)
`Saka Fleet must be fun, easy and efficient for every gender, age and locality.` Mirrored into `.clinerules` rule 31, `SAKA_TONE_COMPASS.inclusion` (rendered as **UX & INCLUSION** in the playbook), the core prompt's TONE MIRRORING section, the PDF labels/copy and `test_agent_training.js` tokens. Plain words, one question per turn, gender-neutral, example-first, forgiving inputs, gentle celebration, one clear next step.

### 47.6 Files, tests & knobs
- Files: `src/services/pdfEngine.js` (Apex renderer), `reportLedger.js` (transaction ledger builder), `vehicleDeepDive.js`, `ownerPortfolio.js`, `driverReports.js` (daybook ledger + driver performance), `fleetReports.js` (fleet financial block + ledgers), `reportMetrics.js`, `reportDelivery.js`, `reportAccess.js`; `reports.js` (legacy facade → Apex renderer); integrations in `src/routes/whatsapp.js`, `src/services/followups.js`, `sakaAi.js`, `flowKnowledge.js`; fonts in `assets/fonts/`. No new npm dependencies — the renderer stays pdfkit-based.
- Tests: `test_pdf_engine.js` (29 assertions: glyph safety, theme, Apex components, real drawn text via `useStandardFonts`, zero-vs-missing, phantom-page guard), `test_report_builders.js` (67: ledger mapping, deep-dive, portfolio, driver performance, aliases, lane guards, lane wiring, adapter PDF renders), `test_report_metrics.js` (25), `test_report_access.js` (33), `test_fleet_reports.js` (42), `test_agent_training.js` (109), `test_doc_sync.js` (24).
- Ops: `node scripts/test_anthropic_connection.js`; `npm run migrate:*` unchanged; report PDFs require the `fleet-reports` storage bucket (already used by the legacy audit path).

### 47.7 Apex report spec — data mapping blueprint
Every builder returns `{ ok, type, data, text }`; `data` is the single renderer contract:
```json
{
  "title": "Vehicle Deep-Dive - KAS 628T",
  "subtitle": "Toyota Hilux - engine-calculated figures, nothing hidden",
  "reportType": "vehicle_deep_dive",
  "plate": "KAS 628T",
  "periodLabel": "All recorded activity",
  "generatedAt": "2026-11-01T00:00:00.000Z",
  "currency": "KES",
  "kpis": [{ "label": "Total spend", "value": "KES 23,000", "hint": "3 expense record(s)", "tone": "negative" }],
  "charts": [
    { "type": "segment", "title": "Spend by category", "currency": "KES", "segments": [{ "label": "Fuel", "value": 11000 }] },
    { "type": "vs", "title": "Earnings vs expenses", "currency": "KES", "earnings": 25000, "expenses": 23000 },
    { "type": "bar|donut|line|progress", "series": [{ "label": "W1", "value": 12 }] }
  ],
  "ledgers": [{
    "title": "Itemized activity - KAS 628T",
    "currency": "KES",
    "showVehicle": false,
    "groups": [{ "label": "November 2026", "expenseTotal": 6000, "earningTotal": 25000,
      "rows": [{ "date": "2 Nov 2026", "kind": "fuel", "kindLabel": "FUEL", "description": "Fuel - 45 L - Shell Westlands",
                 "odometer": 50800, "unitCost": 133.33, "amount": 6000 }] }],
    "totals": { "scanned": 4, "shown": 4, "expenseTotal": 23000, "earningTotal": 25000, "net": 2000 },
    "footnote": "All 4 record(s) in this period are shown — nothing hidden."
  }],
  "tables": [{ "title": "Portfolio performance", "currency": "KES", "columns": [{ "key": "plate", "label": "Vehicle" }], "rows": [] }],
  "callouts": [{ "tone": "positive", "title": "Financial health: surplus", "body": "…" }],
  "sections": [{ "title": "Data completeness", "rows": [{ "label": "Ledger rows shown", "value": "4" }], "lines": ["…"] }],
  "notes": ["Generated by Saka Fleet on … - Africa/Nairobi"]
}
```
- `kpis[].tone`: `positive` (emerald), `negative` (coral), `warn` (amber), `brand` (teal) or omitted (ink).
- `charts[].type`: `bar`, `donut`/`pie`, `line`, `progress`, `segment`/`segmented`/`split`, `vs`/`compare`.
- Ledger `kind` drives the badge tone: `earning` → emerald, `fuel` → teal, `service|maintenance|parts` → amber, `compliance` → amber, `tolls|other` → coral/neutral.
- Real zeros stay `0`; missing values stay `null`. The renderer owns formatting (`KES 0` vs `—`), so builders never pre-format ledger amounts.

---

## 48. v1.18.1 — Emoji Artistry & Saka's First Hello

### 48.1 Emoji Policy (data, not vibes)
`SAKA_TONE_COMPASS.emojiPolicy` in `flowKnowledge.js` is the single source of truth, rendered into the playbook as **EMOJI POLICY** and mirrored by the composer's **EMOJI ARTISTRY** line and the core prompt:
- **Principle:** emojis are scaffolding, not decoration — one semantic emoji per line anchors the eye for every reading level; numbers, currency and dates stay emoji-free.
- **Density:** ≤3 emojis per standard message (max 1 per line); welcome/onboarding messages ≤4; never an emoji wall, never the same emoji twice in a row.
- **Situation matrix:** greetings 👋 + time-of-day (🌅☀️🌙), local greeting first (Namaste 🙏 in India, Habari in East Africa, Hello elsewhere); onboarding 📋→✅→🎉→🚗; logs ⛽🔢💰✅; reminder ladder 🔔 30d → ⏰ 14d → ⚠️ 7d → 🚨 overdue; status 🟢🟡🔴; errors/frustration exactly ONE gentle 🙏; money/legal/compliance one semantic header emoji with plain figures; celebration max 2, never during bad news.
- **Banned:** sarcastic/ambiguous emojis (🙄 😏 😒 🤡 💀) and emojis inside amounts, plate numbers, codes or OTPs.
- **Mirror:** match the user's playfulness inside these limits; formal users still get the light scaffolding version.

### 48.2 First-contact introduction (`src/services/greetings.js`)
- Deterministic, zero tokens, country-aware: `resolveDaypart()` (in the user's timezone), `greetingFor()` (Namaste 🙏 · Habari · Marhaba · Bonjour · Hola · Olá · Hallo · Ciao · Sawubona; time-of-day fallback), `sakaIntroText()` and `isFirstContact()`.
- Intro copy (example, India): *"Namaste! 🙏 I'm Saka — your vehicle's co-pilot on WhatsApp. I keep your fuel ⛽, costs 💰 and service reminders 🔔 in one calm place, so you can focus on the road. To begin, send your vehicle's number plate (e.g. MH 01 AB 1234)."*
- **Trigger:** a genuinely fresh conversation (no DB history, no in-memory history, no `sakaIntroduced` flag, no registered vehicle). The greeting branch uses the intro verbatim; any other first message (e.g. a plate sent straight away) gets the intro prefixed once, without repeating the plate ask. `buildFirstTimeWelcome()` now introduces Saka by name in both English and Swahili.
- Never repeats (`session.sakaIntroduced`), never assumes gender/role, and always ends with ONE next step.
- v1.19.2: `isIntroCopy()` / `wantsIntroduction()` guard AI-generated replies too — a welcome is replaced by a re-engage line whenever history exists and the user did not ask who Saka is (see §51.3).

### 48.3 Sync, files & tests
- Files: `src/services/greetings.js`, `flowKnowledge.js` (emojiPolicy + GREETING playbook), `conversationEngine.js` (EMOJI ARTISTRY), `sakaAi.js` (emoji bullet + first-contact behavior), `src/routes/whatsapp.js` (import + first-contact trigger + opener), `.clinerules` rule 31 emoji bullet.
- Tests: `test_greetings.js` (23 assertions: dayparts, localized greetings, intro content/ceiling, first-contact detection, emoji discipline) and `test_agent_training.js` (68 assertions incl. `EMOJI POLICY`, `EMOJI ARTISTRY`, `Namaste`, `first contact`).

---

## 49. v1.19.0 — Receipt Intelligence (OCR, document types & the receipt vault)

### 49.1 Audit of the original flow
v1.7.4 delivered Meta's two-step media download (5 MB / 15 s guards), Vision `DOCUMENT_TEXT_DETECTION`, images-only with graceful key/timeout failures, parallel session hydration and receipt hints (TOTAL amount, litres, labelled odometer, vendor + date) that prefill the quiz. Gaps: every photo was treated as a receipt; OCR confidence was captured then ignored; duplicate photos re-entered the expense flow; nothing was stored, so users had no receipt history; failures produced a dry system note.

### 49.2 Document intelligence (`classifyOcrDocument` + `extractDocumentHints`)
- Families: `receipt_fuel`, `receipt_general`, `logbook`, `insurance`, `drivers_licence`, `odometer_photo`, `unknown` (fuel words/pump/nozzle; VIN/chassis; policy/underwriter; licence/PSV/PDP/DL; lone odometer).
- Receipt hints: TOTAL amount → max fallback, litres, odometer, **currency** (KES/₹/$/€/£/₦…), vendor, date, pump → notes, `expense_type: Fuel` for fuel receipts.
- Logbook: VIN + country plate pattern. Insurance: policy number + expiry. Driver licence: licence number, expiry and type (PSV/PDP/Licence). Odometer photo: lone reading fallback.
- `extractReceiptHints()` remains backward compatible (delegates, receipt fields only).

### 49.3 Confidence gating & confirmation-first
`OCR_CONFIRM_THRESHOLD=0.85`: below it, the confirmation summary gains *"📸 I read these from the photo — double-check the numbers before saving 🙏"*. Receipt photos **always** route through the quiz confirmation (`receiptQuizStart`), so a paper trail is never silently auto-logged; the existing no-write-before-confirmation rule is preserved.

### 49.4 Receipt vault (`src/services/receipts.js` + `public.receipts`)
- One row per media id (`media_id` UNIQUE): kind, status (`read` / `low_confidence` / `failed`), confidence, currency, amount, litres, odometer, vendor, image URL, error.
- Original image uploaded to the `receipts` bucket (best effort); failures never block the chat.
- **Duplicate suppression:** a re-sent photo returns a warm deterministic reply (*"I've already read this receipt ✅ … reply 'receipts' to see your history"*), cancels any quiz and never re-logs.
- **`receipts` command:** deterministic, zero-token, role-scoped list of the last 5 receipts with 🟢/🟡/🔴 status chips, amount, vehicle and date. Owners see fleet receipts; drivers see their own.
- Migration `npm run migrate:receipts`; boot ensure via `ensureReceiptsTable`; the table is operational and is wiped by the slate reset (`RESET_TABLES` + TRUNCATE + test cleanup).

### 49.5 UX (Emoji Artistry)
OCR failures now speak like Saka: *"📸 I couldn't read that photo clearly 🙏 — try again in good light, or type it: 'Logged 40L at 50350 km for KES 5500 — full tank'."* PDFs remain images-only with friendly guidance; figures stay emoji-free; status chips follow the Emoji Policy.

### 49.6 Files, tests & knobs
- Files: `src/services/ocrService.js` (classifier + rich hints), `src/services/receipts.js` (vault, dedupe, replies), `src/routes/whatsapp.js` (media → classify → vault → confirmation-gated quiz, `receipts` command, duplicate/low-confidence overrides), `scripts/run_receipts_migration.js`, `scripts/reset-db.js`, `scripts/testCleanup.js`, `sakaAi.js` (`OCR & PHOTOS` training block), `flowKnowledge.js` (OCR confirmation boundary).
- Tests: `test_ocr_flow.js` (38 assertions), `test_agent_training.js` (`OCR & PHOTOS`, `RECEIPT INTELLIGENCE`), `test_db_reset_scope.js` (receipts wiped).
- Knobs: `OCR_MAX_MEDIA_BYTES` (5242880), `OCR_TIMEOUT_MS` (15000), `OCR_CONFIRM_THRESHOLD` (0.85), `RECEIPTS_BUCKET` (receipts).

---

## 50. v1.19.1 — Intent Resilience, Registration Summary PDF & Existing-User Rollout

### 50.1 Purpose-scoped empty-completion retry (`aiClient.js`)
Live audit showed Tier-1 DeepSeek returning `Empty completion` nine times on `intent_classify` plus one timeout, pushing real turns onto the regex fallback. `chatCompletion()` now performs **one** extra call, same provider/model, when the body is empty **and** the purpose is in `EMPTY_RETRY_PURPOSES` (`intent_classify`, `question_render`, `prose_render`). The retry nudges temperature by +0.05 (capped at 0.9), keeps `maxRetries: 0`, and records `empty_retry_ok` / `empty_retry_failed` inside the **same** `ai_usage_logs.attempts[]` row — no extra telemetry row, no provider hopping, no cost on casual chat. Tier clamping, entitlements and deterministic fallbacks are untouched.

### 50.2 Registration summary PDF by email (`vehicleSummary.js`)
Real request: *"email me the registration summary PDF"*. New deterministic command path in `src/routes/whatsapp.js`:
- Triggers on `registration/vehicle summary|details|passbook` or `(send|email|resend|share) … registration`. Zero tokens.
- Owner lane only: drivers receive a lock notice and are pointed to *vehicle health* / *driver daybook*. VIN/passbook stay owner-visible.
- `buildVehicleSummary()` assembles plate, VIN, specs, odometer, insurance/inspection countdowns, open reminders, owner + assigned-driver People panel.
- `emailVehicleSummary()` renders the Saka Pro PDF, uploads to `fleet-reports` and emails via `sendReportByEmail`; failure degrades to the in-chat summary + link, never an error.
- Plain *"vehicle summary"* returns text with a one-line hint to ask for the PDF. This is a core account document: it does **not** consume the fleet-report quota.

### 50.3 Cloud Run deployment-noise filter (`sentinel.js`)
`scanCloudRunAnomalies()` ignores revision/traffic conflict artifacts (`Conflict for resource`, `version '…' was specified but current version is …`) through exported `DEPLOY_NOISE_RE` / `isDeployNoiseLog()`. Rollout noise no longer reaches `chat_friction_logs`, `error_logs` or Superadmin WhatsApp alerts; genuine runtime errors still alert.

### 50.4 Once-only "What's new" digest for existing users
- Schema: `profiles.feature_notice` + `profiles.feature_notice_at`; `npm run migrate:feature-notice` (idempotent) and fail-soft boot `ensureFeatureNoticeSchema`.
- `FEATURE_NOTICE_VERSION` (default `1.19.1`) is stamped per profile. `isNoticeStale()` compares version parts numerically (1.19.10 > 1.19.1).
- `buildFeatureNotice({ lane })` is deterministic, ≤4 emoji anchors: owners get receipts/PDF reports/full-tank logging; drivers get Daybook/Vehicle Health/Compliance Card. Drivers never see owner financial prompts.
- Append rules (`shouldShowFeatureNotice`): registered users only, once per session, never during a quiz/confirmation, circuit-breaker trip or the summary command; session flag + DB stamp both set.
- Backfill: `npm run rollout:features` (dry-run default) reports profile/notified/pending/vehicles/receipts/registry counts and, with `--apply`, runs the feature-notice + fuel fill-type + receipts + model-registry DDL idempotently.
- Superadmin: `admin rollout` / `admin rollout status` → deterministic digest, audited `ADMIN_ROLLOUT`, zero tokens.

### 50.5 Upload guidance
`sakaAi.js` OCR block and `flowKnowledge.js` boundary now state explicitly that users may upload receipts, logbooks, insurance policies and driver licences (one photo at a time) and that nothing saves before confirmation.

### 50.6 Files, tests & knobs
- Files: `src/services/aiClient.js`, `src/services/vehicleSummary.js`, `src/services/featureNotice.js`, `src/routes/whatsapp.js`, `src/workers/sentinel.js`, `src/services/superadmin.js`, `index.js`, `sakaAi.js`, `src/services/flowKnowledge.js`, `scripts/run_feature_notice_migration.js`, `scripts/feature_rollout.js`, `package.json`, `.env.example`, `README.md`.
- Tests: `test_feature_notice.js` (24 assertions), `test_vehicle_summary.js` (14), `test_model_router.js` (empty-retry allow-list), `test_agent_training.js` (upload permission token).
- Knobs: `FEATURE_NOTICE_VERSION` (1.19.1).


---

## 51. v1.19.2 — Live-Chat Hardening (OCR Resilience, No-Repeat Welcome)

Evidence base: the 2026-10-30 production transcript (`254734852529`) plus `ai_usage_logs`, `receipts` and `chat_friction_logs` showed 20/25 `intent_classify` failures, 3/4 Vision document reads timing out, and four fresh "Karibu" welcomes in 25 minutes.

### 51.1 Vision resilience (`ocrService.js`)
- `OCR_VISION_TIMEOUT_MS` (25000) is now separate from `OCR_TIMEOUT_MS` (15000, Meta lookup/download).
- `extractTextFromImage()` retries **once** on `AbortError`/`TimeoutError` only (`OCR_VISION_MAX_ATTEMPTS`, clamped 1-3); HTTP/credential errors return immediately. Vision annotate is idempotent, so the retry is safe.
- Every result carries `attempts`; a blank 200 returns `No text detected in the document` (never a null error), so `receipts.error` stays diagnosable.
- `ocrWhatsAppMedia()` spreads the new fields through unchanged.

### 51.2 OCR recovery ladder (`whatsapp.js` + `receipts.js`)
- `OCR_UNREADABLE_NOTE` (deterministic) is appended after **two** unreadable photos on the same quiz step (`session.ocrFailures` / `ocrFailuresStep`, keyed by flow + phase + answers). The counter resets on a new step, on a successful read and on non-media turns.
- The escape offers typing the answer or `Skip`, and changes the reply text so photo failures can never trip the identical-prompt circuit breaker.

### 51.3 No repeated welcome (`greetings.js` + `whatsapp.js`)
- `isIntroCopy()` / `wantsIntroduction()` (exported, unit-tested) detect fresh-welcome copy and genuine "who are you" requests.
- When history exists, no quiz is active and the user did not ask who Saka is, an intro reply is replaced with a warm re-engage line plus one next step.
- Prompt sync: `sakaAi.js` section 6 and `conversationEngine.js` composer instructions forbid re-introducing or repeating an unreadable-photo question; `flowKnowledge.js` adds both as boundary rules.

### 51.4 Deterministic empty garage (`whatsapp.js`)
- `list my cars|vehicles|fleet` and `manage vehicle` with zero registered vehicles answer deterministically with the country plate example and `REGISTER` — zero tokens, no generic menu.
- Populated fleets keep the numbered switch menu.

### 51.5 Housekeeping
- The stale, unversioned `system_config.saka_core_prompt` (6000 chars, ignored at runtime) was deleted; runtime prompts come from `flowKnowledge.js` only.

### 51.6 Files, tests & knobs
- Files: `src/services/ocrService.js`, `src/services/receipts.js`, `src/services/greetings.js`, `src/routes/whatsapp.js`, `sakaAi.js`, `src/services/conversationEngine.js`, `src/services/flowKnowledge.js`, `.env.example`, `README.md`.
- Tests: `test_ocr_flow.js` (45 — timeout retry, no-retry transport, blank-read reason, escape copy), `test_greetings.js` (28 — intro-copy guard), `test_agent_training.js` (75 — boundary + prompt sync).
- Knobs: `OCR_VISION_TIMEOUT_MS` (25000), `OCR_VISION_MAX_ATTEMPTS` (2).


---

## 52. v1.20.0 — Document Lens (Photos & PDFs, Confirm-Before-Save)

Saka now accepts **any PDF or image** as an input, reads it, shows what it found, and asks only for what is missing. Nothing is written without the user's confirmation.

### 52.1 PDF support (`pdfTextExtractor.js`, zero dependency)
- Google Vision cannot read PDFs inline and the async batch API would need a GCS bucket, so Saka extracts the text layer locally: scan `stream…endstream`, inflate `FlateDecode` with Node `zlib` (with sync-flush fallbacks), then walk `Tj` / `TJ` / `'` / `"` operators plus `Td`/`TD`/`T*` line breaks.
- Literal + hex strings (incl. UTF-16BE) are decoded with escape handling; content is sanity-checked (≥55% printable) so CID-font binary is never surfaced as text.
- Guards: `%PDF` magic check, `OCR_PDF_MAX_PAGES` (20, max 80), `400` stream cap, 4,000-char output cap, never throws.
- **Scanned PDFs** (no text layer) return a clear "send the pages as photos" reason; the route's OCR recovery ladder then applies.

### 52.2 Document Lens (`documentLens.js`)
- `classifyDocumentFamily()` refines the Vision classifier into nine families: registration/logbook, insurance, inspection/roadworthiness, road service licence/permit, purchase invoice, driver licence/badge, fuel receipt, service invoice, odometer photo.
- `parseDocumentFields()` returns `{ family, label, lane, fields, hints, found, missing, confidence }`; every field carries `{ value, confidence }` and dates are normalized through `dateParser.js` (Africa/Nairobi canonical).
- `toQuizHints()` maps lens fields onto the existing quiz/classifier keys so prefill, confirm-before-save and "ask only the missing field" keep working unchanged.
- `DOCUMENT_UPLOAD_HINTS` + `uploadHintFor()` give every uploadable quiz field a deterministic, zero-token invite (plate/VIN/year → logbook; expiry → insurance/licence; amount → receipt).
- `DOCUMENT_SUPPORT_MENU` powers the `what documents can I send?` / `upload document` command.

### 52.3 Route wiring (`whatsapp.js`)
- `ocrWhatsAppMedia()` accepts `application/pdf`, returns `kind: 'pdf'`, and keeps the 5 MB download guard.
- Every media turn runs the lens; lens hints merge **over** Vision hints so richer fields (insurer, service items, inspection dates) prefill the quiz.
- Quiz turns append the upload hint **once per pending field** (`getCurrentQuizField` + `session.uploadHintField`).
- OCR recovery ladder (v1.19.2) and low-confidence note apply to PDFs too; a scanned PDF gets the photo fallback note.

### 52.4 Supported families
Photos **or PDFs**: logbook/registration certificate, fuel receipt, service invoice, insurance certificate, driving licence / PSV / PDP / CPC / CDL, inspection certificate, road service licence or permit, purchase invoice, odometer/hour-meter photo. Extended catalog (flag-first): speed-limiter certificates, driver medicals, fleet fuel-card statements, fleet insurance schedules, M-Pesa receipts. ID/passport copies are politely declined (data minimisation).

### 52.5 Files, tests & knobs
- Files: `src/services/pdfTextExtractor.js`, `src/services/documentLens.js`, `src/services/ocrService.js`, `src/routes/whatsapp.js`, `src/services/featureNotice.js` (1.20.0 copy), `sakaAi.js`, `src/services/conversationEngine.js`, `src/services/flowKnowledge.js`, `.env.example`, README.
- Tests: `test_doc_lens.js` (48 — PDF parsing/extraction/guards, nine families, upload hints, end-to-end PDF intake), `test_agent_training.js` (78 — Document Lens prompt + boundary sync), `test_feature_notice.js` (1.20.0 digest), `test_ocr_flow.js` (45).
- Knobs: `OCR_PDF_MAX_PAGES` (20), `FEATURE_NOTICE_VERSION` (1.20.0).
- Clean-slate onboarding test: `node scripts/reset-db.js --all --confirm --backup` cleared all operational tables (with a git-ignored backup); Management API token failures now fall back to the Supabase JS client (§15.2).


---

## 53. v1.21.0 — Country Bucket & Global Asset Kinds

Every user is placed in ONE **country bucket**, created automatically at onboarding: the country is parsed from the WhatsApp number (E.164), confirmed once, and the **asset kind** selects the identity track and the jurisdiction knowledgebase.

### 53.1 Asset kinds & identity tracks (`countryBucket.js`)
- Eight kinds: `vehicle`, `motorcycle`, `truck`, `bus`, `heavy_equipment`, `machinery`, `generator`, `watercraft` (`ASSET_KINDS`).
- Road assets: plate + VIN (**VIN immutability unchanged**), odometer meter. Non-road assets: **serial number**, hour meter, no plate/VIN; the passbook remains asset-scoped (`vehicles.id`), and `vin_registry` stays a road-vehicle provenance ledger.
- `vehicles.asset_kind` + `vehicles.serial_number` added; `vehicles.plate_number` is nullable. Non-road registration writes a stable `ASSET-……` internal identity so the NOT NULL index never blocks onboarding (pre-migration safe), and the insert retries without new columns if the schema is not yet migrated.
- `assetDisplayName()` returns the plate for road assets and `make/model (SN …)` for equipment; the registration quiz asks the asset kind first and then swaps plate↔serial, odometer↔hours, VIN↔(skipped).

### 53.2 Country knowledgebase (`COUNTRY_KB`)
- Bundled bundles (code) for **DEFAULT + KE, TZ, UG, RW, NG, ZA, GB, US, CA, AE, IN, AU, BE** with authority, official source URLs, required/optional compliance rules, renewal hints, law references, **example submission text** and `verified_at` (v1.21.0).
- `country_kb` table (superadmin-approved overrides, effective-dated, asset-scoped) layered over the bundle — same discipline as `compliance_catalog`; legal rules are never auto-generated or auto-changed.
- `getCountryBucket()` (sync, bundled) feeds the prompt; `loadCountryBucket()` (DB overrides) feeds deterministic commands. Unknown countries fall back to `DEFAULT` with `fallback: true` and the local-authority disclaimer.
- Freshness: `KB_REVIEW_DAYS` (90), `KB_VERIFIED_AT`, `COUNTRY_KB_VERSION`; future ingest (`scripts/kb_ingest.js`) writes draft rows for superadmin approval only.

### 53.3 Conversation & onboarding
- Registration: **asset kind is the first question** (Car / motorcycle / truck / bus / heavy equipment / machinery / generator / boat); plate, serial, VIN, odometer and hour-meter questions are conditional on the answer.
- Profiles gain `jurisdiction_confirmed` / `jurisdiction_updated_at`; completing registration stamps the bucket as confirmed.
- Deterministic commands (zero tokens): `my country` / `country <name>` (writes the profile, updates units/timezone), `my rules`, `required documents`, `example compliance` (personalized with the plate).
- `processSakaMessage({ jurisdictionContext })` injects the **JURISDICTION CONTEXT** block (authority, required documents, example submissions, verified date). Boundary rule: quote only supplied rules, never invent a law/penalty/deadline, always add the disclaimer.

### 53.4 Migration, files & tests
- `npm run migrate:country-kb` (`scripts/run_country_kb_migration.js`): `country_kb` + `profiles.jurisdiction_*` + `vehicles.asset_kind/serial_number` + nullable plate; `country_kb` joins `PRESERVED_TABLES` so a slate wipe never deletes legal reference data.
- **Applied 2026-10-30** on project `wnvbhpykboonygaznhhl`: `country_kb` created (0 override rows — bundled defaults serve), `profiles.jurisdiction_confirmed/jurisdiction_updated_at` present, `vehicles.asset_kind/serial_number` present, `vehicles.plate_number` now NULLABLE (verified through `information_schema.columns`).
- Files: `src/services/countryBucket.js`, `src/services/quizEngine.js`, `src/routes/whatsapp.js`, `sakaAi.js`, `src/services/flowKnowledge.js`, `scripts/run_country_kb_migration.js`, `scripts/reset-db.js`, `package.json`, README.
- Tests: `test_country_bucket.js` (54 — asset kinds, bucket resolution/overrides, guidance/examples/disclaimers, onboarding conditional fields), `test_agent_training.js` (80 — jurisdiction boundary), `test_quiz_flow.js` (asset-kind-first registration).
- Knobs: `COUNTRY_KB_VERSION` (2026.10.1), `KB_VERIFIED_AT` (2026-10-30), `KB_REVIEW_DAYS` (90).


---

## 54. v1.21.1 — Knowledgebase Ingest & Review Pipeline

Official-source harvesting for the Country Bucket, with a superadmin approval gateway. **Legal rules are never auto-changed by AI.**

### 54.1 Source registry & allow-list (`src/data/kb_sources.json`)
- One entry per country: authority + official HTTPS sources (NTSA, TRA, URA, RRA, FRSC, DoT ZA, GOV.UK, NHTSA/USA.gov, Transport Canada, RTA, Parivahan, infrastructure.gov.au, Mobilité BE).
- **v1.21.2 — traffic-act deep-links:** each country also carries a `legislation` array with the exact law name and a human-verified official URL where one exists. Fetch order is **verified legislation → authority pages**, so statutory text wins the per-rule dedupe and every draft inherits `law_reference` (e.g. `Road Traffic Act 1988 (c. 52)`).
  - Verified: **KE** Traffic Act (Cap 403) · **ZA** National Road Traffic Act 93/1996 · **GB** Road Traffic Act 1988 · **US** 49 CFR Part 390 · **CA** Motor Vehicle Safety Act (S.C. 1993, c. 16) · **IN** Motor Vehicles Act 1988 · **BE** Wegcode.
  - Pending (law name only, **never fetched**): **TZ** Road Traffic Act Cap 168 · **UG** Traffic and Road Safety Act 1998 · **RW** road traffic law · **NG** National Road Traffic Regulations 2004 · **AE** Federal Law No. 21/1995 · **AU** Road Vehicle Standards Act 2018. Bot-protected official pages (Kenya Law, eCFR, India Code) are skipped gracefully when they challenge automated fetches.
- `kbIngest.js` enforces an **HTTPS + official-host allow-list** (exact base domain or subdomain, `www.` normalised). Anything else is rejected before a request is made.
- Fetch guards: 20 s timeout, 2 MB cap, HTML → text (scripts/styles removed, entities decoded), PDFs via `pdfTextExtractor`.

### 54.2 Draft-only ingest (`npm run kb:ingest`)
- `buildDraftRules()` deterministically scans fetched text for rule families (insurance, inspection, road service licence/permit, road tax, speed limiter, driving licence, PSV/PDP) and extracts a real summary sentence per rule.
- Drafts are written with `is_active=false`, `verified_at=null`, `curated_by='ingest-draft'`, official `source_urls` and the current `COUNTRY_KB_VERSION`.
- **Approved rows are never overwritten** by a later ingest; only drafts are refreshed.
- CLI: `npm run kb:ingest` (dry run) · `-- --apply` · `-- --countries=KE,TZ` · `-- --review` · `-- --stale` · `-- --approve <id>` · `-- --reject <id>`.

### 54.3 Superadmin approval gateway
- `admin kb` / `admin kb review` → draft queue + stale count (audited `ADMIN_KB_REVIEW`).
- `admin kb approve <id>` → `is_active=true`, `verified_at=today`, `curated_by='superadmin'` (audited `ADMIN_KB_APPROVE`).
- `admin kb reject <id>` → draft deleted (audited `ADMIN_KB_REJECT`); active rules can never be deleted here.
- `admin kb stale` → active rules missing/older than `KB_REVIEW_DAYS` (audited `ADMIN_KB_STALE`).
- Resolution order stays: active DB override → bundled `COUNTRY_KB` → `DEFAULT` + disclaimer.

### 54.4 Files, tests & knobs
- Files: `src/services/kbIngest.js`, `src/data/kb_sources.json`, `scripts/kb_ingest.js`, `src/services/superadmin.js`, `package.json`, `.env.example`, README.
- Tests: `test_kb_ingest.js` (50 — allow-list, HTML/PDF fetching, legislation ordering + law references, pending never fetched, draft-only guarantees, dry-run vs apply, approve/reject audits, freshness, command parsing).
- Knobs: `KB_MAX_SOURCE_BYTES` (2000000), `KB_FETCH_TIMEOUT_MS` (20000), `KB_REVIEW_DAYS` (90).


---

## 55. v1.21.3 — Wipe-Aware First Contact & Zero-Vehicle Routing

Live onboarding evidence (2026-10-30, post-slate-wipe): the first "Hello" received the v1.19.2 re-engage guard ("I'm still here — no need to start over") because a warm Cloud Run instance still held pre-wipe in-memory session flags while the database was empty; two later turns also asked a zero-vehicle user for a plate before the asset-kind question.

### 55.1 Wipe-aware `isFirstContact()` (`greetings.js`)
- **Persisted history is now the only conversation signal.** `isFirstContact()` returns true when there are no registered vehicles and `chat_history` is empty, regardless of stale in-memory `session.history` / `sakaIntroduced` flags.
- The route now **always reads the last 10 persisted turns** (parallel with the vehicle query) instead of skipping the read on warm sessions — a warm instance must never make a wiped account look like a returning one.
- Persisted history still suppresses the intro (returning users are unaffected).

### 55.2 Zero-vehicle plate guard (`whatsapp.js` + `greetings.js`)
- `asksForPlateDirectly()` detects replies that ask for a registration plate outright.
- When the user has **zero assets**, no active quiz and did not ask to register, the route replaces such a reply with a REGISTER invitation describing the asset-kind-first flow (plate or serial, or a document).
- Prompt sync: `sakaAi.js` section 6 now states "NEVER ask a zero-vehicle user for a plate directly. Invite REGISTER; the engine asks the asset kind first…".

### 55.3 Files, tests & knobs
- Files: `src/services/greetings.js`, `src/routes/whatsapp.js`, `sakaAi.js`, `test_greetings.js`, `test_agent_training.js`, README.
- Tests: `test_greetings.js` (33 — wipe-aware contact, stale-flag handling, plate-ask detection), `test_agent_training.js` (81 — prompt routing rule), `test_quiz_flow.js` 52, `test_country_bucket.js` 54.


---

## 56. v1.22.0 — Snappy Saka (Latency, Ack-First Media & OCR Kill Switch)

Live evidence (2026-10-30): reply gaps ranged from 4.9 s to **86.6 s**. `ai_usage_logs` showed `intent_classify` at 2.7–16.3 s, `question_render` 3.4–19.4 s (one `failed@19400ms`), and empty-retries doubling calls (`empty_retry_ok@8900ms + ok@9000ms`). Both photo uploads returned `No text detected in the document` — the images genuinely had no readable text, while still sitting in the critical path.

### 56.1 Vision photo OCR kill switch
- `OCR_ENABLED` (`on|true|1`) defaults **off**. Photo turns skip Meta download + Vision entirely and answer instantly: *"Photo reading is paused right now — type the details, or send the PDF."* No receipt row, no error, no waiting.
- **PDFs are exempt and always enabled** — the local text-layer extractor is fast and provider-free, so Doc Lens PDF intake keeps working with the switch off.
- `OCR_ACK_FIRST` (default `on`) controls the ack behaviour when Vision is re-enabled.

### 56.2 Ack-first media pipeline
- With OCR enabled, the route sends a deterministic ack **before** awaiting OCR (*"📸 Reading your photo now — I'll reply with what I find in a moment."* / PDF variant), logged to `chat_transcripts` + `chat_history`.
- The per-phone serial queue guarantees the parsed follow-up (prefilled quiz question / confirmation) arrives before the next user message is processed, so no merge races.
- Slow work therefore never blocks the first visible reply; only the follow-up carries the parse result.

### 56.3 AI latency trims
- Empty-completion retries now require a **fast first attempt** (`EMPTY_RETRY_MAX_FIRST_MS`, default 5000) — a 9 s empty answer is never followed by another 9 s wait. Gate lives in exported `shouldRetryEmpty()`.
- `question_render` gets a tighter ceiling (`AI_TIMEOUT_MS_QUESTION`, default 10000) so a slow provider lands on the deterministic question template instead of blocking the turn.
- Quiz questions remain prefetched/cached; `intent_classify` keeps its 12 s fail-fast with the regex fallback.

### 56.4 Files, tests & knobs
- Files: `src/services/ocrService.js`, `src/routes/whatsapp.js`, `src/services/aiClient.js`, `.env.example`, README.
- Tests: `test_ocr_flow.js` (51 — kill switch, no network while paused, ack copy), `test_model_router.js` (91 — retry latency gate, question timeout), `test_doc_lens.js` 48 (PDF intake unaffected), `test_greetings.js` 33.
- Knobs: `OCR_ENABLED` (off), `OCR_ACK_FIRST` (on), `EMPTY_RETRY_MAX_FIRST_MS` (5000), `AI_TIMEOUT_MS_QUESTION` (10000).
---

## 57. v1.23.0 - Sonnet-First Front Conversations (All Plans)

Owner decision: model quality is not a subscription gate - vehicle count is. Every FRONT user conversation now runs on Sonnet when an Anthropic key exists, for free and paid plans alike.

### 57.1 Routing
- `USER_FACING_PURPOSES` allow-list: `intent_classify`, `extraction`, `question_render`, `prose_render`, `small_talk`, `stall_nudge`, `admin_parse` -> Tier-1 Sonnet-first.
- Background/system purposes (`model_benchmark`, `model_research`, `default`, and the whole Tier-3 reasoning tier) stay DeepSeek.
- Failover chain: Sonnet -> OpenAI GPT-4o (only when `OPENAI_API_KEY` exists and the breaker is closed) -> DeepSeek (always terminal, never skipped). Missing keys surface as `skipped_missing_key` in `ai_usage_logs.attempts`.
- `AI_TIER1_PROVIDER` pins the front provider (anthropic | deepseek); `AI_MODEL_TIER_1_ANTHROPIC` overrides the model (default Sonnet); `AI_PREMIUM_MAX_CONCURRENCY` defaults to 8 and overflow still lands on DeepSeek.
- `PREMIUM_MODEL_ENABLED` now only gates the extra Tier-2 escalation canary; entitlements clamp the tier NUMBER, never the front model.

### 57.2 Production env
- Cloud Run must carry `ANTHROPIC_API_KEY` (Sonnet) and `OPENAI_API_KEY` (GPT fallback). Without keys the app auto-degrades to DeepSeek - the never-throws contract is unchanged.
- Production audit defaults: `PREMIUM_MODEL_ENABLED=off`, `REMEDIATION_AUTONOMY=off`, `AI_MODEL_AUTO_ADOPT=off`, `AI_WEB_SEARCH_ENABLED=off`, `OCR_ENABLED=off` (PDFs still read locally), `AI_PREMIUM_MAX_CONCURRENCY=8`.

### 57.3 Tests
- `test_model_router.js` asserts the front/background split, `AI_TIER1_PROVIDER=deepseek` legacy restore, and the chain order Sonnet -> GPT -> DeepSeek (and Sonnet -> DeepSeek without a GPT key).
---

## 58. v1.23.1 - Pricing v2, Free Vault Gating & OCR Flow Hard-Paused

### 58.1 Pricing v2 (USD list; 30% annual discount everywhere)
| Tier | Monthly | Annual (-30%) | Assets |
|---|---|---|---|
| Free | 0 | - | 1 |
| Solo Pro | 9.99 | 83.92 | 1 |
| Team Fleet | 17.99 | 151.12 | 3 |
| Growth Fleet | 27.99 | 235.12 | 5 |
| Fleet Command | 27.99 | 235.12 | 5 + add-ons |
| Fleet Command add-on | 3.99 | 33.52 | +1 asset |

- Add-ons carry BOTH monthly and discounted annual pricing (`getAddonPriceUSD(tier, interval)`), and every paid tier annualises at 30% off (12 x monthly x 0.70).
- Plan codes stay env-driven (`PAYSTACK_PLAN_<TIER>_<INTERVAL>_<CURRENCY>`), so add-on annual checkout works wherever the plan code exists.

### 58.2 Free tier: parsed data, no document storage
- New tier flag `receiptVaultStorage`: `false` on Free, `true` on every paid tier (and therefore during the full-featured welcome trial).
- Doc Lens still parses photos/PDFs and confirms before saving for free users; the ORIGINAL file is not uploaded (`receipts.image_url = null`). Files stored during a trial are retained after lapse (no destructive deletes); only new uploads stop.

### 58.3 Vision OCR hard-paused in code
- `isOcrEnabled()` now always returns `false`: the WhatsApp photo flow never downloads media or calls Vision, regardless of `OCR_ENABLED`. Photo turns answer instantly with typed/PDF guidance.
- PDFs remain fully active through the local text-layer extractor. Vision helpers and their unit tests stay inert for a future, deliberate revisit.

### 58.4 Release tracker & deploy confirmation
- **`SAKA_FLEET_ARCHITECTURE.md` is the single update tracker** (Release History index above + one section per version). No other changelog file may be created.
- The deployment WhatsApp alert reads `**Version:**` from this file and prints `Release: vX.Y.Z`.
- `npm run health` now asserts the tracker is committed and its version line parses (`release tracker` check), so every deploy confirms the update file is present and current.

### 58.5 Tests
- `test_subscription_billing.js` (new prices, 30% annual, add-on annual, paid-only vault flag), `test_ocr_flow.js` (hard pause even with `OCR_ENABLED=on`), `test_doc_lens.js` (PDF intake unchanged), `test_trial_engine.js` (trial keeps paid features).

---

## 59. v1.23.2 - Plain-English Admin Alerts & Deploy-Noise Decoder

Template for every superadmin alert: what happened -> what it means -> what to do (or no action needed).

### 59.1 Deploy alert
- notify_git_push.js renders "Saka update is live - vX.Y.Z", pulls the headline from the Release History above, states the impact and the action needed, then a compact details footer. Exported buildDeploymentAlertText() is unit-tested.

### 59.2 Remediation watchdog
- formatRemediationBlockedReply() explains the stuck auto-fix job, names GH_REMEDIATION_TOKEN as the likely cause and gives three numbered steps; one alert per stuck plan.

### 59.3 Quieter startup & health
- Cloud Run startup announcements are opt-in (STARTUP_ANNOUNCE=on, default off) and say only "Saka is running (revision X). No action needed."
- Bare Health / Status from the superadmin phone now maps to the health check.

### 59.4 Deploy-noise decoder
- isDeployNoiseLog() decodes protobuf AuditLog byte arrays before matching, so stale-revision console deploys no longer create errors, friction, alerts or a FAILING health status.
- v1.51.9 widened the classifier: `decodeAuditByteArrays()` extracts printable runs (>= 4 printable bytes, control bytes collapsed to one space) recursively across nested `data` arrays (bounded to 3 passes, never throws); `DEPLOY_NOISE_RE` gained the Ready/Waiting-for-revision condition family and a new `CLOUD_RUN_ROLLOUT_NOISE_RE` covers probe failures, Ready condition, instance-not-started, CANCELLED handshakes and container-start failures. `isDeployNoiseLog()` matches BOTH families against raw AND decoded text.
- `scanCloudRunAnomalies` decodes once into `readableText`, uses it for every persisted snippet/error message/WhatsApp line, fingerprints incidents on `buildIncidentSignature(normalizeCloudRunSignature(readableText))` (base64-ish and long repeated-char runs stripped) so a rollout resolves to one signature, and logs one diagnostic `console.info` per scan. Genuine Ready-condition failures (e.g. `Ready check failed: cannot read property plate of undefined`, `TypeError: Cannot read properties of undefined`) still alert.
- `sentinelCloudLogs.fetchCloudRunLogs` classifies payloads at the source (textPayload → api/jsonPayload.message → decoded AuditLog text) and exports `isRolloutLifecycleEntry(entry)`.

### 59.5 Tests
- test_notifications.js: 11 assertions (plain-English alert + headline, watchdog copy, protobuf/plain noise filtered, genuine errors still alert).

---

## 60. v1.23.3 - Incident Registry (Track, Resolve, Silence)

One row per backend issue signature in `backend_incidents`. Sentinel opens incidents from its audit clusters; superadmins resolve or suppress them; silenced signatures never alert again unless they regress.

### 60.1 Lifecycle
- `open` -> `acknowledged` (optional) -> `resolved` | `suppressed` (superadmin only, audited ADMIN_INCIDENT_RESOLVE / ADMIN_INCIDENT_SUPPRESS).
- Signature = the same deterministic normalization Sentinel clusters on (`buildIncidentSignature` mirrors `buildSignature`). 4+ digit numbers become `<n>`, UUIDs `<uuid>`, hex `<hex>`.
- Recurrence guard: resolved/suppressed signatures stay quiet until they recur `INCIDENT_REOPEN_THRESHOLD` (default 3) times after the fix, then the incident re-opens automatically.
- Severity: errors high, stalls/loops/frustration medium, everything else low.

### 60.2 Wiring
- `runRemediationScan()` upserts one incident per audit cluster (source `sentinel_scan`).
- `scanCloudRunAnomalies()` checks the registry before alerting: silenced signatures produce no friction row, no error_logs row and no WhatsApp alert.
- Deployment alerts append `Open backend issues: N (text admin incidents)` when any incident is open.

### 60.3 Commands
- `admin incidents` - open issues with severity chips, counts and ids.
- `admin incident resolve <id> [note]` - resolved + fixed-in-version stamp; silence begins.
- `admin incident suppress <id> [note]` - permanent expected-noise suppression.

### 60.4 Migration, files & tests
- `npm run migrate:incidents` (`scripts/run_incidents_migration.js`); `backend_incidents` is part of the slate-wipe scope (`RESET_TABLES`).
- Files: `src/services/incidents.js`, `src/workers/remediation.js`, `src/workers/sentinel.js`, `src/services/superadmin.js`, `scripts/notify_git_push.js`.
- Tests: `test_incidents.js` (19 - stable signatures, open/update/resolve/suppress, post-fix silence, regression re-open, counts, list, plain-English replies, command parsing).
- Knob: `INCIDENT_REOPEN_THRESHOLD` (3).

---

## 61. v1.24.0 - Conversation-First Saka

Saka now gathers data from natural, flowing conversation instead of running a questionnaire. Paragraphs are the default input; the engine extracts everything it can and asks only for what is genuinely missing.

### 61.1 Natural intake (default)
- The quiz-composer instruction no longer says "state the current question exactly once": it asks for the ONE missing item in a natural, varied sentence, with an explicit ban on form-like wording and listing future questions.
- `DEFAULT_SAKA_CORE_PROMPT` carries a `NATURAL CONVERSATION FIRST` directive: extract values from paragraphs, celebrate captured data in one short line, then ask at most one natural follow-up.
- `SAKA_BOUNDARY_RULES` states that natural conversation is the default intake style (no numbered questionnaires).
- `NATURAL_INTAKE` (v1.24.1, default on) is the prompt-style kill switch: `off|false|0` restores the original strict "state the current question exactly once" instruction without a deploy of code.
- Security flows (OTP, PIN) and the deterministic plate/menu prompts stay exact - never conversational.

### 61.2 Instant acks (perceived speed)
- Free-form messages of `INSTANT_ACK_CHARS` (180) or more, outside an active quiz, get an immediate "📖 Got it - reading that now." before the turn parses, records and composes. This is the same post-ACK pattern used for documents, now applied to long paragraphs.
- `INSTANT_ACK_ENABLED` (default on) is the kill switch. The ack is transcript-logged only, never injected into chat history context.
- **Slow-turn ack (v1.24.2, tuned v1.25.1):** any turn still unanswered after `SLOW_ACK_MS` (**8000**; 4000 in v1.24.2) sends one gentle line regardless of message length, then proceeds normally. The copy rotates per session (`⏳ Still with you…` → `🙂 One sec — checking your garage…` → `📒 Flipping through your passbook…` → `🚗 Almost there…`) with a 60-second anti-spam floor. It is cleared the moment the real reply is sent and counted in `turn_latency_logs.ack_sent`.

### 61.3 Paragraph parsing
- Cleaned make/model output for paragraph stories ("Toyota Fielder 2016 diesel at 120,000 km" -> `Toyota Fielder`).
- Purchase cost is inferred from "bought ... for KES 1,250,000" (6+ digit amounts only) and never from fuel/expense sentences.
- Existing regex + AI extraction fast-forward merge across turns, so a single paragraph can fill plate, make/model, year, fuel, mileage and cost.

### 61.4 Onboarding document prompts
- `UPLOAD_HINTS_ENABLED` (default off) gates the document-upload tips on quiz questions. Vision OCR stays hard-paused; PDFs can still be parsed silently if a user sends one unprompted.

### 61.5 Tests
- `test_natural_intake.js` (13): paragraph stories (two shapes), fuel-spend never becomes purchase cost, core prompt directive, boundary rule.

---

## 62. v1.24.1 - Reply-Speed Telemetry & Natural-Intake Kill Switch

The user-perceived reply time is now measured on every answered turn, so the two-lane worker decision is data-driven rather than guessed.

### 62.1 What is measured
- `turn_latency_logs` holds one row per answered turn: `phone`, `turn_ms` (webhook receipt to the final reply), `ack_sent` (instant ack fired first) and `created_at`.
- **v1.24.3 — `phase_ms` jsonb:** `{ setup, preAi, ai, postAi }` millisecond breakdown so a slow turn names its own bottleneck. `admin latency` prints the averages; the migration (`npm run migrate:turn-latency`) adds the column idempotently and `ensureTurnLatencyTable()` self-migrates it.
- Instrumentation lives in `processIncomingWhatsAppMessage`: `turnStartedAt` at entry, `void logTurnLatency(...)` after the final send and on the error path (never delays the reply).
- Caps mirror `ai_usage_logs`: `TURN_LATENCY_MAX_ROWS` (10000), `TURN_LATENCY_TRIM_EVERY` (250). `TURN_LATENCY_LOGGING_ENABLED` (on) is the kill switch; writes never throw.
- Migration: `npm run migrate:turn-latency` (`scripts/run_turn_latency_migration.js`); the table is part of the slate-wipe scope.

### 62.2 Commands
- `admin latency [Nh]` (aliases: `admin reply latency`, `admin turn latency`) — deterministic p50/p95/p99/average digest, instant-ack share, and a plain verdict. Audited `ADMIN_TURN_LATENCY`, zero tokens.
- `admin ai-stats` now appends `Conversation replies: p50 … · p95 … over N turns` when latency rows exist.

### 62.3 Two-lane worker — trigger and design (deferred)
- **Decision (2026-10-30): measure first.** Trigger: p95 reply ≥ 4 s for 7 consecutive days (the `admin latency` verdict states this).
- If triggered: Cloud Tasks → idempotent `/internal/parse-worker` HTTP target that owns extraction + DB writes; the front lane answers instantly (ack already exists via `INSTANT_ACK_ENABLED`) and posts a follow-up only when it has news. Merge rule stays `session.pendingWork` so a mid-flight user message is never clobbered.
- No `@google-cloud/tasks` dependency is added until the trigger fires.

### 62.4 Natural-intake kill switch
- `NATURAL_INTAKE` (default on) selects `QUIZ_INSTRUCTION_NATURAL`; `off|false|0|no|disabled` restores `QUIZ_INSTRUCTION_STRICT`. Both strings and `buildQuizQuestionInstruction()` are exported for tests.

### 62.5 Files & tests
- Files: `src/services/turnLatency.js`, `scripts/run_turn_latency_migration.js`, `src/routes/whatsapp.js`, `src/services/superadmin.js`, `src/services/conversationEngine.js`, `index.js`, `scripts/reset-db.js`, `.env.example`.
- Tests: `test_turn_latency.js` (32 — percentile math, aggregation, paging, fail-soft, digest copy, command parsing, self-cleaning DB round-trip); `test_natural_intake.js` (15 — kill-switch branches). Also repaired pre-existing pricing drift in `test_phase2_analytics.js` (Sonnet $2 / Haiku $0.50 list prices, cost total 0.0083) — it had been stale since v1.23.0.

---

## 63. v1.24.2 - Provider-Outage Hardening (the 3-5 minute reply incident)

### 63.1 Post-mortem (2026-10-31, 03:22-03:31 UTC)
- `turn_latency_logs` recorded **101 s, 124 s, 162 s and 173 s** turns for two phones.
- `ai_usage_logs.attempts` showed every turn paying for the whole chain **twice** (`intent_classify` + `prose_render`): Anthropic timed out at 15-24 s on a 13-20k-token classify prompt, OpenAI returned `429 You have no credits remaining` on every call, and the DeepSeek fallback leg inherited the premium timeout (17-30 s).
- Root causes: (1) a **billing outage** (OpenAI out of credits) was treated like a transient failure, so every call re-probed it; (2) `AI_TIMEOUT_MS_PREMIUM` was too tight for the classify prompt; (3) the DeepSeek terminal leg used the premium timeout instead of `AI_TIMEOUT_MS`; (4) silent waiting with no ack on short messages; (5) `superadmin commands` fell through to the AI chain.
- Live probes at diagnosis time: Anthropic ✅ 1.6 s, DeepSeek ✅ 1.0 s, OpenAI ❌ 429 no-credits.

### 63.2 Fixes
- **Billing-aware breaker:** `isBillingError()` classifies 401/402/403 and quota/credit 429s; `recordProviderOutcome(provider, false, now, { billing: true })` opens the breaker on the FIRST failure for `AI_CB_BILLING_OPEN_MS` (30 min). Rate-limit 429s and timeouts keep the transient ladder.
- **Per-leg timeout shaping:** primary premium leg `AI_TIMEOUT_MS_PREMIUM` (30 s, mirrored in Cloud Run), later premium legs `AI_TIMEOUT_MS_FALLBACK` (10 s), DeepSeek always `AI_TIMEOUT_MS` (12 s). Premium legs are capped by `AI_CHAIN_BUDGET_MS` (45 s); over-budget legs log `skipped_chain_budget`, DeepSeek is never gated.
- **Hard per-leg deadline:** `runLegWithDeadline()` races every leg against its budget (+2 s grace) with an `AbortController`, so a stalled socket or late timer can never stretch the chain.
- **Slow-turn ack:** `SLOW_ACK_MS` (8000 since v1.25.1; 4000 in v1.24.2) sends a rotating one-liner and marks `turn_latency_logs.ack_sent` (60-second anti-spam floor).
- **Deterministic admin help:** `admin help` / `superadmin commands` return `formatAdminHelpReply()` with zero AI calls, audited `ADMIN_HELP`.
- **Runbook for any future provider outage:** confirm with `admin ai-stats` (looking at `skipped_circuit_open` / `skipped_missing_key` / failed attempts), then `admin latency` for user impact. A billing-dead provider now costs one failed call per 30-minute window, not per message.

### 63.3 Tests & operations
- `test_phase3_resilience` (72): billing detection, instant open/hold/re-probe, end-to-end billing trip with no repeat probing, per-leg timeout shaping.
- `test_turn_latency` (35): `ADMIN_HELP` parsing + help copy.
- **Clean-slate hardening:** the global wipe's TRUNCATE block was missing `public.turn_latency_logs` (the registry had it, the SQL did not), so stale telemetry survived a wipe. Fixed, and `test_db_reset_scope.js` is now part of `npm run health`'s stateless suites so the registry and the SQL can never drift apart again.
- Post-fix baseline: `admin latency` should show p95 back under ~10 s; the two-lane worker stays deferred while the tail is provider-driven.

---

## 64. v1.24.3 - Operator Tooling & Chat-Log Health

### 64.1 Silent superadmin sessions
- `adminstart` / `adminstop` no longer send email. The session is initiated by the operator in WhatsApp, so the email was pure noise (and a Resend-quota consumer). `admin_audit_logs` (`SESSION_START` / `SESSION_STOP` / `SESSION_TIMEOUT`) remain the permanent record. Remediation and OTP emails are unchanged.

### 64.2 Revision visibility without console access
- `GET /healthz` stays metadata-free for the public. A request carrying `x-saka-secret: $SENTINEL_SECRET` additionally returns `revision` (`K_REVISION`), `service` (`K_SERVICE`) and `environment`, so an operator can confirm exactly which Cloud Run revision is serving after a deploy.
- **v1.24.4 — probe aliases.** Verified on 2026-10-31 that Google's edge intercepts `/healthz` on `saka-fleet-*.run.app` (Google HTML 404, while `/favicon.ico` and even `/Healthz` reach Fastify). The same payload is therefore also served on `GET /api/health` and `GET /internal/status` (same secret gate), built by `src/services/statusProbe.js` and unit-tested by `test_status_probe.js` (in `npm run health`).
- For full read-only deploy history, grant a service account `roles/run.viewer` and run `gcloud auth activate-service-account --key-file=<json>` then `gcloud config set project <id>`; `gcloud run services describe <svc> --region <region>` / `gcloud run revisions list` are then safe to run from this repo.

### 64.3 First-contact race (found in the 2026-10-31 chat logs)
- Observed: a brand-new number sent "Hi" and received "🙂 I'm still here with you — no need to start over" instead of the welcome.
- Cause: the turn's own user row can be persisted before the `chat_history` read (slow DB), so `firstContact` was false and the intro-copy guard replaced the welcome.
- Fix: `isFirstContact()` now returns true for a profile created within `newProfileWindowMs` (120 s) **before** the history check, and the turn filters its own row out of `dbHistory` (created within 1.5 s of `turnStartedAt`). Regression coverage in `test_greetings.js`.

### 64.4 Phase telemetry (why was that turn slow?)
- `turn_latency_logs.phase_ms` records `setup` (profile/entitlements/history), `preAi` (country bucket, KB, quiz prep), `ai` (classify + render) and `postAi` (compose + send) per turn.
- `admin latency` adds `Phases (avg): setup … · pre-AI … · AI … · post-AI …`. On 2026-10-31 the 115 s turn spent its time in `setup`/`preAi` (Supabase round-trips taking 5-10× normal with zero errors), which points at instance CPU, not the providers.

### 64.5 Live-log findings & follow-ups (2026-10-31)
- Post-wipe traffic: `+254734852529` "Hi" took 115 s (`ack_sent=true`, proving the slow-turn ack and the v1.24.2 revision were live); `+254720641985` "Adminstart" produced no assistant row.
- Profiles are created before onboarding; the welcome trial (`trial_sessions.source='welcome'`) starts when onboarding completes (`onboarding.js` / `quizEngine.js`), so an empty `trial_sessions` before that is expected — not a bug.
- **Cloud Run runtime checklist (operator):** `--min-instances=1`, `--cpu-boost`, `--no-cpu-throttling`, instance concurrency ≤ `MESSAGE_MAX_CONCURRENCY` (8). Slow Supabase round-trips with zero errors are the signature of CPU throttling.
- **v1.24.4 — onboarding loop fixed (found live at 05:32).** A real first-time number sent "Hi", "Hi", "Restart" and received the identical "I'm still here with you — no need to start over" every time (`chat_friction_logs` `LOOPING_PROMPTS`). The v1.19.2 intro-copy guard assumed any intro after history was accidental; for a zero-vehicle user who has not started onboarding the welcome IS the correct answer. `shouldReplaceIntroCopy()` now applies only past onboarding (vehicle registered), `isRepeatedReply()` guarantees a next-step nudge instead of a byte-identical repeat, and `restart`/`menu`/`help` reset `sakaIntroduced` so the welcome (with the REGISTER CTA) is shown again. Covered in `test_greetings.js`.

---

## 65. v1.25.0 - Conversational-First Onboarding & Sales Voice

### 65.1 The complaint (2026-10-31 chat logs)
- "Tell me more about saka fleet" produced a corporate blurb with zero emojis and jumped straight into a form.
- "Restart" produced a blunt option list; the insurance step asked "What is the insurance policy number and provider?" verbatim.
- "Help" produced a long wall of text; "Did you save my car?" was deflected to support.

### 65.2 The welcome (`sakaIntroText`)
Country-aware greeting → name → **hook** ("your machine's memory, money-saver and paperwork wizard") → three value anchors (⛽ every litre and shilling · 💰 cost per kilometre · 🔔 reminders before they bite) → **one next step** that also teaches the shortcut: *"type one line like 'Toyota Fielder 2016, diesel, 120,000 km, KDA 123A' and I'll pick out every detail myself"*. Emoji ceiling stays ≤4; `test_greetings.js` asserts the hook, the plate example and the ceiling.

### 65.3 VOICE LAW (top of the core prompt)
Six hard rules sit immediately after the identity lines (where models attend most): short lines · one question per message · 1–3 emojis one per line · warm opener → point → **exactly one next step** · never form-like, never more than four options, banned corporate words · mirror language/register. Two before/after examples use the exact failures observed in production. `test_agent_training.js` asserts `VOICE LAW` stays embedded.

### 65.4 Sales playbook (`SAKA_SALES_PLAYBOOK`)
Always close with the smallest next action; sell outcomes (cost per km, resale value, no missed deadlines); celebrate the first asset/log/report; risk reversal (free trial, no card, data never held hostage); never pressure, never invent prices, never ask two questions. Rendered by `buildSalesPlaybookBlock()` into the flow playbook (single source of truth) and asserted as `SALES PLAYBOOK` / `Saka the Closer`.

### 65.5 Onboarding copy
Registration and compliance quiz questions are conversational with one emoji anchor each ("First things first — what are we taking care of today? 🚗 Car · 🏍️ Bike …", "Almost done 🎉 The VIN / chassis number…", "When does the insurance expire? 📄 …"). The deterministic templates remain the floor so a provider outage can never mute onboarding.

### 65.6 Help menu & support routing
`help` / `menu` / `what can you do` → a five-line tour with one example line and a closing question. The support escalation trigger no longer fires on a bare "agent"/"human"/"support" word: only explicit phrases (`support team`, `talk to a person`, `file a complaint`, `escalate`, …) route to `support@sakafleet.com`.

### 65.7 v1.25.1 — stale prompt refinements retired + ack polish
- **Prompt schema gate:** `SAKA_PROMPT_SCHEMA_VERSION` is now `2026.11.0`. Because the marker embeds the version, `includes(PROMPT_REFINEMENT_MARKER)` is an exact-version check — the 2026-10-28 refinement in `system_config.saka_core_prompt` (which pulled replies back to "Let's keep moving" and corporate copy) is now ignored. `test_agent_training.js` asserts a stale-schema refinement is dropped while `VOICE LAW` survives. Bump this constant on any prompt-breaking release.
- **Slow-turn ack:** `SLOW_ACK_MS` default 4000 → **8000**; the line rotates per session (`⏳ Still with you…` → `🙂 One sec — checking your garage…` → `📒 Flipping through your passbook…` → `🚗 Almost there…`) and at most one ack is sent per 60 s (`src/services/turnAck.js`). `test_turn_ack.js` (in `npm run health`) covers the threshold, rotation wrap and the anti-spam floor.

### 65.8 Stop/pause is deterministic (v1.25.2)
Retiring the stale refinement also retired its stop/pause policy, so v1.25.2 restores it **in code**: `isStopRequest()` (bare `stop`/`pause`/`unsubscribe`, plus frustration phrases like "stop with the many replies") sends `PAUSE_REPLY` once, sets `session.paused`, skips the AI entirely and returns `status='paused'`. The user's next message resumes the conversation. Business intents are never stolen ("stop at the petrol station", "cancel my subscription", and the quiz-exit `cancel` stay with their own flows). Covered in `test_greetings.js` and `test_reliability.js`.

---

## 66. v1.25.0 - Product Q&A (Saka answers anything about herself)

- `src/services/productQa.js` is the user-facing answer engine: pricing, trial, what Saka is, what can be logged, privacy, countries/units, fleet limits, passbook/resale value and support.
- **Facts are engine-owned:** prices come from `TIER_MATRIX`/`getTierPriceUSD` and the trial length from `TRIAL_DAYS` — a pricing change can never leave stale copy. `test_product_qa.js` (in `npm run health`) asserts the generated price equals the registry and that no answer mentions providers, databases, env knobs, admin tooling or remediation.
- **Deterministic first:** question-shaped messages ("what is cost of this service?", "is my data safe?", "how many cars can I add?") are answered instantly with zero tokens; statement messages ("I paid 5000 for fuel") are never hijacked into the pricing card.
- **AI long-tail with a gate:** the core prompt carries `buildProductQaContext()` — the canonical answers plus `BACKEND GATE` (never reveal servers, APIs, databases, providers, env vars, admin tools) and the graceful deflection line ("that's all under the hood 🙂 — what it means for you is …").
- **Why not feed the architecture document?** It is the backend reference (env knobs, superadmin commands, remediation pipeline). Injecting it would blow the prompt budget and leak internals; the registry is its curated, user-safe mirror, kept in sync by the versioned tests instead.

---

## 67. v1.25.2 - Full App Audit & Documentation Guard

### 67.1 Audit scope
Repo-wide inspection: 159 tracked files, 56 `test_*.js` suites, live DB health, dependency list, script inventory, log noise and documentation drift. Live errors: **none** (`error_logs` empty).

### 67.2 Exhaustive suite runner (`npm run test:all`)
`scripts/run_all_tests.js` executes **every** `test_*.js` file standalone (240 s timeout each), prints a pass/fail table, writes `test-all-report.json` (gitignored) and finishes with the permanent cleanup sweep. This closes the gap where 27 suites were never exercised.

### 67.3 Findings & fixes
- **Environment-sensitive suites** — `test_model_router.js` and `test_phase1_canary.js` now clear all provider keys (and pin `PREMIUM_MODEL_ENABLED=off`) before asserting no-credential/DeepSeek paths, because a real `.env` routes front purposes to Sonnet. `test_model_scout.js` pins `AI_MODEL_SCOUT_ENABLED=off` around the digest assertion. `test_reliability.js` clears provider keys for the 3-strike breaker test (the detector needs deterministic replies) and `test_sentinel_recovery.js` counts only Meta `graph.facebook.com` dispatches (provider fetch stubs are no longer mistaken for nudges).
- **Phase-1 invariant refreshed** — "premium off → DeepSeek" was superseded by v1.23.0 (front purposes are Sonnet-first on every plan); the canary test now asserts the Sonnet front leg and its telemetry.
- **Retired legacy suites:** `test_agent_flow.js` (pre-v1.7 static strings), `test_daudi_journey.js` (pre-quiz `onboardingStore.core` shape), `test_whatsapp_flow.js` (pre-quiz onboarding step) and `test_sentinel_phase2.js` (presumes seeded vehicle data for the audit copy) are renamed `legacy_*` and documented here; they no longer run in the sweep. Conversational-journey replacements are tracked as follow-up work.
- **Documentation drift** — `SLOW_ACK_MS` was documented as 4000 in §61.2/§63.2 (now 8000, tuned v1.25.1). Version and assertion counts refreshed.
- **Package metadata** — `package.json` was stuck at `1.0.0`; it now mirrors the release version (1.25.2).
- **Artifacts** — `reset-backup-*.json`, `test-all.log`, `test-all.err.log` and `test-all-report.json` are gitignored (backups stay on disk, never in git).
- **Known follow-ups (documented, not yet done):** split the 3.1k-line `whatsapp.js` into route modules; replace remaining `console.log` noise with a structured logger (whatsapp 13, index 11, mailer 10); add conversational-journey replacements for the retired legacy suites.

### 67.4 Documentation guard (`test_doc_sync.js`)
Stateless suite (in `npm run health`) that fails when:
- the architecture version line drifts from `package.json`,
- a documented default (`SLOW_ACK_MS` 8000, `AI_TIMEOUT_MS_FALLBACK` 10000, `AI_CHAIN_BUDGET_MS` 45000, `AI_CB_BILLING_OPEN_MS` 1800000, `AI_TIMEOUT_MS_PREMIUM` 30000, telemetry caps) drifts from the code constants,
- a required section (§62–§67) disappears, or
- README stops mentioning the current release line.

### 67.5 Release hygiene
`npm run health` remains the pre-push gate: stateless suites (now including doc sync, product Q&A, status probes and ack behaviour), workflow lint, release tracker and the DB/CI snapshot.

### 67.6 Release identity & changelog (v1.25.3)
- **Deploy alerts name the commit in the title** — `✅ Saka update is live - v<version> - <hash>` — and append a GitHub commit link (`scripts/notify_git_push.js`, `repoWebUrl()`), so a release is identifiable without reading the footer.
- **`CHANGELOG.md`** is generated from the real git history (version, date, commit, one-line summary per release, plus earlier milestones). It is guarded by `test_doc_sync.js`: the newest entry must equal `package.json` and historical entries must name their commit. Update it in the same commit as any release (rule 13 sync).

---

## 68. v1.25.7 - Deploy Telegraph, Field-Work Sync & Rules Gate
### 68.1 Two notifications, every deploy path
- **Building:** `deploy_notify.yml` (push to main) sends `Saka update building - v<version> - <hash>` with a plain-English headline and the promise of a second message (`scripts/notify_git_push.js`).
- **LIVE:** the app itself announces the revision at boot — `announceRevisionLive()` (`src/services/deployLiveAlert.js`) compares `K_REVISION` with `system_config.last_deployed_revision`; on change it upserts the key and sends `🚀 Saka is LIVE - v<version> · <revision>` exactly once. This works for local pushes, **cline.bot pipelines** and manual console deploys, and survives restarts without repeating.
- GitHub does not chain-trigger workflows for pushes made with the Actions `GITHUB_TOKEN`; cline.bot's merges therefore may skip the "building" alert, which is why the in-app LIVE alert is the guaranteed channel.

### 68.2 Field-work protocol (remote fixes)
- `.clinerules` rule 32-34: a local session must `git fetch origin && git pull --ff-only origin main` (or `npm run sync:origin`) before any work; every field fix ships targeted suites + `npm run health`, a version/history/changelog sync in the same commit and the `v<X.Y.Z>: …` commit style.
- `npm run health` now warns `branch sync - local is N commit(s) behind origin/main` so a stale checkout can never go unnoticed.

### 68.3 Rules Gate
- `.github/workflows/rules_gate.yml` runs the stateless rule suites (agent training, greetings, product QA, ack, status probes, reset scope, notifications, doc sync) on every push to main and every PR. Failure dispatches `⚠️ Saka build rules check FAILED - <hash>` through `notify_git_push.js --failure` so remote fixes that break the rules are immediately visible.

### 68.4 Operator CLI
- GitHub CLI is available for run inspection (`gh run list`, `gh run view`). Installation is a machine-level setup step; `gh auth login` is required once per workstation.

---

## 69. v1.26.0 - Conversational Answer Engine (answer first, anticipate always)

### 69.1 The failure it fixes (live evidence 2026-10-31 14:36-14:40 UTC)
- "What are the costs of using Saka?" → "Logged expense of amount." (plural "costs" missed the matcher; the AI read it as an expense log).
- "How do I use saka?", "What are the details of Solo Pro?", "How do the add ons work?" → the **plate script** ("send me your vehicle's registration plate").
- "Why do you need my VIN?" → an **apology + automated prompts paused** (the friction detector treated "why do you" as frustration).
- Root causes: the AI had no answer-first instruction; the FAQ registry had gaps; `checkIsConversationalFeedback` contained question-shaped keywords (`why do you`, `why are you`, `again`, `wrong`, `huh`).

### 69.2 Anticipated-question matrix (new `PRODUCT_QA` entries)
`how_to_use` · `how_to_subscribe` · `tier_details` (built from `TIER_MATRIX`) · `addons` (price from `TIER_MATRIX.fleet_command.addonMonthlyUSD`) · `why_details` (why plate/VIN/email) · `mistakes` (edit/undo, VIN exception) · `progress` (how many questions, skipping) · `technical` (no app, low data) · `data_control` (export/delete) — plus `costs?`/`price[sd]?` coverage in the pricing matcher.
These are exactly the questions a person asks **right before sharing personal vehicle details**, so they are answered instantly, deterministically and without a plate ask.

### 69.3 Answer-first enforcement
- `buildProductQaContext()` now carries an **ANSWER-FIRST RULE** and an explicit prohibition: *never reply with the registration/plate script unless the user asked to register, said REGISTER, or sent a plate.* `test_agent_training` asserts both strings in the assembled prompt.
- The recognised product question **outranks the friction apology** in the unregistered branch (`!productQaMatch` guard).

### 69.4 Trust lines on sensitive asks
The quiz copy now reassures at the exact moment of hesitation: plate (`only to keep *your* records, never shared 🔒`), VIN (`locks into your private passbook forever`), email (`only for your OTP`), OTP (`10 seconds`).

### 69.5 Proof
`npm run test:flow` drives the real handler through today's exact conversation plus the anticipated matrix (28 assertions): each question gets its card and **none** may contain the plate script. `test_product_qa` is now 102 assertions.

### 69.6 v1.26.1 — generic answers removed at the root
- **Product answers are composed, not pasted.** The `productQa` registry is now *knowledge*: the AI writes each answer fresh from the verified facts (`purpose: 'product_answer'`). The canned card is retained only as the outage/short-answer fallback (a composition under 60 chars, or a pricing/trial/tier/add-on answer without any figure, is replaced by the complete verified card).
- **The nudge family is gone from the happy path.** "Let's keep moving", "Happy to help you begin", "Welcome! Let's get you started", "I'm still here with you" are listed as **BANNED PHRASES** in the core prompt. A repeat no longer swaps in a canned line — it asks the composer for a genuinely different, warmer phrasing (`purpose: 'repeat_variation'`).
- **No plate ask outside the registration quiz.** The welcome, greeting, and default compose prompts now ask *"What do you drive? One line is enough"*; the plate question exists only inside the deterministic registration quiz. `test_first_message_flow` asserts the welcome, the intro and every FAQ answer never ask for a plate.
- **Small talk no longer hides a question.** `matchProductQa` strips leading interjections ("Nice.", "Ok", "Cool", "Please"), so *"Nice. Tell me more about Saka"* reaches the intro answer instead of the AI's generic script.
- Proof: `npm run test:flow` is now **30 assertions** (welcome, pricing, trial, intro + the 8-question matrix, each checked for no canned line and no plate ask); `test_product_qa` 103; `test_agent_training` 92; `test_greetings` green.

### 69.7 v1.26.2 — free-service routing + the no-plate invariant
- **"Is this a free service?" / "Is it free to use Saka?"** now route to the pricing answer — the pricing matcher was missing the word `free`.
- **Hard no-plate invariant (code-enforced):** after composition, if the user is not inside the registration quiz, has no vehicle and did not type REGISTER, any reply that mentions "plate" is replaced with a warm one-line invitation ("Tell me what you drive — one line is enough… Or reply REGISTER"). The model can never re-introduce the plate ask outside registration. The intro prompts additionally forbid the word itself.
- Proof: `npm run test:flow` is now **37 assertions** — every turn (welcome, pricing, trial, intro, the 8-question matrix and both free-service turns) asserts the reply contains no "plate". `test_product_qa` 105.

## 70. Answer Oracle (v1.27.0) — answer ANY question, zero pre-made replies

### 70.1 Why training alone was not enough
`test_agent_training` proves the registry is embedded in the prompt; it cannot prove the model follows it. The live 16:00–16:07 test failures were fact and routing gaps, not training gaps:
- annual prices were absent from the Q&A facts → the model hedged;
- no capacity math → "8 cars" recommended Team Fleet (3 cars);
- no matcher topic for "details of each package" / "features" → fell to the generic intro;
- no farewell path → "Ok. Bye" re-triggered the welcome;
- a tester's opinion triggered the canned friction apology.

### 70.2 Facts, not answers (`src/services/productQa.js`)
The registry now stores **plain fact lines only** (no marketing copy). Prices, limits and the annual figures come live from `subscriptionTiers.js`; the trial length from `trialEngine.js`. New ids: `features`, `packages`; `pricing` now renders monthly **and** annual prices, so an annual question can never be hedged. `buildProductQaReply()` is the outage fallback and the composer's context.

### 70.3 Computed capacity (`recommendTierForFleet`)
"I have 8 cars" is arithmetic, not model work: 1 → Free · 2–3 → Team Fleet · 4–5 → Growth · 6+ → Fleet Command (5 included + N−5 add-ons) with the exact monthly/annual total. The result is injected as a fact and must be used verbatim.

### 70.4 Realtime user data (`src/services/userContextSnapshot.js`)
Builds the account facts a user can ask about: name, plan + status, vehicles (model, plate, odometer, fuel), this month's expense count/total/fuel litres, and the next four reminders with days remaining. Numbers are computed in code; the service never throws (a failed query removes that fact line only).

### 70.5 The Answer Path (`src/routes/whatsapp.js`)
- **Product questions** (`matchProductQa`) → topic facts + computed recommendation + user snapshot → `composeMessage({ purpose: 'product_answer' })` → `sanitizeSakaReply`.
- **Any other question** (interrogative shape or "?") in the idle branch → all product facts + the user snapshot → `composeMessage({ purpose: 'user_data_answer' })`. A product match always outranks this path.
- **Farewell** ("Ok. Bye") → one warm goodbye; never the welcome.
- **Feedback** (tester notes, "templates are stupid") → acknowledged in plain words and logged as `USER_FEEDBACK`; the apology flow is reserved for genuinely broken flows.

### 70.6 Personality v2 (`SAKA_TONE_COMPASS.voice` + `bannedPhrases`)
Saka is "your machine's memory, money-saver and paperwork wizard — never a support assistant". Answer first, one next step, plain words, the number attached. **Banned hedge family:** "I don't have that information to share", "I don't have any details to confirm", "As an AI language model", "I understand your frustration" (plus the whole nudge family). The core prompt now carries an **ANSWER LAW**: never answer a question with a welcome, tour, menu or template.

### 70.7 Reply linter (`sanitizeSakaReply`)
The model can never ship a corporate hedge, an empty capacity placeholder (`· vehicles`) or an unfilled token (`undefined`/`null`/`NaN`); a violation falls back to the verified fact lines.

### 70.8 Testing-phase clean slate rule
`.clinerules` rule 35: during this testing phase, clean slate wipes may be requested at any time, as often as needed; `npm run reset-db -- --all --confirm --backup` runs immediately and every operational table is verified at 0 rows.

### 70.9 Proof
`test_product_qa` **128 assertions** (annual pricing, features, packages, capacity math, linter, no empty placeholders) · `test_answer_oracle` **26 assertions** (live routing + seeded DB snapshot: plan, vehicles, month spend, reminders, days-left) · `test_first_message_flow` now includes features, package details, the 8-car recommendation, an annual question and a goodbye that must never be a welcome · `test_agent_training` asserts the ANSWER LAW and the banned hedges.

### 67.7 Sentinel refinements must carry the schema marker (v1.25.3)
- `runConversationRefinement()` wrote the refined prompt **without** the `SAKA-PROMPT-SCHEMA` marker, so the v1.25.1 gate ignored every weekly refinement — and the unmarked 3k-character legacy prompt kept reappearing in `system_config`. The writer now stamps `PROMPT_REFINEMENT_MARKER` and bounds the payload to `MAX_STORED_PROMPT_REFINEMENT_CHARS`, so a refinement can only ever augment the current, trained prompt.
- **Admin help aliases (v1.25.3):** `list commands`, `list superadmin commands` and `show admin commands` also route to the deterministic command list (`ADMIN_HELP`); before this they fell through to the AI chain and produced the "Let's keep moving" nudge.

### 65.9 Live-chat flow fixes (v1.25.4)
- **Product FAQ reaches "sakafleet":** `what_is_saka` now matches `sakafleet` and `saka fleet` as phrases, so *"Tell me about sakafleet"* answers instantly with the warm intro instead of falling through to the AI and being eaten by a guard.
- **Repeat nudges rotate:** the anti-repeat replacement is no longer one fixed sentence. `pickRepeatNudge()` alternates between "Let's keep moving…" and a warm options line (*REGISTER* / *pricing* / tell me what you drive), and `session.nudgeCount` resets on real progress (quiz start, vehicle registered, restart/menu). A confused user ("???") always receives a next step, never the same line twice.
- Evidence: 2026-10-31 09:01–09:02 UTC, a prospect asked "Tell me about sakafleet" and "???" three times and received the identical nudge each turn.

### 65.10 The welcome survives the plate guard (v1.25.6)
- **Bug:** the v1.21.3 zero-vehicle guard replaced any reply that asked for a plate — including the v1.25.0 **sales welcome** (which offers the plate example as one option). Plain "Hi" therefore never showed the welcome; it showed "Let's set up your first asset".
- **Fix:** the guard is now `shouldReplacePlateAsk()` and is skipped when `firstContact`, when the reply already **is** welcome/intro copy, during an active quiz, for registered users, and for explicit `REGISTER` messages.
- **FAQ phrase coverage:** `tell me (more) about saka fleet / sakafleet / you` routes to the warm intro card.
- Evidence: 2026-10-31 12:52–14:40 local (09:52–11:40 UTC) — "Hi" received nudges and "Welcome! Let's get you started" variants instead of the sales welcome.

### 65.11 Root cause: the repeat guard compared the reply with itself (v1.25.8)
- **The bug:** `session.lastAssistantPrompt` is written to the CURRENT reply at the loop-signature step (line ~2932), and the anti-repeat guard (line ~3002) then read that same field. `isRepeatedReply(reply, lastPrompt)` therefore compared the reply to itself → **always true** → every genuine answer (sales welcome, pricing card, trial card, FAQ card) was replaced by a rotating "newcomer nudge". The nudges then became the next `lastAssistantPrompt`, producing the endless "Let's keep moving" / "Welcome! Let's get you started" loop.
- **Proof:** a local end-to-end reproduction through `handleWhatsAppWebhook` (real handler, real DB) returned the pricing card on turn 1 and a nudge on turn 2 — matching production exactly — and `session.lastAssistantPrompt` afterwards held the trial card that *should* have been sent.
- **Fix:** capture `previousAssistantPrompt` BEFORE the loop-signature update and guard against that value. The guard now compares this turn's reply with the previous turn's reply, as designed.
- **Also fixed:** new profiles no longer get the placeholder `full_name = 'WhatsApp User'` (they start with `null`, and `sakaIntroText` ignores that placeholder), which had produced greetings like "Habari! 👋 WhatsApp I'm Saka".
- **Permanent regression:** `test_first_message_flow.js` drives the real handler and asserts "Hi" → sales welcome, "How much does it cost?" → pricing card, "What's the trial period?" → trial card, "Tell me more about saka fleet" → intro card, each explicitly NOT replaced by a nudge. Run with `npm run test:flow` (DB-backed, self-cleaning).


### 65.10 Newcomer nudge fix (v1.25.5)
- A new sign-up (no vehicle, no quiz) never receives "Let's keep moving"; the repeat guard uses `NEWCOMER_NUDGES` / `pickNewcomerNudge()` (REGISTER-oriented) instead.
- First contact clears stale `lastAssistantPrompt` / `nudgeCount` so a warm instance cannot trigger the repeat guard.
- `isFirstTimeMessage()` ("this is my first time", "let's keep moving to what?") answers with the welcome + REGISTER step. Covered in `test_greetings.js`.

---

## 71. Human Saka 2.0 (v1.28.0) — typo tolerance, no re-greeting, local prices, contact nudge, append-only learning

### 71.1 Typo & omission tolerance (`src/services/textNormalizer.js`)
- `prepareRoutingText()` = lowercase → strip diacritics/emoji/punctuation → collapse whitespace → typo map + adjacent transposition + fuzzy Levenshtein (≤1/≤2) + missing-space split, all against a fixed routing dictionary.
- Applied ONLY to routing: `matchProductQa` (the trailing-question shape is also checked on the raw text), `classifyIntentWithRegex` greeting/action-discovery, `isStopRequest`, `shouldPauseQuizForChat` greetings/help. Extraction, storage and display always use the raw message — plates, VINs and amounts are never rewritten.
- `test_text_normalizer.js` proves the behaviour and the no-rewrite invariant.

### 71.2 GREETING LAW + reply linter
- The core prompt (`sakaAi.js`) and composer (`conversationEngine.js`) carry an explicit GREETING LAW: greet only on first contact or when the user greeted this turn; never open a reply with Hi/Hello/Habari/Good morning once the conversation is underway.
- `sanitizeSakaReply(text, fallback, { historyLength })` rejects a greeting opener when `historyLength > 0`; first contact is unaffected. Covered in `test_greetings.js`.

### 71.3 Payment answers in the user's currency
- `buildLocalPricingFacts({ supabase, currency, locale, fleetCount })` converts every paid tier + the Fleet Command add-on with `getEffectiveExchangeRate()` (the same cached rate Paystack charges at checkout), states the free tier without a price, and labels the figures approximate. USD needs no extra facts.
- **v1.28.1 — local currency is exclusive:** when a local currency is available, dollar figures are removed from the verified facts, the composer is instructed to quote local only, and the finished reply is scrubbed by `stripUsdFigures()` — a hard invariant (like the plate guard). `formatUsdInLocalCurrency()` now returns "KES 519", never "KES 519 (≈ $3.99)".
- A fleet-size question gets a computed local total (`For 7 vehicles: Fleet Command ≈ KES 4,676/month …`), so plan math is never shown in USD.
- The `product_answer` and `user_data_answer` paths both inject the local facts; USD users keep the USD facts unchanged.
- `test_product_qa.js` asserts KES conversion, the computed 7-vehicle total, the absence of `$`/`USD`, and the scrubber. v1.28.4 adds `hasLocalFigure()`: a money answer must contain a numeric local figure ("KES 1,298"), not merely the currency name, or the complete local fact lines are used.

### 71.4 Save-my-number nudge (`src/services/contactNudge.js`)
- Fires once per profile at the first milestone (vehicle registered + passbook issued) and on a lost-chat moment; 30-day cooldown (`CONTACT_NUDGE_COOLDOWN_DAYS`), stamped in `profiles.contact_save_nudged_at` (`npm run migrate:contact-nudge`, fail-soft boot `ensureContactNudgeSchema`).
- Never during a quiz/confirmation, never to a frustrated or paused user. The line is AI-composed from facts (`purpose: 'contact_save_nudge'`) with a deterministic fallback, and the wording never uses the word "plate".
- Suggestion: save as "Saka – KDA 123A" or any name the user likes.

### 71.5 Learning framework hardening (`runConversationRefinement`)
- The worker no longer rewrites the core prompt. It returns up to five short `learnings`, appended under `SENTINEL LIVE LEARNINGS` inside the schema marker and the 2,000-char bound (oldest learnings drop first).
- `refinementIsSafe()` rejects a missing marker, an oversized payload and any banned phrase that is not explicitly negated. The trained `DEFAULT_SAKA_CORE_PROMPT` remains immutable code.
- `buildUserContextSnapshot()` adds relationship stage (stranger/newcomer/regular/veteran) and remembered preferences (language, units, timezone, preferred vehicle) — no schema change.

### 71.6 Generated knowledge docs (`scripts/gen_kb_docs.js`)
- `npm run docs:gen` renders `docs/PRODUCT_QA.md` (every registry topic + generated facts) and `docs/SAKA_TRAINING.md` (prompt schema, tone compass, banned phrases, sales playbook, flow playbook, full core prompt) from live imports.
- `npm run docs:check` + `test_kb_docs.js` (Rules Gate + `npm run health`) fail when the committed docs drift from the code, so the QA file and Saka's training stay current with every deploy.

### 71.7 Scoped multi-part banking (`quizEngine.applyTextExtraction`)
- A multi-part sentence is scoped per field before parsing (volume → L/gal fragment, distance → km/mi fragment, amount → currency-adjacent or non-unit number, fill type → phrase, expense type → keyword). Without this, "5000 for 40 litres at 366900 km" filled every numeric field with 5000.
- Banked fields are collected in `state.bankedThisTurn` and acknowledged once by `askCurrent()`; the confirmation-before-write gate is unchanged. Covered in `test_quiz_flow.js`.

### 71.8 Proof
`test_text_normalizer` 24 · `test_contact_nudge` 24 · `test_greetings` 75 · `test_product_qa` 142 · `test_agent_training` 102 (incl. the learning content gate) · `test_quiz_flow` 60 · `test_kb_docs` 36 · `test_answer_oracle` 31. `npm run health` green.

### 71.9 Local-currency-only rule + reply-complaint recovery (v1.28.1)
- **Live evidence (2026-10-31 18:40–18:43):** a Kenyan prospect saw `KES 10,901/year ($83.92)` on an annual question, a pure-USD `$27.99/$3.99/$35.97` card on "What if I have 7 vehicles?", and was re-welcomed twice ("Karibu! I'm Saka…") after saying *"Your last reply was incomplete"*.
- **No dollar values:** `stripUsdFigures(text, { currency })` removes `$12.34`, `(≈ $9.99)` and `USD 9.99` and rewrites a bare `USD` to the local code. It is applied to product and user-data money answers whenever local facts exist; the verified-fact lines are filtered of `$`/`USD` first, and the composer is told to quote local only. Replies without a local currency code fall back to the complete local fact lines.
- **Computed local fleet totals:** `buildLocalPricingFacts(..., fleetCount)` adds `💡 For N vehicles: Fleet Command ≈ <local>/month (5 included + N-5 extra slots)`.
- **Complaint recovery:** `isIncompleteReplyComplaint()` recognises *"your last reply/brief/answer was incomplete / cut off / cut short"*. The route acknowledges, logs `INCOMPLETE_REPLY_COMPLAINT`, and — if a fleet count is present — delivers the full local-currency answer immediately. It never re-introduces Saka or shows the welcome.
- **"Tell me a little about Saka"** now routes to the warm intro facts (`what_is_saka`) instead of the generic greeting fallback.
- **Proof:** product Q&A 142 · greetings 75 · answer oracle 31 · `test_first_message_flow` extended with local-only annual/7-vehicle turns and the complaint turn.

### 71.10 Complete replies — thinking budget & truncation guard (v1.28.2)
- **Live evidence (2026-10-31 19:09):** Saka's reply ended mid-word at *"…I also remind you before insur"*. `ai_usage_logs` showed `prose_render · anthropic · claude-sonnet-5-5 · completion_tokens 420/420`; the intent call also maxed its 800-token cap. Sonnet 5.5 was spending the shared output budget on hidden `thinking` blocks, so the visible text was chopped.
- **Fix:** `buildAnthropicPayload()` turns thinking off with the gateway-supported `thinking: { type: 'between_tools' }` (the live gateway rejects `disabled` with HTTP 400; a probe after the fix returned `stop=end_turn`). `ANTHROPIC_THINKING_MODE` overrides the mode, and `ANTHROPIC_THINKING_ENABLED=on` opts into provider-default thinking for deliberate reasoning work. Temperature remains opt-in via `ANTHROPIC_TEMPERATURE_SUPPORTED`.
- **Truncation can never ship:** `normalizeAnthropicResponse()` surfaces `stop_reason`; `runAnthropicAttempt()` throws on `max_tokens`, so the provider chain falls back to DeepSeek (which always completes) instead of returning half a sentence.
- **Retired identity blocked:** the regex classifier's canned greeting ("intelligent WhatsApp vehicle & asset management assistant") is gone (`reply_message: null`), `isLegacyWelcomeCopy()` blocks legacy copy at all four route passthroughs, and the core prompt carries an **IDENTITY LAW** (machine's memory, money-saver, paperwork wizard). "Let's start again" now maps to `isFirstTimeMessage()` → the warm sales welcome.
- **Proof:** new `test_anthropic_payload.js` (13 assertions) in `npm run health` + the Rules Gate; `test_greetings` 81; `test_first_message_flow` adds the restart turn.

### 71.11 No phantom plates — paragraph intake hardening (v1.28.3)
- **Live evidence (2026-10-31 19:51):** "…register my car A 1991 80 series…" banked the odometer/year fragment **"1991 80"** as the plate, so Saka claimed "plate details you already shared"; the real **"KAS 628T"** volunteered one turn later was skipped and would have been saved wrong.
- **Structural check:** `isPlateLike()` requires ≥2 letters, 1–6 digits, (≥3 letters OR ≥3 digits), rejects odometer-style digit prefixes and part-groups like "80 SERIES"/"TOYOTA 2016". `parsePlate()` now uses it for direct answers too.
- **Windowed scan:** paragraph capture tests 1–4-word candidates instead of the greedy character regex that swallowed `KAS` into the previous word. "Car Registration KAS 628T" now banks **KAS 628T** while answering the asset kind.
- **Self-heal:** registration-only — a previously banked non-plate-like plate is dropped before scanning, so a phantom can never block the real plate or reach the confirmation summary.
- **Proof:** `test_quiz_flow` 74 assertions (incl. the exact live two-turn sequence); `test_natural_intake` 15.

### 71.12 Write-time plate guard (v1.28.4)
- **Live evidence (2026-10-31 20:09):** the confirmation summary for the same session showed `🔢 Plate: 1991 80` — a phantom captured before v1.28.3 was deployed. Had the user replied YES, the wrong plate would have been written.
- **Guard:** `executeFlow('vehicle_registration')` now refuses to persist when `requiresPlate(asset_kind)` is true and `isPlateLike(plate_number)` is false: it deletes the plate, returns to the question phase and re-asks for it (nothing is written). This also protects sessions created by older builds and keeps the confirmation summary honest.
- **Proof:** `test_quiz_flow` 77 assertions (adds the confirmation-refusal case).

### 71.13 Fuel volume derived from spend ÷ price (v1.28.4)
- **Live evidence (2026-10-31 20:14):** "Topped up fuel; 1000kes @227kes per liter, @367365km" was answered with "How many litres did you put in?" — the message already contains the arithmetic.
- `extractVehicleAttributes()` now derives `fuel_liters = round(spend / price-per-litre, 2)` when no explicit volume is present, flags it as `derived_fuel_liters`, and never overwrites a stated volume ("Logged 40L …" stays 40). The one-line quick log therefore saves immediately instead of starting the quiz.
- **Proof:** `test_natural_intake` adds the live message (4.41 L) and the explicit-volume guard.

### 71.14 Mileage reminders actually save (v1.28.5)
- **Live evidence (2026-10-31 20:17–20:20):** "Log an oil change reminder. To happen @370,000km" → type and distance were collected, the summary showed "Due at: 370,000 km", but CONFIRM failed with a date-flavoured error and the user cancelled.
- **Root cause:** threshold reminders intentionally omit `due_date`, while the legacy `reminders.due_date` column is `NOT NULL` — the insert was rejected (the composer paraphrased the constraint error as "the due date didn't come through"). The columns themselves already existed.
- **Fix:** `npm run migrate:reminder-due-date` runs `ALTER TABLE public.reminders ALTER COLUMN due_date DROP NOT NULL`; the same statement is inside the boot `$v18$` DDL so new environments heal automatically.
- **Trigger banking:** the flow-start path now passes the triggering message into `startQuiz`, so `applyTextExtraction` banks `reminder_type` and the `due` threshold from the first sentence (`set_reminder` only). A part blocklist prevents prose like "CAR A 1991" from looking plate-shaped.
- **Proof:** `test_quiz_flow` 88 assertions — the live sentence reaches confirm with `Oil change` + 370,000 km, and the confirmed row is inserted with `threshold_unit='distance'`, `target_value=370000` and **no `due_date` key**; both the migration and the boot DDL are asserted.

### 71.15 Report requests never become logging flows (v1.28.6)
- **Live evidence (2026-10-31 20:53–20:54):** "Give me a fuel report for kas" and "Give me fuel report" both started the expense quiz ("How much did it come to?"). The classifier leaned LOG_EXPENSE because the message mentions fuel.
- **Guard:** `looksLikeReportRequest()` treats any message containing report/summary/statement/analysis/breakdown/overview (unless it starts with log/record/add/save) as a report request. `detectQuizStart()` returns null for it, and the route upgrades a misclassified LOG_EXPENSE / LOG_EARNINGS / UPDATE_MILEAGE / QUERY_FUEL_EFFICIENCY intent to `REQUEST_REPORT`, so the report engine (and its quota/access rules) owns the turn.
- The REQUEST_REPORT playbook line now states the rule explicitly, so the model never reclassifies a report request as a log.
- **Proof:** `test_quiz_flow` 95 assertions (the two live report messages never start the quiz; "log fuel" still does).

### 71.16 Reports never vanish, PDFs are glyph-safe, trials speak local money (v1.28.7)
- **Silent report loss fixed:** the live 21:06:33 / 21:07:03 "fuel report" / "fleet report" turns replied with the background ACK and then delivered nothing. `runFleetReport` now wraps `buildReportForLane` in try/catch, `deliverReportPdf` always reports a status (and a recovery line when the PDF cannot be linked), and `processPendingFollowUps` sends a deterministic "report hit a snag — reply report" message for any failed report job, so a user can never be left with silence.
- **Storage self-heal + link fallback:** `uploadReportToSupabase()` (reports.js) retries once after `createBucket('fleet-reports', { public: true })` and falls back to a 24-hour signed URL, so the "empty link" can no longer happen.
- **PDF glyph safety:** `pdfSafeText()` in `pdfEngine.js` maps em dash / arrows / comparators / check marks to ASCII, removes every emoji/pictograph range and drops characters outside Latin-1; `buildProReportPdf()` wraps `doc.text` with it, covering cover pages, KPI cards, charts, tables, sections and footers. `test_pdf_engine.js` renders an emoji-heavy report and asserts a valid `%PDF-` header, a `%%EOF` trailer and at least one page object.
- **Trial award localization:** `ownerLocaleContext()` (trialEngine) resolves currency, locale and timezone from the profile or the phone's country; `trialDateLabel()` formats every trial date in that locale/timezone. `activationRewardText()` shows monthly **and** yearly local prices, states explicitly that ACTIVATE20 discounts the first payment (monthly or yearly) and is **not** extra free days, and invites "extend trial". `issueActivationCoupon()` stamps `trial_sessions.coupon_code`, fixing the nudge checkout that previously went out at full price. The winback checkout now uses the owner's currency instead of USD.
- **Operations registry:** `SAKA_OPERATIONS` (owner + driver lanes) + `buildOperationsList()` / `buildOperationsBlock()` in `flowKnowledge.js`, rendered by `sakaIntroText()` (first contact), guaranteed in `renderActionDiscovery()` (on-demand help; appends the deterministic block when the model omits it) and injected into the core prompt as `SAKA_OPERATIONS_PROMPT_BLOCK`. Emoji policy: one anchor per operation line, no fixed total ceiling for the welcome list.
- **Reminder phrasing:** `describeThresholdSpec(spec)` now emits "in 5,000 km" for relative intervals and "at 370,000 km" for absolute targets (plus "in 36 operating hours"), so a user can tell an interval from an odometer reading.
- **Proof:** `test_pdf_engine` 15 · `test_greetings` 83 · `test_quiz_flow` 95 · `test_trial_engine` 73 · `test_maintenance_reminders` 46 · `test_followups` 12 · `test_agent_training` asserts the capability registry is embedded.

### 71.17 OCR unpaused, continuous learning, country tone and recovery ladders (v1.28.8)
- **OCR end to end:** `isOcrEnabled()` (ocrService.js) is env-driven again and defaults ON (`OCR_ENABLED=off|false|0` pauses); `UPLOAD_HINTS_ENABLED` defaults ON, so quiz turns can offer a photo for the pending document. PDFs still use the local text layer, ack-first still answers instantly, low confidence still asks for confirmation and nothing is written without YES. Applies to: receipt photos, logbooks, insurance/inspection documents, driver licences and odometer photos.
- **Self-learning runs on its own:** `index.js` ticks `runConversationRefinement(supabase)` every `SENTINEL_LEARN_INTERVAL_MS` (default 15 min) behind an in-flight guard. Previously refinement only ran via the external `/api/sentinel/run`, so `saka_core_prompt` and `conversation_analytics` stayed empty.
- **Country communication styles:** `src/services/countryCommStyles.js` derives deterministic per-country profiles from transcripts (`deriveCountryCommStyles`), persists them in `country_comm_styles` (Sentinel upsert + `ensureSentinelTables` DDL), and `getCountryCommStyleLine()` (10-minute cache) appends a `COUNTRY COMMUNICATION STYLE (XX…)` line to the per-turn jurisdiction context in the WhatsApp route.
- **Abandoned-checkout recovery:** `processAbandonedCheckouts()` runs inside the 15-minute trial sweep. Stage resolver `resolveAbandonedCheckoutStage()`: T+30 min (`CHECKOUT_ABANDONED_AFTER_MIN`), T+24 h, coupon T-2 days; capped by `CHECKOUT_REMINDER_MAX` (3) and stopped when the trial converts. `checkoutForTier()` keeps the FIRST `checkout_started_at` (resets only after an hour) so nudges cannot rewind the ladder. Copy (`abandonedCheckoutText`) is deterministic, local-currency and repeats the same link.
- **Post-expiry benefit nudges:** `processExpiredRenewalNudges()` sends `renewalBenefitText()` at D+7 (benefits + data safety) and D+30 (final, gentle), with the existing D+15 WINBACK40 between them; `RENEWAL_NUDGE_MAX` (3) caps it, and renewed/canceling/opted-out accounts are skipped. Counters: `profiles.renewal_nudge_count` / `last_renewal_nudge_at`.
- **Schema:** `npm run migrate:recovery` (`scripts/run_recovery_migration.js`) adds the four columns + `country_comm_styles`; the boot DDL in `vehicles.js` mirrors the column adds so new environments heal automatically.
- **Proof:** `test_recovery_ladders` 30 · `test_ocr_flow` 54 · `test_trial_engine` 73 · `test_subscription_billing` 75 · flow suite.

### 71.18 One metric registry for every asset kind (v1.28.9)
- **Why:** Saka supports eight asset kinds (`vehicle`, `motorcycle`, `truck`, `bus`, `heavy_equipment`, `machinery`, `generator`, `watercraft`) that measure different things. Before this release the metric knowledge was split: `countryBucket.ASSET_KINDS` only knew identity tracks, `reports.js` kept a private EV/HEAVY/ICE map, and summaries hardcoded odometers.
- **Registry:** `src/services/assetMetrics.js` — `ASSET_METRIC_PROFILES` declares, per kind, the primary meter (`odometer` or `hours`), fuel family, accepted fuel types, and the complete metric list (`distance`, `engine_hours`, `fuel_volume`, `energy_volume`, `fuel_economy`, `fuel_burn_per_hour`, `energy_economy`, `energy_output`, `earnings`, `trips`). Each metric carries a canonical unit, metric/imperial display units and the flows it serves.
- **Population rules:** road kinds -> odometer + litres + km/L (+ hours optional, + trips for truck/bus); heavy equipment/machinery -> hours + litres + L/h; generator -> hours + litres + L/h + kWh output; watercraft -> hours + litres + L/h; electric road vehicles swap litres/km-L for kWh/km-kWh through `metricsForAssetKind(kind, { fuelType })`.
- **Surgical integration:** `reports.js` (`assetMetricKpis`) renders the legacy audit PDF from the registry; `reportMetrics.metricsForAccess()` filters bespoke menus by `access.assetKinds` (new `operating_hours` and `energy_kwh` metrics, `metricAppliesToAssetKinds()` exported); `vehicleSummary.js` takes its primary KPI/text line from `assetMetricSummaryLines()` (engine hours for hours-led assets, Energy charged for EVs, serial fallback in the title); `flowKnowledge.SAKA_METRIC_GLOSSARY` is embedded in `DEFAULT_SAKA_CORE_PROMPT` and re-exported by `sakaAi.js`; `productQa.ASSET_METRIC_FACTS` publishes one “what can I log for a <kind>” fact per asset kind.
- **Formatting:** `formatMetricValue()` converts km↔mi, L↔gal, km/L↔MPG, L/h↔gal/h and km/kWh↔mi/kWh, renders hours as `h`, uses the local currency for money and returns `—` for nullish values. Canonical storage stays km/litres/hours/kWh.
- **Proof:** `test_asset_metrics` 70 · `test_agent_training` 109 (glossary embedded) · `test_report_metrics` 25 · `test_vehicle_summary` 14 · `test_fleet_reports` 42 · `test_product_qa` 147.

---

## 72. Expense Catalog (v1.30.0) — every expense, every asset kind

### 72.1 Why (chat-driven audit)
Before this release the expense taxonomy was split across three private classifiers (`fleetReports.expenseCategory`, `reportLedger.expenseKind`, `reportMetrics` category reduce) and the quiz offered only **Fuel / Maintenance / Insurance / Other**. Recent live chats showed the gaps directly:
- A user answered the type question with **"Parts"** - not an option.
- *"I repaired a puncture in Nanyuki. Front left tyre. Cost me 300kes..."* - a tyre expense that would land in "Other".
- *"The odometer reading for the maintenance is not for fill up but an odometer reading at time of repair"* - the label always said "at fill-up".
- *"Remind to Change fuel filter and air filter"*, *"Log an oil change reminder"*, *"Front tyre change reminder"* - filters/oil/tyres vocabulary the engine did not classify.
- *"Topped up fuel; 1000kes @227kes per liter"*, *"Diesel..."* - fuel synonyms beyond the four choices.

### 72.2 The registry (`src/services/expenseCatalog.js`)
Single source of truth, pure and deterministic:
- **18 report categories:** fuel, maintenance, parts, tyres, repairs, bodywork, washing, parking, tolls, fines, compliance, accessories, subscriptions, towing, wages, consumables, berthing, other - each with a human label, ledger badge (`FUEL`, `SERVICE`, `PARTS`, `TYRES`, `REPAIRS`, `BODY`, `WASH`, `PARKING`, `TOLLS`, `FINES`, `COMPLIANCE`, `ACCESSORY`, `SUBS`, `TOWING`, `WAGES`, `FLUIDS`, `MOORING`, `OTHER`) and a semantic tone.
- **19 canonical expense types**, each with aliases, applicable asset kinds and optional electric-only flags: Fuel, Charging, Maintenance, Parts, Tyres, Repairs, Bodywork & Paint, Washing, Parking, Tolls, Fines, Insurance, Accessories, Subscriptions, Towing & Recovery, Crew Wages, Consumables, Mooring & Berthing, Other.
- **Longest-alias-first resolution:** "fuel filter" is Parts (not Fuel), "oil change" is Maintenance (not Consumables), "hydraulic oil" is Consumables, "brake pads" is Parts while "brake fluid" is Consumables, "engine oil" is Maintenance while "engine repair" is Repairs.
- **Canonical legacy values preserved** (`Fuel`, `Maintenance`, `Insurance`, `Tolls`, `Other`), so stored rows and every existing report keep working.
- Exports: `EXPENSE_CATEGORIES`, `EXPENSE_CATEGORY_KEYS`, `EXPENSE_TYPES`, `expenseTypeChoices(assetKind, { fuelType })`, `expenseTypeMenu()`, `resolveExpenseType()`, `normalizeExpenseType()`, `hasExpenseTypeMarker()`, `expenseCategoryOf/Label/Badge/Tone`, `expenseTypesForAssetKind()`.

### 72.3 Asset-kind-aware quiz
- The `log_expense` type menu is built from the catalog: road assets get **Fuel · Maintenance · Parts · Tyres · Repairs · Parking · Insurance · Other** (8, WhatsApp-short); EV fleets swap Fuel for **Charging**; generators/machinery/watercraft get **Consumables + Crew Wages** and never Tyres/Parking.
- Free text always resolves even when outside the menu ("tolls", "fines", "berthing") through a `fallbackParse/accept` extension on `choiceField`.
- **Odometer label fixed:** "Odometer at the time of this expense" with the hint "the reading when it happened - fill-up, service or repair" (no longer implies every expense is a fill-up).
- Quick-path markers now come from the catalog (`hasExpenseTypeMarker`), and every write normalises the type at source (`normalizeExpenseType`), so `diesel` → Fuel, `puncture` → Tyres, `wash` → Washing in `expense_logs`.

### 72.4 Unified classifiers (no more private copies)
`fleetReports.expenseCategory`, `reportLedger.expenseKind`/`ledgerKindLabel`, `reportMetrics` category series + top-category, `analytics.buildVehicleSummary` grouping, and the driver/vehicle-deep-dive/owner-portfolio category accumulators all delegate to `expenseCategoryOf()`. Financial totals are now **additive**: the legacy fuel/maintenance/parts/tolls/other keys stay, and the new categories appear alongside them in the WhatsApp text, the Apex PDF segmented bars and the itemized ledger badges. Category accumulators are initialised from `EXPENSE_CATEGORY_KEYS`, so a new type can never produce `NaN`.

### 72.5 Chat-driven tweaks
- "Parts" is a first-class menu choice; puncture/tyre phrases become **Tyres**; fuel/air filter phrases become **Parts**; oil change becomes **Maintenance**; wash/parking/tolls/fines/licences all classify.
- The trigger sentence "log expense" must never pre-fill a type: the word "expense" is deliberately **not** an alias (regression covered by `test_expense_catalog` and `test_quiz_flow`).
- The odometer complaint is fixed in copy and in the flow order (type → amount → [fuel volume/fill type] → odometer → notes → confirm).

### 72.6 Files, tests & knobs
- Files: `src/services/expenseCatalog.js` (new), `quizEngine.js` (menu, label, markers, write normalisation), `src/routes/whatsapp.js` (quick-path normalisation), `reportLedger.js`, `fleetReports.js`, `reportMetrics.js`, `reportDelivery.js`, `analytics.js`, `driverReports.js`, `vehicleDeepDive.js`, `ownerPortfolio.js`, `pdfEngine.js` (badge tones), `flowKnowledge.js`, `sakaAi.js`.
- Tests: new `test_expense_catalog.js` (66 assertions: 25 real-chat phrases, longest-alias precedence, asset-kind menus, quiz/ledger integration, trigger-word regression) plus `test_quiz_flow.js` (95), `test_fleet_reports.js` (42), `test_report_metrics.js` (25), `test_report_builders.js` (67), `test_pdf_engine.js` (29), `test_agent_training.js` (109), `test_doc_sync.js`, `test_kb_docs.js`.
- No schema/DDL change, no new dependency, no new env knob. WhatsApp menus stay at 8 choices; every other type is reachable by free text.

---

## 73. Populate the Variables (v1.31.0) — reminders, earnings, compliance, attributes and demo data

### 73.1 Reminder catalog (`src/services/reminderCatalog.js`)
The category layer stays `EXPIRY_CATEGORIES` (maintenanceReminders.js); the new registry adds the concrete reminder TYPES with aliases, the meter each uses and an asset-kind menu:
- **Maintenance:** Oil change (distance), Service, Fuel filter, Air filter, Brake pads, Tyres, Battery, Timing belt (road); Hydraulic service, Undercarriage (hours); Generator service, Hull service, Engine service (machine/watercraft).
- **Compliance:** Insurance Renewal, Inspection (MOT/NTSA/TÜV/ITV/APK/Shaken/Puspakom aliases), Road License, Road Service Licence (PSL), Driver License, Permit (speed limiter), Deadline.
- **Resolver:** longest-alias-first (`fuel filter` beats `oil`, `hydraulic service` beats `service`); generic words (`reminder`, `expires`) are deliberately NOT aliases so they can never hijack a specific type.
- **Quiz:** `set_reminder` builds its menu with `reminderTypeChoices(assetKind)` (max 8 + Other) and accepts any catalog type by free text; catalog resolution runs BEFORE menu-alias matching (`choiceField` `fallbackParse` first). Writes normalise `reminder_type` and derive the category through `reminderCategoryOf()` before `categoryForReminderType()`.
- **Examples:** "Log an oil change reminder" → Oil change; "Change fuel filter and air filter" → Fuel filter; "Front tyre change reminder" → Tyres; "hydraulic service in 36 hours" → Hydraulic service (hours); "PSL 445566 expires 30 Nov 2026" → Road Service Licence.

## 87. UPDATE-SUGGEST> command, message_status receipts & deploy-alert diagnosis (v1.48.0)

### 87.1 `UPDATE-SUGGEST>` — superadmin suggestions into the remediation pipeline (Model A)

- **Command:** `UPDATE-SUGGEST> <free text>` (case-insensitive). Only the
  verified `SUPERADMIN_PHONE` may file it — `handleSuperadminFlow` rejects any
  other phone before parsing (multi-role coexistence: the message falls through
  to normal chat for everyone else). Requires the active admin session like
  every admin command.
- **Parse:** `ADMIN_DIRECTIVE_RE` (the admin-claim gate) now includes
  `update-suggest\b`; `parseSuperadminCommand` matches
  `/^\s*UPDATE-SUGGEST>\s*([\s\S]*)$/i` → `ADMIN_UPDATE_SUGGEST` + the trimmed
  suggestion text (empty text is recognized and answered with a usage hint).
- **Capture:** `captureUpdateSuggestion()` inserts a `remediation_proposals`
  row — `proposal_code` `SUG-YYYY-MM-DD-NN` (Nairobi date, sequenced like
  `FIX-`), `category='update_suggest'`, `title` truncated to 80 chars,
  `root_cause` = full text, `proposed_changes.overview` = full text with
  `source='UPDATE-SUGGEST command'` + `author_phone`, `tests=['test_agent_training.js']`
  (default stateless suite for the CI pre/post passes), `status=PENDING_APPROVAL`,
  `risk_level='low'`. Audited as `ADMIN_UPDATE_SUGGEST`. The reply carries the
  code and the approval next-step. **Nothing executes until the Superadmin
  approves** (`admin accept fix <CODE>`, existing state machine) — Model A.
- **Gate:** `verifyProposalGate()` has a free-text path for
  `category='update_suggest'`: the structured sanitizer is skipped (Cline drafts
  the concrete scope at execution time), but the suggestion text is checked for
  `REMEDIATION_BLOCKED_PATTERN` keywords and forbidden-path mentions; a blocked
  suggestion needs an explicit audited `override` to proceed. The post-edit
  `guard` step keeps enforcing forbidden paths on the produced diff.
- **Work order:** `scripts/remediation_ci.js fetch` renders a free-text scope
  section for SUG proposals instead of the change table; the execute workflow's
  Cline prompt interprets the suggestion into the smallest correct change set.
- `admin remediations` lists `SUG-` codes alongside `FIX-` (no prefix filter).
- **Suite:** `test_update_suggest.js` (15 assertions: parse, non-superadmin
  gating, delivery-receipt webhook, capture, suggestion gate + destructive-keyword
  block; DB rows cleaned in `finally`).

### 87.2 WhatsApp delivery receipts (`message_status`)

- `handleWhatsAppWebhook` now acknowledges `entry[0].changes[0].value.statuses[0]`
  (previously it answered `ignored_non_message_event`): every `sent`/`delivered`/
  `read` receipt is logged (`event: whatsapp_message_status`), and a `failed`
  receipt is persisted to `error_logs` (`route='/webhook/whatsapp/status'`) so
  Sentinel's 60-second scan + 15-minute synthesis can surface undelivered
  proactive messages. This ends the "silent failure" era: Meta can accept a send
  (return a `wamid`) and still fail delivery, or fail asynchronously.

### 87.3 Build-notification diagnosis (why deploy alerts stopped)

- **Evidence (2026-11-02):** normal chats worked; the manual dispatch returned a
  `wamid` (token + `META_PHONE_NUMBER_ID` + `SUPERADMIN_PHONE` verified healthy);
  `system_config.last_deployed_revision` was stuck at `saka-fleet-00187-xh2` —
  no new Cloud Run revision had booted, so the in-app "🚀 Saka is LIVE" alert
  (announce once per new revision) never fired.
- **Contributing fragility:** deploy alerts are **free-form** (non-template)
  messages — they silently fail outside Meta's 24-hour customer-service window,
  and until v1.48.0 the app had no `message_status` handling to see it.
- **Operator follow-ups:** redeploy Cloud Run (advances the revision marker and
  fires the LIVE alert), verify the `Deploy & Push WhatsApp Notification`
  Actions workflow runs on push, and (recommended) approve a Meta template for
  deploy alerts so they deliver regardless of the 24-hour window.

### 87.4 Files, tests, knobs

- Files: `src/services/superadmin.js` (gate regex, parse, capture, route, help),
  `src/workers/remediation.js` (`verifyProposalGate` suggestion path),
  `scripts/remediation_ci.js` (SUG work-order rendering),
  `.github/workflows/remediation_execute.yml` (interpret-or-execute prompt),
  `src/routes/whatsapp.js` (status receipts), `test_update_suggest.js` (new).
- No new env knobs and no schema changes (reuses `remediation_proposals`).


### 73.2 Earning catalog + `earning_type` (`src/services/earningCatalog.js`)
- **8 canonical types:** Trip fares, Daily takings, Cargo & freight, Vehicle hire, Equipment hire, Contract & charter, Transport service, Other. Aliases: matatu/fares/rides → Trip fares; takings/collections → Daily takings; freight/load → Cargo & freight; generator hire → Equipment hire; school run → Transport service.
- **Capture:** `log_earnings` gains ONE optional choice (skippable) after the amount; the WhatsApp one-liner quick path resolves the same aliases from the message.
- **Storage:** `private_earnings.earning_type` (plus `notes` parity) via `npm run migrate:earning-type` (`EARNING_TYPE_SQL`, idempotent), a boot ensure (`ensureEarningTypeSchema`, fail-soft), and the staging DDL. The same migration repairs `reminders.updated_at`, which the live table lacked while `createExpiryReminder` writes it — date reminders could not be saved before this release. No other schema changes.
- **Reporting:** `earningToLedgerRow()` prefixes the type into the ledger description ("Cargo & freight - Nairobi to Mombasa"); the EARNING badge is unchanged, so every Apex report shows what the money came from.

### 73.3 Global compliance catalogs + driver compliance
- **17 new vehicle catalogs** (DE, FR, ES, IT, NL, BR, MX, GH, EG, SA, PK, BD, MY, SG, JP, PH, TR, CN, ID, NZ) join the existing 12; each carries 3 local items (TÜV/HU, contrôle technique, ITV, revisione, APK, CRLV, tenencia, DVLA roadworthy, istimara, token tax, BRTA fitness, Puspakom, COE, Shaken, LTO, TÜVTÜRK, annual inspection, KIR, WoF) mapped to the universal insurance/inspection/licensing/permit categories through `CATEGORY_BY_TYPE`. `VEHICLE_COMPLIANCE_CATALOG_VERSION` is now `2026.17.0`. Unknown countries still fall back to the global catalog.
- **`driverComplianceCatalog.js`:** driving licence, PSV badge, PDP, CPC, operator card, medical certificate, defensive driving, other; `driverComplianceChoices({ countryCode })` returns the East-African professional set for KE/TZ/UG/RW/NG/ZA and the operator card elsewhere. Driver report labels now resolve stored types through the registry.

### 73.4 Vehicle attribute expansion (`sakaAi.extractVehicleAttributes`)
- **Brands:** adds Renault, Fiat, Chevrolet, GMC, Tesla, Tata, Mahindra, JAC, Foton, Shacman, Sinotruk, Scania, DAF, Iveco, Hino, Fuso, Proton, Geely, Changan, Dongfeng, Citroën, Skoda, Opel, Mack, Kenworth, Freightliner, Peterbilt, Ashok Leyland, Eicher, Bajaj, TVS, Yamaha, Kawasaki, RAM 1500-style and MAN TGX/TGA/TGS/TGM.
- **Colours:** navy, teal, purple, pink, champagne, ivory, bronze, burgundy, turquoise, pearl.
- **Accessories:** trailer, toolbox, canopy, bike rack, fire extinguisher, first aid kit, reflectors, spare wheel, dashcam, GPS tracker, seat covers (alongside bullbar/winch/snorkel/roof rack/lift kit/dual battery/refrigeration/tow hitch).

### 73.5 Guarded demo fleet seeder (`scripts/seed_demo_fleet.js`, `npm run demo:seed`)
- **Payload (deterministic, pure):** one demo owner (+254700999999) and driver, **eight asset kinds + one EV**, **~31 expenses covering all 19 expense types**, **8 earnings covering all 8 types**, 7 reminders (date/distance/hours incl. PSL and hydraulic service), 4 Kenya vehicle compliance rows and 2 driver compliance rows.
- **Safety:** refuses to run without `--confirm`; removes its previous demo rows first (vehicles by demo owner, legacy `expenses` by demo plates); uses a dedicated phone and DEMO-prefixed 17-char VINs that never collide with test fixtures; real users are never touched. Wipe anytime with `npm run reset:slate` / `npm run reset:db -- --all --confirm --backup`.
- **Proof:** `test_demo_seed.js` (30 assertions) proves coverage, determinism and identifier safety without a database connection.

### 73.6 Files, tests & knobs
- **Files:** `reminderCatalog.js` (new), `earningCatalog.js` (new), `driverComplianceCatalog.js` (new), `quizEngine.js` (menus, catalog-first parse, write normalisation), `src/routes/whatsapp.js` (earning type), `reportLedger.js` (earning description), `driverReports.js` (driver compliance labels), `vehicleCompliance.js` (catalogs + version), `sakaAi.js` (attributes + prompt), `flowKnowledge.js`, `index.js` (boot ensure), `scripts/seed_demo_fleet.js` (new), `scripts/run_earning_type_migration.js` (new), `scripts/provision_staging_schema.js`, `scripts/health_audit.js`.
- **Ops:** `npm run migrate:earning-type` (one-time, idempotent), `npm run demo:seed -- --confirm` (explicit demo data). No new environment knobs.
- **Tests:** `test_variable_catalogs.js` (96), `test_demo_seed.js` (30), `test_expense_catalog.js` (66), `test_quiz_flow.js` (95), `test_maintenance_reminders.js` (46), `test_vehicle_compliance.js` (28), `test_agent_training.js` (109), `test_fleet_reports.js` (42), `test_report_builders.js` (67), `test_report_metrics.js` (25), `test_pdf_engine.js` (29), `test_natural_intake.js` (19).

---

## 74. PDF Presentation Polish + Short Links (v1.32.0)

### 74.1 Why (audit of the real KAS 628T PDF)
The attached 4-page `report-Saka_financial_KAS_628T` artifact exposed presentation defects: the cover period chip rendered **`Africa/Nairobi`** (a timezone, not a period), the title was lowercase "Financial report" with no plate/vehicle identity, **zero earnings were emerald (positive)**, the KPI grid had four cards, a one-row "Per-vehicle performance" table duplicated the KPIs, the "Cost efficiency" callout rendered as two em dashes, the ledger was titled "Fleet financial ledger" for one vehicle, and the Summary dumped ~40 raw WhatsApp lines.

### 74.2 Adapter rewrite (`reportDelivery.fleetReportToPdf`, now exported)
- **Single-vehicle detection** from `data.vehicles` (new) or `net.byVehicle`; the cover gets `plate` (plate badge), title **"Financial & Cost Report - <plate>"**, subtitle with make/model, and `periodLabel` "All recorded activity" (financial) or "This month" (others) - never a timezone.
- **Honest KPI tones:** earnings/net are emerald/coral only for non-zero values; zero is neutral. The grid is filled to six cards from spend, earnings, net, transactions (`counts`), fuel logged (`fuelLitres`) and distance (zero distance hint: "no odometer movement logged this month").
- **Vehicle snapshot** replaces the one-row per-vehicle table (plate, vehicle, asset kind, fuel type, odometer, records in scope, ledger rows shown); the multi-vehicle table only renders for 2+ vehicles.
- **Clean callouts:** the "Cost efficiency" callout is only created when `costPerDistance` or `costPerHour` is non-null; the financial-health callout only when there is real money movement.
- **Scope-aware ledger title** is set in `buildFinancialReport` ("Transaction ledger - <plate>" vs "Fleet financial ledger"); the Summary is condensed to eight plain-language lines.
- **Chat-driven alias:** "vehicle profile report" / "profile report" route to `vehicle_deep_dive`.

### 74.3 Engine polish (`pdfEngine.js`)
- KPI grid centres an incomplete last row instead of leaving a ragged gap.
- Footer reads "SAKA FLEET · APEX REPORT".

### 74.4 Self-hosted short links (`src/services/linkShortener.js`)
- **API:** `shortenUrl(supabase, url)`, `resolveShortCode(supabase, code)`, `ensureShortLinksTable`, `generateShortCode` (8-char, unambiguous alphabet), `shortLinkBase()` (`PUBLIC_APP_URL`, default `https://sakafleet.com`).
- **Behaviour:** links under 80 chars and existing `/r/` links pass through; identical URLs reuse their code; expired codes are purged opportunistically; TTL 90 days; every failure returns the ORIGINAL url (a message never loses a link). Codes are unique-indexed with collision retries.
- **Redirect:** `GET /r/:code` (index.js) resolves and 302s; a miss lands on the pricing page.
- **Storage:** `public.short_links(code PK, url, created_at, expires_at)` via `npm run migrate:short-links` (idempotent), boot ensure, staging DDL and `RESET_TABLES` clean-slate coverage.
- **Coverage:** report PDF links (follow-up worker, vehicle summary email/WhatsApp, monthly fleet audit) and ALL Paystack checkout presentations (upgrade, switch-to-annual, add-on, cancel-save, trial digests, winback, dunning, renewal, quiz checkout) are shortened.

### 74.5 Files, tests, ops
- **Files:** `linkShortener.js` (new), `reportDelivery.js`, `fleetReports.js`, `pdfEngine.js`, `followups.js`, `vehicleSummary.js`, `trialEngine.js`, `quizEngine.js`, `src/routes/whatsapp.js`, `index.js`, `scripts/run_short_links_migration.js` (new), `scripts/provision_staging_schema.js`, `scripts/reset-db.js`, `.env.example`.
- **Ops:** `npm run migrate:short-links` (one-time, idempotent); optional `PUBLIC_APP_URL` to change the branded base. No other knobs.
- **Tests:** `test_link_shortener.js` (25), `test_report_builders.js` (83 incl. the financial presentation contract), `test_pdf_engine.js` (29), `test_fleet_reports.js` (42), `test_quiz_flow.js` (95), `test_trial_engine.js` (73), `test_subscription_billing.js` (75), `test_dunning_reengagement.js` (15), `test_followups.js` (12), `test_vehicle_summary.js` (14), `test_report_metrics.js` (25), plus the v1.30/1.31 catalog suites.

---

## 75. OCR Audit Remediation (v1.32.1)

### 75.1 Live evidence (2026-11-01, phone 254734852529)
- **Two photo turns died silently:** acks sent at 06:35:25 and 06:38:08, then nothing. `error_logs` recorded `ReferenceError: session is not defined` at `whatsapp.js:3505` — the catch block referenced a `session` binding declared inside the try, masking the original error. No receipt row, no reply.
- **Insurance certificate filed as a logbook:** media `949674331278052` (Bima Yangu / Monarch, policy C35343842) stored `document_kind='logbook'` because `CHASSIS NUMBER` matched the logbook regex before insurance markers.
- **Expiry saved as the commencement date:** the compliance engine used the FIRST date in the segment (COMMENCING 21/10/2026) instead of the EXPIRING label (20/11/2026). The owner corrected Saka in chat and then could not get the expiry answered.
- **e-TIMS fuel receipts** were stored as `purchase_invoice` (the KRA "Buyer PIN" token matched the buyer rule) and produced `amount=NULL, litres=NULL` because TOTAL sat alone on its line.
- **No OCR telemetry** existed: `ai_usage_logs` had zero OCR purposes.

### 75.2 Silent-crash fix (`src/routes/whatsapp.js`)
`session` is hoisted to function scope (`let session = null` before the try) and the catch uses `session?.slowAckSent`; the original error is persisted with `logSystemError(..., '/webhook/whatsapp')`. A regression test reads the route source and asserts all three properties.

### 75.3 Document-family precedence (`ocrService.js`, `documentLens.js`)
- Strong insurance markers (`CERTIFICATE OF INSURANCE`, `POLICY HOLDER`, `POLICY NO/NUMBER`, `COMMENCING DATE`, `COVER NOTE`, `SUM INSURED`, `UNDERWRITER`, `ISSUED BY`, or `EXPIRY` + `POLICY`) win over bare `VIN`/`CHASSIS`.
- `looksLikeVin()` strips KRA tax PINs (`P051141264M`) and `PIN:` labels first, so a fiscal receipt never looks like a logbook.
- `classifyDocumentFamily()` keeps receipt families and excludes `buyer(?!\s*pin)` from the purchase-invoice rule.

### 75.4 Country receipt profiles — Rule 36
`extractDocumentHints(text, kind, { receiptOnly, countryCode })` resolves a profile from the WhatsApp country:
- **KE (e-TIMS):** merchant line after the legal-receipt marker, TOTAL/CASH figure on the following 1–2 lines (VAT/NET/TAX rows skipped), litres from `<fuel product>` + `qty x unit-price`, `KES` when the receipt omits a code, dates resolved DD/MM/YYYY through `dateParser`.
- **GLOBAL:** neutral heuristics plus one universal improvement — a bare `TOTAL` label now reads the figure from the next 1–2 lines (every market), and address/PIN/phone/serial numbers are never treated as money.
- Ambiguous OCR tokens (`3.000.00`) are rejected instead of guessed. The route merges `{ ...lens.hints, ...countryHints }` so a labelled deterministic value can never be overridden by a lens misread.
- Certificate policy labels now include `CERTIFICATE OF INSURANCE No:` and expiry is read label-first (COMMENCING never becomes expiry) in BOTH `extractDocumentHints` and `Document Lens.parseInsurance` (ISO via `dateParser`).

### 75.5 Duplicate protection (three layers)
1. **Content hash:** `buildOcrTextSha()` (whitespace-normalised SHA-256) is stored in `receipts.text_sha`; `findRecentReceiptByTextSha()` matches within `OCR_DUPLICATE_WINDOW_HOURS` (48).
2. **Re-upload short-circuit:** media-id OR recent text-hash match sets `duplicateReceipt` → quiz cancelled + warm `formatDuplicateReceiptReply` ("already read").
3. **Write-time expense guard (`expenseGuard.js`):** before BOTH expense insert sites (`quizEngine` log_expense and the route's quick path) the engine checks same plate + amount + type + **Africa/Nairobi calendar day** within `OCR_EXPENSE_DEDUPE_HOURS` (3 h). A different odometer reading proves a separate fill and passes; the user is told once that nothing was saved twice and offered the odometer path.

### 75.6 OCR telemetry & admin digest
- `public.ocr_requests` (one row per media turn, written right after OCR completes and BEFORE any crash-prone branch): `media_id, phone, country_code, mime_type, provider (google_vision|local_pdf), document_kind, status (read|low_confidence|failed|paused|pdf_text|pdf_scanned|unsupported), confidence, attempts, latency_ms, error` — never document text.
- `getOcrUsageSummary()` is fail-soft; `admin ocr-stats [Nh]` renders a deterministic digest (outcomes, documents, countries, avg confidence/latency) and audits `ADMIN_OCR_STATS`.
- Migration `npm run migrate:ocr-requests` creates the table, adds `idx_receipts_text_sha` and backfills the audited rows (`1796235211499272`, `2892848571100840` → receipt_fuel; `949674331278052`, `1189365943417791` → insurance).

### 75.7 Compliance expiry precedence
`parseComplianceItem()` (complianceCatalog) now anchors date extraction on `expir*|valid until/to/till|due` when present, so a certificate's COMMENCING/ISSUE date can never be stored as the expiry. Data repaired for KAS 628T on 2026-11-01: `vehicle_compliances.insurance.expiry`, `vehicles.insurance_expiry` and the linked Insurance reminder all set to `2026-11-20`.

### 75.8 Also shipped
HEIC/HEIF accepted (`SUPPORTED_IMAGE_TYPES`); insurance receipt rows carry `Policy <number>` in notes; `admin ocr-stats` added to help text and the ML intent fallback; `flowKnowledge` + `DEFAULT_SAKA_CORE_PROMPT` describe the duplicate contract and country-resolved formats.

### 75.9 Files, tests, knobs
- **Files:** `ocrService.js`, `documentLens.js`, `receipts.js`, `ocrTelemetry.js` (new), `expenseGuard.js` (new), `complianceCatalog.js`, `src/routes/whatsapp.js`, `quizEngine.js`, `superadmin.js`, `flowKnowledge.js`, `sakaAi.js`, `index.js`, `scripts/run_ocr_requests_migration.js` (new), `scripts/provision_staging_schema.js`, `scripts/reset-db.js`, `.env.example`, `.clinerules` (Rule 36).
- **Tests:** `test_ocr_flow.js` (87 — e-TIMS KE vs GLOBAL, Bima certificate, Buyer-PIN family, duplicate comparator, OCR digest, crash regression), `test_vehicle_compliance.js` (30 — expiry label precedence), `test_quiz_flow.js` (95), `test_agent_training.js` (109), `test_turn_latency.js` (41), `test_phase2_analytics.js`.
- **Knobs:** `OCR_DUPLICATE_WINDOW_HOURS` (48), `OCR_EXPENSE_DEDUPE_HOURS` (3); existing OCR knobs unchanged.

---

## 76. Dead-Link Fix & Deterministic Compliance Answers (v1.32.2)

### 76.1 Live evidence (2026-11-01, phone 254734852529)
- **Every short link 404'd.** `sakafleet.com` resolves to parked Hostinger IPs; `https://sakafleet.com/r/QHiTC3it` → HTTP 404 while the PDF objects were healthy (18–30 KB, HTTP 200 in Supabase storage). `PUBLIC_APP_URL` was unset, so the shortener defaulted to a domain the app does not serve.
- **Three unanswered questions:** "When does KAS insurance expires?", "Please tell me insurance expiry date" → canned "all set" replies.
- **Typed correction ignored:** "You read the document wrong … the expiry is 2026-11-20" → "Got your vehicle details!", no write.
- **Reminder quiz hijack:** "Tired alerts report" and "List recent tiered alerts" started a new-reminder quiz instead of listing reminders.
- **Deploy marker frozen:** `system_config.last_deployed_revision` stuck at the 2026-10-28 revision.

### 76.2 Short links: verified-domain gate (`linkShortener.js`)
- `SHORT_LINK_DEFAULT_BASE = https://app.sakafleet.com` (Cloud Run custom subdomain; the root remains the marketing site).
- `isShortLinkDomainReady()` — true when `SHORT_LINK_DOMAIN_READY=on|true|1` or an explicit `PUBLIC_APP_URL` is set; **default off**. While off, `shortenUrl()` returns the original (working) URL, so a message can never carry a dead link.
- `GET /r/:code` redirect is unchanged; once the subdomain serves HTTPS the operator flips the flag and every new link is `https://app.sakafleet.com/r/<code>`.

### 76.3 Deterministic compliance answers (`complianceAnswers.js`, new)
- **Detectors (zero tokens):** reminders list (`alerts`, `list my reminders`, `alerts report`, typo-tolerant), compliance card (`my compliance`), expiry question ("when does insurance expire?"), typed correction (correction marker + date + compliance reference, including the insurance-only word "commencement").
- **Replies:** expiry answer for the asked item, full compliance card, reminders list — all with 🟢🟡🔴 chips and plain-language days-left.
- **Correction writer:** `applyComplianceCorrection()` resolves the catalog item, reads the existing number, and saves through `submitVehicleCompliance()` so the ledger, `vehicles.insurance_expiry` legacy column AND the linked reminder move to the corrected date together.
- **Wiring (`whatsapp.js`):** one deterministic branch before the AI call, active only when no quiz owns the turn; "compliance report"/"expiry report" keep routing to the PDF report engine, and reminder-creation wording is never captured as a list.

### 76.4 Visibility
- Compliance save confirmations now include days-left (`Insurance: 2026-11-20 — in 19 days (C35343842)`), so a misread date is caught in the same message.
- Insurance receipt-vault notes carry `Expires <date>` (never the commencement date).
- `announceRevisionLive()` persists the revision with `onConflict: 'key'` and warns on failure — the LIVE alert fires once per revision again.

### 76.5 Files, tests, knobs
- **Files:** `linkShortener.js`, `complianceAnswers.js` (new), `src/routes/whatsapp.js`, `deployLiveAlert.js`, `ocrService.js`, `flowKnowledge.js`, `sakaAi.js`, `.env.example`, `.clinerules`.
- **Tests:** `test_link_shortener.js` (28 — readiness gate, app subdomain base), `test_vehicle_compliance.js` (44 — detectors, replies, correction writes), `test_ocr_flow.js` (88 — expiry note), `test_quiz_flow.js` (95).
- **Knobs:** `SHORT_LINK_DOMAIN_READY` (off; on|true|1 enables short links), `PUBLIC_APP_URL` (optional explicit base).

---

## 77. Stale-State Hijack, Read-Command Swallowing & the Compliance PDF (v1.32.3)

### 77.1 Live evidence (2026-11-01, phone 254734852529)
- At 08:49 the bot opened with "you are one step away" and re-asked an odometer question. The last-10 history window the model saw was **1 h 43 m stale** (last turn 07:06) — the read had no age limit.
- A long-abandoned expense/registration draft stayed `session.quiz` forever and kept owning every later turn; a "yes" typed minutes later was routed as a quiz/coupon answer instead of a fresh request.
- **Read commands were swallowed:** "Tired alerts report", "List recent tiered alerts", "Show me insurance details for my cars" and "When does my insurance expire" produced model prose (or a new reminder quiz) instead of the deterministic reminder list / compliance card / expiry answer, because the detectors only ran when no quiz was active.
- A bare **"yes"** redeemed a trial-extension coupon the user was never offered.
- The compliance PDF's page 2 was nearly empty: the generic summary layout drew only a couple of body rows for a compliance report.

### 77.2 Conversation freshness (`chatHistory.js`, `quizEngine.js`)
- `CHAT_HISTORY_MAX_AGE_MINUTES` (**45**, clamped to 24 h) — `getRecentChatHistory()` applies a SQL `gte('created_at', …)` cut-off **and** re-filters locally, so a timezone-skewed row can never resurrect stale context. `{ maxAgeMinutes: 0 }` is the explicit full read used by admin/tools. Rows are kept in the database; only the prompt is protected.
- `QUIZ_MAX_AGE_MINUTES` (**20**, clamped 5–240) — `getActiveQuiz(session)` is now the ONLY way a route may read `session.quiz`: it measures from `lastTurnAt` (falling back to `startedAt`), and an expired draft is cleared from the session and never resumed.
- `markQuizTurn(session)` stamps `lastTurnAt` after every handled quiz turn; `abandonQuiz(session, { reason })` parks a draft (`session.quiz = null`, `lastAbandonedQuiz = { …draft, reason, parkedAt }`) so the conversation is free again without losing the collected answers from telemetry.
- `sentinel.js` persists every stall nudge through `saveChatMessage()` (nudges were invisible to history, which is why the model kept "remembering" a dialogue the user could not see) and a last-warning nudge now releases a stalled quiz via `sentinel_stall_release`.

### 77.3 Read commands always win (`whatsapp.js`, `complianceAnswers.js`)
- Deterministic read branches (reminders list, compliance card, expiry question, receipts/parts list, reports, profile, passbook) run **before** the quiz/flow branches and are no longer gated on "no active quiz": when a read command arrives with a live draft, the draft is parked (`abandonQuiz`) and the read is answered in the same turn.
- `complianceAnswers.js` gains `carriesExplicitDate()` plus widened `detectRemindersListCommand`, `detectComplianceStatusCommand` and `detectComplianceExpiryQuestion`: "tiered/tired alerts", "list recent alerts", "see reminders for <plate>" and short non-negated fragments ("reminders") count as reads; any message that supplies its own date ("insurance expires 20/11/2026") is an ANSWER and is excluded from every read detector; "remind me to renew on <date>" stays a creation request; "compliance report"/"expiry report" stays with the PDF report engine.
- The trial-extension coupon branch now requires BOTH a prior offer (`session.lastAssistantPrompt` matching the offer copy) AND a coupon code in the merged extraction — a bare "yes" can no longer redeem anything.
- `receiptsCommand` was widened so "do you have any parts purchases" lists receipts instead of chatting.

### 77.4 Compliance PDF (`reportDelivery.js`, `pdfEngine.js`)
- `fleetReportToPdf()` routes `report_type: 'compliance'` to the new exported `complianceReportToPdf()`: cover highlights (overdue/due-soon counts), an itemized per-vehicle table (item, number, expiry, days left, 🟢🟡🔴 status), a category matrix across vehicles, and provenance notes — page 2 is now full for single-vehicle and fleet compliance reports.
- `fleetReports.js`: `loadFleetData()` also reads `vehicle_compliances` (policy/certificate numbers live in the ledger, not on the vehicle row) and `buildComplianceReport()` returns PDF-ready structures — `scopedVehicles`, itemized rows with `daysLeft`, `dueSoon` aggregation, category counts and `CATEGORY_LABELS` for plain-language panel titles.
- `pdfEngine.js`: `coverHighlights` optional cover row + dynamic hero band height; "PRO REPORT" renamed to "APEX REPORT"; body row/note font sizes raised to 8.6 for readability.

### 77.5 Files, tests, knobs
- **Files:** `src/services/chatHistory.js`, `quizEngine.js`, `complianceAnswers.js`, `reportDelivery.js`, `pdfEngine.js`, `fleetReports.js`, `src/routes/whatsapp.js`, `src/workers/sentinel.js`, `flowKnowledge.js`, `sakaAi.js`, `.env.example`.
- **Tests:** `test_quiz_flow.js` (**107** — quiz expiry/parking + 45-min history window), `test_vehicle_compliance.js` (**62** — read-command detectors, negation and date-bearing exclusions), `test_pdf_engine.js` (**50** — compliance itemization + non-compliance regression), `test_agent_training.js` (prompt/registry sync).
- **Knobs:** `CHAT_HISTORY_MAX_AGE_MINUTES` (45), `QUIZ_MAX_AGE_MINUTES` (20, 5–240).

---

## 78. Report Legibility, Verified Short Links, Env Parity & Chat Friction (v1.32.4)

### 78.1 Live evidence (2026-11-01)
- The delivered `report-Saka_financial_KAS_628T` PDF was unreadable: pages drew text at faded alpha, KPI cards walked down the page one card at a time and ledger/table cells wrapped over the following row.
- `https://app.sakafleet.com/r/<code>` answered, but unknown codes **302'd to the marketing page** while every new report link was still emitted as a raw Supabase signed URL (`SHORT_LINK_DOMAIN_READY` was unset).
- The live revision was missing keys the code degrades on silently (`PUBLIC_APP_URL`, `SHORT_LINK_DOMAIN_READY`, `PUBLIC_PRICING_URL`, `PAYSTACK_CALLBACK_URL`, `OCR_ACK_FIRST`, `UPLOAD_HINTS_ENABLED` …). 167 env reads existed in code, only 121 were documented.
- Chat frictions in one session: "Send me as a detailed pdf" → generic menu, "Summary for 21/10/2026" → "Got your vehicle details!", receipt vendors printed as raw OCR note lines.

### 78.2 Graphics-state contract (`pdfEngine.js`)
- **`paintAlpha(doc, hex, alpha, draw)` replaces `withAlpha`.** `doc.fillColor(rgb, alpha)` writes the alpha into the PAGE graphics state (`/GSn gs`) and never resets it, so the fade leaked into every later fill, stroke AND text op. Alpha is now applied only inside `save()/restore()` (`q … Q`), which restores `ca`. Decorative alphas (cover glows, highlight pills, badges, line-chart fill) are preserved; the fade can no longer escape its shape.
- **Absolute-position helpers never move the cursor:** `kpiCard`, `chip`, `plateBadge` and `drawBadge` capture and restore `doc.y`. `drawKpiGrid` is now a pure exported `computeKpiGrid({count, startY, …})` returning one shared `y` per row (the 85 → 143.8 → 202.7 → 337.5 staircase is impossible).
- **One measured advance per block:** `drawChartHeading` sets `doc.y = startY + titleH + noteH + 4` (no double `+=`); `drawProgressChart` captures one `y` per row; `drawSegmentedBar` gives the label `colWidth − 124` so it can never collide with the value.
- **No-wrap cells:** ledger rows/headers are 21 pt (was 19) with `lineBreak: false`, `height: rowH − 9`, `ellipsis: true`; badge 6.6 pt / 13 pt tall; body 7.6 pt, mono 7.2 pt. `drawTable` uses 22/24 pt header/row and 8.2 pt body with the same single-line contract.
- **Cover composition:** the ink band runs to `PAGE_HEIGHT − 120` (722 pt, was ~484 pt) closed by a solid accent rule; the hero title auto-shrinks 30 → 26 → 22 pt to stay within two lines; the drivers panel moved inside the band with a legible `#94A3B8` label; the subtitle is clamped above the chips.

### 78.3 Legibility regression sensor (`pdfTextExtractor.js`)
- `listDecodedStreams(buffer)`, `contentOperators(stream)`, `readExtGStates(buffer)` and `analyzeAlphaUsage(buffer)` walk the decoded content streams, resolve `/GSn gs` through the page resources and count text ops drawn while `ca < 1`. A legible report MUST report `lowAlphaTextOps === 0`; the suite also renders a deliberately leaking document to prove the sensor fires.

### 78.4 Verified short links (`linkShortener.js`, `index.js`, `reportDelivery.js`)
- **Probe route:** `GET /r/__saka_probe__` (registered BEFORE `/r/:code`) answers `{service:'saka-shortlink'}` with header `x-saka-shortlink: saka-shortlink`.
- **`verifyShortLinkRoute({force})`** fetches `${shortLinkBase()}/r/__saka_probe__` (3 s timeout, cached `SHORT_LINK_PROBE_CACHE_MS` 600000, fail-soft) and records `{ready, base, reason, checkedAt}`. `shortLinkReady()` is the only gate `shortenUrl()` consults: `flag-off` → never; `probe-disabled` (`SHORT_LINK_PROBE=off`) → trust the explicit signal; otherwise the probe decides. A 302, a 200 without the tag, or a network error all mean NOT ready, and the original working URL is delivered.
- **`deliverReportPdf()` shortens the uploaded URL at the single source of truth**, so the WhatsApp reply, the follow-up worker and the email all carry the branded link (`shortenUrl` is idempotent on an existing `/r/` link). Boot warms the probe fire-and-forget; `/internal/status` publishes `shortLinks {ready, base, reason, checkedAt}`.
- **Unknown/expired codes** return `HTTP 404` with `shortLinkNotFoundHtml()` ("expired or does not exist", 90-day lifetime, pricing link) instead of silently bouncing to the marketing site.




### 78.5 Env & secret parity (`envAudit.js`, `scripts/env_audit.js`)
- **`ENV_REGISTRY`** (154 knobs in 21 canonical sections: SERVER → … → FUEL ECONOMY) is the single source of truth; **`ENV_IGNORE`** lists 35 platform/CI/alias names (`K_REVISION`, `GITHUB_SHA`, `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` …) that are never knobs.
- **`auditEnv(env, {templateKeys, codeKeys})`** reports `missingRequired`, `missingRecommended`, `undocumented`, `templateDrift`, `undocumentedTemplate`, `codeDrift`, `placeholders` (untouched template values such as `sk_test_xxx`, `your-service-role-key`, `choose-a-verify-token`) and a `fingerprint` (sha256 over sorted `NAME:length` pairs). **No value is ever serialised.**
- **Endpoints/commands:** `/internal/status` adds an `env` block (`envStatusSummary`, `values:'redacted'`) for a caller holding `SENTINEL_SECRET` — the public payload keeps its shape; `admin env` (`ADMIN_ENV_AUDIT`) returns the deterministic digest and is audited.
- **CLI:** `npm run env:audit` (local `.env` vs `.env.example` + code scan), `--remote` (live revision through `/internal/status`), `--cloud` (optional gcloud describe → flag secrets mounted as plain env vars instead of `--set-secrets`), `--json`. Exit 1 on a missing required key or registry drift. `npm run health` runs the same audit (required = red, recommended/template values = amber) and runs `test_env_audit.js` (44 assertions) in the stateless set.
- `.env.example` gained the "v1.32.4 — ENV PARITY" section documenting the short-link probe, Sentinel stall, remediation, hot-path cache, admin paging and legacy-VIN knobs the code already read.

### 78.6 Chat quick wins (from the live transcript)
- `looksLikeReportRequest()` treats deliverable-shaped requests ("send me as a detailed pdf", "email me the full pdf", "prepare a document") as report requests, so they can never start an expense quiz.
- `composeMessage()` rejects contentless renders through the exported `isContentlessReply(text, {facts})` — a bare "Got it / Noted / Got your vehicle details!" falls back to the deterministic, fact-bearing text (or is dropped) instead of being sent. The core prompt and the composer system prompt both carry the NO EMPTY REPLIES rule plus four friction rules (pdf = report, dated summary = query, follow-up total = correction, competing drafts = ask, never merge).
- The receipt vault stored `receiptHints.notes` in the `vendor` column; it now stores the real merchant from `extractDocumentHints().vendor`, so receipt lists and duplicate notices print a shop name instead of an OCR note blob.
- **Deferred to v1.33.0** (planned with the editable ledger, same surfaces): notes keyword search, single-day digest for "summary for <date>", and the non-fuel odometer policy. They all touch the quiz/entry pipeline that v1.33.0 rewrites, so they ship there rather than being half-wired twice.

### 78.7 Files, tests, knobs
- **Files:** `src/services/pdfEngine.js`, `pdfTextExtractor.js`, `linkShortener.js`, `reportDelivery.js`, `envAudit.js` (new), `statusProbe.js`, `conversationEngine.js`, `quizEngine.js`, `superadmin.js`, `src/routes/whatsapp.js`, `index.js`, `sakaAi.js`, `scripts/env_audit.js` (new), `scripts/health_audit.js`, `package.json`, `.env.example`.
- **Tests:** `test_pdf_engine.js` (**68** — alpha guard, KPI geometry, no-wrap cells, 722 pt cover band, leak sensor), `test_link_shortener.js` (**45** — probe verdicts, caching, 404 page), `test_env_audit.js` (**44**, new — registry ≡ template, no value leaks), `test_agent_training.js` (**121** — prompt + composer friction rules), `test_quiz_flow.js` (**112** — pdf-shaped report routing), plus `test_status_probe.js` (14) and the report suites.
- **Knobs:** `SHORT_LINK_PROBE` (on), `SHORT_LINK_PROBE_CACHE_MS` (600000), `SHORT_LINK_PROBE_TIMEOUT_MS` (3000).

---

## 79. Editable Ledger (v1.33.0)

The user could log everything and change nothing: a wrong amount, a wrong fuel
type or a receipt booked twice had no WhatsApp escape hatch. v1.33.0 gives the
ledger a deterministic edit/delete/restore surface — zero AI tokens, no DDL.

### 79.1 Command grammar (engine-owned)
| The user says | The engine does |
|---|---|
| `my entries` / `show my ledger` / `entries` | Last 6 rows (expenses + earnings) numbered, newest first, with an `edit 2` / `delete 2` hint |
| `edit 2`, `edit my last entry`, `I made a mistake on the fuel entry` | Opens that row: current values + editable vocabulary + `cancel` |
| `amount 4800, type parts, odometer 50,350, 42 litres, full tank, notes: …` | Applies only the whitelisted fields in one pass, prints a before -> after diff |
| `delete 2`, `remove my last expense`, `wrong amount … delete it` | Shows the row, waits for the literal word `DELETE` |
| `restore` / `undo the delete` | Replays the last deletion snapshot (30-minute window) |
| `cancel` / `stop` / `no` | Leaves everything untouched |

`detectLedgerCommand()` never fires on a fresh log (`logged 40L at 50,350 km`),
on a subscription/account cancel (`cancel my subscription`, `delete my account`)
or on a report request — the suite pins those exclusions.

### 79.2 `src/services/entryAnswers.js` (pure, no I/O)
- **Detectors:** `detectLedgerCommand()`, `parseEntrySelection()` (`2`, `#2`,
  `entry 3`, `the second one`, `last`), `parseEntryEditRequest()` (amounts with
  or without a currency word, `from repairs to parts`, odometer, litres, fill
  type, notes).
- **Expense types are canonicalised through `resolveExpenseType()`** (rule 23 —
  one catalog); a small `EXTRA_TYPE_ALIASES` map only adds conversational words
  the catalog lacks (`fix`, `garage`, `spares`).
- **`resolveLedgerTurn({ pending, text, now })`** is the single decision point:
  `none | command | select | edit-apply | delete-confirm | cancel`. It owns the
  15-minute pending TTL, and it returns `{ type:'none', dropPending:true }` when
  a fresh log line arrives mid-edit — an abandoned edit prompt can never swallow
  `Logged 40L at 50,350 km`.
- **Copy:** `formatLedgerList()`, `formatEditPreview()`, `formatDeleteConfirm()`,
  `formatEntryDiff()`, `formatEntryUpdated()`, `formatEntryDeleted()`,
  `formatEntryRestored()`, `formatRestoreEmpty()`, `formatNoEntryForSelection()`,
  `formatLedgerHelp()`. Money/volume always carry units via `globalization.js`.


### 79.3 `src/services/entryLedger.js` (database)
- **Two halves of one ledger:** `expense_logs` (kind `expense`) and
  `private_earnings` (kind `earning`, stored as `revenue_amount` + `logged_at`);
  `shapeRow()` normalises earnings so callers see one shape.
- **`sanitizeEntryUpdate(kind, patch)` is the wall:** expense whitelist
  `expense_type, amount, fuel_liters, fill_type, odometer_reading, notes`;
  earning whitelist `earning_type, amount, notes`. `LEDGER_PROTECTED_FIELDS`
  (`id`, `vehicle_id`, `driver_id`, `owner_id`, `created_at`, `logged_at`,
  `vin`, `plate_number`, `qr_passbook_token`) are always rejected and reported.
  Sane bounds: amount 0 < a <= 1e9, litres 0-5000, odometer 0-10,000,000,
  `fill_type` in {full_tank, top_up}.
- **Lane checks:** `listLedgerEntries()` scopes by the caller's vehicles (a
  driver lane only sees rows it logged); `getLedgerEntry()` re-proves visibility
  before any write.
- **`deleteLedgerEntry()` is a hard delete** preceded by a full-row `SELECT`
  snapshot. **`restoreLastDeleted()`** finds the newest `LEDGER_ENTRY_DELETED`
  audit row inside the window, scoped to the caller's vehicles, and re-inserts
  the snapshot with its original id — a second restore cannot duplicate the row.
- **Audit trail:** `LEDGER_ENTRY_UPDATED` (before + after), `LEDGER_ENTRY_DELETED`
  (full snapshot + `restore_until`), `LEDGER_ENTRY_RESTORED` (source audit id) in
  `admin_audit_logs` (`admin_phone` = the acting WhatsApp number).
- **Never throws.** Every function returns `{ ok, reason }` so a ledger command
  degrades into one friendly sentence.

### 79.4 Route wiring (`src/routes/whatsapp.js`)
- The turn is resolved once, before any AI call, right after the compliance read
  commands; the branch sits immediately before `receiptsCommand` in the
  deterministic chain.
- **`quizPhaseLocked` (PIN / account OTP) is never hijacked** — the ledger stays
  silent while a security code is expected. An abandoned draft is *parked*
  (`abandonQuiz(..., { reason:'ledger_command' })`), exactly like read commands.
- Pending state lives on the chat session (`session.pendingEntryAction =
  { mode, key, at }`) and therefore survives Cloud Run restarts through
  `chat_sessions` (sessionStore). It expires after 15 minutes.
- Intents: `EDIT_ENTRY` / `DELETE_ENTRY` (registered in `SAKA_INTENTS`, the JSON
  schema, `SAKA_INTENT_PLAYBOOK`, the boundary rules and the core prompt's
  EDITABLE LEDGER block); list/cancel/restore answer as `GENERAL_CHAT`.

### 79.5 Locked fields & known limits
- VIN, plate, vehicle, user, driver and the entry date are **not editable** —
  the same immutability doctrine as the vehicle (rule 8) applied to the ledger.
- Deleting an expense does **not** roll the vehicle odometer back: `current_mileage`
  is a high-water mark used for reminders and fuel economy. A wrong odometer is
  *edited*, not deleted, so history stays monotonic.
- Still deferred to the next release: notes keyword search, single-day digest
  for `summary for <date>` and the non-fuel odometer policy (see 78.6).

### 79.6 Files, tests, knobs
- **Files (new):** `src/services/entryAnswers.js`, `src/services/entryLedger.js`,
  `test_entry_ledger.js`. **Modified:** `src/routes/whatsapp.js`,
  `src/services/flowKnowledge.js`, `sakaAi.js`, `test_agent_training.js`,
  `scripts/health_audit.js` (the ledger suite joined the health gate).
- **Tests:** `test_entry_ledger.js` (**89 assertions** — detectors, selection,
  edit parsing, pending state machine + TTL + fresh-log guard, whitelist and
  immutability, copy, and a live edit -> delete -> restore round-trip that
  cleans its own rows), `test_agent_training.js` (**126** — 41 intents,
  playbook, boundary rule and prompt block).
- **Knobs:** `ENTRY_PENDING_TTL_MINUTES` (15), `ENTRY_RESTORE_WINDOW_MINUTES`
  (30), `ENTRY_LIST_LIMIT` (6) — exported constants, no env surface (they are
  UX guarantees, not deployment knobs).

---

### 80.1 Narrative Intake engine (v1.34.0)

One pasted free-text sentence becomes a whole draft � deterministically, with
zero AI tokens, and with AI output never allowed to overwrite it.

- **Money lexicon** (`src/services/moneyLexicon.js`): classifies every number
  in the sentence. Unit-suffixed numbers are measurements (`40L`, `50350 km`),
  bare 6+ digit integers are odometers, 4-digit model years are years, counts
  stay counts (`2 tyres`), `@227`-style per-litre prices are separated from
  the spend, and additive words (`and`, `plus`, `total`) combine or total
  line items with labels (`brakes 4,500 + labour 2,500` -> 7,000, derived).
  Currency words resolve by country (`50 bob` -> KES, `45 dollars` -> USD).
  Without a marker the draft is `ambiguous` and is never auto-prefilled.
  Dates/years are blanked before scanning so `28/10/2026` never yields 28, 10
  or 2026 as money, and `fuel 2000` is a spend while `Toyota Fielder 2016` is
  a year.
- **Past-date resolver** (`extractPastDatePhrase` in
  `src/services/dateParser.js`, rule 36): resolves yesterday / last Friday /
  3 days ago / `28/10` with country-resolved DD/MM vs MM/DD, normalized to
  Africa/Nairobi. Future phrases are rejected (`future: true`) and two
  different days in one message yield `multi-date` � the draft refuses to
  pick a day and the flow asks instead.
- **Draft builder** (`src/services/narrativeDraft.js`):
  `buildNarrativeDraft()` resolves the kind (expense | earning | mileage),
  expense type (shared catalog), amount, fuel volume (gallons converted by
  the user's unit system), fill type, odometer (miles converted), vendor,
  vehicle (plate > ordinal > make/model token > single > active-default,
  flagged when defaulted) and the retro date. A mentioned plate is masked
  before number parsing so `KCB 456B` never reads as money.
  `shouldPrefillNarrativeDraft()` gates: ambiguous money or `multi-date`
  never pre-fill. `narrativeDraftFields()` is the deterministic authority �
  the route merges it AFTER any AI extraction so AI can never overwrite it.
- **Write path** (`src/services/quizEngine.js`): `startQuiz()` stashes
  `session.quiz.narrativeExtras` (`occurred_at`, `occurred_at_iso`, vendor,
  unit price) from `aiExtracted._narrative`. The `log_expense` and
  `log_earnings` writers run `sanitizeRetroTimestamp()` (past or now only;
  future dropped) and set `created_at` (and `logged_at` for earnings) on the
  FRESH insert only � no DDL, and the editable ledger can never change a
  date (rule 37).
- **Route wiring** (`src/routes/whatsapp.js`): after ledger and receipts,
  before the generic quiz turn � for `LOG_EXPENSE` / `LOG_EARNINGS` /
  `UPDATE_MILEAGE` when no quiz and no media is in flight, the draft is
  built and passed as `aiExtracted` (deterministic fields + `_narrative`).
  Not pre-fillable drafts fall through to the existing behavior unchanged.

### 80.2 Files, tests, knobs

- **Files (new):** `src/services/moneyLexicon.js`,
  `src/services/narrativeDraft.js`, `test_narrative_draft.js`.
  **Modified:** `src/services/dateParser.js` (+`extractPastDatePhrase`),
  `src/services/quizEngine.js` (narrative extras, retro `created_at`/
  `logged_at` writes), `src/routes/whatsapp.js` (narrative branch),
  `sakaAi.js` (NARRATIVE INTAKE prompt block), `src/services/flowKnowledge.js`
  (log_expense trigger/extracted/rules), `src/services/conversationEngine.js`
  (quiz instruction honours pre-fills), `src/services/envAudit.js`,
  `.env.example`, `scripts/health_audit.js`.
- **Tests:** `test_narrative_draft.js` (**91 assertions** � money/volume/
  odometer/vendor/vehicle/date determinism, never-guess corpus, KE/US
  country conventions, AI-never-overwrites guard, kill switch, and a live
  pre-fill -> confirm -> write round-trip proving `created_at` equals the
  stated Nairobi day; cleans its own rows).
- **Knobs:** `NARRATIVE_INTAKE` (on by default; `off|false|0|no|disabled`
  disables narrative pre-fill). Registered in `envAudit` GROWTH &
  RE-ENGAGEMENT section next to `NATURAL_INTAKE`.
- **Still deferred:** draft confirmation cards (v1.35.0), record answers +
  `QUERY_RECORDS` intent (v1.36.0), corrections 2.0 incl. the re-log
  collision fix (v1.37.0), multi-record paragraphs (v1.38.0).

### 81.1 Draft Cards (v1.35.0)

A narrative pre-fill is no longer invisible: it confirms through an
engine-rendered card the user checks before anything is written.

- **Renderer** — `renderNarrativeCard(state, ctx)` in
  `src/services/quizEngine.js` builds the card from live quiz state +
  `narrativeExtras` (Vehicle, Type/Earning/Odometer-update, Amount in local
  currency, Volume, Fill, Odometer, When = `occurred_at_label`, Place =
  vendor, Notes) and ends with quick actions `1 ✅ Save it · 2 ✏️ Change
  something · 3 ❌ Cancel`. Deterministic — zero AI tokens.
- **Confirm path** — `askCurrent()` returns the stored `narrativeCard`
  instead of the composed summary; `isYes` accepts `1`/`1️⃣`, `isNo` accepts
  `3`/`3️⃣` (both helpers are confirm-phase-only, so menu replies elsewhere
  are unaffected).
- **Change path** — `2` (or change/edit/fix) answers with a deterministic
  "which field?" prompt; the next message runs the normal correction flow
  (`applyCorrections`) and the card re-renders with `✅ Updated: <label>`
  above it. The card can never go stale.
- **Fastest path** — for narrative drafts, unanswered optional fields
  (notes, earning type, period) are auto-skipped at start so the card is the
  first thing shown; corrections remain one message away.
- **Eligibility threshold (D5)** — `isNarrativeEligibleText()` in
  `src/services/narrativeDraft.js`: intake engages only for ≥40 chars, a
  sentence break, or a narrative marker (past-date word, `@` price, fill
  word, measurement unit, `at <Proper noun>`). Short one-liners keep the
  v1.24+ instant paths unchanged. The route guard is in the narrative branch
  of `src/routes/whatsapp.js`.
- **Writes unchanged** — action 1 executes the same audited write path as
  v1.34.0 (retro date still lands in `created_at` on the fresh insert; a
  future date is still dropped).

### 81.2 Files, tests

- **Files:** `src/services/quizEngine.js` (card renderer, confirm branch,
  quick actions, optional auto-skip), `src/services/narrativeDraft.js`
  (`isNarrativeEligibleText`, `kind` added to extras),
  `src/routes/whatsapp.js` (threshold guard), `sakaAi.js` (draft-card rule
  in the NARRATIVE INTAKE block), `src/services/flowKnowledge.js`
  (log_expense rules mention the card + quick actions).
- **Tests:** `test_quiz_flow` (**128** — card rendering, quick actions
  1/2/3, correction re-render, retro-date save through the card),
  `test_narrative_draft` (**100** — eligibility threshold both sides, kind
  in extras), `test_agent_training` (**130** — prompt carries the quick
  actions). No new env knobs.
- **Still deferred:** record answers + `QUERY_RECORDS` (v1.36.0),
  corrections 2.0 (v1.37.0), multi-record paragraphs (v1.38.0).
---

### 82.1 Record Answers (v1.36.0)

Questions about the user's own logged records are answered deterministically
from the ledger — zero AI tokens, figures never invented.

- **Parser** — `parseRecordQuestion()` in `src/services/recordAnswers.js`
  (pure): classifies the question (total | count | average | list), resolves
  expense types through the shared catalog ("fuel" → Fuel, "parking" →
  Parking), flips to the earnings ledger on earning words, captures an
  explicit plate, and resolves the period through
  `dateParser.resolveDateRange()` — yesterday, last Friday, last week
  (trailing 7 days), last N days/weeks/months, this/last month, this year,
  "in October" (year rollback when the month is ahead), and "from 1 Oct to
  15 Oct". Endpoints are country-resolved (DD/MM vs MM/DD), ends clamp to
  today, and the width is capped at 730 days. Never throws.
- **Query** — `queryRecordLedger()` in `src/services/recordQuery.js`
  (DB): scoped to the caller's vehicles (owner/driver lane like the editable
  ledger), Nairobi calendar-day boundaries converted to UTC range ends, rows
  capped at 100, sums/counts/averages/litre totals computed in code. Reads
  `expense_logs` or `private_earnings` by question side.
- **Renderer** — `formatRecordAnswer()` (pure): localized money via
  `formatMoney`, litre totals, 6-row lists with a "my entries" pointer,
  multi-vehicle scope line, and an honest "Nothing logged" for empty periods.
- **Route lane** (`src/routes/whatsapp.js`) — sits beside the v1.33 ledger
  lane with the same guards: never inside a PIN/OTP phase
  (`quizPhaseLocked`), parks an abandoned draft (`record_query` reason),
  and answers only when the parser matched. An AI-classified QUERY_RECORDS
  that the engine could not parse gets a deterministic "ask me like this"
  nudge — never an AI answer with invented figures.
- **Intent (42)** — `QUERY_RECORDS` registered in `SAKA_INTENTS`, the
  classifier JSON schema, `SAKA_INTENT_PLAYBOOK`, the core-prompt QUERY
  RECORDS block and `test_agent_training` (registry stays the single source
  of truth, rule 13).

### 82.2 Files, tests

- **Files (new):** `src/services/recordAnswers.js`,
  `src/services/recordQuery.js`, `test_record_answers.js`.
  **Modified:** `src/services/dateParser.js` (+`resolveDateRange`),
  `src/routes/whatsapp.js`, `sakaAi.js`, `src/services/flowKnowledge.js`,
  `scripts/health_audit.js` (the suite joined the health gate).
- **Tests:** `test_record_answers.js` (**35 assertions** — question parsing
  incl. type/earning/plate resolution, country-resolved date ranges, all four
  renderers, and a live seeded-ledger round-trip proving "yesterday" totals
  exactly 5,800 and fuel-only filters to 5,500 · 40 L; cleans its own rows),
  `test_agent_training.js` (**133** — 42 intents, QUERY RECORDS prompt block
  and playbook entry).
- **Still deferred:** corrections 2.0 incl. the re-log collision fix
  (v1.37.0), multi-record paragraphs (v1.38.0).
---

### 83.1 Corrections 2.0 — delete & re-log (v1.37.0, D1)

A ledger correction is one honest operation: remove the wrong row, log the
right one — and the restore window can never resurrect the superseded row.

- **`relogLedgerEntry()`** (`src/services/entryLedger.js`): reads the row,
  hard-deletes it with its full snapshot audit (`LEDGER_ENTRY_DELETED` +
  `restore_until`), inserts a FRESH row built from the snapshot + the
  sanitized patch (whitelist unchanged: `expense_type, amount, fuel_liters,
  fill_type, odometer_reading, notes` / earnings `earning_type, amount,
  notes`), keeps the ORIGINAL entry date (`created_at` rides the fresh
  insert — the v1.34 retro-date rule), and audits
  `LEDGER_ENTRY_UPDATED` with `via: 'relog'`, `old_entry_id`,
  `new_entry_id` and the consumed audit id. VIN, plate, user, vehicle and
  date stay locked (rule 8/37).
- **D1 collision fix** — `markDeletedEntryRelogged()` stamps
  `details.relogged_entry_id` onto the matching DELETE audit row, and
  `restoreLastDeleted()` skips any DELETE row carrying that marker.
  `restore` after a correction therefore returns `nothing_to_restore`
  instead of duplicating the corrected row; a plain delete keeps the normal
  30-minute restore.
- **Copy** — `formatEntryRelogged()` (deterministic) renders "Entry
  corrected" with the same before → after diff and states that the old row
  was removed and the corrected one re-logged.
- **Route** — the ledger lane's `edit-apply` branch now calls
  `relogLedgerEntry` (was `applyEntryUpdate`); blocked patches fall back
  to the edit preview with the locked-field list, unchanged.

### 83.2 Files, tests

- **Files:** `src/services/entryLedger.js`, `src/services/entryAnswers.js`,
  `src/routes/whatsapp.js`, `sakaAi.js` (EDITABLE LEDGER block),
  `src/services/flowKnowledge.js` (EDIT_ENTRY playbook).
- **Tests:** `test_entry_ledger` — the live round-trip now proves relog
  (old row gone, fresh row with corrected values + preserved date, locked
  fields rejected), that restore-after-correction is blocked, and that the
  plain delete → restore → double-restore contract is unchanged; new copy
  assertions for the correction headline. Cleans its own rows.
- **Still deferred:** multi-record paragraphs (v1.38.0).
---

### 84.1 Multi-record paragraphs (v1.38.0, D4)

One paragraph describing several complete records becomes a numbered plan
card — deterministically, with every row written through the normal audited
path.

- **Splitter** — `buildNarrativeParagraphDrafts()` in
  `src/services/narrativeDraft.js`: splits on sentence breaks, and on an
  "and" between two amount-bearing parts; each chunk then runs the exact
  single-draft machinery (money lexicon, plate masking, per-chunk past
  dates). A single additive line ("brakes 4,500 plus labour 2,500") stays
  ONE record; a chunk that cannot pre-fill safely is rejected (never
  guessed); a chunk without its own date simply has none.
- **Plan card** — `renderNarrativeBatchCard()` lists the numbered rows via
  `describeNarrativeDraft` with actions `1 ✅ Save all · 2 ✏️ Edit one ·
  3 ❌ Cancel`. Deterministic, zero AI tokens.
- **Batch state** — `session.narrativeBatch = { drafts, at }` with a
  15-minute TTL (same pattern as the editable ledger's pending state);
  `resolveNarrativeBatchTurn()` owns save-all / edit N / cancel / expiry.
- **Route** (`src/routes/whatsapp.js`): SAVE ALL loops the drafts and
  drives each one through `startQuiz` + the confirm action of the same
  quiz engine write path (dedupe guard, trial activation, retro
  `created_at`), then reports "Saved N of M" with the row summaries. Edit N
  reopens that draft's confirmation card; cancel writes nothing. A fresh
  single-record line always outranks a stale batch.
- **Wiring fix** — the route's quiz call now passes the narrative
  `aiExtracted` (deterministic fields + `_narrative` extras) instead of
  the raw AI extraction, so retro dates and pre-fills ride through in
  production exactly as the unit tests have always asserted.

### 84.2 Files, tests

- **Files:** `src/services/narrativeDraft.js`,
  `src/routes/whatsapp.js`, `sakaAi.js`, `src/services/flowKnowledge.js`.
- **Tests:** `test_narrative_draft` (**115** — two/three-record splits,
  additive keep-together, earning+expense kinds, per-chunk dates, batch card
  rendering, turn resolver incl. TTL expiry, and a live SAVE-ALL round-trip
  writing two rows with cleanup).
- **Roadmap complete:** v1.34 intake → v1.35 draft cards → v1.36 record
  answers → v1.37 corrections 2.0 → v1.38 multi-record.

---

## 85. Odometer & hour-meter reading policy (v1.39.0)

Research-backed answer to "is a mileage reading really necessary for every
submission?" — **no**. Readings are tiered, catalog-driven and enforced by the
quiz engine:

| Tier | Types / events | Policy | Why |
| --- | --- | --- | --- |
| **Required** | Full-tank fuel fills (road assets) | The quiz REFUSES Skip | The reading anchors the brim-to-brim km/L segment; without it the economy engine quarantines the fill (`full_fill_missing_odometer`) |
| **Required (flow-enforced elsewhere)** | Vehicle registration, driver handover/handback, passbook transfer | Already mandatory in those flows | Baseline + distance-driven audits + sale record |
| **Optional (Skip works)** | Top-ups, Charging, Maintenance, Parts, Tyres, Repairs, Consumables | Asked, skip allowed | Service intervals want the reading, but a skipped one must never block a log |
| **Never asked** | Parking, Tolls, Fines, Washing, Insurance, Accessories, Subscriptions, Towing & Recovery, Crew Wages, Mooring & Berthing, Bodywork & Paint, Other | Question absent | The reading adds no signal — asking is pure friction |
| **Hours-led assets** | Heavy equipment, machinery, generators, watercraft | ENGINE HOURS replaces the odometer | Matches `assetMetrics.js` (L/h, fuel burn/hour); the hours ride the entry notes (`Engine hours: N h`) — no DDL |

- **Registry:** every `EXPENSE_TYPES` entry carries `odometerMode: 'fuel' |
  'optional' | 'never'`; helpers `odometerModeForType()`, `isHoursLedKind()`,
  `isFullFillAnswer()` live in `expenseCatalog.js`.
- **Engine:** `quizEngine.expenseReadingFields()` renders three mutually
  exclusive questions (required full-fill odometer, optional odometer,
  optional engine hours) gated by `when` on the answered type + fill + asset
  kind; the expense write path merges hours into notes.
- **Prompt/docs sync (rule 13):** `flowKnowledge` log_expense fields/rules,
  `DEFAULT_SAKA_CORE_PROMPT` ODOMETER POLICY directive,
  `conversationEngine.READING_POLICY_NOTE`.
- **Tests:** `test_expense_catalog` (82), `test_quiz_flow` (128),
  `test_agent_training` (137).

---

## 86. Marketing website & web onboarding (v1.39.0)

### 86.1 `landing/` — the sakafleet.com static site

- **Pages:** `index.html` (hero, WhatsApp chat mock, features, pricing from
  `subscriptionTiers.js` facts, live changelog, live uptime probe), full
  `privacy.html` (KDPA 2019 + GDPR), full `terms.html` (Saka 360, Kenya),
  `404.html`.
- **Conversion architecture:** multi-step modal — details (E.164 phone,
  default +254) → exhaustive legal gate (mandatory checkbox; submit disabled
  until ticked) → inline 6-digit OTP card (resend 60 s cooldown) → success
  with wa.me deep link. Honeypot + global rate limiting.
- **SEO/AEO/AI legibility:** semantic HTML, JSON-LD (Organization, WebSite,
  SoftwareApplication, FAQPage), `sitemap.xml`, `robots.txt` (welcomes
  GPTBot/ClaudeBot/PerplexityBot/Google-Extended), `llms.txt`, OpenGraph +
  Twitter cards, canonical URLs, `manifest.webmanifest`, `humans.txt`.
- **Uptime probe (v1.39.1):** the widget probes `/api/health` first and falls
  back to `/healthz` — Google's edge intercepts `/healthz` on some Cloud Run
  deployments (v1.24.4), so the alias keeps the live-status card honest.
- **Data Deletion (v1.39.1):** `data-deletion.html` (WhatsApp `delete my
  account`, per-entry deletion, email requests, KDPA/GDPR rights + ODPC)
  linked from every footer, the sitemap and `llms.txt`.
- **v1.40.0 refinement wave:** vendor-name/Apex/app-host sweep across all
  visible copy; one-car-friendly language; `/status` page (realtime probe +
  plain-language incident ticker + changelog); cookie-consent flow
  (versioned localStorage, no CMP dependency); self-hosted Outfit/Inter
  fonts (zero third-party requests); locale-based country-code detection on
  the signup form; already-registered visitors skip the OTP ("You're all
  set"); the Privacy Policy documents the cookie categories.
- **v1.41.0 country-aware personalization:** `data/countries.json` (17
  countries) mirrors `COUNTRY_COMPLIANCE_CATALOG` + `REGIONS` exactly —
  drift-guarded by `test_landing_static`. `locale.js` detects the visitor's
  country from the browser locale and renders the flag chip, the
  country-specific compliance section and the signup calling-code default;
  unknown locales get neutral GLOBAL copy. The cookie banner is now a
  - **v1.42.0 extensionless URLs:** `.htaccess` 301s `/page.html` → `/page` and serves `/page` from `page.html` internally; all links, canonicals, sitemap and llms.txt use clean URLs; the proactive welcome always sends the `{{1}}` parameter (fallback "there").- **v1.43.0 first-load + cache:** inline bootstrap renders the flag chip and phone code on first paint; HTML/JSON are no-cache and assets are version-stamped by `npm run landing:stamp`; PNG share image and favicons added.compact slim card (clamped copy, small buttons).
- **Isolation (rule 6):** zero secrets client-side; `test_landing_static.js`
  scans every static file for key patterns and verifies local references,
  structured data and AI files (49 assertions).
- **Styling:** single self-contained `styles.css` (dark navy + cyan/lime,
  Outfit/Inter, CSS-only animations, reduced-motion safe). No frameworks.

### 86.2 Web onboarding handshake (Fastify + Supabase)

- **Routes:** `POST /api/onboard` (validate → `web_onboard_otps` session →
  `sendEmailOtp` via Resend → profile upsert with `email_verified=false`),
  `POST /api/onboard/verify` (3 attempts, 10-min TTL, lockout → profile
  `email_verified=true` + audit + optional WhatsApp template),
  `POST /api/onboard/resend` (60 s cooldown).
- **Service:** `src/services/webOnboarding.js` (sanitize, session, verify,
  resend, complete, `tryVerifyPendingEmailCode`). **The welcome trial is
  NEVER started here (rule 26)** — it begins at vehicle registration in
  WhatsApp. New profiles are inserted with an explicit
  `subscription_tier: 'free'` (v1.39.3): the live schema's legacy `SOLO`
  default normalizes to `solo_pro` with an ACTIVE-equivalent null status,
  which would grant paid entitlements to a brand-new account.
- **Schema:** `public.web_onboard_otps` via `npm run migrate:web-onboard`
  (idempotent) + boot-time `ensureWebOnboardOtpTable()`.
- **CORS:** `LANDING_ORIGINS` (default `https://sakafleet.com,
  https://www.sakafleet.com`; localhost always allowed in dev) opens ONLY
  `/api/onboard*` + `/healthz` + `/api/health` — every other route stays
  closed to browsers.
- **Omnichannel fallback:** in WhatsApp, a bare 6-digit code from a
  registered-but-unverified user (and only when no quiz/onboarding/OTP/PIN
  phase is active) verifies their web code in chat; the core prompt's WEB
  SIGNUPS directive teaches Saka the same.
- **v1.40.0:** already-verified visitors are never re-onboarded
  (`WEB_ONBOARD_EXISTING` audit); verified email changes audit
  `WEB_ONBOARD_EMAIL_UPDATED`; verification now sends the welcome
  proactively (template when configured, plain text inside the 24-hour
  window); every failure is telemetried through `logSystemError` +
  `upsertIncident` into Sentinel's pipeline; expired OTP sessions are
  pruned at boot and every 15 minutes.
- **Welcome message:** `META_WELCOME_TEMPLATE_NAME` (optional, approved Meta
  template) fires on verification; the guaranteed channel is the site's
  wa.me deep link + Saka's first-message greeting.
- **Tests:** `test_web_onboarding.js` (30, stateless in-memory double);
  both new suites registered in `scripts/health_audit.js`.

### 86.3 Hostinger deployment (shared hosting + GitHub Actions FTP)

- `.github/workflows/deploy_landing.yml` deploys **only `landing/**`** to
  Hostinger on push to `main` (path-filtered) via
  `SamKirkland/FTP-Deploy-Action`; credentials live in GitHub secrets
  (`HOSTINGER_FTP_SERVER/USERNAME/PASSWORD`); the job self-skips until the
  secrets exist. The backend repo never reaches Hostinger.
- **v1.39.2 gotcha:** the `secrets` context is unavailable in a job-level
  `if` (the first two runs failed instantly with zero jobs) — the guard is a
  bash step emitting a `ready` output that gates the FTP step instead.
- `landing/.htaccess` ships HTTPS redirect, canonical host, security headers,
  cache policy and a custom 404.
- Operator walkthrough: `docs/LANDING_DEPLOYMENT.md`.

### 88. Website-first onboarding + consent-gated analytics (v1.49.0)

- **Point of entry = website.** The first-contact greeting (`sakaIntroText`),
  newcomer/repeat nudges, the AI welcome prompts and the `how_to_use` product
  answer now lead with `https://sakafleet.com` ("Get Started Free") instead of
  "Reply REGISTER". `SAKA_WEB_SIGNUP_URL` (exported from `flowKnowledge.js`) is
  the single source of truth; `test_greetings`, `test_agent_training` and
  `test_first_message_flow` assert the website link.
- **Registration gate.** In `whatsapp.js`, a user with no vehicle who tries to
  register (register command, `REGISTER_VEHICLE`/`ONBOARDING_INPUT` intent, or
  pasted vehicle attributes) but whose profile is not `email_verified` is
  redirected to the website with the 6-digit-code fallback — the
  `vehicle_registration` quiz is never started. The core prompt teaches the same
  rule ("the WhatsApp vehicle_registration quiz only proceeds once the profile
  is email-verified").
- **GTM (consent-gated).** `landing/assets/js/cookieConsent.js` v2 loads
  `GTM-TGR68X2X` only when `analytics === true` (Accept all / Save with
  analytics). The Meta Pixel is configured inside GTM, so no standalone snippet
  ships. Banner + settings copy, `privacy.html` §11 and `llms.txt` now describe
  opt-in analytics; the consent-key version bump forces a fresh opt-in.
- **Reset gap closed.** The targeted reset SQL now deletes `subscriptions`,
  `trial_sessions` and `usage_counters` by `owner_id` before the profile row is
  removed (they were previously orphaned). `test_db_reset_scope` asserts it.

### 89. Registration-gate regression + fix-status lookup (v1.49.1)

- **Regression (v1.49.0).** The website-first registration gate
  (`registrationEmailGated` in `whatsapp.js`) did not exempt the superadmin, so
  a non-`admin` message from the superadmin phone (e.g. "Status of
  FIX-2026-10-30-01", which is not an explicit `admin …` directive and therefore
  falls through to the normal conversation) was answered with the website-signup
  redirect. Fix: the gate now also requires `!isSuperadminPhone(senderPhone)`.
- **Fix-status lookup.** `parseSuperadminCommand` recognises `Status of
  FIX-<code>` / a bare `FIX-<code>` / `admin FIX-<code>` as
  `ADMIN_REMEDIATION_STATUS`; `handleAdminRemediationStatus` returns the single
  proposal's status/title/risk from `remediation_proposals` and is audited as
  `ADMIN_REMEDIATION_STATUS`. Deterministic — zero LLM tokens.
- **Tests:** `test_update_suggest.js` (+5 assertions), `test_superadmin.js`.

### 90. Website-only signup + OTP, reset coverage (v1.49.2)

- **In-chat web-signup OTP removed.** The bare 6-digit-code verifier
  (`tryVerifyPendingEmailCode` + the "WEB SIGNUP CODE CHECK" block in
  `whatsapp.js`) is deleted, and the registration-gate redirect no longer says
  "Reply with your 6-digit code here". Signup + email verification now happen on
  sakafleet.com only. The core prompt WEB SIGNUPS directive, `flowKnowledge`
  playbook, and `conversationEngine.WEB_SIGNUP_NOTE` all say "website only —
  never invite or accept a code in WhatsApp".
- **Reset coverage.** `web_onboard_otps` joined `RESET_TABLES`, the global
  `TRUNCATE`, and the targeted phone cascade so a clean-slate reset clears
  signup OTP sessions too.
- **Tests:** `test_web_onboarding.js` (WhatsApp-fallback test removed),
  `test_agent_training.js` (+1 "never invite a code in WhatsApp"),
  `test_db_reset_scope.js` (+1 web_onboard_otps cascade).

### 91. Signup tracking + cookie-choice gate (v1.49.3)

- **`successful_signup` dataLayer push.** `main.js` pushes
  `window.dataLayer = window.dataLayer || []` then
  `{ event: 'successful_signup', signup_method: 'website' }` on the
  `/api/onboard/verify` success branch only — never the `already_verified`
  path (returning visitors are not counted as conversions).
- **Cookie-choice gate.** `cookieConsent.js` exposes
  `window.__sakaCookies = { chosen(), open() }`; `main.js` gates `legalSubmit`
  (account creation) on a recorded choice. Both "Accept all" and "Reject
  non-essential" satisfy it, so analytics stays opt-in and signup is never
  blocked on tracking. `open()` re-surfaces the banner.
- **GTM next steps (operator):** Custom Event trigger `successful_signup`,
  GA4 `sign_up` tag, Meta `CompleteRegistration` tag.

### 92. English-first welcome + language-switch confirmation (v1.49.4)

- **Welcome is English-first.** `webOnboardWelcomeText()` (index.js) adds a
  "🌍 Want a different language? Reply in the language you'd like" line; the
  approved `web_signup_welcome` Meta template should mirror it (operator: update
  the template body in Meta Business Manager).
- **Explicit language switch.** `languageSwitchConfirmation(lang)` (whatsapp.js)
  returns a per-language confirmation (Swahili/French/Spanish/German/Arabic +
  a generic fallback). The message handler now sets a `languageSwitchNote` when
  the detected language differs from `preferred_language` and prepends it to the
  reply — replacing the previous silent auto-switch — while still persisting
  `preferred_language`.
- **Prompt sync (rule 13).** The core prompt LANGUAGE section adds "CONFIRM the
  switch" before replying in a new language.

### 93. Mandatory website signup (v1.49.5)

- **Write-path guards.** `quizEngine.persistVehicleRegistration` and legacy
  `onboarding.saveVehicleAssetRecord` refuse to write a vehicle when
  `email_verified !== true`, so the welcome trial can never start before website
  signup. The legacy flow no longer self-sets `email_verified: true`.
- **Registration gate.** `registrationEmailGated` (whatsapp.js) no longer requires
  an empty `onboardingStore`, and clears stale legacy-onboarding state
  (`onboardingStore`, `session.state`, `session.onboardingStep`) on redirect.
- **Legacy auth removed.** `POST /api/auth/whatsapp/request` and
  `/api/auth/whatsapp/verify` (the non-website `email_verified=true` path) are
  deleted from `index.js`.

### 94. Superadmin remediation view (v1.49.6)

- `handleAdminRemediationsList(supabase, filter)` groups proposals into
  **Pending** (`PENDING_APPROVAL`, `APPROVED`, `EXECUTING`, `VALIDATED`,
  `NEEDS_MODIFICATION`), **Deployed** (`DEPLOYED`) and **Declined/Other**
  (`DECLINED`) sections; the hard `limit(8)` is raised to 30 so nothing is
  hidden.
- `parseSuperadminCommand` recognises `admin remediations [pending|deployed|all]`
  and the natural `admin pending|deployed remediations/fixes` aliases; the
  `handleSuperadminFlow` routing audits the filter. `admin remediations`
  defaults to the grouped `all` view.

### 95. True two-tier routing + superadmin-only (v1.50.0)

- **Two-tier decoupling.** `DEFAULT_ANTHROPIC_TIER1_MODEL = 'claude-haiku-4-5'`
  now serves Tier-1 (router/everyday) and no longer borrows `AI_MODEL_TIER_2`;
  Tier-2 (`PREMIUM_MODEL_ENABLED=on`, `maxAiTier >= 2`) stays on
  `claude-sonnet-5-5`. `AI_MODEL_TIER_1_ANTHROPIC` pins/overrides Tier-1.
- **Haiku payload fix.** `buildAnthropicPayload` only sends the
  `thinking: { type: 'between_tools' }` block for Sonnet/Opus models; Haiku and
  other fast models reject a `thinking` block with HTTP 400.
- **Superadmin-only.** `buildRoleContext` returns `['Superadmin']` only; the
  webhook short-circuits a non-admin superadmin message to the admin hub;
  `canAssignDriverToVehicle` refuses the superadmin phone as a driver. The
  superadmin phone (`+254720641985`) can no longer hold Owner/Driver roles.

### 96. Homepage changelog removal + premium on (v1.50.1)

- The "What's new" changelog section was removed from the homepage
  (`landing/index.html` + `landing/assets/js/main.js`); the feed now renders on
  `/status` only, and the footer "Changelog" link points to `/status`.
- `PREMIUM_MODEL_ENABLED=on` (operator): trial/paid users' escalated + prose
  turns run Tier-2 Sonnet; free stays Tier-1 Haiku.

### 97. Unified admin backlog + gentle signup (v1.51.0)

- **`admin backlog`** (deterministic, zero-token) lists `remediation_proposals`
  (`FIX-*` / `SUG-*`, grouped ⏳ pending / 🚀 deployed / ⛔ declined) and
  `weekly_feature_proposals` (`FEAT-*`, review-only) in one view, with
  `admin backlog pending|deployed` filters; audited as `ADMIN_BACKLOG`.
- The `admin proposals` footer no longer points at a non-existent
  `admin approve [code]` — feature blueprints remain review-only.
- **Gentle website signup push:** a returning unverified newcomer (no
  `email_verified`, no vehicle) now receives a rotating `NEWCOMER_NUDGES`
  website nudge instead of a repeated full intro — `isFirstTimeMessage()` is
  gated on `firstContact` in `whatsapp.js`.
- `landing/data/changelog.json` bumped to 1.51.0 (was 1.47.0); `test_landing_static`
  asserts `changelog.latest === package.json` to prevent drift.

### 98. Short links enabled (v1.51.1)

- `SHORT_LINK_DOMAIN_READY=on` + `PUBLIC_APP_URL=https://app.sakafleet.com` are now
  set in Cloud Run (and documented in `.env` / `.env.example`); the `/r/__saka_probe__`
  route was verified live (HTTP 200 + `x-saka-shortlink`), so report PDF and checkout
  links now ship as `https://app.sakafleet.com/r/<code>` instead of the long Supabase
  storage URL.

### 99. FEAT-* approval dead-end fixed (v1.51.2)

- `admin accept/decline/modify fix <FEAT-*>` (and `Status of <FEAT-*>`) now return a
  clear "review-only blueprint" reply via `featureProposalReviewOnlyReply()` instead of
  `⚠️ Unknown proposal` — Sentinel Horizon feature proposals are a backlog, not
  autonomous code changes.

### 100. FEAT adoption (`admin adopt`) (v1.51.3)

- `admin adopt <FEAT-code>` promotes a Sentinel Horizon feature blueprint into the
  remediation pipeline: `captureFeatureAdoption()` looks up `weekly_feature_proposals`,
  inserts a `remediation_proposals` row (`SUG-<date>-<n>`, category `update_suggest`,
  `proposed_changes.overview = title + technical_spec`, `PENDING_APPROVAL`), and marks
  the feature `adopted`. Approval + CI execution reuse the existing `admin accept fix`
  flow unchanged (two-step, mirroring `UPDATE-SUGGEST>`).
- `admin accept/decline/modify fix <FEAT-*>` now points to `admin adopt` instead of a
  dead end.

### 101. Unverified greeting → website (v1.51.4)

- The greeting flow now branches on `email_verified`: an unverified number gets
  `websiteSignupNextStep()` (a website-only CTA) instead of "what do you drive?" in
  `sakaIntroText`, the AI `first_time_welcome` prompt and the `first_time_default`
  prompt — vehicle registration remains gated behind website signup.

### 102. Unverified hard gate (v1.51.5)

- A single early gate in `whatsapp.js` (after the profile load, superadmin exempt)
  returns a one-line website-signup message for any number whose
  `profile.email_verified !== true`, short-circuiting greetings, product QA, menus,
  registration and the AI conversation. This supersedes the v1.51.4 per-branch
  greeting checks (kept as harmless defense-in-depth).

### 103. Unverified media gate (v1.51.6)

- The unverified hard gate now also runs for media turns, BEFORE the OCR ack and
  Vision call: an unverified number's photo/PDF gets the website line immediately
  (no "Reading your photo" ack, no download, no OCR). This closes the "ack without
  follow-up" hole where an unverified logbook submission produced silence.

### 104. Document-turn resilience (v1.51.7)

- Document Lens parsing is now best-effort (try/catch) in the media turn, and
  `recordOcrRequest` telemetry is written BEFORE the lens using the safe
  `classifyOcrDocument` classifier — a lens crash degrades to raw OCR text and
  still leaves a durable `ocr_requests` row.

### 105. Registration email/OTP is website-only (v1.51.8)

- The WhatsApp `vehicle_registration` quiz no longer asks for `owner_email` or an
  `otp` code. Signup + email verification happen only on sakafleet.com; the quiz
  is only reachable once the profile is `email_verified`, and `persistVehicleRegistration`
  uses `ctx.profile.email` for the vehicle record, profile sync and passbook email.
- The legacy `onboarding.js` path skips the chat email/OTP step for verified profiles
  (falls back to `profileData.email` and checks `profileData.email_verified`).
- Synced `flowKnowledge.js` (field order + extracted keys), `SAKA_TRAINING.md` playbook
  and the architecture flow table (rule 13).

### 106. Cloud Run deploy-noise classifier + cut-off reply recovery (v1.51.9)

- **Deploy-noise decoder (FIX-2026-11-02-01 / FIX-2026-11-02-02):** printable-run extraction from protobuf AuditLog byte arrays, the Ready/Waiting-for-revision condition family added to `DEPLOY_NOISE_RE`, `CLOUD_RUN_ROLLOUT_NOISE_RE`, signature-based dedupe inside `scanCloudRunAnomalies`, source classification in `fetchCloudRunLogs` via `isRolloutLifecycleEntry`, and the guarantee that genuine Ready-condition failures still alert (see §59.4).
- **Cut-off reply recovery (FIX-2026-11-03-01):** `isIncompleteReplyComplaint` widened (cut off / only half / where is the rest / finish your answer / …) and `replyContinuationRequestFor()` returns `isComplaint`, `isContinuation`, `detectedFleetCount` and `wantsFullAnswer` so the route parses the fleet count in one place. The reply-quality branch is currency-agnostic and, when the composer reports `stoppedAtCap` (new `isOutputCappedStop()` treating `max_tokens` and `length`), sends the deterministic facts instead of a truncated sentence. New `complaint_recovery` AI purpose maps to `question_render`; `shouldSendSlowAck` never fires after the first outbound reply; Sentinel maps the cut-off vocabulary to `INCOMPLETE_REPLY`; the core prompt + flowKnowledge carry the COMPLETENESS COMPLAINTS rule.

### 107. Interactive quick-edit payload builder (v1.51.10)

- **SUG-2026-11-03-01 clause 7 only.** An audit of the approved suggestion showed
  six of its seven clauses already ship (§52 Document Lens field-level confidences
  + confirm-before-save, §36 COMMENCING-vs-EXPIRING insurance disambiguation in
  `ocrService.js` and `complianceCatalog.js`, §76 deterministic compliance
  correction ("you read it wrong … expiry is …"), `deliverReportPdf` →
  `sendReportByEmail`, and `buildVehicleSummary`/`emailVehicleSummary`). The one
  genuine gap was WhatsApp **interactive** messages: `grep -ri interactive src/`
  returned zero hits and the outbound sender only emits `type:"text"`.
- **New pure module `src/services/interactiveReply.js`:**
  - `buildInteractiveReply()` renders a Cloud API `interactive` payload —
    `type:'button'` for 1-3 actions (limit `maxButtons`), `type:'list'` for 4-10
    rows — and ALWAYS returns a `fallbackText` so a caller without button support
    degrades to plain text.
  - `buildReplyButton()` / `resolveQuickEditButtonId()` map a button id
    (`<action>` or `<action>:<field>`) back to the operator a user would have
    typed, so quick edits reuse LIVE grammar instead of duplicating it.
  - `QUICK_EDIT_ACTIONS` aggregates the two existing whitelists
    (`edit_vehicle_fields`: plate/make/yom/fuel and `sanitizeEntryUpdate`:
    expense_type/amount/fuel_liters/fill_type/odometer_reading/notes) plus the
    compliance-correction detector. `INTERACTIVE_LOCKED_FIELDS`
    (`vin`, `qr_passbook_token`, `vehicle_id`, `driver_id`, `user_id`,
    `entry_date`) is refused by every builder — rule 8 holds: a VIN button can
    never be produced or resolved.
  - Never throws; every entry point degrades to `null`/text.
- **Not wired to the wire, by design:** the sender in `src/routes/whatsapp.js`
  still sends `type:"text"`. Emitting interactive objects requires the buttons to
  be registered and tested on the Meta WABA; shipping them blind from a headless
  run would risk dead buttons for live users.
- **Superadmin lane (existing `admin` family, no new Saka intent):**
  `admin quick-edit` (also `admin quick edit` / `admin quickedit preview`) →
  `ADMIN_QUICK_EDIT_PREVIEW`, handled by `formatQuickEditPreview()` and audited
  as `ADMIN_QUICK_EDIT_PREVIEW`. Deterministic, zero AI tokens, Superadmin-gated
  by `handleSuperadminFlow` like every other branch; listed in
  `formatAdminHelpReply()`.
- **Deliberately NOT included:** a literal `trial status` command. `subscription`
  already answers it deterministically (`formatSubscriptionSummary` →
  "🎁 Free trial — N day(s) left (ends <date>)"). A new phrase matcher would have
  to be mirrored in `flowKnowledge.js`, the Saka core prompt, the role index and
  the docs in the same commit (rule 13); rule 18 forbids editing the prompt from
  this autonomous run, so it stays a human-session change.
- **Intents/flows unchanged:** `SAKA_INTENTS` stays 42 and `SAKA_QUIZ_FLOWS` stays
  21 — the builder is an operator-rendering utility, not a new classifier lane.

### 108. Registration certificates register vehicles (v1.51.11)

- **NTSA "REGISTRATION CERTIFICATE" → registration, never a receipt.** `extractDocumentHints(…, 'logbook')` now parses the certificate layout: the plate from the line under the title (old `N7200766H` and new `KDA 123A` formats), `MAKE OF VEHICLE`/`MODEL`/`FUEL TYPE` label values (fuel restricted to known fuel words) and a labelled YOM. A real VIN must contain letters — a pure-digit `TRANSFER` number is never stored.
- **Routing (media turn):** `logbook` uploads with extracted fields start the `vehicle_registration` quiz prefilled (via `handleQuizTurn` `prefill`) and open with a deterministic "I read these from your registration certificate: …" summary. The receipt dedupe, "already read this receipt" reply, receipt vault and `receiptQuizStart` are now gated to `receipt_fuel`/`receipt_general` only.
- **Empty-expense guard:** the `log_expense` write path refuses to write without a type and a positive amount — "Logged expense of amount." is impossible.
- **Logbook CTA:** `asksToUploadLogbook()` (greetings.js) answers "Can I upload the logbook?" deterministically with a YES and one next step.
- **Git auto-sync (rule 32):** `scripts/sync_origin.js` (skips in CI) is wired as `prehealth`/`pretest`, so every `npm run health`/`npm test` first fast-forwards `main` to `origin/main` — a local session can never run gates on a stale tree after an autonomous push.
- **Tests:** `test_ocr_flow` 93 (NTSA fixture + date-stable duplicate fixture), `test_greetings` 94, `test_quiz_flow` 128.

### 109. Own-data snapshot + OWN-DATA LAW (v1.52.0)

- `buildUserContextSnapshot()` now carries the user's OWN data end-to-end: per-vehicle `insurance_expiry`/`inspection_expiry` with days-left/overdue, the driver compliance record (`compliance_type` + `compliance_expiry`), the trial end date with days-left, and vehicle YOM/VIN. "When does my insurance expire?" is therefore answerable from the facts in BOTH the deterministic compliance lane (`detectComplianceExpiryQuestion` → `buildComplianceExpiryAnswer`) and the composed `user_data_answer` path.
- **OWN-DATA LAW** in the core prompt: the FACTS block is the user's own data and is theirs to read — give the exact figure, never claim you lack access, and when a field is genuinely missing, name the exact missing field and offer the ONE step to add it.
- The access-refusal family (`I don't have access to`, `I can't access`, `I do not have that data`, `that data is not available to me`) joins the banned phrases in the core prompt and `SAKA_TONE_COMPASS.bannedPhrases` (rule 13 synced).
- `user_data_answer` instructions now tell the composer "userDataFacts is the user's own data — read from it FIRST".
- **Tests:** `test_user_data_access.js` (8, stateless, registered in the health gate), `test_agent_training` (145).

### 110. Conversational-first replies + no-canned ratchet (v1.52.1)

- Every prose reply in the WhatsApp route is composed by `composeMessage` from facts with the previous sentence demoted to `fallbackText`: website-signup gates, records-query hint, support escalation, assignment cancellation, OTP dispatch, batch cancellation, logbook upload invite, drive nudge (no-plate invariant), pause confirmation, duplicate-receipt reply.
- Only progress indicators stay literal (instant "reading now" ack, slow-turn ack rotation, media ack) — they are transitory signals, never answers.
- `test_no_canned_replies.js` (stateless, registered in the health gate) scans `whatsapp.js` for direct literal user-facing replies and ratchets the count at ≤ 20 — the quiz outcome cards are the remaining batch, converted in follow-up releases. Any NEW canned literal fails `npm run health`.
- The superadmin operator console stays deterministic (hybrid console per the plan).

### 111. Personality v3 (v1.53.0)

- **Tone-dimension lock (NN/g research):** casual-warm, always respectful, never sarcastic/irreverent, matter-of-fact with milestone-only enthusiasm, mirror-only humour — locked in the core prompt as the PERSONALITY LAW.
- **Plain-language + older-user floors (W3C + plain-language research):** sentences of ~15 words or fewer, everyday words, active voice, "you" address, one idea per line, ONE question per message; on the second struggle offer the simplest path; never rush or imply a deadline; accept fragments, typos, voice notes and mixed languages without scolding. Added to `SAKA_TONE_COMPASS.floors` + the core prompt EVERY-DEMOGRAPHIC LAW.
- **Tests:** `test_agent_training` (147) asserts both new laws; the persona conversation-compliance harness (`test_conversation_compliance.js` with elderly/low-literacy/angry/Shenglish personas + the David Njonjo replay) ships as the follow-up in the same release line.

### 112. Governance v2 — proposal registry + review-in-chat (v1.53.1)

- **Autonomous execution decommissioned.** `dispatchRepositoryEvent` permanently refuses `remediation_execute`; `.github/workflows/remediation_execute.yml` is deleted; `checkRemediationExecutionRetry` returns `decommissioned`; `admin accept fix <CODE>` marks `APPROVED` with `approval_kind: chat_session` — no nonce minting, no CI dispatch. Sentinel keeps scanning, drafting proposals (`remediation_plan` dispatch) and sending digests; implementation happens in superadmin chat sessions (plan → design → act), then the proposal is marked `DEPLOYED`.
- **Single `PROP-*` registry.** All proposal codes are `PROP-YYYY-MM-DD-NN` (Nairobi date): Sentinel fixes (`remediation_ci.js submit-plan`), `UPDATE-SUGGEST>` captures, `admin adopt` work orders, model-update proposals (`aiModelRegistry.js`) and Sentinel Horizon feature blueprints (`sentinel.js`). Origin is carried by `category`. `npm run migrate:proposals` re-codes legacy rows idempotently and stores the previous code in `execution.legacy_code` for lookups.
- **Dormant columns preserved** (`approval_nonce`, `nonce_expires_at`, `execution_dispatched_at`) — no schema churn.

### 113. Onboarding & registration fixed (v1.53.2)

- **KE NTSA "VEHICLE PARTICULARS" parsing** (country profile only, rule 36): value-before-label pairs read the **current** plate (`KAS628T DATE OF REGISTRATION`; the title-line plate is only a GLOBAL fallback and is never mistaken for the current one), make/model/body, year, fuel, engine number and colour. A pure-digit `TRANSFER` timestamp can never become an expiry. GLOBAL documents parse exactly as before (no-leak regression test).
- **Registration correction lane** (`detectRegistrationCorrection` in quizEngine): "you captured/read/got the <field> wrong" clears and re-asks that one field; "edit: <field> <value>" sets the user's value verbatim and runs **before** whole-message extraction so an edit can never clobber the other banked answers.
- **Own-data answer for verification**: the snapshot carries the masked email + `email_verified`, so "is my profile verified?" answers with the real state.
- **Register routing**: "add/register/upload … vehicle / reg cert / logbook" maps deterministically to `vehicle_registration`.
- **Tests:** `test_ocr_flow` 99, `test_quiz_flow` 131, `test_user_data_access` 9.

### 114. ANSWER LAW v2 — full own-data snapshot + zero refusal (v1.54.0)

- **Recent ledger rides the snapshot:** `buildUserContextSnapshot()` adds the last 3 expense + 3 earning rows (Nairobi date, type, amount, plate) plus a bounded `Recent logs` line, so "what did I log yesterday?" is answerable from facts in every composed turn. Structured rows are exposed as `data.ledger`.
- **One populate step per missing field:** the snapshot emits a `Missing (each has one fill step)` line naming each absent field AND its engine-owned single step (insurance expiry → certificate photo or "my insurance expires <date>"; inspection; odometer; driver licence; email). Saka names the field and the step — never an access refusal, never an invented step.
- **OWN-DATA LAW v2:** the core prompt now demands the EXACT figure with local time context (user timezone + days-left from today), bans the widened refusal family (`I can't see`, `not stored on my side`, `I don't hold that data`, `no record of`) in both the prompt and `SAKA_TONE_COMPASS.bannedPhrases`, and points at the snapshot's Missing line as the only sanctioned source of populate steps.
- **Snapshot on data-sensitive turns:** new `buildUserFactsLines()` (capped, never throws) attaches the user's own data to the composed `complaint_recovery`, `friction_apology` and `hard_trip_support_escalation` turns — the two answer lanes (`product_answer`, `user_data_answer`) already carried it since v1.52.0.
- **Tests:** `test_user_data_access` 19 (ledger rows, populate steps, cap), `test_agent_training` 153, `test_kb_docs` 36, `test_no_canned_replies` ratchet unchanged.

### 115. Global OCR hardening — universal normalization + zero-shot top-up (v1.54.1)

- **Universal normalization (`src/services/ocrNormalizer.js`, new):** every OCR value resolves through one layer — `parseOcrAmount()` handles BOTH grouping conventions (1,234.56 | 1.234,56) structurally, resolves single-separator tokens by CLDR locale (45,50 in DE vs 45,50 in KE; 1.234 = thousands in DE, decimal in KE) and never guesses noise (3.000.00 → null); `detectCurrencyFromText()` carries an extended CLDR symbol table (฿ ₱ ₩ ₺ R$ KSh …) with longest-symbol-first so R$ never degrades to $; `validatePlateCandidate()` adds per-country plate patterns (KE/GB/IN/ZA/US/…), the GLOBAL shape stays neutral (rule 36); `validateVinCandidate()` is the universal VIN guard; `normalizeOcrDate()` routes every date through `dateParser` country-resolved.
- **Wired into the existing lens:** `documentLens.amountFrom/parseReceipt/parseInsurance/parsePurchaseInvoice` parse through the normalizer with the caller's countryCode; `ocrService.extractDocumentHints` money tokens and the e-TIMS path delegate too. A German `TOTAL € / 1.234,56` now prefills 1234.56 in the quiz — the GLOBAL path parses the same structurally-unambiguous grouping (no leakage).
- **Zero-shot extraction top-up (`src/services/ocrSemantic.js`, new, flag-gated):** when the deterministic lens misses fields, an `ocr_extraction` background-tier JSON call (bounded 4k chars, purpose registered in `AI_PURPOSES`) proposes values for EMPTY slots only; every proposal is re-validated (dates → dateParser, amounts → normalizer, plates → country pattern, VIN → guard) and invalid values are dropped. The deterministic lens is ALWAYS the authority. Kill switch `OCR_AI_EXTRACTION` (default **off** in the testing phase), env-registered + `.env.example` documented. Wired after the lens in the WhatsApp media turn; any failure keeps today's behavior.
- **Purchase-invoice classification fixed:** a strong `PURCHASE INVOICE` / `SALE AGREEMENT` / `SOLD TO` marker now wins over the generic INVOICE → `receipt_general` base, so the purchase-cost prefill fires again; `Buyer PIN` e-TIMS receipts stay receipts and service invoices stay service receipts.
- **Prompt sync (rule 13):** the core prompt's OCR & PHOTOS block names the top-up and locks the deterministic lens as the authority; docs regenerated.
- **Tests:** `test_ocr_normalizer` 38 (new, health-registered), `test_ocr_flow` 108 (EU/Brazil fixtures, purchase regression, top-up kill switch), `test_doc_lens` 48, `test_agent_training` 154, `test_env_audit` 44.

### 116. Country parsing profiles as data + ongoing resilience loop (v1.54.2)

- **Profiles as plug-in data (`src/data/ocrCountryProfiles.js`, new):** the KE e-TIMS receipt extractor and the NTSA "VEHICLE PARTICULARS" logbook parser moved out of `ocrService.js` into a country-profile registry (`KE_OCR_PROFILE.etimes` / `.logbook`); `getOcrCountryProfile()` resolves from the WhatsApp country and **GLOBAL/unprofiled countries return null** — the universal path stays neutral (rule 36). `extractDocumentHints` now delegates through the registry; the existing 108 OCR-flow assertions prove exact parity. New country profiles are added as plug-in modules — never pushed globally.
- **Data-driven strengthening loop:** `summarizeOcrCountryRows()` (pure), `getOcrCountryProfileStats()` (one country, 1–168 h) and `getOcrCountryWatchlist()` (all countries crossing thresholds, min 5 rows, ≥25% unusable or ≥30% low-confidence) in `ocrTelemetry.js` turn the existing `ocr_requests` rows into the signal for which country profile to write NEXT.
- **`admin ocr-profile [CC]`:** deterministic, zero-token per-country digest (`formatOcrProfileReply` — reads, unusable, low-confidence, avg confidence, top document kinds, watch verdict + reason), audited `ADMIN_OCR_PROFILE`; a bare `admin ocr-profile` shows the GLOBAL bucket. Registered in the command parser, the AI classifier enum and the help menu.
- **Sentinel digest watchlist:** `sendRemediationDigest` adds a `🌍 OCR country watchlist` line listing flagged countries and pointing at `admin ocr-profile <CC>` — so the resilience loop runs on its own cadence without pushing NTSA rules anywhere else.
- **Tests:** `test_ocr_flow` 120 (profile registry, marker re-export, parser, digest verdicts, watch thresholds, sample floor).

### 117. Conversational-first completion + conversation compliance (v1.54.3)

- **All 19 remaining canned replies are composed.** Every quiz outcome card, gate and cancellation ack in the WhatsApp route now renders through `composeMessage` from facts, with the previous deterministic sentence demoted to `fallbackText`: passbook/onboarding stage prompts (buyer details, registration plate, onboarding reset, weave nudge), vehicle not-found/unassign/delete errors, the VIN-lock invariant, deletion/switch/expense/account outcome cards (figures preserved verbatim in the fallback), earnings/email prompts, account/email cancellations and the email-required gate. Only the instant "reading now" progress ack stays literal — **the ratchet dropped from ≤ 20 to ≤ 4** (1 literal remains). Provider outages keep the exact engine cards.
- **Conversation compliance harness shipped (`test_conversation_compliance.js`, promised in §111):** persona proof (elderly, low-literacy, angry, Shenglish) pinned by the core-prompt LAWS and the tone-compass poles/mirror/floors, plus a plain-language lint over all 32 deterministic fallbacks (banned phrases, ONE unquoted question, ≤ 28-word sentences after stripping quoted example phrasings) and the David Njonjo document replay staying engine-owned. Health-registered (18 assertions).
- **Follow-up (tracked):** the engine-owned patience counter (session-level repeats of the same quiz field: 2nd failure → simplest typed path, 3rd → human lane) — the prompt-level EVERY-DEMOGRAPHIC LAW already carries the behavior; the deterministic counter ships with the next conversation release.
- **Tests:** `test_no_canned_replies` ratchet ≤ 4 (1 literal), `test_conversation_compliance` 18, `test_agent_training` 154, health green.

### 118. Engine-owned patience ladder (v1.54.4)

- **The EVERY-DEMOGRAPHIC LAW is now deterministic, not prompt-only.** `askCurrent()` in the quiz engine tracks repeats per field in `quiz.patience {field, retries}`: the **2nd failure on the same field** appends the simplest typed path to the question hint (country-resolved: plate example, currency, date, litres, email, phone — `simplestTypedPath()`), and the **3rd+ failure** appends the human lane (`reply Support`). Any progress (a banked answer or a new field) resets the ladder; a fresh quiz starts with `patience: null`. Never blame, never rush — the turnNote teaches the composer to offer only the simplest option.
- **Prompt sync (rule 13):** the core prompt's EVERY-DEMOGRAPHIC LAW now names the engine ladder ("The ENGINE tracks repeats per step … use those engine-supplied hints exactly"); docs regenerated.
- **Tests:** `test_quiz_flow` 141 (new Test 11 drives the full ladder deterministically with provider keys cleared: invalid → recorded retry → simplest path → human lane → progress reset; exit 0), `test_agent_training` 155.

### 119. Draft-correction lane fixed (v1.54.5)

- **The saved-ledger edit command no longer steals draft corrections.** Live evidence 2026-11-03 (0734852529, fuel top-up): during the confirmation summary the user wrote *"The fuel volume is definitely wrong… amount … price was 222 kes per liter"* — `detectLedgerCommand()`'s "natural mistake" rule matched `fuel … wrong … amount` and turned it into a saved-entry `edit`, replying *"I could not find an entry to change."* The rule now requires a genuine **saved-entry noun** (`entry/entries`, `record`, `expense`, `log`, `transaction`, `receipt`) instead of any bare field/fuel word, so a correction to the **open draft** flows to the confirmation summary (which re-renders and asks which field to change) — the saved-entry phrasing (`"I made a mistake on the fuel entry"`, `"wrong amount on my last expense"`) is unchanged.
- **Tests:** `test_entry_ledger` (new regression: the live draft-correction text returns `null`; the saved-entry phrasings still resolve), `test_agent_training` unchanged.
- **Follow-ups tracked (not shipped):** (a) `"I have another vehicle"` → deterministic registration for an existing owner (the phrase was answered with a generic menu twice; self-recovered after the user typed "Register"); (b) normalize `chat_friction_logs.user_phone` to E.164 (`+` prefix) — it is written bare (`254…`) by one Sentinel path while `chat_history` carries `+254…`.

### 120. Conversation working memory (v1.55.0)

- **The submitted-but-UNSAVED draft is now visible to the model.** New pure, dependency-free `buildConversationMemory({ quiz, pendingLabel, activeVehicle })` renders a compact "In-progress … draft (NOT saved yet)" block: collected fields as human labels, extra notes (details that never mapped to a DB column), the pending field, and the active vehicle — **never OTP/PIN/token**, and `''` when there is no draft (zero prompt cost in idle chat).
- **Wired into the conversational-pause path:** `buildPausedQuizReply`'s `quiz_pause_conversation` facts now carry `workingMemory` instead of the raw `answers` object (which leaked secret keys and lacked labels) — so "what did I already tell you?" mid-quiz is answerable. Also passed to `processSakaMessage` (`options.workingMemory`) for any future draft-carrying general turn.
- **Tests:** `test_conversation_memory` 11 (health-registered), `test_no_canned_replies` ratchet unchanged.

### 121. Sentinel response-mismatch → code diagnosis → PROP proposal (v1.55.1)

- **Conversational response-mismatch loop.** New `src/services/conversationDiagnosis.js` closes the gap between "friction logged" and "proposal drafted": when `evaluateConversationalFriction` records a `USER_FRUSTRATION` / `INCOMPLETE_REPLY`, a flag-gated reasoning-tier call (`purpose: conversation_diagnosis`, registered in `AI_PURPOSES`) inspects a curated **routing map** (the intent/detector entry points — `detectLedgerCommand`, `resolveLedgerTurn`, `detectQuizStart`, `detectRegistrationCorrection`, `isRegisterCommand`, `parseDocumentFields`, `buildConversationMemory`) plus the friction transcript, and returns `{ root_cause, likely_file, minimal_change }`.
- **Sanitizer (`sanitizeConversationDiagnosis`)** is the wall: empty fields dropped, `likely_file` blocked by a forbidden-path guard (auth/OTP/VIN/payment/schema/CI/.env/reset), caps enforced. `recordConversationProposal()` mints a `PROP-<date>-<nn>` and inserts a **`PENDING_APPROVAL`** `remediation_proposals` row (`category: conversation`, `target_signature` = snippet, `proposed_changes` carries the diagnosis) — the same review-in-chat governance as v1.53.1; **nothing runs autonomously** (rules 16/18).
- **Wired in `sentinel.js` `processFrictionPatches`** (after the friction row, before the micro-rule optimizer), fail-soft and deduped by the existing 24 h friction dedupe.
- **Env:** `CONVERSATION_DIAGNOSIS_ENABLED` (default **off**) — registry + `.env.example` documented.
- **Tests:** `test_conversation_diagnosis` 11 (health-registered: valid passes, forbidden paths rejected, caps), `test_env_audit` 44 (parity).

### 122. Existing owners add assets + current mileage reads the vehicle (v1.56.0)

- **Add-another-asset registration (R1).** `detectQuizStart` (quizEngine.js) no longer gates `vehicle_registration` behind `!hasVehicleRegistered`: an explicit register command now starts the registration quiz for an EXISTING owner too. `isRegisterCommand` (whatsapp.js) additionally recognises the "I have another car", "a second vehicle", "one more truck" family. Capacity + verified email are still enforced at write time by `persistVehicleRegistration` (`checkOwnerVehicleTierLimit` → "plan allows N vehicle(s)"), so a Free account can never over-register. Live 2026-11-03 (0734852529): "I have another car" / "Add car" produced AI prose with no quiz state, so "Car" / "KBJ 819C" / "Ok" all fell through to the generic menu.
- **Current-mileage answers come from the VEHICLE (R2).** New pure `src/services/odometerAnswer.js` (`isOdometerQuestion`, `buildOdometerAnswer`). In the deterministic read chain (whatsapp.js, checked before `parseRecordQuestion`) a "current mileage / odometer / odo reading / last update / how many km" question answers from `vehicles.current_mileage` (or `operating_hours` for hours-led assets) — never an expense summary, and never "no odometer on file" when the vehicle has a reading. It parks a non-registration quiz (`abandonQuiz` reason `odometer_query`) exactly like the record lane. Live 2026-11-03: all three odometer questions returned expense totals or a false "no odometer".
- **Skill/prompt sync (rule 13):** `flowKnowledge.js` vehicle_registration trigger/rules now cover existing owners adding an asset; `sakaAi.js` `DEFAULT_SAKA_CORE_PROMPT` gains the MILEAGE & ADD-ASSET LAW.
- **Tests:** `test_odometer_answer` 11 (health-registered), `test_quiz_flow` 142 (+1: an existing owner adding another car starts registration). `test_no_canned_replies` ratchet unchanged (≤4 literals; 1 remains).
- **Deferred (tracked):** `chat_friction_logs.user_phone` E.164 normalization (bare `254…` vs `+254…`); confirm the live `CONVERSATION_DIAGNOSIS_ENABLED` value in Cloud Run.

### 123. Complaint vs. ledger edit + readable empty answers (v1.56.1)

- **Complaint guard (R3).** `detectLedgerCommand` (`src/services/entryAnswers.js`) returns `null` when a past-tense action is attributed to Saka ("You deleted the wrong entry", "you logged the wrong amount on the fuel entry"), so the message reaches the complaint-recovery lane instead of being turned into an edit of the user's last saved row. Explicit edits ("edit entry 2 amount to 5000") still resolve. Live 2026-11-03: the complaint was misread as an edit request.
- **Readable empty record answer (R4).** `formatRecordAnswer` (`src/services/recordAnswers.js`) now names a noun in the empty case — "no other expenses all time", "no earnings all time" — replacing the broken "no other all time" from the live audit (the type label was concatenated with the period label with no noun between them).
- **Tests:** `test_entry_ledger` (+3 complaint guards, explicit-edit regression), `test_record_answers` 36 (+1 noun assertion).

### 124. Plain-English admin backlog (v1.56.2 — PROP-2026-11-03-07)

- **Deterministic parse (R6).** `parseSuperadminCommand` (`src/services/superadmin.js`) now resolves conversational backlog requests BEFORE the `ADMIN_DIRECTIVE_RE` gate: "show me [all] pending proposals" / "list pending proposals" / "pending proposals" / "what's pending" → `ADMIN_REMEDIATIONS` filter `pending`; "show me [all] proposals" → filter `all`. A classifier-fallback safety net mirrors the pending patterns. Zero tokens.
- **Bare "admin proposals" is untouched** — it still opens the Horizon feature proposals (`ADMIN_PROPOSALS`). The admin help menu now names "show me pending proposals".
- **Tests:** `test_update_suggest` 43 (+6 plain-English parse assertions, +1 Horizon-unchanged regression).
- **Provenance:** implements the approved proposal `PROP-2026-11-03-07` (marked DEPLOYED after the health gate was green).

### 125. Maintenance-schedule questions answer from reminders (v1.56.3 — live-audit R5)

- **Detector + answer (pure).** `src/services/complianceAnswers.js` gains `detectMaintenanceScheduleQuestion` ("when / how often / how many km" + a maintenance verb + a part), `detectMaintenancePart` (tyres, brakes, oil, battery, filters, spark plugs, coolant, belts, wipers) and `buildMaintenanceScheduleAnswer`. The answer cites the user's own active `reminders` row (distance km / hours / due date) when it matches; otherwise it states honestly that no reminder exists and offers the ONE step to set one — never an invented interval.
- **Wired** into the deterministic compliance/reminder branch in `whatsapp.js` (parks a non-registration quiz like the other read commands). Live 2026-11-03 (0734852529): "when am I supposed to buy my front tyres" got a generic menu.
- **Tests:** `test_vehicle_compliance` 67 (+5 maintenance assertions).




### 126. Friction-point tracker + whole-conversation memory (v1.56.4)

- **Track never lost.** New `src/services/frictionTracker.js` adds a PENDING -> DEPLOYED lifecycle on `chat_friction_logs` (`status`, `resolved_at`, `resolution`); a deployed point auto-clears from the active list after `FRICTION_CLEARED_AFTER_HOURS` (4) but is never deleted. `npm run migrate:friction` adds the columns (idempotent). `normalizeFrictionPhone` fixes the bare-254 vs +254 split at the Sentinel write paths.
- **Superadmin:** `admin friction [pending|deployed|log]` lists the active track and the persistent log; `admin friction done <id>` marks a point deployed. Audited as `ADMIN_FRICTION` / `ADMIN_FRICTION_DONE`. Deterministic, zero tokens.
- **Whole-conversation memory (rule 40):** `CHAT_HISTORY_MAX_MESSAGES` (default 40, clamped 20-60) is the new default limit for `getRecentChatHistory`; `session.history` caps at the same bound in `whatsapp.js` (3 sites). The 45-minute age guard is unchanged.
- **Live audit (2026-11-03, 0734852529):** Sentinel flagged 8 friction rows (USER_FRUSTRATION x5, LOOPING_PROMPTS x2, CONVERSATION_STALL x1) and minted `PROP-2026-11-03-08` (conversation). Real root causes: (a) registration flow stored free-text (save as draft / financial analysis) as make and model; (b) welcome-trial user told the Free 1-vehicle cap; (c) a hallucinated Honda CR-V; (d) bare/+254 phone split. The Sentinel diagnosis mis-targeted the ledger detector.
- **Sentinel fix:** `conversationDiagnosis.js` ROUTING_MAP now names the registration-correction, entitlement and active-vehicle entry points so future PROP diagnoses land on the right file.
- **Tests:** `test_friction_tracker` 10 (health-registered); `test_quiz_flow` asserts `CHAT_HISTORY_MAX_MESSAGES === 40`.
- **v1.56.5:** `admin friction done <id>` accepts any unique id prefix (the 8 chars shown in the list); `resolveFrictionId` maps it to the full uuid before the update, and a full uuid still passes through unchanged.
### 127. Autonomous country-scoped learning + superadmin-driver rectification (v1.57.0)

- **Existing autonomy confirmed.** `evaluateConversationalFriction` -> `processFrictionPatches` already upserts `saka_dynamic_rules` (is_active) with no approval, and `runConversationRefinement` writes append-only LIVE LEARNINGS; both are injected by `getSakaCorePrompt()`. This release keeps that autonomy and adds country separation.
- **Country learning buckets:** new `country_learnings` (country_code PK, learnings, tone_notes, message_count) + `src/services/countryLearnings.js` (`ensureCountryBucket`, `deriveCountryLearnings`, `upsertCountryLearnings`, `getCountryLearningsLine`, `COUNTRY_LEARNINGS_SQL`). `ensureCountryBucket` creates the bucket on the fly at signup; Sentinel derives and upserts per-country lessons; `whatsapp.js` injects `COUNTRY LEARNINGS (CC, ...)` beside `COUNTRY COMMUNICATION STYLE`. Isolation: a CC lesson only reaches CC users; GLOBAL is never mixed.
- **Superadmin is never a driver:** guard in `createDriverAssignment` refuses `SUPERADMIN_PHONE`; `scripts/rectify_superadmin_driver.js` (idempotent) cancelled the live assignment (`superadmin_cannot_be_driver`), released the vehicle link and normalised the profile to `Superadmin`.
- **Tests:** `test_country_learnings` 9 (health-registered); `npm run migrate:country-learnings` applied.
### 128. v1.57.1 live-bug fixes: coupon, trial capacity, superadmin cleanup, clear chat

- **Coupon false-positive:** sakaAi.js classifyIntentWithRegex and the whatsapp coupon branch now require an explicit code (EXT30-...) or verb (apply coupon / redeem coupon / extend trial); a bare yes/extend no longer routes to APPLY_COUPON (was the spurious Applying trial extension coupon... message).
- **Trial capacity:** getEntitlements resolves the tier from the live trial_sessions row when subscription_status is TRIALING (a free-tier profile on a live trial now gets the trial capacity); new profiles are created ACTIVE (no phantom trial); the welcome trial runs on WELCOME_TRIAL_TIER (default growth = 5 vehicles). reconcile_trials.js backfills real welcome trials for phantom-TRIALING accounts.
- **Superadmin:** rectify_superadmin_driver.js also clears the superadmin profile trial/subscription (free/ACTIVE, trial fields null).
- **Clear chat:** confirm-gated clear chat / reset chat / start over deletes chat_history / chat_transcripts / processed_webhooks and resets the session (fleet data untouched; wipe-aware isFirstContact re-fires the welcome).
- **Tests:** test_v1571 8 (health-registered).
### 129. v1.58.0 - registration confirm loop fix + Sentinel friction auto-close (2026-11-03)

- **Registration confirm correction lane:** handleConfirmation runs detectRegistrationCorrection + the new parseRegistrationFieldCorrection (label:value / label is value) before the extra-notes catch-all, sets/clears that field, strips the stale duplicate note via stripFieldNotes, and re-renders the summary. The question-phase correction lane also strips the field note. Fixes the TOYOTA/TOUOTA re-send-the-same-correction loop (live 2026-11-03).
- **Sentinel friction -> DEPLOYED:** processFrictionPatches marks the originating chat_friction_logs row DEPLOYED (resolution rule:key) when a micro-rule is minted, closing the tracker loop (auto-clears after FRICTION_CLEARED_AFTER_HOURS).
- **Proposals triaged:** PROP-2026-11-03-08 and -09 DECLINED (already fixed v1.56.1 detectLedgerCommand complaint guard).
- **Remaining (tracked):** the reminder reply-3 -> identical re-prompt loop (LOOPING_PROMPTS 16:06) needs a numbered catalog menu for reminder_type / patience-ladder escalation.
- **Tests:** test_v1571 10 (health-registered).
### 130. v1.58.1 - reminder menu numeric selection (2026-11-03)

- choiceField maps a bare number N (1-99) to normalized[N-1].value before catalog/alias parsing, so a numbered menu reply is consumed instead of re-prompted. reminderTypeMenu is numbered (1. X - 2. Y ...). Out-of-range numbers return null. Fixes the reply-3 to identical Set Reminder prompt LOOPING_PROMPTS loop (live 2026-11-03).
- Tests: test_v1571 13 (health-registered).
### 131. v1.58.2 - field-value pollution guard + edit-field alias normalization (2026-11-03)

- isPollutedFieldValue (quizEngine) rejects instruction/UI-label strings (Extra Notes:, Save ... as a draft, Change VIN to ..., Financial analysis for KAS, bare confirm/yes/no) at the direct-answer accept, the AI natural-fill and applyExtraction paths, so a note can never become a field value. Live 2026-11-03: KBJ 819C make_model was Extra Notes: (corrected to Toyota Hiace Van, audited).
- choiceField alias matching normalizes & and / to and, so MAKE AND MODEL maps to the Make / model edit field (fixes the Which field would you like to update? loop).
- Tests: test_v1571 17 (health-registered).
### 132. v1.58.3 - cross-vehicle ledger scoping + one-line plate routing (2026-11-03)

- Ledger is never owner-wide. New resolveLedgerVehicleScope (entryAnswers) resolves a single target vehicle (pending row, then explicit plate/label/ordinal, then the active vehicle, then the single vehicle); whatsapp.js scopes listLedgerEntries/restore to it and pins vehicleId in pendingEntryAction, so editing one vehicle can never touch another history. When no vehicle resolves, the engine asks which vehicle.
- One-line plate routing works for live data. matchNarrativeVehicle plateOf/labelOf now read plate_number/make_model (previously only plate/make/model keys, so plate detection was dead for real DB rows), and the multi-vehicle/no-mention fallback returns ambiguous (never silently defaults to active). A write intent (log/earning/mileage/operating-hours/reminder/edit_vehicle) with several vehicles and no named vehicle forces a which-vehicle prompt via forceVehiclePrompt.
- Tests: test_v1583.js (9, health-registered), test_narrative_draft.js (118), test_entry_ledger.js + test_agent_training.js green.

### 133. v1.58.4 - deep-audit reliability fixes (2026-11-04)

- **Mojibake purge.** User/admin-facing WhatsApp strings and logs carried UTF-8 mojibake (double-encoded emojis/dashes) from a round-trip; every source string is now correct UTF-8 (driver-activity summary, fleet auto-audit, Sentinel Cloud-Run alert, Horizon blueprint, quiz VIN error / trip hint / summaries). A repo-wide sweep confirms zero remaining double-encoded emoji/dash sequences.
- **No silent crash.** `processIncomingWhatsAppMessage` now sends one short deterministic recovery line if the turn throws before any reply was dispatched (`replyDispatched` guard), ending dead-air failures.
- **Global auto-audit.** The daily/weekly auto-audit resolves currency via `formatMoney(buildGlobalContext(detectCountryFromPhone(phone)))` instead of hardcoded `KES`, and normalizes all windows and scheduling to Africa/Nairobi (`formatNairobiDate`, `(getUTCHours()+3)%24`, `T00:00:00+03:00`, Nairobi weekday) instead of server-local/UTC.
- **Record-lane scoping.** QUERY_RECORDS now scopes to one vehicle via `resolveLedgerVehicleScope` (mirrors v1.58.3), aggregating the fleet only when genuinely ambiguous.
- **Pinned ledger edits.** A pending edit/delete re-fetches the original row by id (`getLedgerEntry`) when it has scrolled out of the top-6 list, so it can never retarget `entries[0]`; `applyEntryUpdate` / `relogLedgerEntry` / `deleteLedgerEntry` re-verify `vehicleIds` (defense-in-depth).
- **Sentinel boundary lock.** `processFrictionPatches` and `refinementIsSafe` now reject security-weakening instructions (negation-aware verb+target match) instead of 5 literal phrases, so a prompt hint can never weaken VIN/OTP/auth/schema.
- **Meta API + cleanup.** All Graph API calls moved from deprecated `v17.0` to `v21.0` (OCR default too); the dead `whatsappRoutes` plugin that duplicated the /webhook routes was removed.
- **Tests:** test_agent_training (155), test_entry_ledger, test_edit_delete, test_v1583, test_record_answers, test_conversation_compliance, test_env_audit (44), test_sentinel - all green; `npm run health` fully green.

### 134. v1.58.5 - bi-weekly Sentinel deep audit & proposal registry (2026-11-04)

- **Deterministic, twice-weekly code audit.** `src/services/deepAudit.js` runs a code-integrity scan Monday & Thursday at 03:00 Africa/Nairobi (`SENTINEL_DEEP_AUDIT_SCHEDULE`, default `Mon,Thu@03:00`; kill switch `SENTINEL_DEEP_AUDIT_ENABLED`, default on). It is wired in `index.js` (a 60 s scheduler check + manual `POST /api/cron/deep-audit`) and is idempotent per Nairobi day via an `admin_audit_logs` run marker (`SENTINEL_DEEP_AUDIT`, `run_key = DEEP-AUDIT-<date>`).
- **Four checks (zero AI tokens for detection):** mojibake lint (double-encoded UTF-8 in `src/**` + root JS), Nairobi-time lint (`now.getHours()`/`now.getDay()` server-local time and UTC-midnight DB windows, excluding legitimate `new Date(...T00:00:00Z)` weekday math), ledger-scoping lint (the `.in('vehicle_id', scoped)` guard and `resolveLedgerVehicleScope` usage), and a silent-failure watch (recurring unresolved `error_logs` by route, >=3 in 7 days).
- **Proposal registry, not autonomy.** Each finding mints one deduped `PENDING_APPROVAL` proposal - `proposal_code = PROP-YYYY-MM-DD-NN` (via the new shared `src/services/proposalRegistry.js::nextProposalCode`), `category = deep_audit_finding`, dedupe key `target_signature = DEEP-AUDIT:<date>:<slug>`. Nothing is ever executed; the finding's remediation is a hint for a superadmin chat session (`admin remediations` / `show me pending proposals`). A light `sanitizeFinding` strips governance-protected paths (`.env`, `.clinerules`, `.github/`, `supabase/`, `paystack.js`, `remediation*.js`, VIN/reset/provision scripts).
- **Tests & health.** `test_deep_audit.js` (25 assertions: schedule parse + fallback, enable/kill switch, all four lints incl. the `new Date` exclusion, `sanitizeFinding`, mint + dedupe + `PENDING_APPROVAL` + `PROP-` code, run-marker idempotency, `runDeepAudit` dryRun and same-window skip) is registered in the health suite; `npm run health` fully green.

### 135. v1.58.6 - log-vs-query disambiguation (2026-11-04, live chat audit)

- **A past-tense expense statement is logged, never answered as a query.** "Repaired a puncture for KAS628T … cost me 300kes" was answered "Nothing logged" (the records-query lane) five times in a row. `parseRecordQuestion` now returns `reason:'looks-like-log'` for a statement with a past-tense action verb + amount and no question lead, and the route re-labels the turn to `LOG_EXPENSE` so the expense is actually recorded. `looksLikeLogStatement()` (recordAnswers.js) is the single shared guard.
- **"Pull/show/list … records/entries" is a records query, not a fuel-log flow.** "Pull fuel records for KBJ 819C" kept starting the fuel-log quiz (litres / full-tank). `parseRecordQuestion` now treats records/entries/history/ledger (plus an expense/earning word or a plate) as a QUERY, and `pull/get/fetch/give` are recognised query leads.
- **An ambiguous multi-vehicle read ASKS which vehicle.** A records question with no plate, no active vehicle and several vehicles now replies "Which vehicle — A or B? (or *all vehicles*)?" instead of silently summing the fleet. Only an explicit "all/both/fleet" aggregates.
- **Tests:** `test_record_answers.js` (+9 assertions, 45 total) covers each phrase; `test_v1583`, `test_entry_ledger`, `test_edit_delete`, `test_narrative_draft` green; `npm run health` green.

### 136. v1.58.7 - verified saves, switch-anytime, Stop fixed (2026-11-04, live chat audit)

- **No "Saved" without a verified write (F5).** The quick-path one-liner expense save rendered "Expense Logged Successfully! ✅ Saved" unconditionally — even on a duplicate, a missing client, or a failed insert (the `expense_logs` insert error was never checked). The success card now runs only after a clean insert; a failed write returns "nothing was written"; a duplicate is no longer overwritten by a false success.
- **"Switch to <plate>" works anytime (F3).** Mid-draft, "switch to KBJ 819C" was swallowed by the open expense quiz (asking for litres, and garbling the plate into "KES 819"). An explicit switch now abandons any open draft first, then routes to the switch handler.
- **"Stop" no longer dead-airs (TDZ).** The pause handler referenced `countryInfo` before its `const` declaration → a `ReferenceError` threw and the user got an empty reply. Fixed by computing `countryInfo` inline in the pause path (surfaced by `test_reliability` Test 3a).
- **Tests:** `test_record_answers` (45), `test_v1583`, `test_entry_ledger`, `test_edit_delete`, `test_narrative_draft` green; `test_reliability` Test 3a ("Stop" pause) now passes; `npm run health` green.

### 137. v1.58.8 - deploy pipeline, profile wipe, verified earnings, post-signup conversion (2026-11-04)

- **Backend now auto-deploys on push.** Added `Dockerfile` + `.dockerignore` + `.github/workflows/deploy_cloud_run.yml` (builds from source via `gcloud run deploy --source .`, `--min-instances=1 --cpu-boost --no-cpu-throttling --allow-unauthenticated`). Enable with repo secrets `GCP_SA_KEY`, `GCP_PROJECT_ID`, `GCP_REGION`; while `GCP_SA_KEY` is unset the job skips with a warning (never red). Fixes the frozen live revision (was `saka-fleet-00253-b4q`, 2026-10-28) — previously a push only fired the WhatsApp "building" alert, never a deploy.
- **OTP-gated profile wipe for a clean sign-up.** `admin wipe <phone>` emails a 6-digit code to `SUPERADMIN_EMAIL` (`sendEmailOtp`); `admin wipe confirm <code>` verifies it (10-min TTL, 5 attempts, superadmin-own-phone refused) then `wipeProfileForSignup()` (`src/services/profileWipe.js`) erases the profile + vehicles + ledger + chats + sessions + trials/subscriptions + coupons + the VIN ledger. Audited `ADMIN_PROFILE_WIPE_REQUESTED` / `ADMIN_PROFILE_WIPED`. No DDL.
- **Verified earnings save (F5 remainder).** The LOG_EARNINGS quick path inserted into `private_earnings` without checking the error and still said "Recorded" — now the write is verified and a failure says "nothing was written" (same assurance as the expense path).
- **Post-signup conversion directive.** The Saka core prompt now instructs: a verified user with no vehicle gets their app/pricing/feature question answered first in 2-4 short lines, then ONE soft next step — set up their first vehicle (reply Register) — to experience the feature. Warm, never long or pushy (answers stay AI-composed from facts).
- **Security:** audited every success renderer ("Successfully"/"Saved") — the expense quick path (v1.58.7) and the earnings quick path (this release) were the two unverified writes; trial-extension, vehicle-delete, odometer and operating-hours paths were already gated on their result.
- **Tests:** `test_profile_wipe.js` (13, mock) registered in the health suite; `test_record_answers` (45), `test_v1583`, `test_entry_ledger`, `test_edit_delete`, `test_narrative_draft`, `test_agent_training`, `test_product_qa`, `test_greetings`, `test_conversation_compliance`, `test_superadmin`, `test_update_suggest` green; `npm run health` green.

### 138. v1.58.9 - wipe phone-variant fix + ops CLI (2026-11-04)

- **Wipe matches every stored phone form.** `wipeProfileForSignup` now builds `+254...`, `254...`, `0...` and bare 9-digit variants (from the input AND the resolved profile), so chat rows stored WITHOUT a `+`/`0` are deleted too (live: 711 `254734852529` transcripts survived the first pass). Locked by a `test_profile_wipe` assertion.
- **Ops CLI.** `scripts/wipe_profile.js <phone> [--confirm]` writes a JSON backup to `tmp/` then wipes (dry-run by default) — the headless counterpart of `admin wipe <phone>`.
- **Applied live:** +254734852529 fully reset (profiles / vehicles / chat_history / chat_transcripts / chat_sessions / chat_friction_logs / processed_webhooks = 0) for a clean sign-up.

### 139. v1.58.10 - self-documenting superadmin, autonomous customer care, driver/trial/coupon audit (2026-11-04)

- **Self-documenting, conversational superadmin.** New `ADMIN_COMMAND_REGISTRY` (`src/services/superadmin.js`) is the single source of truth; `admin help` is generated from it (can never go stale). An admin-looking message that matches no command now gets a "did you mean…" clarification with the 2-3 closest commands + a plain-English example (`buildAdminClarifyReply` / `matchAdminCommands`); non-admin chat still falls through to normal Saka (multi-role coexistence).
- **Autonomous customer care.** New `src/services/customerCare.js`: classifies a support request (bug / billing / feature / driver / vehicle / logging / other + priority), opens a `support_tickets` row, emails support@, and pings the superadmin on WhatsApp for high-priority / dispute / refund cases (`handleCareRequest`). `POST /webhook/email/inbound` (Resend inbound, optional `EMAIL_INBOUND_SECRET` gate) relays a support@sakafleet.com reply back to the user's WhatsApp (`handleInboundSupportEmail`). The WhatsApp support flow now uses `handleCareRequest` instead of a bare one-way email.
- **Driver / trial / coupon / nudge audit.** Audited + confirmed green: driver assign→OTP→accept→unassign→reassign (1-to-1 invariant), welcome-trial capacity (growth, 5 vehicles) + lapse→excess paused, dunning/re-engagement ladders, follow-ups and contact-nudge. `test_driver_assignment_gate`, `test_trial_engine`, `test_subscription_billing`, `test_dunning_reengagement`, `test_followups`, `test_contact_nudge` all pass.
- **Recommended follow-ups (next iteration):** a "your requested feature shipped" user notice tied to adopted `PROP-*`, and per-release non-spammy changelog nudges with a 1-per-user-per-release cooldown (reuse `featureNotice.js`).
- **Tests:** `test_customer_care.js` (12) + `test_profile_wipe` (14) + `test_deep_audit` (25) registered; `test_superadmin`, `test_update_suggest`, `test_env_audit` green; `npm run health` green.

### 140. v1.58.11 - fresh-signup fix: never re-welcome a verified user + English-first greeting (2026-11-04)

- **No re-welcome loop for verified accounts.** `isFirstContact()` (`src/services/greetings.js`) now returns `false` whenever `profile.email_verified === true`. A user who signed up on the website and then says "Hi" on WhatsApp is ADVANCED to their first vehicle instead of being welcomed again (live 2026-11-04: a fresh verified user received three welcomes in a row).
- **Deterministic advance branch.** In the GREETING lane (`src/routes/whatsapp.js`) a verified user with **no vehicle** gets one short advance — "Hi <name>! 👋 You're all set ✅ — what do you drive? One line is enough, e.g. *"Toyota Probox"*." — instead of a fresh introduction. A verified user **with** a vehicle gets a one-line greeting + ONE next step (log / check fleet), never "what do you drive" again. Unverified numbers keep the website CTA; a true first contact keeps the full `sakaIntroText` welcome.
- **English-first, language-aware greeting.** `greetingFor()` accepts a `language`; an explicitly English user is never greeted in the local tongue. `sakaIntroText()` derives the language from `profile.preferred_language` and is English-first for a known account with no language set, while a user who chose Swahili keeps the local greeting and the country default is preserved when there is no profile at all.
- **Tests:** `test_greetings.js` Test 10 (verified ≠ first contact; English-first; Swahili preserved; country default preserved) and `test_first_message_flow.js` Test 1 rewritten to the advance contract; `test_agent_training` (155) green.

### 141. v1.58.12 - zero-vehicle owners are not asked for a driver licence before a vehicle (2026-11-04)

- **Snapshot noise fix.** `buildUserContextSnapshot()` (`src/services/userContextSnapshot.js`) now emits the `driver licence — …` populate step ONLY once the account has at least one vehicle. A brand-new zero-vehicle owner's ONE next step is the vehicle (plus email if unset), so "is my profile verified?" on a fresh account no longer returns a licence instruction as noise (live 2026-11-04).
- **Boundary intact:** OWN-DATA LAW v2 still names every missing field with one engine-owned step; only the premature licence step for vehicle-less accounts is removed.
- **Tests:** `test_user_data_access.js` +1 (a zero-vehicle account lists no driver-licence step); 20 assertions green.

### 142. v1.58.13 - pending-only remediation alerts + unverified-gate clarification + phantom-trial fix (2026-11-04)

- **Remediation alerts key on the PENDING backlog.** `maybeSendUrgentRemediationAlert()` no longer pages on raw `error_logs` volume — it queries every `PENDING_APPROVAL` proposal and fires only when the pending count reaches `REMEDIATION_URGENT_PENDING_THRESHOLD` (default 10), listing ONLY those proposals. The old `REMEDIATION_URGENT_ERROR_THRESHOLD` is read as a fallback and kept as a deprecated alias. (Live: 58 unresolved WhatsApp delivery-status rows paged the superadmin while the real signal — a single pending proposal — sat in the digest.)
- **PROP-2026-11-04-01 — the unverified gate no longer loops.** `isConfusedUnverifiedTurn()` (`src/services/greetings.js`) detects a short confused/repeat turn ("Huh?", "What?", "Still confused", "I don't get it") from an unverified number; the hard gate then sends a short clarification plus a `HELP`-to-human path (new `website_signup_gate_clarify` compose purpose) instead of re-firing the identical 🔒 line. Genuine first turns keep the standard gate line and the `unverified_gated` status.
- **Phantom 90-day trial remedied (live +254734852529).** The `profiles.trial_ends_at` column carried a legacy DB default `now() + interval '90 days'` and `subscription_status` defaulted to `'TRIALING'`, so accounts created without those columns were born with a fake 90-day trial that leaked into copy ("trial running until 2027-02-02 (90 days left)") on a Free/ACTIVE profile. `npm run migrate:trial-defaults` drops the `trial_ends_at` default and sets the `subscription_status` default to `'ACTIVE'`; every profile insert path (WhatsApp route, web onboarding, driver creation) now pins `trial_ends_at: null`; `buildUserContextSnapshot()` only reports a trial end when `subscription_status='TRIALING'`; and `npm run remediate:phantom-trials` cleared the 1 live phantom (0 profiles now carry a stray `trial_ends_at`; a fresh insert verified to stay null).
- **Env/docs:** `REMEDIATION_URGENT_PENDING_THRESHOLD` added to the env registry and `.env.example`; staging bootstrap matches (`subscription_status DEFAULT 'ACTIVE'`, nullable `trial_ends_at`).
- **Tests:** `test_greetings` (+7 confused-turn), `test_user_data_access` (+1 phantom guard, 21), `test_remediation_pipeline` (+2 pending-keyed), `test_trial_engine` (73), `test_subscription_billing` (75), `test_web_onboarding` (41) green; `npm run health` green.



### 143. v1.58.14 - duplicate-signup block + Sentinel log-only policy + Resend inbound email (2026-11-04)

- **Website duplicate signups are impossible.** `landing/assets/js/main.js` now strips a leading trunk `0` before prepending the country code (typing `0734852529` with `+254` no longer becomes `+2540734852529`). Backend `webOnboarding.js` adds `phoneVariants()` (E.164 / bare / 9-digit national tail), `findProfileByPhone()`, `findExistingProfile()` (phone OR email, case-insensitive) and `notifyExistingSignup()`. `inspectExistingSignup()` returns `email_exists` when the submitted email already belongs to a profile; `/api/onboard` blocks `verified` and `email_exists`, sends an "already on board" email (`sendExistingAccountNoticeEmail`) plus a one-line WhatsApp reminder to the stored number, and returns `already_verified` so the site shows "you are all set". `completeWebOnboarding()` resolves by phone variants, so a local-format submission updates the existing profile instead of inserting a duplicate. Audit: `WEB_ONBOARD_DUPLICATE_NOTIFIED`.
- **Sentinel detects, never offers proposals.** New `src/services/sentinelPolicy.js` exposes `isSentinelProposalsEnabled()` reading `SENTINEL_PROPOSALS_ENABLED` (default **off**). When off: `conversationDiagnosis.isConversationDiagnosisEnabled()` is false (no diagnosis, no `PROP-*`), `deepAudit.mintFindingProposal()` returns `proposals_disabled` and `runDeepAudit()` routes findings to `mintFindingLog()` (a `chat_friction_logs` row with `friction_type='DEEP_AUDIT_FINDING'`, `source='deep_audit'`, `diagnosis` JSON), and `checkRemediationPlanTriggers()` returns skipped (no CI dispatch). `sentinel.js` links recent unresolved `error_logs` to the friction row. `frictionTracker.js` gains `error_log_ids text[]`, `source text`, `diagnosis jsonb`, a `recordFriction()` helper, and `markFrictionDeployed()` now ALSO sets the linked `error_logs.status='resolved'` - `admin friction done <id>` therefore clears the log once the issue is tended.
- **Resend inbound email for support@sakafleet.com.** New `src/services/inboundEmail.js`: `verifyResendSignature()` (Svix `svix-id` / `svix-timestamp` / `svix-signature`, HMAC-SHA256 over `id.timestamp.rawBody`, 5-minute tolerance), `parseInboundEmail()` for the `email.received` metadata, `fetchInboundEmailBody()` (Resend Get Email API - the webhook carries no body), and `handleInboundEmail()` which verifies, parses, fetches, opens a `support_tickets` row (`issue_category='email'`) and pings the customer-care worker (`CUSTOMER_CARE_PHONE`, falling back to `SUPERADMIN_PHONE`). `/webhook/email/inbound` now uses the raw body retained by the existing `addContentTypeParser`, honours the optional `EMAIL_INBOUND_SIGNING_SECRET` (legacy `EMAIL_INBOUND_SECRET` header still accepted) and still relays a reply to the sender's WhatsApp via `handleInboundSupportEmail`. New superadmin commands: `admin inbox` and `admin inbox read <id>`.
- **Env:** `SENTINEL_PROPOSALS_ENABLED` (off), `EMAIL_INBOUND_SIGNING_SECRET`, `CUSTOMER_CARE_PHONE` registered in `envAudit.js` and `.env.example`.
- **Rules:** `.clinerules` 44 (audit before acting on any remediation/proposal), 45 (consult the rules before every plan/act operation), 46 (Sentinel detects, never proposes), 47 (duplicate signups blocked + owner notified).
- **Tests:** `test_duplicate_signup` (14), `test_sentinel_policy` (17), `test_inbound_email` (18), `test_deep_audit` (28), `test_friction_tracker` (10), `test_conversation_diagnosis` (11), `test_remediation_pipeline` (74), `test_web_onboarding` (41), `test_greetings` (110), `test_first_message_flow` (53), `test_superadmin`, `test_customer_care` (12) - green.
### 144. v1.58.15 - production knobs off + multi-asset branding + document retention (2026-11-04)

- **Production knobs (Cloud Run `saka-fleet`, `europe-west1`).** `REMEDIATION_AUTONOMY=off` and `CONVERSATION_DIAGNOSIS_ENABLED=off` (revision `saka-fleet-00267-8f9`), joining `SENTINEL_PROPOSALS_ENABLED=off` (Secret Manager). Sentinel no longer diagnoses or dispatches plans; `dispatchRepositoryEvent` refuses CI execution, so an approved fix is implemented by Cline in a superadmin session.
- **Multi-asset branding (landing).** The website now leads with every supported asset, not just cars: title/meta/OG/Twitter, JSON-LD, hero ("Every machine you run practically runs itself"), a generator engine-hours bubble in the chat mock, stats ("8 asset kinds - cars, trucks, boats, generators and EVs"), features, FAQ (EVs use kWh and km/kWh), terms/privacy summary, done screen, footer and `llms.txt`. No flow or handler changed; the app already supports all eight kinds (`ASSET_KINDS`), EVs via `metricsForAssetKind(kind, { fuelType })`, and asset-aware expense/reminder/report menus (proof: `test_asset_metrics` 70, `test_country_bucket` 54, `test_expense_catalog` 82).
- **Document pipeline hardening.** The audit confirmed the lens/OCR pipeline is sound (families, country profiles, three dedupe layers, confirm-before-save), so nothing was decommissioned. Gaps closed:
  - `wipeProfileForSignup` now removes the stored receipt IMAGES (`receiptStoragePaths` -> `storage.remove`) in addition to the rows, and reports `counts.storage_objects` (PII no longer orphaned).
  - `deleteReceipt()` + the deterministic `delete receipt <n>` (literal `DELETE` to confirm) command let a user delete one receipt row + its image, audited `RECEIPT_DELETED`; the parsed expense stays in the ledger (`my entries`).
  - `RECEIPT_RETENTION_DAYS` (default **0 = keep forever**, tax evidence) and `OCR_TELEMETRY_RETENTION_DAYS` (90) with a daily boot sweep (`pruneOldReceipts`, `pruneOcrTelemetry`).
  - `landing/privacy.html` section 6 now states document/image retention and the 90-day OCR telemetry window.
- **Env:** two new knobs registered in `envAudit.js` and `.env.example`.
- **Rules:** `.clinerules` 48 (documents are evidence, the user can remove them, retention bounds).
- **Tests:** `test_document_retention` (16), `test_ocr_flow` (120), `test_profile_wipe` (14), `test_landing_static` (217), `test_asset_metrics` (70), `test_country_bucket` (54), `test_expense_catalog` (82), `test_env_audit` (44) - green.