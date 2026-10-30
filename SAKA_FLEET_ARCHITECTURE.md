# SAKA FLEET - Master Architecture & System Audit

**Status:** Production Ready / Active  
**Version:** 1.16.3  
**Efficiency Policy:** Consult this document and `.clinerules` first before inspecting codebase files.

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
| API key env | `DEEPSEEK_API_KEY` (Tier 1/3) + `ANTHROPIC_API_KEY` (Tier 2) + optional `OPENAI_API_KEY` |
| Tier-2 provider | Anthropic Messages API via native `fetch` (`anthropic-version: 2023-06-01`, `AI_TIMEOUT_MS_PREMIUM` timeout) |
| Optional model override | `DEEPSEEK_MODEL`, `AI_MODEL_TIER_1/2/3` |
| Purpose registry | `AI_PURPOSES` (tier + default params per purpose) |
| Kill switch | `PREMIUM_MODEL_ENABLED` (off; Tier-2 downgrades to Tier 1 while off) |
| Telemetry analytics | `getAiUsageSummary()` (1–168 h window) → Superadmin `admin ai-stats` digest (§37) |
| Tier-2 failover chain | `anthropic → openai → deepseek`; per-provider circuit breakers; DeepSeek never skipped (§38) |
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

- **`src/services/conversationEngine.js`** — every user-facing reply is rendered by Saka AI from a structured FACTS payload (`composeMessage`, `renderQuizQuestion`, `renderConfirmationSummary`, `renderOutcome`, `renderActionDiscovery`). The provider is tier-routed: prose renders use Tier 2 (Claude Sonnet 4.5 when `PREMIUM_MODEL_ENABLED=on`, otherwise DeepSeek-V3) while quiz questions and stall nudges stay Tier 1; the system prompt carries explicit **VOICE & EMPATHY** guardrails so tone stays consistent across providers and failover legs. Hard-coded conversational prose has been removed from the WhatsApp route; deterministic fallbacks remain only for provider outages. Quiz questions are cached per field/language (`seedQuizQuestions`, `isQuizQuestionCacheWarm`) and prefetched in one batch per flow.
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
   - `calculateFuelConsumption`: Calculates km/L, L/100km, MPG, total distance, volume in liters, and total cost from `expense_logs`. Identifies missing parameters (`NEEDS_MORE_DATA`) and prompts the user conversationally.
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
- **Preserved (`PRESERVED_TABLES`):** `system_config` (boot-critical `saka_core_prompt`, `last_deployed_revision`, remediation scheduling markers), `compliance_catalog` (bundled + superadmin legal overrides), `weekly_feature_proposals`, `sentinel_audit_runs` and `remediation_proposals` (governance ledger for autonomous changes).
- **Scope regression test:** `test_db_reset_scope.js` (stateless) asserts the wipe/preserve registries are disjoint and that the global `TRUNCATE` block matches `RESET_TABLES` exactly.

### 15.2 Production & Execution Safeguards
- **Production Block:** If `NODE_ENV === 'production'` or `APP_ENV === 'production'`, the script aborts immediately unless `--force-production-wipe` is explicitly supplied.
- **Confirmation Flag:** Requires `--confirm` (e.g. `node scripts/reset-db.js --all --confirm`). Without `--confirm`, execution is safely aborted with an informational warning.
- **Explicit Scope Required:** The script now also requires either `--all` (global slate wipe) or `--phone <number>` (targeted). A bare `--confirm` can no longer wipe the database.
- **Targeted Reset:** Supports phone-specific clearing: `node scripts/reset-db.js --phone +254712345678 --confirm`. It resolves vehicles by `owner_phone` **and** `owner_id`, releases any driver assignment held by the phone, and clears dependent logs/transfers/notifications.
- **Fallback Safety:** The Supabase-JS fallback uses per-table primary keys (`processed_webhooks.wamid`, `vin_registry.vin`, otherwise `id`).
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
- `test_ocr_flow.js` — stateless OCR suite: Meta media download, Vision parsing, size/type guards, receipt hint extraction and quiz prefill (20 assertions).
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
| `vehicle_registration` | plate → make/model → YOM → fuel → odometer → VIN → email → OTP → optional specs (insurance/inspection/colour/transmission/engine/tires/cost/mods) → confirm | `current_mileage` (canonical km) | inserts `vehicles`, `vin_registry` trial, profile email, coupon, passbook email, reminders |
| `email_update` | new email → OTP → confirm | — | `profiles.email`, `vehicles.owner_email` |
| `assign_driver` | vehicle → driver phone → **handover odometer** → confirm | `metadata.odometer_at_assignment` + vehicle odometer | `assignDriverToVehicle` |
| `unassign_driver` | vehicle → **handback odometer** → confirm | `metadata.odometer_at_release` + distance driven | `unassignDriverFromVehicle` |
| `transfer_seller` | vehicle → buyer phone → buyer email → **odometer at sale** → confirm → release PIN | `metadata.odometer_at_transfer` | `initiatePassbookTransfer` → `setBuyerDetailsAndSendReleaseOtp` → `verifyOwnerReleaseOtpAndNotifyBuyer` |
| `log_expense` | vehicle → type → amount → fuel volume → **odometer at fill-up** → notes → confirm | `expense_logs.odometer_reading` + vehicle odometer | `expense_logs` + `expenses` |
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

## 24. OCR Flow (v1.7.4)

### 24.1 Pipeline
1. The webhook detects `messageObj.image` or `messageObj.document`, capturing `id`, `caption` and `mime_type` (previously image messages were silently ignored).
2. `downloadWhatsAppMedia()` calls `GET graph.facebook.com/{version}/{media-id}` → receives `{ url, mime_type, file_size }`, then downloads the binary from `url` with the same bearer token (`User-Agent: curl/8.0.0`). Direct-binary responses are also supported.
3. `extractTextFromImage()` posts the bytes to Google Cloud Vision `images:annotate` with `DOCUMENT_TEXT_DETECTION` → `{ text, confidence }`.
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
| `OCR_TIMEOUT_MS` | Media/Vision request timeout | `15000` |
| `META_GRAPH_VERSION` | Graph API version | `v17.0` |

### 24.3 Failure behaviour & limits
- Missing key, quota errors, unsupported types (PDF in v1) or oversized media never break the turn: Saka AI apologises and asks for a clearer photo or typed details.
- OCR failures are warnings only; no database write occurs.
- Media messages flow through the same per-phone queue, dedupe and durable session store as text.
- Test coverage: `test_ocr_flow.js` (20 stateless assertions — Meta download, Vision parsing, size/type guards, receipt hints, quiz prefill).


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
| `AI_TIMEOUT_MS_PREMIUM` | 15000 | Tier-2 fail-fast timeout |
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
- `sanitizeRemediationPlan` (shared by CI submit and server) blocks: VIN/OTP/auth/schema/destructive keywords, `.env`, `.clinerules`, `.github/`, `supabase/`, reset/provision/VIN migrations, `paystack.js`, `transfers.js`, `githubDispatch.js`, `remediation.js`, `remediation_ci.js` and the remediation migration (self-modification guard).
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
| `AI_MODEL_TIER_2` | env → provider default (`claude-sonnet-4-5` / `gpt-4o` / `deepseek-chat`) | conversational-tier model |
| `AI_MODEL_TIER_2_OPENAI` | `gpt-4o` | OpenAI secondary Tier-2 leg model |
| `AI_MODEL_TIER_3` | `deepseek-chat` (`deepseek-reasoner` when autonomy is on) | reasoning-tier model |
| `AI_REASONING_PROVIDER` | deepseek | Tier-3 provider (`anthropic` = Claude Opus opt-in) |
| `AI_TIMEOUT_MS_REASONING` | 45000 | Tier-3 background timeout |
| `ANTHROPIC_API_KEY` | (unset) | Tier-2/Tier-3 Anthropic key; unset ⇒ DeepSeek-only |
| `OPENAI_API_KEY` | (unset) | enables the OpenAI Tier-2 fallback leg |
| `CONVERSATIONAL_PROVIDER` | deepseek | Tier-2 primary provider |
| `AI_TIMEOUT_MS_PREMIUM` | 15000 | Tier-2 fail-fast timeout (Anthropic `AbortSignal` / OpenAI SDK) |
| `AI_PREMIUM_MAX_CONCURRENCY` | 2 | Anthropic in-flight cap; overflow → next leg |
| `AI_CB_FAILURE_THRESHOLD` / `AI_CB_WINDOW_MS` / `AI_CB_OPEN_MS` | 3 / 60000 / 30000 | per-provider circuit breaker (DeepSeek exempt) |
| `AI_DAILY_BUDGET_USD` | (unset = off) | rolling-24 h spend cap; over-budget premium legs are skipped |
| `AI_BUDGET_ALERT_PCT` | 80 | first alert threshold; 100% always alerts |
| `AI_USAGE_LOGGING_ENABLED` | on | telemetry writes kill switch |
| `AI_USAGE_LOG_MAX_ROWS` | 10000 | retention cap |
| `AI_USAGE_TRIM_EVERY` | 250 | writes between retention sweeps |

### 36.6 Files & tests
- `src/services/aiClient.js` — purpose registry, tier resolution, provider clients, telemetry sink, Phase 3 failover chain (`buildProviderChain`), per-provider circuit breakers and the budget-guard seam.
- `src/services/aiUsageLog.js` — `ensureAiUsageLogsTable` (incl. the `attempts` self-migration), `logAiUsage`, `trimAiUsageLogs`, `installAiUsageSink`, Phase 2 analytics (`getAiUsageSummary`, `estimateAiUsageCostUsd`, `AI_USAGE_COST_RULES`) and Phase 3 budget guard (`computeAiBudgetStatus`, `checkAiDailyBudget`, `installAiBudgetGuard`).
- `src/services/superadmin.js` — `ADMIN_AI_STATS` parsing, `handleAiStatsCommand`, `formatAiStatsReply` (v1.13.0) and `maybeSendAiBudgetAlert` (v1.14.0).
- `index.js` — boot chain ensures the table, installs the usage sink **and** the budget guard after `ensureRemediationTables()`; a 5-minute ticker runs `maybeSendAiBudgetAlert`.
- `test_model_router.js` — 71 assertions: tier resolution for every purpose, premium toggle, Tier 0, unknown purpose, missing-key degradation + single telemetry record, provider caching, helper contracts, DB provisioning/insert/cleanup (zero live API calls).
- `test_phase1_canary.js` — 37 assertions: Anthropic translation/normalization, Tier-2 success, 429/timeout fallback to DeepSeek, `AI_PREMIUM_MAX_CONCURRENCY` cap + overflow, escalation matrix, premium-off downgrade, DB telemetry (fetch-stubbed, zero network).
- `test_phase2_analytics.js` — 57 assertions: pricing rules, aggregation math (tier/provider/purpose), window clamping, 1,000-row pagination, fail-soft contract, deterministic digest, escalation precision, offline `admin ai-stats` parsing, DB round-trip with self-cleanup.
- `test_phase3_resilience.js` — 54 assertions: chain order, missing-key skip, autonomy-gated reasoning binding, Anthropic→DeepSeek failover with `attempts`, breaker state machine + bypass, budget gating, budget math/alerts/dedupe, digest fallbacks/budget lines, `attempts` jsonb DB round-trip.

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
| Tier 1 (router) | DeepSeek candidates only (`AI_MODEL_TIER_1` → `DEEPSEEK_MODEL` → `deepseek-chat`) |
| Tier 2 (conversational) | primary `CONVERSATIONAL_PROVIDER` → the other premium provider (OpenAI or Anthropic) → DeepSeek |
| Tier 3 (reasoning) | `AI_REASONING_PROVIDER` (DeepSeek default / Anthropic Opus opt-in) → DeepSeek |
| explicit `model` | that provider/model → DeepSeek fallbacks |

- Premium legs are included only when their API key exists; missing keys are recorded as `skipped_missing_key`.
- `AI_PREMIUM_MAX_CONCURRENCY` still caps in-flight Anthropic calls; overflow is recorded as `skipped_concurrency` and falls through to the next leg.
- **Invariant:** DeepSeek is always the terminal leg and is never skipped, never budget-gated and never breaker-blocked. No single provider can brick a conversation.

### 38.2 Circuit breakers
Per-provider, in-memory, fixed-cooldown breakers in `aiClient.js`:
- `AI_CB_FAILURE_THRESHOLD` (3) failures within `AI_CB_WINDOW_MS` (60 s) open the breaker for `AI_CB_OPEN_MS` (30 s).
- Any success resets the failure window; cooldown expiry resets the breaker (no half-open probing).
- While open, the provider is omitted from the chain and logged as `skipped_circuit_open`; DeepSeek is exempt.
- Helpers: `isProviderCircuitOpen()`, `recordProviderOutcome()`, `resetProviderBreakers()` (tests/ops).

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
- `.env` / `.env.example` gain a `FAILOVER, CIRCUIT BREAKERS & BUDGET` block: `AI_CB_FAILURE_THRESHOLD`, `AI_CB_WINDOW_MS`, `AI_CB_OPEN_MS`, `AI_REASONING_PROVIDER`, `AI_MODEL_TIER_2_OPENAI`, `AI_TIMEOUT_MS_REASONING`, `AI_DAILY_BUDGET_USD` (0 = off in the template), `AI_BUDGET_ALERT_PCT`.

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


