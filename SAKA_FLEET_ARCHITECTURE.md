# SAKA FLEET - Master Architecture & System Audit

**Status:** Production Ready / Active  
**Version:** 1.5.0  
**Efficiency Policy:** Consult this document and `.clinerules` first before inspecting codebase files.

---

## 1. Executive Overview & Tech Stack

Saka Fleet is an intelligent vehicle asset management and conversational fleet operating system designed to run frictionlessly over WhatsApp, backed by an autonomous AI agent, enterprise database, and cloud messaging services.

### Core Technology Stack
- **Runtime & Server:** Node.js (ES Modules), Fastify 5 (`@fastify/formbody`, `@fastify/rate-limit`)
- **AI Engine:** DeepSeek (`deepseek-chat` / DeepSeek-V3) via the `openai` SDK pointed at `https://api.deepseek.com`, with structured JSON intent triage, conversational memory, and Sentinel runtime micro-rules
- **Database & Storage:** Supabase (PostgreSQL 15+ with Row-Level Security, B-Tree Indexes, REST & direct SQL query endpoints)
- **Messaging & Channels:** Meta WhatsApp Cloud API (Graph API v17.0+) with HMAC SHA-256 signature verification
- **Email Infrastructure:** Resend SDK (`resend`) for transactional MFA codes, OTP verification, PDF audit reports, passbook issuance, support escalation, and admin alerts
- **Payments & Subscriptions:** Paystack API (KES, USD, ZAR, NGN multi-currency checkout & subscriptions)
- **Document Generation:** PDFKit (`pdfkit`) for automated monthly fleet financial audits and compliance reports
- **Worker & Self-Healing:** Saka Sentinel background supervisor with health checks, conversational friction analysis (`evaluateConversationalFriction`), and runtime prompt self-tuning

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
- **Verify connectivity** any time with `node scripts/test_deepseek_connection.js` (plain text + JSON mode + conversation history).

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
- `vin`: `text` (**Immutable Core Identifier**, permanently tied to passbook)
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

3. **Message ID Deduplication (Idempotency Cache):**
   - Extracts Meta Message ID (`wamid`) from `entry[0].changes[0].value.messages[0].id`.
   - Primary: In-memory `processedWebhooksCache` map with a strict 10-minute (600,000 ms) TTL for <0.1ms lookups.
   - Secondary: Distributed `public.processed_webhooks` Supabase table for multi-instance cluster persistence.
   - If a duplicate `wamid` is received within 10 minutes, the server immediately returns `HTTP 200 OK` (`{ status: 'success', deduplicated: true }`) and aborts execution, completely eliminating Meta webhook retry loops.

4. **Immediate Fastify 200 OK Response:**
   - Fastify immediately sends `HTTP 200 OK` (`{ status: 'success' }`) to Meta upon receiving the webhook (after signature and deduplication checks).
   - DeepSeek AI generation, vehicle state transitions, WhatsApp reply dispatches, and database logging execute asynchronously in background tasks, eliminating Meta webhook timeout errors.

5. **Two-Stage Self-Healing Circuit Breaker (Strike-Based):**
   - Sessions track `loopSignature`, `consecutivePromptCount`, `circuitBreakerStage`, `lastAssistantPrompt`.
   - The `loopSignature` is the actual generated reply text; breaker messages never overwrite it, so strikes accumulate correctly across grace retries.
   - **Strike 3 → `SOFT_TRIP` (Sentinel self-heal window):** logs `LOOPING_PROMPTS` friction, replies *"I've hit a temporary snag processing this step. Kindly try again!"* and grants one clean retry while Sentinel synthesizes a dynamic micro-rule.
   - **Strike 4 → `HARD_TRIP` (escalation):** logs `SYSTEM_ERROR` friction, emails `support@sakafleet.com` via Resend with the profile, repeated prompt, and last user input, then replies *"I've hit a temporary snag processing this step. I have notified our support team at support@sakafleet.com, and we will update you right here on WhatsApp once this is resolved!"*
   - **Navigation Freedom (no permanent lockout):** any `cancel|exit|stop|reset|start over|1..5` or `log|update|set|request|help` input clears the breaker stage, strike count, and loop signature instantly.
   - **Driver assignment parser is order-agnostic:** single-turn `assign <plate> to [driver] <phone>` and `assign <phone> to <plate>` both work; if no phone is supplied the session stores `pendingDriverAssignment` and asks for the driver's number (multi-turn). `UNASSIGN_DRIVER` supports `unassign driver [from] <plate>` / `remove driver`.
   - **Phone-as-VIN guard:** `extractVehicleAttributes` routes `(?:+?254|0)[17]\d{8}` / `\+?\d{9,15}` into `driver_phone` and never into `vin`.

6. **Unregistered / Idle User Conversational Model:**
   - Swahili greetings (*"Habari"*, *"Mambo"*, *"Jambo"*) are greeted warmly with an introduction to Saka Fleet.
   - Pausing (*"Stop"*, *"Pause"*, *"Cancel"*) gracefully acknowledges with *"Understood! I'll pause here..."* without spamming registration prompts.
   - Conversational friction detection: Phrases like *"too many messages"*, *"stop with the many replies"*, *"repeating"*, *"frustrating"* are logged to `chat_friction_logs` and acknowledged empathetically.
   - Informational questions are answered conversationally via DeepSeek without forcing the registration prompt.

7. **Superadmin Intercept:**
   - If incoming sender matches `SUPERADMIN_PHONE`, message is routed to `handleSuperadminFlow` for health telemetry, prompt tuning, coupon generation, and fleet diagnosis.

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
   - All incoming user WhatsApp messages are stored immediately to `chat_history` (`role: 'user'`).
   - Outgoing assistant responses are stored to `chat_history` (`role: 'assistant'`).
   - The last 10 messages from `chat_history` are fetched and injected as turns (`{ role: 'user' | 'model', parts: [{ text }] }`).

4. **Intent Classification & Autonomous Actions:**
   - Supported intents (single source of truth: `sakaAi.js` `DEFAULT_SAKA_CORE_PROMPT`): `GREETING`, `ACTION_DISCOVERY`, `TRANSFER_PASSBOOK`, `APPLY_COUPON`, `REGISTER_VEHICLE`, `ONBOARDING_INPUT`, `ONBOARDING_SKIP`, `VERIFY_OTP`, `RESEND_OTP`, `UPDATE_EMAIL`, `APP_HELP`, `MANAGE_VEHICLE`, `LIST_VEHICLES`, `SWITCH_VEHICLE`, `QUERY_FUEL_EFFICIENCY`, `QUERY_FLEET_SUMMARY`, `LOG_EXPENSE`, `UPDATE_MILEAGE`, `LOG_EARNINGS`, `SET_REMINDER`, `COMPLETE_REMINDER`, `REQUEST_REPORT`, `CONTACT_SUPPORT`, `REACTIVATE_ACCOUNT`, `GENERAL_CHAT`, `ASSIGN_DRIVER`, `UNASSIGN_DRIVER`.
   - Hybrid extraction merges DeepSeek structured JSON with smart regex heuristics (including currency exclusion to prevent false plate matches, phone-vs-VIN disambiguation, and odometer-safe OTP parsing).
   - **Expense-vs-Odometer disambiguation:** messages containing fuel/expense wording (`fuel`, `liters`, `refuel`, `paid`, `cost`, `receipt`, `maintenance`) are classified as `LOG_EXPENSE` even when an odometer value is also present (e.g. *"Logged 30L fuel at 50350 km for KES 5500"*).

5. **Fleet Analytics Engine (`src/services/analytics.js`):**
   - `calculateFuelConsumption`: Calculates km/L, L/100km, MPG, total distance, volume in liters, and total cost from `expense_logs`. Identifies missing parameters (`NEEDS_MORE_DATA`) and prompts the user conversationally.
   - `getVehicleSummaryReport`: Provides full financial breakdown (fuel, maintenance, net profit) and asset health.

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
   - In `sakaAi.js`, `getSakaCorePrompt()` retrieves active rules (`is_active = TRUE`) and appends them to the DeepSeek system instruction as real-time behavioral guidance.

### Function Boundary Lock & Admin Kill Switch
- **Function Boundary Lock:** Sentinel is strictly restricted to tone, phrasing, clarification flows, and entity hints. It cannot alter core hardcoded logic, database schemas, VIN locks, OTP verification, or security rules.
- **Admin Kill Switch:** Superadmin can instantly override Sentinel rules via WhatsApp:
  - `adminrules reset`: Deactivates all dynamic micro-rules (`is_active = FALSE`).
  - `adminrules toggle [key]`: Toggles activation status for a specific rule key.

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

## 10. Database Slate Reset Utility & Token Efficiency

- **Reset Slate Script:** `scripts/reset_db_slate.js`
- **Token Efficiency Directive:** Consult `SAKA_FLEET_ARCHITECTURE.md` and `.clinerules` first on every prompt. Target reads/writes and batch all independent operations.

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
  - `chat_history`, `chat_transcripts`, `chat_friction_logs`, `processed_webhooks`
  - `pending_owner_notifications`, `passbook_transfers`
  - `private_earnings`, `expenses`, `expense_logs`, `reminders`
  - `superadmin_sessions`, `coupons`, `admin_audit_logs`, `conversation_analytics`, `error_logs`

### 15.2 Production & Execution Safeguards
- **Production Block:** If `NODE_ENV === 'production'` or `APP_ENV === 'production'`, the script aborts immediately unless `--force-production-wipe` is explicitly supplied.
- **Confirmation Flag:** Requires `--confirm` flag (e.g. `node scripts/reset-db.js --all --confirm`). Without `--confirm`, execution is safely aborted with an informational warning.
- **Targeted Reset:** Supports phone-specific data clearing: `node scripts/reset-db.js --phone +254712345678 --confirm`.
- **Post-Reset Verification:** Queries and outputs a clean verification summary table confirming zero residual records across all primary operational tables.

---

## 16. First-Time User Conversational Flow (Progressive Onboarding)

### 16.1 Shared First-Time Guide (`buildFirstTimeWelcome`)
- `src/routes/whatsapp.js` exports `buildFirstTimeWelcome({ swahili, senderPhone })` — the single source of truth for brand-new / unregistered users; it auto-renders the user's country plate format, metric/imperial unit hint, and currency from `detectCountryFromPhone`.
- Provides a numbered, ~2-minute walkthrough: (1) plate → (2) make/model + year + fuel + mileage → (3) email OTP → (4) VIN-locked passbook, then optional Stage 2 specs.
- Always surfaces recovery affordances: **Help**, **What can I do?**, **Restart**, **Cancel**, and buyer **ACCEPT**.
- Reused by `generateRoleBasedActionDiscovery` (unregistered branch) and the idle/greeting branches (English + Swahili), so every entry point is consistent.
- **AI language auto-translation:** `detectMessageLanguage` (in `src/routes/whatsapp.js`) auto-detects the user's language per turn, persists it to `profiles.preferred_language`, and injects it into the DeepSeek runtime context; the core prompt instructs Saka to always reply in the user's language (global multilingual support).

### 16.2 Accurate Progressive Stage Labels
- **Stage 1 of 2 · Step 1 of 4** — Registration Plate (offers *Cancel*).
- **Stage 1 of 2 · Step 2 of 4** — Vehicle Core Details (offers *Cancel* / *Restart*).
- **Stage 1 of 2 · Step 3 of 4** — Email Verification (invalid/expired codes offer **resend** or **cancel**).
- **Stage 1 of 2 · Step 4 of 4** — Passbook Issued (transitions into **Stage 2 of 2 — Optional Specs**).
- Onboarding completion returns a numbered quick-action menu (1–5) plus a **Help** hint.

### 16.3 Help & Action Discovery Routing
- `Help` → `APP_HELP` and `What can I do?` → `ACTION_DISCOVERY`; both route through the special-flow handler to `generateRoleBasedActionDiscovery`.
- Unregistered users receive the first-time guide; active users receive their role-specific command center (Owner / Driver / Owner+Driver / Superadmin).
- `Restart` / `Reset` / `Start over` restarts onboarding; `Cancel` / `Exit` / `Stop` aborts cleanly.

---

## 17. Known Operational Observations (Operational Review 2026-10-28)

1. **Tier-limit source drift (needs alignment):**
   - `src/services/paystack.js` → `SUBSCRIPTION_TIERS.solo_pro.vehicleLimit = 2`.
   - `src/services/vehicles.js` → `TIER_LIMITS.solo_pro = 3` (and this document specifies 3).
   - `whatsapp.js` gates pre-registration capacity via `SUBSCRIPTION_TIERS` (2), while `onboarding.js` gates final capacity via `checkOwnerVehicleTierLimit` (3). Recommend converging on a single source (3 per this document).
2. **Intermittent DeepSeek empty completions:** Under high-frequency test runs, `deepseek-chat` occasionally returns an empty completion; `aiClient.chatCompletion` retries and callers deterministically fall back to `classifyIntentWithRegex`, so flows remain functional with no data loss observed.
3. **Test isolation:** Root-level `test_*.js` suites depend on live Supabase + Resend + DeepSeek and clear data by hard-coded test phones. A transient Supabase `fetch failed` can leave stale rows and make an "unregistered" test user appear registered; run `node scripts/reset-db.js --phone <number> --confirm` before re-running.
4. **Test runner:** All suites are standalone `node test_*.js` scripts (no Jest/Mocha/Vitest, no `npm test` script). `test_first_time_flow.js` is the offline suite covering the redesigned first-time flows.

