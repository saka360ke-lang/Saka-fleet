# SAKA FLEET - Master Architecture & System Audit

**Status:** Production Ready / Active  
**Version:** 1.9.1  
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
- **Legacy providers removed (v1.7.3):** SendGrid (`@sendgrid/mail`), Twilio (`twilio`) and the unused `supabase` CLI package were fully removed — zero code imports, zero env keys. **Resend** + **Meta WhatsApp Cloud API** are the only outbound channels.

### 1.1 LLM Provider — DeepSeek (single source of truth)

All LLM traffic flows through **`src/services/aiClient.js`**. No service talks to a provider directly.

| Setting | Value |
| :--- | :--- |
| Base URL | `https://api.deepseek.com` |
| Primary model | `deepseek-chat` (DeepSeek-V3) |
| SDK | `openai` (OpenAI-compatible surface) |
| API key env | `DEEPSEEK_API_KEY` |
| Optional model override | `DEEPSEEK_MODEL` |

**Exports**
- `getAIClient()` — lazily created, cached `OpenAI` instance bound to the DeepSeek baseURL.
- `chatCompletion({ system, messages, jsonMode, maxTokens, temperature })` → `{ ok, text, model, error }`. **Never throws.**
- `generateText({ system, prompt, jsonMode, ... })` → `string | null` (single-turn convenience wrapper).
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
- **Verify connectivity** any time with `node scripts/test_deepseek_connection.js` (plain text + JSON mode + conversation history).

### 1.2 Conversational Engine (v1.7 — pure AI, quiz-first)

- **`src/services/conversationEngine.js`** — every user-facing reply is rendered by DeepSeek-V3 from a structured FACTS payload (`composeMessage`, `renderQuizQuestion`, `renderConfirmationSummary`, `renderOutcome`, `renderActionDiscovery`). Hard-coded conversational prose has been removed from the WhatsApp route; deterministic fallbacks remain only for provider outages. Quiz questions are cached per field/language (`seedQuizQuestions`, `isQuizQuestionCacheWarm`) and prefetched in one batch per flow.
- **`src/services/quizEngine.js`** — one-piece-at-a-time wizard engine: declarative flow definitions, per-field validators/extractors, deterministic multi-field fast-forward (`applyTextExtraction`), two-pass conditional extraction (`applyExtraction`), background question prefetch, Cancel/Restart/Help navigation, and a **mandatory confirmation summary before any database write**. VIN and passbook token are never editable.
- **`src/services/naturalParser.js` (v1.8)** — natural conversational extraction: deterministic field parsing plus a DeepSeek JSON top-up for missing fields, "extra notes" compilation for details that do not map to a database column, missing-field computation for dynamic prompts, and graceful degradation when the provider is unavailable.
- **`src/services/maintenanceReminders.js` (v1.9)** — universal reminder engine: distance (canonical km), operating hours **and date-based expiries** (insurance, inspection/MOT, licensing, permits, driver licences, general deadlines). Explicit `remaining_value` tracking, 75/25/5/due-now/overdue threshold tiers, 30d/14d/7d/24h/overdue expiry tiers, `due_at` timestamps in the user's confirmed timezone, driver-licence promotion, `expiry_notification_log` audit trail, and a single background sweep worker.
- **`src/services/fleetReports.js` (v1.9)** — four core report builders returning structured JSON + localized WhatsApp text: Fleet Status, Compliance & Expiry, Maintenance & Service and Financial & Cost. Every figure is derived from the database; currency/units/dates come from `globalization.js`.
- **`src/services/complianceCatalog.js` (v1.9.1)** — regional, asset-aware compliance catalog (mandatory minimal item + optional extras), lifetime-economy support, bundled defaults + effective-dated DB overrides, natural compliance parsing, and a Sentinel staleness review (`COMPLIANCE_CATALOG_VERSION`).
- **`src/services/driverAssignments.js` (v1.9.1)** — OTP-gated driver assignment lifecycle (owner OTP → driver ACCEPT), compliance snapshot, management gate, 3-strike cancellation, once-only owner compliance reports and 48h acceptance expiry.
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

---

## 3. WhatsApp Webhook, Reliability & Circuit Breaker Architecture

1. **Endpoint Routing:**
   - Handshake: `GET /webhook`, `GET /webhook/whatsapp`, `GET /api/whatsapp/webhook`
   - Messages: `POST /webhook`, `POST /webhook/whatsapp`, `POST /api/whatsapp/webhook`

2. **Cryptographic Validation:**
   - Meta Cloud API sends `x-hub-signature-256`.
   - The server verifies `crypto.createHmac('sha256', META_APP_SECRET)` against raw request body using constant-time comparison (`crypto.timingSafeEqual`).

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
   - Only explicit admin directives (`admin*`, `adminrules*`, `check health`, `system status`, `sentinel …`, `profiles report`, `coupon …`, `horizon`, `proposals`) are claimed by `handleSuperadminFlow`.
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
   - Supported intents (single source of truth: `sakaAi.js` `DEFAULT_SAKA_CORE_PROMPT`): `GREETING`, `ACTION_DISCOVERY`, `TRANSFER_PASSBOOK`, `APPLY_COUPON`, `REGISTER_VEHICLE`, `ONBOARDING_INPUT`, `ONBOARDING_SKIP`, `VERIFY_OTP`, `RESEND_OTP`, `UPDATE_EMAIL`, `APP_HELP`, `MANAGE_VEHICLE`, `LIST_VEHICLES`, `SWITCH_VEHICLE`, `QUERY_FUEL_EFFICIENCY`, `QUERY_FLEET_SUMMARY`, `LOG_EXPENSE`, `UPDATE_MILEAGE`, `LOG_EARNINGS`, `SET_REMINDER`, `COMPLETE_REMINDER`, `REQUEST_REPORT`, `CONTACT_SUPPORT`, `REACTIVATE_ACCOUNT`, `EDIT_VEHICLE`, `DELETE_VEHICLE`, `EDIT_PROFILE`, `DELETE_ACCOUNT`, `GENERAL_CHAT`, `ASSIGN_DRIVER`, `UNASSIGN_DRIVER`.
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
- `adminstop`: Terminates the admin session immediately.

### 6.2 Automated 8:00 AM Morning Executive Briefing
- Daily at 8:00 AM, Sentinel automatically synthesizes a fleet-wide status digest and pushes it directly to `SUPERADMIN_PHONE` via WhatsApp.

### 6.3 Strict Scope Bounds & System Protection
- Sentinel is strictly a superadmin and system-level supervisor.
- Sentinel **must not** receive general vehicle reminders, compliance alerts, or delayed owner notifications unless the superadmin is actively operating in Owner or Driver mode for a vehicle they personally own or is assigned to.

### 6.4 Sentinel Full-Authority Self-Healing & Evolution Framework

Sentinel operates under a **"fix first, escalate last"** doctrine: it autonomously repairs every issue it is capable of fixing, and only pages human support when a boundary is hit.

**A. Guaranteed Deployment Notifications (Cloud Build → Superadmin)**
- `scripts/notify_git_push.js` now dispatches **dual-channel** alerts (Meta WhatsApp **and** Resend email to `SUPERADMIN_EMAIL`) so a single API outage never silences a deployment announcement.
- `.github/workflows/deploy_notify.yml` installs dependencies before invoking `node scripts/notify_git_push.js`, and `notify_git_push.js` loads `dotenv`/`resend` lazily so the primary WhatsApp channel can never be blocked by a missing optional SDK.
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

### 7.1 Subscription-Tier Ownership Limits
Vehicle ownership capacity is bound to active subscription tier:
- `free`: 1 vehicle
- `solo_pro`: 3 vehicles
- `fleet_starter`: 10 vehicles
- `enterprise`: Unlimited vehicles
Owners exceeding tier limits are prompted to upgrade via Paystack checkout.

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

### 11.1 Asset-Bound 30-Day Free Trial
- Every unique vehicle VIN receives a one-time **30-day free trial** starting on the day its first passbook is created.
- Managed via `vin_registry`:
  - `trial_granted = true`, `trial_start_at = now()`, `trial_end_at = now() + 30 days`.
  - Re-registering the same VIN preserves the original trial expiration and does NOT grant extra free days.
  - If a trial has lapsed, the vehicle requires an active subscription slot to continue live updates.

### 11.2 Slot-Based Capacity & Upgrade Prompt
- Owners operate under slot capacity limits:
  - `free`: 1 active vehicle slot
  - `solo_pro`: 3 active vehicle slots
  - `growth`: 5 active vehicle slots
  - `scale` / `fleet_starter`: 10 active vehicle slots
  - `unlimited` / `enterprise`: Unlimited active vehicle slots
- When an owner reaches their tier limit and attempts to add another vehicle:
  - Registration is halted before database insertion.
  - Saka displays: *"⚠️ Vehicle Capacity Limit Reached. Your current plan allows [X] active vehicle(s). To add more vehicles, please upgrade to Solo Pro. Upgrade Link: [Paystack URL]. Note: Individual 30-day trials on your existing vehicles will remain fully preserved and active!"*
  - Account upgrading expands available slots without altering any vehicle's trial countdown.

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
  - **Superadmin:** Displays executive fleet commands (`admin report`, `admin audit [Plate or VIN]`, `admin alerts`, `adminrules`).
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
- Covered Tables:
  - `vehicles`, `vin_registry`
  - `profiles`
  - `chat_history`, `chat_transcripts`, `chat_friction_logs`, `processed_webhooks`, `chat_sessions`, `saka_dynamic_rules`
  - `pending_owner_notifications`, `passbook_transfers`
  - `private_earnings`, `expenses`, `expense_logs`, `expiry_notification_log`, `reminders`
  - `superadmin_sessions`, `coupons`, `admin_audit_logs`, `conversation_analytics`, `error_logs`
  - **Intentionally preserved:** `system_config` (deployment revision + retained prompt overrides), `weekly_feature_proposals` and `compliance_catalog` (legal reference data + effective-dated overrides; reseeded idempotently at startup).

### 15.2 Production & Execution Safeguards
- **Production Block:** If `NODE_ENV === 'production'` or `APP_ENV === 'production'`, the script aborts immediately unless `--force-production-wipe` is explicitly supplied.
- **Confirmation Flag:** Requires `--confirm` (e.g. `node scripts/reset-db.js --all --confirm`). Without `--confirm`, execution is safely aborted with an informational warning.
- **Explicit Scope Required:** The script now also requires either `--all` (global slate wipe) or `--phone <number>` (targeted). A bare `--confirm` can no longer wipe the database.
- **Targeted Reset:** Supports phone-specific clearing: `node scripts/reset-db.js --phone +254712345678 --confirm`. It resolves vehicles by `owner_phone` **and** `owner_id`, releases any driver assignment held by the phone, and clears dependent logs/transfers/notifications.
- **Fallback Safety:** The Supabase-JS fallback uses per-table primary keys (`processed_webhooks.wamid`, `vin_registry.vin`, otherwise `id`).
- **Post-Reset Verification:** Queries and outputs a clean verification summary table confirming zero residual records across all primary operational tables.

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

1. **Tier-limit source drift (needs alignment):**
   - `src/services/paystack.js` → `SUBSCRIPTION_TIERS.solo_pro.vehicleLimit = 2`.
   - `src/services/vehicles.js` → `TIER_LIMITS.solo_pro = 3` (and this document specifies 3).
   - `whatsapp.js` gates pre-registration capacity via `SUBSCRIPTION_TIERS` (2), while `onboarding.js` gates final capacity via `checkOwnerVehicleTierLimit` (3). Recommend converging on a single source (3 per this document).
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
| `assign_driver` | vehicle → driver phone → **handover odometer** → confirm → **owner WhatsApp OTP** | assignment request (no vehicle write yet) | `driver_assignments` → `PENDING_OWNER_OTP` → `PENDING_DRIVER_ACCEPTANCE`; driver replies ACCEPT |
| `driver_onboarding` | full name (optional) → email → OTP → minimal compliance (regional catalog) → optional asset-aware extras → confirm | compliance details + catalog | `profiles` (email_verified, compliance_*), `driver_compliances`, driver expiry reminders, once-only owner compliance report |
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
- `naturalParser` clamps extraction input to `MAX_EXTRACTION_TEXT_CHARS` (600) and the collected-fields JSON to `MAX_COLLECTED_JSON_CHARS` (800); deterministic parsing still sees the full text.
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
| `SUPABASE_TIMEOUT_MS` | 15000 | per-request DB timeout |
| `SAKA_PROMPT_CACHE_MS` | 60000 | core prompt cache |
| `QUIZ_QUESTION_CACHE_MS` / `QUIZ_QUESTION_CACHE_MAX` | 900000 / 300 | AI question render cache |

---

## 31. Agent Training: Flow Knowledge & Skill Synchronization (v1.8.1)

### 31.1 Single source of truth — `src/services/flowKnowledge.js`
- `SAKA_INTENTS` — every classifier intent (32), matching the JSON schema.
- `SAKA_QUIZ_FLOWS` — every quiz flow (18) with trigger phrases, field order, extracted JSON keys, post-confirmation writes and per-flow rules.
- `SAKA_INTENT_PLAYBOOK` — non-quiz intents (greeting, discovery, analytics, buyer-side transfer, OTP, reminders, onboarding) and the allowed behaviour for each.
- `SAKA_BOUNDARY_RULES` — VIN/passbook-token immutability, owner-only soft delete, strict 1-to-1 driver assignment, never invent OTP/PIN/amounts/dates, confirmation gate, superadmin interception, Saka/Sentinel division.
- `buildFlowPlaybook()` is injected into `DEFAULT_SAKA_CORE_PROMPT` via `${SAKA_FLOW_PLAYBOOK}`, so **the prompt can never drift from the code**.

### 31.2 Saka vs Sentinel (permanent boundary)
- **Saka** = front-facing WhatsApp agent: intent classification, structured extraction, localized prose, step-by-step guidance.
- **Sentinel** = background supervisor: health checks, conversational friction analysis, stall recovery, Cloud Run triage, weekly feature proposals. Saka never impersonates Sentinel or superadmin.

### 31.3 Training coverage added in v1.9.1
- All 18 quiz flows, all non-quiz intents, the universal reminder engine (date expiries / km-mi distance / operating hours), the 30d/14d/7d/24h/overdue expiry ladder, timezone confirmation, natural multi-field parsing + extra-notes compilation, the four core reports, the OTP-gated driver assignment handshake and the regional compliance catalog are explicit prompt instructions.
- `extracted_data` gained `reminder_type`, `reminder_category`, `reminder_due_date`, `reminder_threshold`, `timezone`, `report_type`, `driver_email`, `driver_response`, `compliance_type`, `compliance_number`, `compliance_expiry`, `compliance_lifetime` and `extra_notes`.
- `conversationEngine.composeMessage` adds FACTS-contract lines for expiry timezone confirmation, assignment OTP/ACCEPT, report fidelity and catalog-derived compliance facts.
- `test_agent_training.js` asserts every intent and flow key is embedded in the assembled core prompt (offline training regression guard), including the new driver/compliance tokens and all 18 flows.

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

## 33. OTP-Gated Driver Assignment & Compliance Lifecycle (v1.9.1)

### 33.1 Assignment lifecycle (`driver_assignments`)
| Status | Meaning |
| :--- | :--- |
| `PENDING_OWNER_OTP` | Owner confirmed the assignment summary; a 6-digit code was sent to the **owner's WhatsApp**. The driver has not been contacted yet. |
| `PENDING_DRIVER_ACCEPTANCE` | Owner verified the OTP. The driver receives a WhatsApp message and must reply **ACCEPT** or **DECLINE**. |
| `ACTIVE` | Driver accepted; `vehicles.assigned_driver_id` is set and the compliance snapshot is stored. **Management stays gated** until email + minimal compliance are valid. |
| `REJECTED` / `CANCELLED` / `EXPIRED` | Driver declined, owner/3-strike cancelled, or 48h acceptance timeout. |
| `COMPLETED` | Assignment ended (unassignment). |

Pending rows reserve both the driver and the vehicle (`canAssignDriverToVehicle` also checks `driver_assignments`), so the strict 1-to-1 rule cannot be raced. The owner OTP expires after 10 minutes and is cancelled after 3 wrong attempts; a Resend supersedes the previous pending request.

### 33.2 Assignment-time compliance snapshot
On ACCEPT, `compliance_snapshot` records the email-verified flag, the minimal item (type/number/expiry/lifetime), the additional items and `validAtAssignment`. This is an audit record of what was valid when the driver took the vehicle; the live gate is always recomputed from current data.

### 33.3 Management gate
`canManageVehicle()` returns `{ gated, canManage, status }`:
- Owner acting on their own vehicle → never gated.
- Assigned driver with an OTP-gated ACTIVE assignment → gated until `profiles.email_verified = true` **and** the minimal compliance is valid (`expiry >= today`, or `lifetime` where the catalog allows it).
- Legacy assignments without a `driver_assignments` row are grandfathered (re-assigning through the new flow enables the gate).

The route computes the gate for the active vehicle and redirects vehicle-bound intents (`LOG_EXPENSE`, `UPDATE_MILEAGE`, `SET_REMINDER`, reports, edits, transfers…) into the `driver_onboarding` flow with a single next step. `detectQuizStart({ driverOnboardingPending })` owns the redirect, and the gate is re-checked on the engine path.


### 33.4 Regional, asset-aware compliance catalog (`compliance_catalog`)
- `COUNTRY_COMPLIANCE_CATALOG` in `src/services/complianceCatalog.js` ships bundled defaults per country: a mandatory **minimal** item (driver licence variants: NTSA, DMV, DVLA, RTA, RTO, FRSC, TRA, URA, RRA, CNH, LTO…) and **additional** items filtered by the vehicle's `asset_type` (KE PSV badge, GB Driver CPC + CPCS plant card for excavators, US CDL + operator certification, ZA PDP, NG Hackney permit, AU heavy rigid/white card, AE heavy vehicle permit, IN commercial DL…). Unknown economies fall back to the driver licence.
- `lifetimeAllowed` marks economies that issue the minimal item for life (e.g. Belgium); everywhere else an expiry date is mandatory and must be in the future or the submission is rejected.
- **Living catalog:** bundled defaults are versioned (`COMPLIANCE_CATALOG_VERSION`, bumped with every release), seeded idempotently into `compliance_catalog` at startup (`ensureComplianceCatalog`), and can be overridden by superadmin with an `effective_from` date (`upsertComplianceCatalogEntry`). Resolution order: active DB override effective today → bundled default. `getComplianceCatalog()` caches for `COMPLIANCE_CATALOG_CACHE_MS` (1h).
- **Periodic review:** `reviewComplianceCatalog()` flags entries whose `next_review_at` (180 days after review) has passed. The Sentinel weekly worker messages the superadmin to re-verify against current law. Legal rules are **never** auto-applied by AI; only a code release or an explicit admin override changes them.

### 33.5 Driver profile & reminder integration
- `driver_onboarding` (18th quiz flow) collects full name (optional), email + OTP (if unverified), the minimal compliance and up to three asset-aware extra items. Natural parsing (`parseComplianceItem`) extracts the number and country-resolved expiry, and detects "valid for life".
- `driver_compliances` stores one row per item (`driver_id`, `type`, `label`, `number`, `expiry`, `lifetime`, `country_code`, `asset_type`). The minimal item is mirrored to `profiles.compliance_*` and legacy `driver_license_*`.
- Expiring items create driver-linked reminders (`linked_column = 'driver_compliances:<type>'`) through the v1.9 engine, so the 30d/14d/7d/24h/overdue ladder notifies the driver and the owner(s). Lifetime items create no reminder.
- Optional extras are framed as "so we can remind you before it expires"; skipped items are never mandatory and are re-offered gently later. A driver can also add or refresh any item directly in chat (e.g. "PSV badge 445566 expires 15 Dec 2028"), which routes through the same parser and reminder pipeline (and can open the gate if the minimal item is submitted).

### 33.6 Owner reports, invalid attempts & cancellation
- **Once-only compliance-cleared report:** when the minimal item first becomes valid, the owner receives a deterministic WhatsApp report (driver, email status, minimal item + expiry/lifetime, additional items) and `compliance_report_sent_at` prevents repeats.
- **Invalid minimal attempt:** every expired submission queues an owner report (`DRIVER_COMPLIANCE_INVALID`, attempt n/3) and the gate stays closed.
- **3-strike cancellation:** the third expired minimal submission sets the assignment to `CANCELLED` (`cancelled_reason = EXPIRED_MINIMAL_COMPLIANCE_3X`), unassigns the driver, releases the vehicle, and sends `DRIVER_ASSIGNMENT_CANCELLED` telling the owner to restart once the driver renews.
- Owner reports use the existing `pending_owner_notifications` queue (processed every 30s).

### 33.7 Schema
`driver_assignments` (lifecycle, OTP code/attempts, handover odometer, compliance snapshot/report timestamps), `driver_compliances` (unique per driver+type), `compliance_catalog` (country_code unique, minimal/additional jsonb, effective/review dates, source, version, is_active), `profiles.compliance_type/number/expiry/updated_at`. DDL is idempotent in `ensureVehicleTableColumns`; assignment/compliance tables are cleaned by `scripts/testCleanup.js` and `scripts/reset-db.js`, while `compliance_catalog` is intentionally preserved.

### 33.8 Tests
`test_driver_assignment_gate.js` (stateless) covers catalog resolution incl. lifetime + asset filtering, natural parsing, OTP expiry/attempt cancellation, strict 1-to-1 reservation, ACCEPT + snapshot, the gate, once-only owner report, 3-strike cancellation, lifetime vs expiring economies, catalog overrides/effective dating, stale expiry and flow wiring (48 assertions).

