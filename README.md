# Saka Fleet — Backend

WhatsApp-native fleet operating system: vehicles, expenses, reminders, driver &
vehicle compliance, reports, subscriptions and an autonomous Sentinel supervisor.

## Quick start
```bash
npm install
cp .env.example .env      # fill secrets (never commit .env)
npm start                 # Fastify on :3000, GET /healthz is DB-free
```

## Tests
```bash
npm test                  # all suites (always cleans up test rows)
npm run health            # stateless suites + workflow lint + DB/CI snapshot
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
