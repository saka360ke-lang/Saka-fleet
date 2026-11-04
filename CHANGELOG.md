# Changelog

## [1.58.23] - 2026-11-04

- **Recurrence-autopsy law (rule 51).** Every friction/error fix now sweeps the defect class: sibling entry points audited, patched or documented, one targeted assertion each, and the autopsy recorded in the architecture section + changelog. A fix whose class was not swept is incomplete.
- **Intent-lane hijack sweep.** Any sentence ending in `?` is no longer a ledger question (it needs a records/expense/earning/plate signal), and mid-sentence plan phrases (`confirm which tier i am on`, `put me on the second tier`, `enroll me on solo fleet`) now reach the deterministic plan handler while advisory questions like `Which subscription is best?` still get the pricing answer.
- **Draft cards accept explicit fields.** `Type: Part (AC idler pulley mounting bracket)` canonicalises and stores the parenthetical as the note; `Extra notes: ...` updates the draft in place (the 14:48/15:44 `I did not change anything` loops are gone). A unique plate prefix (`KBJ`) now resolves when only one vehicle matches.
- **Delivery guard.** Permanent WhatsApp failures (131026/131047/131051) block that recipient for 24h (`DELIVERY_BLOCK_HOURS`) in both senders and the status callback, ending retry storms against numbers that can never receive.
- **Files:** .clinerules, src/routes/whatsapp.js, src/services/{quizEngine,recordAnswers,entryAnswers,deliveryGuard}.js, src/workers/sentinel.js, test_*.js, .env.example, package.json, SAKA_FLEET_ARCHITECTURE.md, CHANGELOG.md.
- **Tests:** test_record_answers (49), test_quiz_flow (147), test_v1583 (10), test_sentinel_policy (23), test_first_message_flow (53), test_entry_ledger, test_agent_training (155), test_customer_care (18), test_narrative_draft (118) - green; `npm run health` green.

## [1.58.22] - 2026-11-04

- **Support claims are backed by a real ticket.** `openCareTicket` now writes the care lifecycle (`status=OPEN`, priority, source, subject, thread_key) with a slim-table fallback, failed inserts are reported (`ticketCreated:false`) and logged, and Saka says "forwarded" only when a row exists - it no longer promises a hand-off that the care console cannot see. Live check: insert + cleanup green (0 rows left).
- **A pending support intake owns the next message.** The intake runs before the stop/quiz lanes, so an open expense draft cannot swallow the issue description; `cancel/exit/stop` exits.
- **A request mid-draft is not an answer.** Statements like "I should be able to name the part" park the draft (nothing lost) and offer Support instead of re-asking the same question (live: 7 repeats).
- **Parts are nameable and notes are visible.** The quiz note step invites `brake pads, oil filter, Shell station`; record lists show `(notes)` per row; plate-scoped reads print `For *PLATE*` instead of claiming the whole fleet; `why...` questions never return ledger totals.
- **Driver compliance phrasings** (`show me my driver compliance`, `drivers licence expiry`, `personal compliance`) read the owner Compliance Card.
- **Delivery-failure log hygiene:** status callbacks log a normalized recipient+code message so the 24h rollup folds repeats (22 near-identical 131026 rows in 48h).
- **Files:** src/services/{customerCare,recordAnswers,recordQuery,quizEngine,flowKnowledge}.js, src/routes/whatsapp.js, test_customer_care.js, test_record_answers.js, .clinerules, package.json, SAKA_FLEET_ARCHITECTURE.md, CHANGELOG.md.
- **Tests:** test_customer_care (18), test_record_answers (48), test_quiz_flow (143), test_inbound_email (26), test_care_worker (44), test_entry_ledger, test_v1583 (9), test_first_message_flow (53), test_agent_training (155), test_sentinel_policy (17) - green; `npm run health` green.

## [1.58.21] - 2026-11-04

- **The welcome trial now runs from the day the passbook is issued.** `startAccountTrial({ startedAt })` anchors `started_at`/`ends_at` to the asset creation instant; both registration paths pass it, and the heal/reconcile pass the owner oldest ACTIVE vehicle `created_at`. Existing trials were re-anchored live (13:20:24 and 13:22:14 - the exact asset timestamps).
- **Growth rides on the trial.** Upgrading no longer shortens the window: a paid subscription records the conversion but the trial row stays ACTIVE until its anchored end; entitlements treat the trial as the floor (a lapsed paid plan returns to the trial, never straight to Free) and the expiry sweep never downgrades a live paid account.
- **Chat friction fixed:** bare "switch car" now asks "Which one?" with the numbered list; "show me my driver profile" answers with the owner Compliance Card instead of fleet context; "confusing" joins the support escape; tier-math follow-ups ("I have less than 3 assets") get the count-aware plan answer.
- **Files:** src/services/{trialEngine,subscriptions,quizEngine,onboarding}.js, src/routes/whatsapp.js, scripts/reconcile_welcome_trials.js, test_trial_engine.js, test_subscription_billing.js, package.json, SAKA_FLEET_ARCHITECTURE.md, CHANGELOG.md.
- **Tests:** test_trial_engine (77), test_subscription_billing (78), test_quiz_flow (143), test_agent_training (155), test_first_message_flow (53), test_greetings (110) - green; `npm run health` green.

## [1.58.20] - 2026-11-04

- **The welcome trial is back (root cause found).** The live profiles table was missing `currency` and `locale`, so every `startWelcomeTrial` call returned "profile not found" and was swallowed - trial_sessions was empty and every account sat on Free capacity while believing it was on a trial. Migration `npm run migrate:profile-context` adds both columns (applied live); `fetchOwner` now falls back to a slim select, and both registration paths log a refused trial instead of hiding it.
- **Lazy heal + reconcile.** A Free owner with no trial now receives the welcome trial before any capacity block can fire, and `npm run reconcile:welcome-trials` heals every owner of an ACTIVE vehicle with no trial row (audited TRIAL_RECONCILED). Live: +254734852529 and +254710268605 are on growth (5 vehicles) now.
- **No more complaint pollution.** "I am on a valid 30 day trial!!!", "Your last reply was incomplete" and "I want a refund" can never be stored as a vehicle field.
- **Error rollup.** Identical failures (same route + message) are logged once per ERROR_ROLLUP_HOURS (24) instead of one row per event - the 40 identical WhatsApp 131026 undeliverable rows were drowning error_logs and burning diagnosis tokens.
- **Files:** src/services/{trialEngine,quizEngine,onboarding,envAudit}.js, src/routes/whatsapp.js, src/workers/sentinel.js, scripts/{run_profile_context_migration,reconcile_welcome_trials}.js, test_v1571.js, .env.example, package.json, SAKA_FLEET_ARCHITECTURE.md, CHANGELOG.md.
- **Tests:** test_quiz_flow (143), test_trial_engine, test_v1571 (20), test_agent_training (155), test_env_audit (44) - green; `npm run health` green.

## [1.58.19] - 2026-11-04

- **No more support-inbox self-loop.** Escalation emails are sent to support@reports.sakafleet.com, which is also the inbound address - so the platform was re-ingesting its own escalations as new tickets. `handleInboundEmail()` now ignores mail from `@reports.sakafleet.com` (the platform own senders) as `self-sender`, before any ticket write or care ping. Four loop tickets produced during verification were removed.
- **Tests:** test_inbound_email (26) with the new self-sender guard; test_care_worker (44) - green; `npm run health` green.

## [1.58.18] - 2026-11-04

- **The care worker now has a real console.** Resend mail at support@reports.sakafleet.com and WhatsApp support requests become tracked tickets the worker can `care inbox`, `care read`, `care reply` (WhatsApp + email), `care note`, `care take`, `care escalate` / `care deescalate`, `care close` / `care reopen`, `care search`, `care stats` and `care audit` - all deterministic and audited.
- **Tickets have a lifecycle and threads.** Status (OPEN/IN_PROGRESS/RESOLVED/CLOSED), priority, source, assignee, internal notes and a full message thread; follow-up emails in the same thread append to the open ticket instead of creating duplicates.
- **Replies land on both channels.** A reply goes to the customer WhatsApp and email (From support@reports.sakafleet.com, reply_to the inbox), so their email answer threads straight back into the ticket.
- **Escalations reach the superadmin** by WhatsApp and email; de-escalation, closing and reopening are one command each. Every action is audited as CARE_TICKET_*.
- **Training:** `docs/CARE_WORKER_GUIDE.md` - role, boundaries, shift routine, escalation ladder, tone, SLA (4h first reply / 24h updates / 72h close-or-escalate), sample replies and a first-shift checklist.
- **Safety:** the worker role stays OFF until CUSTOMER_CARE_PHONE is set; the superadmin can run every care command; the console never touches ledger, VIN, billing or refunds and never blocks normal chat.
- **Files:** src/services/{careConsole,inboundEmail,mailer,flowKnowledge,envAudit}.js, src/routes/whatsapp.js, scripts/run_care_console_migration.js, scripts/health_audit.js, test_care_worker.js, test_inbound_email.js, docs/CARE_WORKER_GUIDE.md, .env.example, package.json, SAKA_FLEET_ARCHITECTURE.md, CHANGELOG.md.
- **Tests:** test_care_worker (43), test_inbound_email (25), test_customer_care (12), test_agent_training (155), test_landing_static (223) - green; `npm run health` green.

## [1.58.17] - 2026-11-04

- **One support inbox: support@reports.sakafleet.com.** The Resend inbound domain is reports.sakafleet.com, so every care path now uses that address: WhatsApp care requests are emailed there (From: `Saka Support <support@reports.sakafleet.com>`), Saka's support copy (circuit-breaker, support intake, friction apology, hard-trip) names it, and the website (JSON-LD, FAQ, footer, privacy, terms, data-deletion, llms.txt, humans.txt) publishes it. security@reports.sakafleet.com (OTP) is unchanged.
- **Inbound recipient gate.** Only mail addressed to support@reports.sakafleet.com opens a care ticket; replies to any other alias are ignored, so OTP threads never become tickets.
- **Escalations now reach the superadmin on email AND WhatsApp.** `escalateCareToSuperadmin()` keeps the WhatsApp ping and adds `sendSuperadminEscalationEmail()` to SUPERADMIN_EMAIL (never throws; skipped when unset). `CUSTOMER_CARE_PHONE` stays off by policy - inbound pings fall back to the superadmin.
- **Files:** src/services/{mailer,customerCare,inboundEmail,flowKnowledge,quizEngine,productQa}.js, src/routes/whatsapp.js, landing/{index,privacy,terms,data-deletion}.html, landing/llms.txt, landing/humans.txt, test_inbound_email.js, test_customer_care.js, test_landing_static.js, .env.example, .clinerules, package.json, SAKA_FLEET_ARCHITECTURE.md, CHANGELOG.md.
- **Tests:** test_inbound_email (23), test_customer_care (12), test_landing_static (223), test_document_retention (16) - green; `npm run health` green.

## [1.58.16] - 2026-11-04

- **Document storage is spelled out in the legal pages.** Terms section 6, Privacy section 6, Data Deletion section 2, `llms.txt` and the homepage FAQ now state the scope: Saka reads every receipt, logbook, insurance and licence photo; the Free plan keeps only the parsed figures (no original file); paid plans and the welcome trial store the original; and any receipt photo can be deleted from WhatsApp (`receipts` -> `delete receipt N`).
- **Free-tier gate pinned by tests.** `receiptVaultStorage` was already enforced (no bucket upload on Free); `test_subscription_billing` now asserts `freeEnt.receiptVaultStorage === false` and `test_landing_static` (223) guards the new copy.
- **Live-test catch: long sender emails were silently dropped.** `support_tickets.whatsapp_number` was `varchar(20)` on the live database (the staging DDL already used `text`), so any sender email longer than 20 characters failed the ticket insert. `npm run migrate:support-tickets` widens it to `text` (applied live), `handleInboundEmail()` retries with a 20-character trim as a safety net, and `test_inbound_email` covers long senders (20 assertions).
- **Inbound support email is verified in production.** Cloud Run revision `saka-fleet-00271-dn4` carries `EMAIL_INBOUND_SIGNING_SECRET`, so `/webhook/email/inbound` validates Svix signatures (20 assertions green); the legacy shared-secret header path remains as a fallback. Live smoke test: valid signature -> 200 + ticket + care ping; tampered / missing -> 401.
- **Audit:** `REMEDIATION_AUTONOMY=off`, `CONVERSATION_DIAGNOSIS_ENABLED=off`, `SENTINEL_PROPOSALS_ENABLED=off`; zero pending proposals; friction rows recording `PENDING`.
- **Files:** landing/{terms,privacy,data-deletion,index}.html, landing/llms.txt, landing/data/changelog.json, test_landing_static.js, test_subscription_billing.js, scripts/run_support_tickets_migration.js, package.json, SAKA_FLEET_ARCHITECTURE.md, CHANGELOG.md.
- **Tests:** test_landing_static (223), test_subscription_billing (76), test_inbound_email (20), test_document_retention (16), test_sentinel_policy - green; `npm run health` green.

## [1.58.15] - 2026-11-04

- **Production knobs off.** Cloud Run now runs `REMEDIATION_AUTONOMY=off` and `CONVERSATION_DIAGNOSIS_ENABLED=off` (revision `saka-fleet-00267-8f9`), alongside `SENTINEL_PROPOSALS_ENABLED=off`. Sentinel detects only; approved fixes are implemented in a superadmin session.
- **Branding for every asset, not just cars.** The website now leads with cars, trucks, bikes, boats, generators, excavators and EVs across title/meta/OG/Twitter, JSON-LD, hero, a generator engine-hours chat example, stats, features, FAQ (EVs use kWh and km/kWh), terms/privacy summary, the done screen, footer and `llms.txt`.
- **Document pipeline hardening (audit: no decommission needed).** Account wipe now removes stored receipt images too; new `delete receipt <n>` (literal `DELETE` to confirm) deletes a receipt row + image and audits `RECEIPT_DELETED` while the expense stays in the ledger; `RECEIPT_RETENTION_DAYS` (default 0 = keep forever) and `OCR_TELEMETRY_RETENTION_DAYS` (90) drive a daily prune; privacy section 6 states the retention windows.
- **Files:** landing/{index.html,llms.txt,privacy.html}, src/services/{receipts,ocrTelemetry,profileWipe,envAudit}.js, src/routes/whatsapp.js, index.js, scripts/health_audit.js, .env.example, .clinerules, package.json.
- **Tests:** test_document_retention (16), test_ocr_flow (120), test_profile_wipe (14), test_landing_static (217), test_asset_metrics (70), test_country_bucket (54), test_expense_catalog (82), test_env_audit (44) - green; `npm run health` green.

## [1.58.14] - 2026-11-04

- **Duplicate website signups are blocked (and the owner is told).** Typing `0734852529` with `+254` no longer becomes `+2540734852529`; `/api/onboard` matches phone variants AND email, never re-creates an existing account, sends an "already on board" email plus a WhatsApp reminder, and blocks `email_exists` outright.
- **Sentinel detects, never proposes.** New `SENTINEL_PROPOSALS_ENABLED` (default off) gates conversation diagnosis, deep-audit proposal minting and CI plan dispatch. With it off, findings land in `chat_friction_logs` with the associated `error_log_ids`; `admin friction done <id>` marks the point deployed and resolves those errors, so the log clears when tended.
- **Resend inbound email.** support@sakafleet.com mail is verified with the Svix signature (`EMAIL_INBOUND_SIGNING_SECRET`), parsed, body-fetched, stored as a support ticket, pinged to `CUSTOMER_CARE_PHONE`, and listed by `admin inbox` / `admin inbox read <id>`. Replies still relay to the sender WhatsApp.
- **Rules of engagement:** audit before acting on any remediation/proposal; consult `.clinerules` before every plan/act operation.
- **Files:** src/services/{webOnboarding,mailer,inboundEmail,sentinelPolicy,conversationDiagnosis,deepAudit,frictionTracker,superadmin,envAudit}.js, src/workers/{sentinel,remediation}.js, src/routes/whatsapp.js, index.js, landing/assets/js/main.js, .clinerules, .env.example, scripts/health_audit.js.
- **Tests:** test_duplicate_signup (14), test_sentinel_policy (17), test_inbound_email (18), test_deep_audit (28), test_friction_tracker (10), test_conversation_diagnosis (11), test_remediation_pipeline (74), test_web_onboarding (41), test_greetings (110), test_first_message_flow (53), test_superadmin, test_customer_care (12) - green; `npm run health` green.

## [1.58.13] - 2026-11-04

- **Remediation alerts list pending only.** The urgent page no longer fires on raw error volume — it keys on the count of PENDING proposals and lists just those (`REMEDIATION_URGENT_PENDING_THRESHOLD`, default 10; the old `REMEDIATION_URGENT_ERROR_THRESHOLD` is read as a fallback).
- **Unverified gate stops looping (PROP-2026-11-04-01).** A confused/repeat turn ("Huh?", "What?", "Still confused") now gets a short clarification + a HELP-to-human path instead of the identical signup line on repeat.
- **Phantom 90-day trial fixed.** The legacy `profiles.trial_ends_at` default (`now()+90d`) and `subscription_status='TRIALING'` default are gone (`npm run migrate:trial-defaults`); every insert pins `trial_ends_at: null`; the snapshot only shows a trial for a genuine TRIALING account; `npm run remediate:phantom-trials` cleared the one live phantom (+254734852529).
- **Files:** src/workers/remediation.js, src/routes/whatsapp.js, src/services/{greetings,userContextSnapshot,conversationEngine,envAudit,webOnboarding,driverAssignments,trialSchema}.js, scripts/{run_trial_default_migration,remediate_phantom_trials,provision_staging_schema}.js, index.js, package.json, .env.example.
- **Tests:** test_greetings, test_user_data_access, test_remediation_pipeline, test_trial_engine, test_subscription_billing, test_web_onboarding - green; `npm run health` green.

## [1.58.12] - 2026-11-04

- **Zero-vehicle owners aren't asked for a driver licence first.** `buildUserContextSnapshot()` now offers the `driver licence — …` fill step only once the account has a vehicle, so a fresh owner's single next step is the vehicle (not a licence). Removes snapshot noise on "is my profile verified?".
- **Files:** src/services/userContextSnapshot.js, test_user_data_access.js.
- **Tests:** test_user_data_access (20) green.

## [1.58.11] - 2026-11-04

- **Fresh sign-ups are never re-welcomed.** `isFirstContact()` returns `false` for a verified account, so a user who set up on the website and then says "Hi" on WhatsApp is advanced to their first vehicle instead of being welcomed again (live: three welcomes in a row).
- **Verified advances, unverified signs up.** The GREETING lane now gives a verified vehicle-less user one short advance ("You're all set ✅ — what do you drive?"), a verified user with a vehicle a one-line greeting + next step, and unverified numbers the website CTA.
- **English-first, language-aware greeting.** `greetingFor()`/`sakaIntroText()` honour `preferred_language`: an English user (or a known account with no language set) is greeted in English, never "Habari"/"Karibu"; a Swahili user keeps the local greeting; the country default is preserved when there is no profile.
- **Files:** src/services/greetings.js, src/routes/whatsapp.js, test_greetings.js, test_first_message_flow.js.
- **Tests:** test_greetings (103), test_first_message_flow (53), test_agent_training (155) - green.

## [1.58.10] - 2026-11-04

- **Self-documenting superadmin.** `ADMIN_COMMAND_REGISTRY` is the single source of truth; `admin help` is generated from it (never stale). An admin-looking message that matches no command gets a "did you mean…" clarification (2-3 closest commands + a plain-English example); normal chat still falls through.
- **Autonomous customer care.** New `customerCare.js`: classifies a support request, opens a `support_tickets` row, emails support@, and pings the superadmin on WhatsApp for high-priority/refund cases. `POST /webhook/email/inbound` (optional `EMAIL_INBOUND_SECRET`) relays a support@ reply back to the user's WhatsApp. WhatsApp support now creates a ticket too.
- **Driver/trial/coupon/nudge audit:** driver assign→unassign→reassign (1-to-1), welcome-trial capacity + lapse pauses, dunning, follow-ups and contact-nudge all confirmed green.
- **Files:** src/services/{superadmin,customerCare,profileWipe}.js, src/routes/whatsapp.js, index.js, src/services/envAudit.js, .env.example, scripts/health_audit.js, test_customer_care.js.
- **Tests:** test_customer_care (12), test_superadmin, test_update_suggest, test_env_audit, and the driver/trial/coupon/nudge suites - green; `npm run health` green.

## [1.58.9] - 2026-11-04

- **Profile wipe matches every stored phone form.** `wipeProfileForSignup` now deletes `+254...`, `254...`, `0...` and bare 9-digit variants (from both the input and the resolved profile), so chat rows stored without a `+`/`0` are not left behind. (Live: 711 `254734852529` transcripts survived the first pass; now zero.)
- **Ops CLI.** `scripts/wipe_profile.js <phone> [--confirm]` - backup-first, dry-run by default; the headless counterpart of `admin wipe`.
- **Applied:** +254734852529 fully reset for a clean sign-up.
- **Tests:** test_profile_wipe (14) green; `npm run health` green.

## [1.58.8] - 2026-11-04

- **Backend auto-deploys on push.** New `Dockerfile` + `.github/workflows/deploy_cloud_run.yml` (builds from source, `--min-instances=1 --cpu-boost --no-cpu-throttling`). Enable with the `GCP_SA_KEY`/`GCP_PROJECT_ID`/`GCP_REGION` secrets; skips softly while unset. Fixes the frozen live revision (a push previously only sent a WhatsApp alert, never deployed).
- **OTP-gated profile wipe.** `admin wipe <phone>` -> 6-digit code emailed to `SUPERADMIN_EMAIL` -> `admin wipe confirm <code>` wipes the profile + all its data for a clean sign-up (audited `ADMIN_PROFILE_WIPED`).
- **Verified earnings save.** The earnings quick path now checks the insert before saying "Recorded".
- **Post-signup conversion.** The core prompt answers app/pricing questions concisely and nudges a verified, vehicle-less user to set up their first vehicle.
- **Files:** Dockerfile, .dockerignore, .github/workflows/deploy_cloud_run.yml, src/services/{profileWipe,superadmin}.js, src/routes/whatsapp.js, sakaAi.js, test_profile_wipe.js, .clinerules.
- **Tests:** test_profile_wipe (13), test_record_answers (45), test_agent_training, test_product_qa, test_greetings, test_conversation_compliance, test_superadmin - green; `npm run health` green.

## [1.58.7] - 2026-11-04

- **No false "Saved".** The one-line expense save showed "Expense Logged Successfully! ✅ Saved" even on a duplicate, a missing client, or a failed insert (the error was never checked). Success now renders only after a verified `expense_logs` insert; failures say "nothing was written".
- **"Switch to <plate>" works mid-draft** - an explicit switch abandons the open quiz first (no more stuck "how many litres?" or "KES 819" plate-garbling).
- **"Stop" no longer dead-airs** - fixed a TDZ ReferenceError (countryInfo used before its declaration) that left the pause reply empty.
- **Files:** src/routes/whatsapp.js.
- **Tests:** test_record_answers (45), test_v1583, test_entry_ledger, test_edit_delete, test_narrative_draft green; test_reliability Test 3a ("Stop" pause) now passes; `npm run health` green.

## [1.58.6] - 2026-11-04

- **A past-tense expense statement is logged, not answered as a query.** "Repaired a puncture for KAS628T … cost me 300kes" was repeatedly answered "Nothing logged". `parseRecordQuestion` now returns `looks-like-log` for a past-tense verb + amount, and the route logs it (`LOG_EXPENSE`). New shared `looksLikeLogStatement()`.
- **"Pull/show/list … records/entries" is a records query, not a fuel-log flow.** "Pull fuel records for KBJ 819C" no longer starts the fuel quiz.
- **Ambiguous multi-vehicle reads ask which vehicle** instead of silently summing the fleet (only an explicit "all/fleet" aggregates).
- **Files:** src/services/recordAnswers.js, src/routes/whatsapp.js, test_record_answers.js.
- **Tests:** test_record_answers (45), test_v1583, test_entry_ledger, test_edit_delete, test_narrative_draft - green; `npm run health` green.

## [1.58.5] - 2026-11-04

- **Bi-weekly Sentinel deep audit.** New `src/services/deepAudit.js` runs a deterministic code-integrity scan Monday & Thursday at 03:00 Africa/Nairobi (env-gated `SENTINEL_DEEP_AUDIT_ENABLED`, cadence `SENTINEL_DEEP_AUDIT_SCHEDULE`), wired in `index.js` + a manual `POST /api/cron/deep-audit`. Idempotent per Nairobi day via an `admin_audit_logs` run marker.
- **Four checks, zero AI for detection:** mojibake lint, Nairobi-time drift (server-local time + UTC-midnight windows, `new Date(...T00:00:00Z)` weekday math excluded), ledger vehicle-scoping guards, and recurring unresolved `error_logs` by route.
- **Proposal registry, never autonomy.** Each finding mints one deduped `PENDING_APPROVAL` `PROP-*` proposal (`category=deep_audit_finding`, `target_signature=DEEP-AUDIT:<date>:<slug>`) via the new shared `src/services/proposalRegistry.js::nextProposalCode`. `sanitizeFinding` strips governance-protected paths. Nothing executes automatically.
- **Files:** src/services/deepAudit.js, src/services/proposalRegistry.js, index.js, src/services/envAudit.js, .env.example, scripts/health_audit.js, test_deep_audit.js.
- **Tests:** test_deep_audit.js (25 assertions), test_env_audit (44) - green; `npm run health` fully green.

## [1.58.4] - 2026-11-04

- **Mojibake purge.** User/admin WhatsApp strings carried UTF-8 mojibake (driver-activity summary, fleet auto-audit, Sentinel Cloud-Run alert, Horizon blueprint, quiz VIN error/trip hint/summaries). All fixed; a repo sweep confirms zero double-encoded emoji/dash sequences left.
- **No silent crash.** `processIncomingWhatsAppMessage` sends one deterministic recovery line when a turn throws before any reply went out (`replyDispatched` guard).
- **Global + Nairobi auto-audit.** Currency localized via `formatMoney`/`buildGlobalContext` (no more hardcoded KES); all windows/scheduling normalized to Africa/Nairobi.
- **Record-lane scoping.** QUERY_RECORDS scopes to one vehicle via `resolveLedgerVehicleScope`, aggregating the fleet only when ambiguous.
- **Pinned ledger edits.** A pending edit/delete re-fetches the original row by id (`getLedgerEntry`) if it scrolled out of the top-6 list; ledger write helpers re-verify `vehicleIds` (defense-in-depth).
- **Sentinel boundary lock.** `processFrictionPatches`/`refinementIsSafe` reject security-weakening prompts (negation-aware) instead of 5 literal phrases.
- **Meta API + cleanup.** All Graph calls bumped `v17.0`->`v21.0` (incl. OCR default); removed the dead `whatsappRoutes` plugin duplicating /webhook routes.
- **Files:** index.js, src/routes/whatsapp.js, src/services/{entryLedger,quizEngine,superadmin,ocrService}.js, src/workers/sentinel.js, scripts/notify_git_push.js.
- **Tests:** test_agent_training (155), test_entry_ledger, test_edit_delete, test_v1583, test_record_answers, test_conversation_compliance, test_env_audit (44), test_sentinel - all green; `npm run health` fully green.

## [1.58.3] - 2026-11-03

- Cross-vehicle ledger leakage is closed. The editable ledger (list/edit/delete/restore) now resolves a single target vehicle (pending row, then an explicit plate/label/ordinal, then the active vehicle, then the single vehicle) and scopes every query to it - so editing KBJ 819C can never surface or touch a KAS628T record. Mid-edit stays pinned to the row vehicle. When no target resolves the engine asks which vehicle instead of listing the whole fleet.
- One-line plate routing works for live data. matchNarrativeVehicle now reads plate_number and make_model (it previously read only plate/make/model keys, so plate detection was dead for real DB rows), and a one-line log/edit/reminder with several vehicles and no named vehicle asks which vehicle instead of silently defaulting to the active one. A named plate (or a single-vehicle account) still routes instantly.
- Files: src/services/narrativeDraft.js, src/services/entryAnswers.js (resolveLedgerVehicleScope), src/routes/whatsapp.js, src/services/flowKnowledge.js.
- Tests: test_v1583.js (9, new - plate routing, safe gate, live two-vehicle scoping), test_narrative_draft.js (118, +3), test_entry_ledger.js + test_agent_training.js green.
## [1.58.2] - 2026-11-03

- **Instruction/UI labels can never become field values.** New isPollutedFieldValue guard rejects Extra Notes:, Save KBJ as a draft, Change VIN to ..., Financial analysis for KAS and bare confirm/yes/no at the direct-answer, AI-extraction and text-banking paths, so a note or label can no longer overwrite make/model (or any free-text field). Live 2026-11-03: KBJ 819C had make_model = Extra Notes:.
- **make and model now edits the vehicle.** choiceField alias matching normalizes & and / to and, so MAKE AND MODEL maps to the Make / model edit field instead of looping Which field would you like to update?.
- **Corrupted live row fixed.** KBJ 819C make_model corrected from Extra Notes: to Toyota Hiace Van (audited).
- **Tests:** test_v1571 17 (+4).

## [1.58.1] - 2026-11-03

- **Bare-number menu replies no longer loop.** choiceField now maps a bare number to the Nth menu item, and reminderTypeMenu is numbered (1. Oil change - 2. Service - ...), so reply 3 selects Insurance Renewal instead of re-showing the identical Set Reminder prompt (LOOPING_PROMPTS live 2026-11-03). Out-of-range numbers are rejected.
- **Tests:** test_v1571 13 (+3 reminder-numeric).

## [1.58.0] - 2026-11-03

- **The registration confirm no longer loops on a re-sent correction.** During confirmation, a natural field correction (Make and model: TOYOTA HIACE VAN / make is Toyota / insurance expiry: ...) now updates that field and drops its stale duplicate extra note, instead of piling up notes and re-showing the same summary (the TOYOTA/TOUOTA loop, live 2026-11-03). New parseRegistrationFieldCorrection + stripFieldNotes in quizEngine; also applied in the question-phase correction lane.
- **Sentinel now marks its own fixes deployed.** When the micro-rule optimizer mints a saka_dynamic_rules patch from a friction point, the originating chat_friction_logs row is auto-marked DEPLOYED (resolution rule:key), so the friction tracker reflects reality and auto-clears after 4h.
- **Conversation proposals triaged.** PROP-2026-11-03-08 and -09 (both the You deleted the wrong entry diagnosis) closed as DECLINED - already fixed in v1.56.1 (detectLedgerCommand complaint guard).
- **Tests:** test_v1571 10 (+2 field-correction assertions).

## [1.57.1] - 2026-11-03

- **No more phantom Applying trial extension coupon.** The coupon intent no longer fires on a bare yes / yes please / extend (both the sakaAi regex classifier and the whatsapp coupon branch were tightened); only an explicit code (EXT30-...) or verb (apply coupon / redeem coupon / extend trial) triggers it. Copy softened to Checking your coupon...
- **Trial users can actually add vehicles.** (1) Accounts born TRIALING + a future trial_ends_at from legacy DB defaults but with no real trial_sessions row were silently on Free capacity; getEntitlements now resolves the tier from the live trial row and new profiles start explicitly ACTIVE. (2) The welcome trial now runs on growth (5 vehicles) via WELCOME_TRIAL_TIER, so a trial user can explore multi-vehicle (was solo_pro = 1). scripts/reconcile_trials.js started the missing welcome trials (David now gets capacity 5).
- **Superadmin is clean.** scripts/rectify_superadmin_driver.js now also clears the superadmin profile trial/subscription (free/ACTIVE, no trial) - run live.
- **Clear chat / reset chat.** A new confirm-gated clear chat / reset chat / start over command wipes chat_history / chat_transcripts / processed_webhooks and starts fresh - vehicles, expenses, reminders and the plan are untouched.
- **Tests:** test_v1571 8 (health-registered).

## [1.57.0] - 2026-11-03

- **Superadmin can never be a driver (rectified).** The assign-driver flow now refuses a superadmin phone at the write path (`createDriverAssignment`), and a one-time idempotent remediation (`scripts/rectify_superadmin_driver.js`) cancelled the live bad assignment, released any vehicle link and normalised the superadmin profile. Rule 15 / v1.50.0 preserved.
- **Country learning buckets (Uganda is not Italy).** New `country_learnings` table + `src/services/countryLearnings.js`: each country gets its own learning bucket, created on the fly at signup (`ensureCountryBucket`) and populated by the Sentinel refinement pass (`deriveCountryLearnings`). The per-country learnings line rides the jurisdiction context beside the comm-style line, so a Ugandan lesson never leaks into an Italian conversation (GLOBAL stays neutral). `npm run migrate:country-learnings`.
- **Tests:** `test_country_learnings` 9 (health-registered, Kenya/Uganda/Italy separation).

## [1.56.5] - 2026-11-03

- **`admin friction done` accepts a short id.** The tracker list shows an 8-character id; `admin friction done <id>` now resolves any unique prefix to the full uuid (a full uuid still works). No more copy-typing 36 characters.
- **Tests:** `test_friction_tracker` 10 (health-registered); `test_quiz_flow` asserts the 40-message default.

## [1.56.4] - 2026-11-03

- **Friction points are tracked, never lost.** New `src/services/frictionTracker.js` + `npm run migrate:friction` add a PENDING -> DEPLOYED lifecycle to `chat_friction_logs` (`status`, `resolved_at`, `resolution`). A deployed point auto-clears from the active list after 4 hours but the log keeps it forever. Superadmin: `admin friction [pending|deployed|log]` and `admin friction done <id>`.
- **Sentinel diagnosis on target.** `conversationDiagnosis.js` routing map now names the registration-correction, entitlement and active-vehicle entry points, so conversational PROP proposals land on the right file (the 2026-11-03 diagnosis mis-targeted the ledger detector).
- **Whole-conversation memory.** `CHAT_HISTORY_MAX_MESSAGES` (default 40, clamped 20-60) raises the injected history and the in-memory session cap from 10/20 to 40 turns, so Saka remembers the whole chat, not just submitted fields.
- **E.164 friction phones.** Sentinel now normalises `chat_friction_logs.user_phone` to +254 form at write time (bare-254 vs +254 split fixed).
- **Tests:** `test_friction_tracker` 10 (health-registered); `test_quiz_flow` asserts the 40-message default.

## [1.56.3] - 2026-11-03

- **Maintenance-schedule questions answer from your reminders.** "When am I supposed to buy my front tyres?" / "how often should I change the oil?" now route to the reminder lane (deterministic, zero tokens) instead of a generic menu. If you have a matching reminder, Saka cites it exactly (date / km / hours); if not, she says so honestly and offers the one step to track it — she never invents an interval.
- **Tests:** `test_vehicle_compliance` 67 (+5 maintenance assertions).

## [1.56.2] - 2026-11-03

- **Plain-English admin backlog (PROP-2026-11-03-07).** The verified superadmin can now ask "show me [all] pending proposals", "list pending proposals", "pending proposals", "what's pending" (→ pending fixes) or "show me [all] proposals" (→ full backlog) and get the deterministic remediation list — zero tokens. These resolve before the directive gate and in the classifier fallback; bare "admin proposals" still opens the Horizon feature proposals, and the help menu names the new phrasing.
- **Tests:** `test_update_suggest` 43 (+6 plain-English parse assertions, +1 Horizon-unchanged regression).

## [1.56.1] - 2026-11-03

- **"You deleted the wrong entry" is a complaint, not an edit.** `detectLedgerCommand` now returns null when the user attributes a past action to Saka ("you deleted/wrote/logged/recorded…"), so it reaches the complaint-recovery lane instead of being misread as an edit of the last saved entry (live 2026-11-03).
- **The empty record answer reads properly.** `formatRecordAnswer` now names a noun — "no other expenses all time" / "no earnings all time" — instead of the broken "no other all time" seen in the live audit.
- **Tests:** `test_entry_ledger` (+3 complaint guards), `test_record_answers` 36 (+1 noun assertion).

## [1.56.0] - 2026-11-03

- **Existing owners can register another asset.** An owner who already has a vehicle and says "I have another car", "add vehicle", "a second truck" (or "Add car") now starts the real registration quiz again — previously `detectQuizStart` only offered registration when the account had NO vehicle, so those requests produced a plausible-looking paragraph with no quiz state and every follow-up ("Car", the plate, "Ok") was dropped. Capacity and verified email are still enforced at save (`persistVehicleRegistration`), so nothing can over-register.
- **"What's my current mileage?" answers from the vehicle.** New deterministic `src/services/odometerAnswer.js` answers current mileage / odometer / odo-reading / last-update questions from the vehicle's own reading (`current_mileage`, or engine hours for hours-led assets) instead of the expense ledger — the live audit showed all three phrasings returning an expense total or a false "no odometer on file". It parks a non-registration quiz exactly like the record lane.
- **Tests:** `test_odometer_answer` 11 (health-registered), `test_quiz_flow` 142 (+1 existing-owner registration); `test_no_canned_replies` ratchet unchanged (≤4, 1 literal); `flowKnowledge` + core prompt synced (rule 13).

## [1.55.1] - 2026-11-03

- **Sentinel now drafts proposals for conversational mismatches.** When a reply misses the user's ask, Sentinel (flag-gated `CONVERSATION_DIAGNOSIS_ENABLED`, default off) inspects the conversation routing map with the reasoning tier, produces a root cause + minimal change, and saves it as a `PROP-*` proposal (`PENDING_APPROVAL`, category `conversation`) for superadmin review — nothing runs autonomously. A forbidden-path sanitizer keeps the diagnosis away from auth/OTP/VIN/payment/schema/CI/.env.
- **Tests:** `test_conversation_diagnosis` 11 (health-registered), `test_env_audit` 44.

## [1.55.0] - 2026-11-03

- **Conversation working memory.** The submitted-but-**unsaved** draft is now visible to the model: a new `buildConversationMemory()` renders a compact, secret-free block (collected fields as labels, extra notes, the pending field, the active vehicle) and it now rides the conversational-pause path (`quiz_pause_conversation`) instead of the raw answers object — so "what did I already tell you?" is answerable mid-quiz, and OTP/PIN/token never leak into the prompt. No draft → no block → zero cost in idle chat.
- **Tests:** `test_conversation_memory` 11 (health-registered), `test_no_canned_replies` ratchet unchanged.

## [1.54.5] - 2026-11-03

- **Draft corrections are no longer swallowed by the saved-ledger edit.** A "wrong field" correction to an **unsaved** entry (e.g. *"The fuel volume is definitely wrong… amount"*) previously matched the ledger's "natural mistake" rule and answered *"I could not find an entry to change."* `detectLedgerCommand()` now requires a real saved-entry noun, so the correction flows to the confirmation summary instead — while `"I made a mistake on the fuel entry"` / `"wrong amount on my last expense"` still edit saved rows exactly as before.
- **Tests:** `test_entry_ledger` (live-text regression), `test_agent_training` unchanged.
- **Tracked follow-ups:** (a) `"I have another vehicle"` → registration for existing owners; (b) E.164 normalization of `chat_friction_logs.user_phone`.

## [1.54.4] - 2026-11-03

- **Engine-owned patience ladder (the §117 follow-up).** The quiz engine now tracks repeats per step in `quiz.patience`: the **2nd failure on the same field** appends the simplest typed path to the question (country-resolved examples — plate, currency, date, litres, email, phone), and the **3rd+ failure** offers the human lane (`reply Support`). Any progress resets the ladder; nothing is ever blamed or rushed. The core prompt's EVERY-DEMOGRAPHIC LAW names the engine ladder so the composer uses the engine-supplied hints verbatim (rule 13).
- **Tests:** `test_quiz_flow` 141 (full ladder drive with provider keys cleared — deterministic), `test_agent_training` 155.

## [1.54.3] - 2026-11-03

- **Conversational-first completion.** The last 19 canned replies in the WhatsApp route are now composed from facts by `composeMessage` — passbook/onboarding stage prompts, vehicle errors, the VIN-lock invariant, deletion/switch/expense/account outcome cards, earnings/email prompts and cancellation acks — with the old deterministic sentence preserved verbatim as `fallbackText` for provider outages. Only the instant "reading now" ack stays literal: **the no-canned-replies ratchet drops from ≤ 20 to ≤ 4 (1 literal remains).**
- **Conversation compliance harness** (`test_conversation_compliance.js`, the §111 follow-up): persona proof for elderly, low-literacy, angry and Shenglish users pinned by the core-prompt LAWS and tone-compass poles/mirror/floors, plus a plain-language lint over all 32 deterministic fallbacks (no banned phrases, ONE unquoted question, ≤ 28-word sentences after stripping quoted example phrasings). Health-registered, 18 assertions.
- **Tracked follow-up:** the engine-owned patience counter (same-field repeats → simplest typed path → human lane) ships with the next conversation release; the prompt-level EVERY-DEMOGRAPHIC LAW already carries the behavior.
- **Tests:** `test_no_canned_replies` ratchet, `test_conversation_compliance` 18, `test_agent_training` 154, health green.

## [1.54.2] - 2026-11-03

- **Country parsing profiles as plug-in data.** The KE e-TIMS + NTSA parsers moved out of `ocrService.js` into `src/data/ocrCountryProfiles.js` (`getOcrCountryProfile`), and GLOBAL/unprofiled countries resolve to the neutral path (rule 36) — exact parity proven by the existing fixtures. New country profiles are added as modules, never pushed globally.
- **Data-driven resilience loop.** `summarizeOcrCountryRows` / `getOcrCountryProfileStats` / `getOcrCountryWatchlist` turn `ocr_requests` telemetry into the signal for which country profile to write next (min 5 rows; ≥25% unusable or ≥30% low-confidence flags a watch).
- **`admin ocr-profile [CC]`.** Deterministic zero-token per-country digest (reads, unusable, low-confidence, confidence, document kinds, watch verdict + reason), audited `ADMIN_OCR_PROFILE`.
- **Sentinel digest watchlist.** The remediation digest now carries a `🌍 OCR country watchlist` line so the strengthening loop runs on its own cadence.
- **Tests:** `test_ocr_flow` 120.

## [1.54.1] - 2026-11-03

- **Universal OCR normalization (new `ocrNormalizer.js`).** Every OCR value now resolves through one layer: amounts parse BOTH grouping conventions (1,234.56 and 1.234,56) with CLDR locale resolution for ambiguous single-separator tokens and zero guessing on noise; currency detection carries an extended symbol table (฿ ₱ ₩ ₺ R$ KSh …) with longest-symbol-first so `R$` never degrades to `$`; per-country plate patterns (KE/GB/IN/ZA/US/…) validate plate candidates with a neutral GLOBAL shape (rule 36); VINs pass a universal guard; dates always route through `dateParser` country-resolved. A German `TOTAL € / 1.234,56` now prefills 1234.56 — in the lens, the receipt hints and the e-TIMS path.
- **Zero-shot extraction top-up (new `ocrSemantic.js`, flag-gated).** When the deterministic lens misses fields, an `ocr_extraction` background-tier JSON call proposes values for EMPTY slots only; every proposal is re-validated (date → dateParser, amount → normalizer, plate → country pattern, VIN → guard) and anything invalid is dropped. The deterministic lens is always the authority. Kill switch `OCR_AI_EXTRACTION` defaults **off** during the testing phase (env-registered + documented).
- **Purchase-invoice classification fixed.** A strong `PURCHASE INVOICE`/`SALE AGREEMENT`/`SOLD TO` marker now beats the generic INVOICE → `receipt_general` base, so purchase-cost prefill fires again; e-TIMS `Buyer PIN` receipts stay receipts.
- **Prompt sync:** the core prompt's OCR & PHOTOS block names the top-up and locks the deterministic lens as the authority.
- **Tests:** `test_ocr_normalizer` 38 (new, health-registered), `test_ocr_flow` 108, `test_doc_lens` 48, `test_agent_training` 154, `test_env_audit` 44.

## [1.54.0] - 2026-11-03

- **ANSWER LAW v2 — the user's whole record rides the snapshot.** `buildUserContextSnapshot` now carries the recent ledger (last 3 expenses + 3 earnings, with plate, type and Nairobi date) and a `Missing (each has one fill step)` line: every absent field is named with its engine-owned single populate step (insurance expiry → certificate photo or "my insurance expires <date>", inspection, odometer, licence, email). "What did I log yesterday?" and "what do I need to fill?" are answerable from facts in every composed turn.
- **Zero-refusal widening.** The core prompt's OWN-DATA LAW v2 requires the exact figure with local time context and points at the snapshot's Missing line as the only sanctioned populate steps; `I can't see`, `not stored on my side`, `I don't hold that data` and `no record of` join the banned phrases in both the prompt and `SAKA_TONE_COMPASS.bannedPhrases`.
- **Own-data on data-sensitive turns.** New `buildUserFactsLines()` (capped, never throws) attaches the user's facts to the composed complaint-recovery, friction-apology and breaker-trip turns.
- **Tests:** `test_user_data_access` 19, `test_agent_training` 153, `test_kb_docs` 36, `test_no_canned_replies` ratchet unchanged.

## [1.53.2] - 2026-11-03

- **Onboarding/registration fixed end-to-end.** (a) NTSA "REGISTRATION CERTIFICATE" parsing now reads the KE **VEHICLE PARTICULARS** table value-before-label pairs — the **current** plate (`KAS628T DATE OF REGISTRATION`) beats the title-line previous plate, and make/model/body (`TOYOTA`/`LAND CRUISER`/`S.WAGON`), year (`1991`), fuel (`DIESEL`), engine (`1HD-0015769`) and colour are extracted — all gated behind the KE country profile (rule 36; GLOBAL stays neutral). (b) A registration **correction lane**: "you captured the plate wrong" clears + re-asks just that field, and "edit: <field> <value>" sets it without clobbering the other banked answers. (c) The snapshot now answers "is my profile verified?" with the masked email + verified state. (d) "add/register/upload … vehicle/reg cert" routes deterministically to registration.
- **Tests:** `test_ocr_flow` 99 (real NTSA PARTICULARS fixture + GLOBAL no-leak regression), `test_quiz_flow` 131 (correction lane), `test_user_data_access` 9 (verified email).

## [1.53.1] - 2026-11-03

- **Autonomous execution decommissioned.** `remediation_execute` dispatches are permanently refused (`githubDispatch.js`), `.github/workflows/remediation_execute.yml` is deleted, `checkRemediationExecutionRetry` returns `decommissioned`, and `admin accept fix <CODE>` now marks the proposal **APPROVED for review** (`approval_kind: chat_session`) — no nonce, no CI dispatch, nothing runs automatically. Sentinel keeps drafting proposals and digests; implementation happens in superadmin chat sessions (plan → design → act).
- **Single `PROP-*` proposal registry.** Every proposal code is now `PROP-YYYY-MM-DD-NN` — Sentinel fixes, `UPDATE-SUGGEST>`, `admin adopt`, model-update proposals and Sentinel Horizon feature blueprints. `npm run migrate:proposals` re-coded all 8 existing rows (legacy codes preserved in `execution.legacy_code`). `admin adopt` accepts `PROP-*` codes.
- **Tests:** `test_remediation_pipeline` + `test_update_suggest` (37) updated for review-only approvals and PROP- codes; both green.

## [1.53.0] - 2026-11-03

- **Personality v3 (research-backed).** From NN/g's four tone dimensions Saka's position is now locked in the core prompt: casual-warm, always respectful, never sarcastic/irreverent, matter-of-fact with milestone-only enthusiasm, mirror-only humour. From W3C older-user and plain-language guidance: sentences of ~15 words or fewer, everyday words, active voice, "you" address, one idea per line, ONE question per message.
- **Every-demographic law.** Assume nothing about tech skill: on the second struggle offer the simplest path ("or just type the number"); always end with the ONE next step in plain words; never rush or imply a deadline; accept fragments, typos, voice notes and mixed languages without scolding. A matching floor joined `SAKA_TONE_COMPASS.floors`.
- **Tests:** `test_agent_training` (147) asserts both new laws.

## [1.52.1] - 2026-11-03

- **Conversational-first replies.** Every prose reply in the WhatsApp route is now composed by `composeMessage` from facts, with the old sentence demoted to `fallbackText`: the website-signup gate (verified + registration variants), the records-query hint, support escalation, assignment cancellation, OTP dispatch, batch cancellation, the logbook upload invite, the drive nudge (no-plate invariant), the pause confirmation, and the duplicate-receipt reply. Only the instant "reading now" ack stays a literal progress indicator.
- **No-canned-replies ratchet.** New stateless `test_no_canned_replies.js` scans `whatsapp.js` for direct literal user-facing replies and pins the remaining count at ≤ 20 (the quiz outcome cards are the remaining batch, converted in follow-ups) — any NEW canned reply fails the health gate. Registered in the health audit.
- **Tests:** `test_greetings` 94, `test_quiz_flow` 128, `test_web_onboarding` 41, `test_no_canned_replies` (ratchet), all green.

## [1.52.0] - 2026-11-03

- **The user's own data always rides the snapshot.** `buildUserContextSnapshot` now carries every expiry date (per-vehicle insurance + inspection, with days-left/overdue), the driver compliance record (type + expiry), the trial end date with days-left, and the vehicle YOM/VIN — so "when does my insurance expire?" is always answerable from the facts, in both the deterministic compliance lane and the composed `user_data_answer` path.
- **OWN-DATA LAW in the core prompt.** The FACTS block is the user's own data and is theirs to read: give the exact figure; never claim you lack access, can't see, or don't hold it; if a field is genuinely missing, name the exact missing field and offer the ONE step to add it. The access-refusal family ("I don't have access to", "I can't access", "I do not have that data", "that data is not available to me") joins the banned phrases in both the core prompt and `flowKnowledge`.
- **Tests:** new stateless `test_user_data_access.js` (8 — expiry/trial/compliance facts, days-left math, no invented data), registered in the health gate; `test_agent_training` (145) asserts the new law.

## [1.51.11] - 2026-11-03

- **Registration certificates now register vehicles, not receipts.** An NTSA "REGISTRATION CERTIFICATE" (logbook) is routed to vehicle registration: the plate (old `N7200766H` and new `KDA 123A` formats), fuel type, make/model and YOM are read from the certificate and prefill the registration quiz with a deterministic "I read these from your certificate" summary. A pure-digit TRANSFER number is never stored as a VIN.
- **Receipt pipeline is receipt-only.** The duplicate-receipt detector, the "already read this receipt" reply and the receipt vault now fire only for `receipt_fuel`/`receipt_general` — a logbook, insurance or licence upload can never be answered with the receipt-duplicate line.
- **No more empty expenses.** The `log_expense` write path refuses to write without a type and a positive amount ("Logged expense of amount." can never happen again).
- **Clear logbook CTA.** "Can I upload the logbook?" now gets a deterministic YES with the next step instead of a vague AI reply.
- **Git auto-sync (rule 32).** New `scripts/sync_origin.js` wired as `prehealth`/`pretest` — every `npm run health`/`npm test` first fast-forwards `main` to `origin/main` (skipped in CI), so local work can never start on a stale tree after an autonomous push.
- **Tests:** `test_ocr_flow` (+5 NTSA fixture, date-stable duplicate fixture; 93), `test_greetings` (+3; 94), `test_quiz_flow` (128).

## [1.51.10] - 2026-11-03

- **Interactive quick-edit payload builder (SUG-2026-11-03-01, clause 7 only).** An audit of the approved suggestion found six of its seven clauses already shipped — Document Lens field-level confidences + confirm-before-save (§52), COMMENCING-vs-EXPIRING insurance disambiguation (`ocrService.js`, `complianceCatalog.js`), deterministic compliance correction ("you read it wrong … expiry is …"), PDF report email (`deliverReportPdf` → `sendReportByEmail`) and on-demand vehicle summaries (`buildVehicleSummary`/`emailVehicleSummary`) — so they were deliberately NOT re-implemented. The only real gap was WhatsApp interactive messages: `grep -ri interactive src/` returned nothing and the sender only emits `type:"text"`.
- **New pure module `src/services/interactiveReply.js`.** `buildInteractiveReply()` renders a Cloud API interactive payload — reply **buttons** for 1-3 actions, a **list** for 4-10 — and always returns a `fallbackText` so callers without button support degrade to plain text. `buildReplyButton()` / `resolveQuickEditButtonId()` map a button id back to the operator a user would have typed, so quick edits reuse live grammar (`my entries`, `edit vehicle`, a typed correction) instead of duplicating it. Existing whitelists only (`edit_vehicle_fields`, `sanitizeEntryUpdate`); `INTERACTIVE_LOCKED_FIELDS` refuses `vin`, `qr_passbook_token`, vehicle, driver, user and entry date, so a VIN button can never be produced or resolved (rule 8). Never throws.
- **Not wired to the wire by design.** The sender still sends `type:"text"` — emitting interactive objects needs the buttons registered and tested on the Meta WABA, and shipping them blind from a headless run would risk dead buttons for live users.
- **Superadmin lane:** `admin quick-edit` (also `admin quick edit` / `admin quickedit preview`) → `ADMIN_QUICK_EDIT_PREVIEW`, rendered by `formatQuickEditPreview()` and audited as `ADMIN_QUICK_EDIT_PREVIEW`; deterministic, zero AI tokens, listed in `formatAdminHelpReply()`.
- **Deliberately excluded:** a literal `trial status` command — `subscription` already answers it deterministically. A new phrase matcher would need `flowKnowledge.js` + the Saka core prompt + role index + docs in the same commit (rule 13), and the core prompt is off-limits for this run (rule 18).
- **Intents/flows unchanged** (`SAKA_INTENTS` 42, `SAKA_QUIZ_FLOWS` 21) — this is an operator-rendering utility, not a new classifier lane.
- **Tests:** `node scripts/run_tests.js test_agent_training.js` green before and after.

## [1.51.9] - 2026-11-03

- **Cloud Run deploy noise stays out of Sentinel.** Protobuf `AuditLog` byte arrays are decoded with printable-run extraction (recursive, bounded 3 passes), a new `CLOUD_RUN_ROLLOUT_NOISE_RE` family (probe failures, Ready condition, instance-not-started, CANCELLED) plus a widened `DEPLOY_NOISE_RE` (Ready/Waiting-for-revision) classify rollout lifecycle records as noise on both raw and decoded text; `scanCloudRunAnomalies` fingerprints incidents on the decoded text so a successful rollout never raises `SYSTEM_ERROR`. `sentinelCloudLogs.fetchCloudRunLogs` classifies payloads at the source and exports `isRolloutLifecycleEntry`.
- **Completeness complaints get the finished answer.** `isIncompleteReplyComplaint` widened (cut off / only half / where is the rest / finish your answer / …) and a shared `replyContinuationRequestFor()` parses the fleet count in one place; the reply-quality branch is now currency-agnostic (USD treated like localized accounts) and, when the composer stops at the cap, sends the deterministic facts instead of a truncated sentence. New `complaint_recovery` AI purpose + `isOutputCappedStop()` (max_tokens | length); slow-turn acks never fire after the first outbound reply; Sentinel detects the cut-off vocabulary as `INCOMPLETE_REPLY`; the core prompt + flowKnowledge carry the COMPLETENESS rule.
- **Tests:** `test_greetings` (+6), `test_turn_ack` (+1), `test_anthropic_payload` (+4 `isOutputCappedStop`).

## [1.51.8] - 2026-11-03

- **Vehicle registration is website-only end-to-end.** Removed the `owner_email` and `otp` steps from the WhatsApp `vehicle_registration` quiz — the verified profile email (`profiles.email`, set during web signup) is now used directly by `persistVehicleRegistration` for the vehicle record, profile sync and passbook email. The legacy `onboarding.js` path also skips the chat email/OTP step when the profile is already `email_verified`. Synced `flowKnowledge.js`, `SAKA_TRAINING.md` and the architecture flow table (rule 13).
- **Tests:** `test_quiz_flow` (registration now asserts no email/OTP), `test_web_onboarding`, `test_agent_training` all green.

## [1.51.7] - 2026-11-02

- **Document turns can no longer die silently.** The Document Lens parsing (field/hint extraction) is now best-effort: a crash degrades to the raw OCR text instead of killing the turn, and `recordOcrRequest` now writes its telemetry row BEFORE the crash-prone parsing (using the safe `classifyOcrDocument` classifier) so a dead turn is still diagnosable. Fixes the live 2026-11-02 logbook turn that died on `toUpperCase of undefined`.

## [1.51.6] - 2026-11-02

- **Unverified numbers no longer run OCR.** The unverified gate now applies to media turns too: a number whose profile is not `email_verified` gets the website-signup line immediately, before the "Reading your photo" ack and before any Meta download or Vision call — fixing the "ack without follow-up" case where an unverified user sent a logbook and got silence.
- **Tests:** `test_web_onboarding` (media-gate source assertion).

## [1.51.5] - 2026-11-02

- **Unverified numbers are hard-gated.** A single early gate in the WhatsApp route now short-circuits EVERY message from a number whose profile is not `email_verified` to one short website-signup line — no intro, no product answers, no menus, no registration — until web signup completes. This supersedes the v1.51.4 per-branch greeting checks (kept as harmless defense-in-depth).
- **Tests:** `test_web_onboarding` (+1 source-level gate assertion), `test_first_message_flow` now runs against a verified profile.

## [1.51.4] - 2026-11-02

- **Unverified numbers are no longer invited to register a vehicle.** The first-contact greeting, the AI welcome and the default reply now branch on `email_verified`: an unverified number gets a website-signup CTA (`sakaIntroText` with `websiteSignupNextStep()`), never "what do you drive?" — vehicle registration stays gated behind website signup.
- **Tests:** `test_greetings` (+3 unverified-greeting assertions).

## [1.51.3] - 2026-11-02

- **FEAT adoption (`admin adopt <FEAT-code>`).** A Sentinel Horizon feature blueprint can now be promoted into the autonomous remediation pipeline: `admin adopt FEAT-…` captures it as a `SUG-*` work order (`category: update_suggest`, title + technical_spec as the overview, `PENDING_APPROVAL`) and marks the FEAT `adopted`; the superadmin then reviews and approves with the existing `admin accept fix SUG-…` — nothing runs until approved. `admin accept fix FEAT-…` now points to `admin adopt` instead of a dead end.
- **Tests:** `test_update_suggest` (+6: parse, capture, dedupe, adopt hint).

## [1.51.2] - 2026-11-02

- **FEAT-* approval dead-end fixed.** `admin accept/decline/modify fix FEAT-…` (and `Status of FEAT-…`) now return a clear "review-only blueprint" reply instead of `⚠️ Unknown proposal` — Sentinel Horizon feature proposals are a backlog, not autonomous code changes.
- **Tests:** `test_update_suggest` (+3 FEAT review-only assertions).

## [1.51.1] - 2026-11-02

- **Short links enabled.** `SHORT_LINK_DOMAIN_READY=on` + `PUBLIC_APP_URL=https://app.sakafleet.com` are now set in Cloud Run and documented in `.env` / `.env.example`. The `/r/__saka_probe__` route was verified live (HTTP 200 + `x-saka-shortlink`), so report PDF and checkout links now ship as `https://app.sakafleet.com/r/<code>` instead of the long Supabase storage URL.

## [1.51.0] - 2026-11-02

- **Unified superadmin backlog.** New `admin backlog` lists autonomous remediations (`FIX-*` / `SUG-*`) and Sentinel Horizon feature proposals (`FEAT-*`) in one deterministic, grouped view with `pending|deployed` filters; the `admin proposals` footer no longer points at a non-existent `admin approve [code]` (feature blueprints stay review-only).
- **Gentle website signup push.** A returning unverified WhatsApp user (no `email_verified`, no vehicle) now gets a short, rotating website nudge instead of a repeated full intro — the welcome is never re-sent once the conversation has history.
- **Website changelog caught up.** `landing/data/changelog.json` now tracks `1.51.0` (was stuck at `1.47.0`), and `test_landing_static` asserts `latest === package.json` to prevent drift.
- **Tests:** `test_update_suggest` (+3 parse assertions), `test_landing_static` (+1 drift guard), `test_greetings`, `test_superadmin` green.

## [1.50.1] - 2026-11-02

- **Homepage "What's new" changelog removed.** The changelog feed now lives on `/status` only; the homepage footer "Changelog" link points to `/status`, and `main.js` no longer fetches `/data/changelog.json`.
- **`PREMIUM_MODEL_ENABLED=on`** (operator decision): Tier-2 Sonnet now activates for trial/paid users' escalated + prose turns; free stays Tier-1 Haiku.
- **Tests:** `test_landing_static` green.

## [1.50.0] - 2026-11-02

- **True two-tier AI routing.** Tier-1 (router/everyday conversation) now runs on Claude Haiku (`AI_MODEL_TIER_1_ANTHROPIC=claude-haiku-4-5`, new `DEFAULT_ANTHROPIC_TIER1_MODEL`), decoupled from Tier-2 (Sonnet). Tier-2 (`PREMIUM_MODEL_ENABLED=on`, trial/paid only) stays on `claude-sonnet-5-5`. The Anthropic payload builder now only sends the `thinking` block for Sonnet/Opus models (Haiku rejects it with HTTP 400).
- **Superadmin-only.** The superadmin phone is now Superadmin-only: it never resolves to Owner/Driver roles, non-admin messages get the admin hub (no fall-through), and it can never be assigned as a driver.
- **Tests:** `test_model_router` (+Tier-1 Haiku assertions), `test_superadmin`, `test_subscription_billing`, `test_phase2_analytics`, `test_driver_assignment_gate` green.

## [1.49.6] - 2026-11-02

- **Superadmin remediation view — pending vs deployed.** `admin remediations` now groups proposals into ⏳ Pending / 🚀 Deployed / ⛔ Declined sections (limit raised to 30), and `admin remediations pending` / `admin remediations deployed` filter deterministically (zero tokens). The chosen filter is audited.
- **Tests:** `test_update_suggest` (+5 assertions), `test_superadmin` green.

## [1.49.5] - 2026-11-02

- **Website signup is mandatory before registration/trial.** Added defense-in-depth guards in both vehicle-registration write paths (`quizEngine.persistVehicleRegistration` and legacy `onboarding.saveVehicleAssetRecord`) so an email-unverified account can never register a vehicle or start the welcome trial. The WhatsApp registration gate now clears stale legacy-onboarding state on redirect and no longer requires an empty `onboardingStore`.
- **Removed legacy WhatsApp auth endpoints.** `POST /api/auth/whatsapp/request` and `/api/auth/whatsapp/verify` (which set `email_verified: true` without the website) are deleted.
- **Tests:** `test_web_onboarding` (+3 source-level assertions).

## [1.49.4] - 2026-11-02

- **English-first welcome + language switch.** The proactive welcome (Meta template `web_signup_welcome` and its plain-text fallback) now greets in English and invites the user to reply in their preferred language. When a user replies in another language, Saka confirms the switch ("Language changed to X — reply English to switch back") instead of silently auto-switching. Synced in the core prompt (rule 13).
- **Tests:** `test_greetings` (+6 language assertions), `test_agent_training` (+1).

## [1.49.3] - 2026-11-02

- **Signup conversion tracking + cookie gate.** A successful website signup pushes a `successful_signup` dataLayer event (`signup_method: 'website'`), ready for a GTM Custom Event trigger → GA4 `sign_up` + Meta `CompleteRegistration`. The signup flow also requires a cookie choice (Accept all or Reject non-essential) before the account is created — analytics stays opt-in and signup is never blocked on tracking.
- **Tests:** `test_landing_static` (+3 assertions).

## [1.49.2] - 2026-11-02

- **Website-only signup + OTP.** Removed the in-chat web-signup OTP fallback ("Already signed up? Reply with your 6-digit code here" and the bare 6-digit-code verifier). Signup and email verification now happen on sakafleet.com only — Saka never invites or accepts a code in WhatsApp. Synced across the core prompt, `flowKnowledge`, the composer and `webOnboarding.js` (rule 13).
- **Clean-slate coverage.** `web_onboard_otps` is now in the global `TRUNCATE` and the targeted phone cascade, so a fresh-onboarding reset clears signup OTP sessions too.
- **Tests:** `test_web_onboarding` (fallback removed), `test_agent_training` (+1), `test_db_reset_scope` (+1), `npm run health` green.

## [1.49.1] - 2026-11-02

- **Regression fix — superadmin bounced to the website.** The v1.49.0 registration gate now exempts the superadmin phone, so a non-`admin` message (e.g. "Status of FIX-…") falls through to normal conversation instead of the website-signup redirect.
- **Natural-language fix status.** `Status of FIX-<code>` (and a bare `FIX-<code>` / `admin FIX-<code>`) now returns that proposal's status/title/risk from `remediation_proposals` via a deterministic `ADMIN_REMEDIATION_STATUS` handler, audited as `ADMIN_REMEDIATION_STATUS`.
- **Tests:** `test_update_suggest` (+5 assertions), `test_superadmin`, `npm run health` green.

## [1.49.0] - 2026-11-02

- **Point of entry is now the website.** First-contact greetings, newcomer/repeat nudges and the "how to use" answer lead with `https://sakafleet.com` ("Get Started Free") instead of "Reply REGISTER". The WhatsApp `vehicle_registration` quiz only proceeds once the profile is `email_verified`; otherwise Saka redirects to the website (with the 6-digit-code fallback). Synced across `flowKnowledge.js`, the core prompt, the composer, `productQa.js` and `greetings.js` (rule 13).
- **Google Tag Manager on the landing site (consent-gated).** `GTM-TGR68X2X` loads only after an explicit analytics opt-in; the Meta Pixel is configured inside GTM (no standalone snippet). The cookie banner, settings panel, privacy policy §11 and `llms.txt` now describe opt-in analytics, and the consent key is bumped to v2 so existing visitors must re-consent.
- **Targeted reset now clears owner_id-keyed rows.** `scripts/reset-db.js --phone` also deletes `subscriptions`, `trial_sessions` and `usage_counters` by `owner_id` before the profile row is removed (previously orphaned).
- **Tests:** `test_greetings` (83), `test_agent_training` (141), `test_product_qa` (152), `test_landing_static`, `test_db_reset_scope` (82) all green.

## [1.48.0] - 2026-11-02

- **`UPDATE-SUGGEST>` — superadmin update suggestions (Model A).** Only the verified `SUPERADMIN_PHONE` can send `UPDATE-SUGGEST> <free text>` from chat; it captures a `remediation_proposals` row (`SUG-YYYY-MM-DD-NN`, category `update_suggest`, status `PENDING_APPROVAL`) with an `ADMIN_UPDATE_SUGGEST` audit row. Nothing runs until the superadmin approves via the existing `admin accept fix <CODE>`; the CI execution gate adds a light keyword/path guard for free-text suggestions, Cline interprets the suggestion at execution time, and the post-edit forbidden-path guard still applies. Listed in `admin remediations` and the admin help.
- **WhatsApp delivery receipts (`message_status`).** The webhook now acknowledges `value.statuses` events: every `sent/delivered/read` receipt is logged, and a `failed` receipt is persisted to `error_logs` (route `/webhook/whatsapp/status`) so Sentinel's scan can surface undelivered proactive messages — previously send failures were invisible.
- **Build-notification diagnosis (v1.48.0).** Deploy alerts to the Superadmin were not arriving while normal chats worked: the token and phone number were verified healthy (Meta returns message IDs), `system_config.last_deployed_revision` was stuck at `saka-fleet-00187-xh2` (no new Cloud Run revision had booted, so the "Saka is LIVE" alert never fired), and free-form (non-template) deploy messages fail silently outside Meta's 24-hour customer-service window with no delivery tracking. Operator follow-ups: redeploy Cloud Run, verify the `Deploy & Push WhatsApp Notification` Actions workflow, and (recommended) approve a Meta template for deploy alerts.
- **Tests:** `test_update_suggest` (15 assertions — parsing, superadmin gating, delivery-receipt webhook, capture, suggestion gate), `test_remediation_pipeline`, `test_superadmin`, `test_meta_signature` all green.

## [1.47.0] - 2026-11-02

- **Language fix — never greet in Swahili uninvited.** Web signup now captures the visitor's browser language and stores it as `preferred_language`; when no preference is set, Saka defaults to English — never the country's default language. The core prompt now says "default to ENGLISH — never the country's default language".
- **Tests:** `test_web_onboarding` (+3 language-capture assertions), `test_landing_static` (signup polish).

## [1.46.0] - 2026-11-02

- **FX ratchet (maximise revenue, protect the downward case).** `getEffectiveExchangeRate()` now uses a one-sided ratchet: the effective rate never falls between monthly re-anchors (a weaker USD no longer lowers the local price), and a >=2% strengthening ratchets up immediately. The pure `applyRateRatchet()` is shared by billing and the landing refresh.
- **META welcome template.** `META_WELCOME_TEMPLATE_NAME=web_signup_welcome` is now Active; set in Cloud Run (redeploy the backend to activate).
- **Tests:** `test_product_qa` (+5 ratchet assertions).

## [1.42.0] - 2026-11-02

- **Template contract hardened.** The proactive welcome now ALWAYS sends the `{{1}}` first-name body parameter (fallback "there") so an approved `web_signup_welcome` template can never break on a nameless profile.

## [1.40.0] - 2026-11-02

- **Saka messages first:** on verification, the backend sends the welcome via the approved `META_WELCOME_TEMPLATE_NAME` template when configured, otherwise attempts a plain-text WhatsApp welcome (24-hour window).
- **Sentinel watches website signups:** every onboard/verify/resend failure is persisted to `error_logs` (Sentinel's 60 s scan + 15-min synthesis) and repeated signatures raise `backend_incidents`; expired OTP sessions are pruned at boot and every 15 minutes.
- **Saka training reinforced (rule 13):** `flowKnowledge` gained the `SAKA_WEB_ONBOARDING_PLAYBOOK` section (injected into the core prompt), the WEB SIGNUPS directive updated, `conversationEngine.WEB_SIGNUP_NOTE` synced, knowledge docs regenerated.

## [1.39.3] - 2026-11-02

- **New accounts are explicitly Free.** The live `profiles` schema carries a legacy `subscription_tier` default of `SOLO`, which the entitlement engine normalizes to `solo_pro` — and with a null status that resolves to ACTIVE, granting paid access to brand-new signups. Both creation paths (web onboarding + WhatsApp first-contact) now insert `subscription_tier: 'free'` explicitly; the welcome trial still upgrades the account at vehicle registration exactly as before (rules 23-26).
- **Live E2E proof:** the full web handshake ran against production — `POST /api/onboard` → OTP row → `POST /api/onboard/verify` → `email_verified=true`, no trial row, explicit Free tier — and every test row was deleted afterwards (rule 10).

## [1.39.0] - 2026-11-01

- **Web onboarding handshake.** New `POST /api/onboard`, `/api/onboard/verify`, `/api/onboard/resend` backed by `src/services/webOnboarding.js` + the idempotent `public.web_onboard_otps` table (`npm run migrate:web-onboard`, boot-ensured). Strict payload gate, 10-minute OTP TTL, 3-attempt lockout, 60-second resend cooldown, audited profile flip (`email_verified=true`) and — per rule 26 — the welcome trial is NEVER started at web signup. Optional `META_WELCOME_TEMPLATE_NAME` fires a business-initiated welcome on verification; a bare 6-digit code from a registered-but-unverified user (never during a quiz/onboarding/OTP/PIN phase) verifies their web code in chat.
- **Odometer policy (research-backed).** Is a mileage reading necessary for every submission? No — the catalog now declares `odometerMode` per type: full-tank fuel fills REQUIRE the odometer (Skip is refused; it anchors the km/L math), top-ups/Charging/service events ask with Skip allowed, and Parking, Tolls, Fines, Washing, Insurance, Accessories, Subscriptions, Towing, Wages, Mooring, Bodywork and Other are never asked. Hours-led assets (machines, generators, boats) substitute the engine-hours meter, stored in the entry notes. Enforced in `quizEngine.expenseReadingFields()` and synced through `flowKnowledge`, the core prompt and the composer (rule 13).

## [1.38.0] - 2026-11-01

- **One message, several records (D4).** "yesterday I filled 40L for 5500 at Shell and paid 300 for parking" becomes a numbered plan card — *1 ✅ Save all · 2 ✏️ Edit one · 3 ❌ Cancel* — rendered deterministically, zero AI tokens.
- **Every row goes through the normal write path.** SAVE ALL runs each draft through the same quiz engine write as a single record (dedupe guard, trial activation, retro `created_at`), and the reply reports exactly how many rows were saved — never a blanket "done".
- **Honest splitting.** `buildNarrativeParagraphDrafts()` splits on sentence breaks and on an "and" between two amount-bearing parts; a single additive line ("brakes 4,500 plus labour 2,500") stays ONE record; a chunk that cannot be pre-filled safely is rejected rather than guessed; and a chunk without its own date simply has none.
- **A 15-minute batch state** (`session.narrativeBatch`, same TTL pattern as the editable ledger) owns SAVE ALL / edit N / cancel; a fresh single-record line always outranks a stale batch.
- **Wiring fix (v1.34 carry-over):** the route's quiz call now passes the narrative `aiExtracted` (deterministic fields + `_narrative` extras) instead of the raw AI extraction — retro dates and pre-fills now genuinely ride through in production, matching the unit-tested contract.
- **Files:** `src/services/narrativeDraft.js` (+`buildNarrativeParagraphDrafts`, `renderNarrativeBatchCard`, `resolveNarrativeBatchTurn`), `src/routes/whatsapp.js` (batch lane + prefill fix), `sakaAi.js`, `src/services/flowKnowledge.js`.
- **Tests:** `test_narrative_draft` (**115** — split/keep-together fixtures, per-chunk dates, batch card + turn resolver + TTL, live SAVE-ALL round-trip writing two rows; cleans its own rows).
- **This completes the Narrative Interaction Engine roadmap:** v1.34 intake → v1.35 draft cards → v1.36 record answers → v1.37 corrections 2.0 → v1.38 multi-record.


## [1.37.0] - 2026-11-01

- **Corrections are one honest operation: delete & re-log (D1).** `relogLedgerEntry()` replaces the in-place edit: the old row is hard-deleted with its full snapshot audit, a **fresh** row carries the corrected values while keeping the original entry date (`created_at` rides the fresh insert, exactly like the v1.34 retro-date rule), and the engine audits `LEDGER_ENTRY_UPDATED` with `via: 'relog'` + `old_entry_id`/`new_entry_id`.
- **The restore collision is fixed.** `markDeletedEntryRelogged()` stamps the superseding row's id into the DELETE audit row (`details.relogged_entry_id`), and `restoreLastDeleted()` skips consumed rows — so `restore` after a correction returns "nothing to restore" instead of resurrecting a duplicate of the corrected row. A plain delete still restores for 30 minutes exactly as before.
- **Copy tells the truth.** `formatEntryRelogged()` renders "Entry corrected — the old row was removed and the corrected one re-logged" with the same before → after diff; VIN, plate, user, vehicle and the entry date remain permanently locked (rule 8/37), and blocked attempts still report the locked fields.
- **Files:** `src/services/entryLedger.js` (+`relogLedgerEntry`, +`markDeletedEntryRelogged`, restore consumed-filter), `src/services/entryAnswers.js` (+`formatEntryRelogged`), `src/routes/whatsapp.js` (edit-apply branch now re-logs), `sakaAi.js`, `src/services/flowKnowledge.js`.
- **Tests:** `test_entry_ledger` (live round-trip rewritten: relog → old row gone, fresh row + date preserved, restore blocked; copy checks; cleans its own rows), `test_agent_training` (playbook + prompt carry the re-log rule).
- **Still deferred:** multi-record paragraphs (v1.38.0).


## [1.36.0] - 2026-11-01

- **Your records answer back.** `QUERY_RECORDS` (the 42nd intent) turns questions like "how much did I spend on fuel last week?", "what did I log yesterday?", "average spend per fill in October" and "how many fills this month?" into deterministic ledger answers — sums, counts, averages and lists read straight from `expense_logs` / `private_earnings`. Zero AI tokens: a figure can never be invented.
- **Date ranges stay in the parser (rule 36).** New `resolveDateRange()` in `dateParser.js`: yesterday, last Friday, last week (trailing 7 days), last N days/weeks/months, this/last month, this year, "in October" (with year rollback), and "from 1 Oct to 15 Oct" — endpoints country-resolved (DD/MM vs MM/DD), ends clamped to today, width capped at two years.
- **Catalog-aware types.** The question's own words resolve expense types through the shared catalog ("fuel" → Fuel, "parking" → Parking, "tyres" → Tyres); "my earnings last month" flips to the earnings ledger; an explicit plate is captured for future scoping.
- **Plain, localized answers.** `formatRecordAnswer()` renders Ksh/$, litre totals, record counts, 6-row lists with "…and N more (reply *my entries*)", multi-vehicle scope lines and an honest "Nothing logged" when the period is empty.
- **Route lane with the same guards as the ledger.** The QUERY_RECORDS lane runs only outside PIN/OTP phases, parks (never destroys) an abandoned draft, and an unparseable records question gets a deterministic nudge instead of an AI answer.
- **Files:** `src/services/recordAnswers.js`, `src/services/recordQuery.js` (new); `src/services/dateParser.js` (+`resolveDateRange`), `src/routes/whatsapp.js`, `sakaAi.js` (schema + rule + QUERY RECORDS prompt block), `src/services/flowKnowledge.js` (intent 42 + playbook), `scripts/health_audit.js`.
- **Tests:** `test_record_answers.js` (**35**, new — parsing, country-resolved ranges, rendering, live seeded-ledger round-trip with cleanup), `test_agent_training` (**133**).
- **Still deferred:** corrections 2.0 (v1.37.0), multi-record paragraphs (v1.38.0).


## [1.35.0] - 2026-11-01

- **Draft Cards: the pre-fill you can see before you save.** A narrative draft now confirms through an engine-rendered card — Vehicle · Type · Amount · Volume · Fill · Odometer · When · Place — with quick actions *1 ✅ Save it · 2 ✏️ Change something · 3 ❌ Cancel*. Zero AI tokens: the card is rendered deterministically and re-rendered live after any correction ("Updated: Amount spent" then the fresh card).
- **Corrections never leave the card.** Action 2 asks which field to fix and the next message ("amount 4,800", "type Parts", "40 litres") updates the card in place; action 3 cancels with nothing written; action 1 saves through the exact same audited write path as before (retro dates still land in `created_at`).
- **The fastest path still wins.** For narrative drafts, unanswered optional fields (notes, earning type, period) are skipped so the card — not a questionnaire — is the first thing the user sees.
- **Narrative eligibility threshold (D5).** Narrative intake engages only when the message is shaped like a story: ≥40 chars, at least one sentence break, or a narrative marker (past-date word, `@` price, fill word, measurement, `at <Proper noun>`). Bare one-liners like "fuel 2000" keep the instant paths.
- **Files:** `src/services/quizEngine.js` (`renderNarrativeCard`, card confirm path, quick actions 1/2/3 in `isYes`/`isNo`/`handleConfirmation`), `src/services/narrativeDraft.js` (`isNarrativeEligibleText`, `kind` in extras), `src/routes/whatsapp.js` (threshold guard), `sakaAi.js`, `src/services/flowKnowledge.js`.
- **Tests:** `test_quiz_flow` (**128**, +16 — card rendering, quick actions 1/2/3, retro-date save through the card), `test_narrative_draft` (**100** — eligibility threshold, kind extras), `test_agent_training` (**130**).
- **Still deferred:** record answers + `QUERY_RECORDS` (v1.36.0), corrections 2.0 (v1.37.0), multi-record paragraphs (v1.38.0).


## [1.34.0] - 2026-11-01

- **One sentence is a whole record now (Narrative Intake).** "spent 5500 on diesel yesterday at Shell, 40L at 50350km, full tank" is parsed deterministically — zero AI tokens — into amount, expense type, volume, fill type, odometer, vendor, per-litre price and the stated past date, then pre-fills the existing quiz and saves on the usual confirmation. `NARRATIVE_INTAKE` is the kill switch (default on).
- **The money never guesses.** `src/services/moneyLexicon.js` classifies every number in the sentence: unit-suffixed numbers are measurements (40L, 50350 km), bare 6-digit integers are odometers, 4-digit model years are years, counts stay counts, per-litre prices (`@227`) are separated from the spend, and additive words ("and", "plus", "total") combine or total line items. Without a marker the draft is flagged ambiguous and Saka asks — the engine never invents a figure.
- **Retro dates land in `created_at`.** `extractPastDatePhrase()` (in `dateParser.js`, rule 36) resolves yesterday / last Friday / 3 days ago / 28/10 — country-resolved DD/MM vs MM/DD — and the quiz writer sets `created_at` on the **fresh insert** only (no DDL, edits never touch the date). Future dates are dropped and two different days in one message ask "which day?" instead of silently picking one.
- **Country-aware throughout.** Currency, locale, gallons→litres, miles→km and date conventions come from the E.164 country; a plate mentioned in the sentence is masked before number parsing so "KCB 456B" never reads as an amount.
- **Deterministic wins, always.** Narrative fields overwrite nothing after AI output is merged — the deterministic draft is the authority (`narrativeDraftFields()` spread last), and `test_narrative_draft` proves it with a hostile AI guess.
- **Files:** `src/services/moneyLexicon.js`, `src/services/narrativeDraft.js` (new); `src/services/dateParser.js` (+`extractPastDatePhrase`), `src/services/quizEngine.js` (narrative extras + retro `created_at` writes for expenses and earnings), `src/routes/whatsapp.js` (narrative branch), `sakaAi.js`, `src/services/flowKnowledge.js`, `scripts/health_audit.js`, `.env.example`.
- **Tests:** `test_narrative_draft.js` (**91**, new — determinism corpus + live retro-date round-trip that cleans its own rows).
- **Still deferred:** draft cards (v1.35.0), record answers + `QUERY_RECORDS` (v1.36.0), corrections 2.0 (v1.37.0), multi-record paragraphs (v1.38.0).


## [1.33.0] - 2026-11-01

- **The ledger is editable at last.** `my entries` prints the last six rows (expenses + earnings) numbered, newest first. `edit 2` opens that row, `delete 2` shows it and waits for the literal word `DELETE`, and `restore` brings the last deletion back for 30 minutes. Every step is deterministic — zero AI tokens, no improvising.
- **Only the right fields move.** `sanitizeEntryUpdate()` is the wall: expense → `expense_type, amount, fuel_liters, fill_type, odometer_reading, notes`; earning → `earning_type, amount, notes`. VIN, plate, vehicle, driver, user and the entry date are permanently locked (same doctrine as the vehicle, rule 8) and every attempt is reported back as "locked or invalid".
- **A before → after diff the user can trust.** `formatEntryDiff()` prints `- Amount: Ksh 4,500 -> Ksh 4,800`, then the corrected row and a "reports and totals use the corrected figure right away" confirmation. Nothing is claimed unless the database write returned OK.
- **Deletion is reversible without DDL.** `deleteLedgerEntry()` snapshots the full row into `admin_audit_logs` (`LEDGER_ENTRY_DELETED`, with `restore_until`) and then hard-deletes; `restoreLastDeleted()` re-inserts that snapshot with its original id inside the 30-minute window, and a second restore cannot duplicate the row. Edits are audited as `LEDGER_ENTRY_UPDATED` (before + after) and restores as `LEDGER_ENTRY_RESTORED`.
- **One natural-language pass, many corrections.** `parseEntryEditRequest()` understands `amount 10,500 kes`, `the amount should be 4,800`, `type parts`, `change the type from repairs to parts`, `odometer 50,350`, `42 litres, full tank` and `notes: …` — in a single message, with the expense type canonicalised through `resolveExpenseType()` (one catalog, rule 23).
- **An abandoned edit prompt can never eat a real log.** `resolveLedgerTurn()` owns a 15-minute pending state and returns `dropPending` when a fresh line arrives (`Logged 40L at 50,350 km`), so the new fill is logged instead of being applied as an edit to the old row.
- **Security phases stay untouched.** While a PIN or account OTP is expected the ledger stays silent, and an abandoned quiz draft is parked (`reason: 'ledger_command'`) exactly like the read commands from v1.32.3. Pending state rides the chat session, so it survives Cloud Run restarts.
- **Trained, not bolted on:** `EDIT_ENTRY` / `DELETE_ENTRY` are registered in `SAKA_INTENTS` (now 41), the classifier JSON schema, `SAKA_INTENT_PLAYBOOK`, the boundary rules and a new EDITABLE LEDGER block in the core prompt.
- **Tests:** `test_entry_ledger` (**89**, new — detectors, selection, edit parsing, pending state + TTL + fresh-log guard, whitelist/immutability, copy, and a live edit → delete → restore round-trip that cleans its own rows), `test_agent_training` (**126**).
- **Still deferred:** notes keyword search, the single-day "summary for `<date>`" digest and the non-fuel odometer policy.


## [1.32.4] - 2026-11-01

- **Reports are legible again (the root cause, not the symptom):** `withAlpha()` called `doc.fillColor(rgb, alpha)`, which writes the alpha into the **page** graphics state and never resets it — the cover drew 9 of 20 text ops at `ca < 1` and the ledger page 22 of 40. The new `paintAlpha()` applies alpha only inside `save()/restore()` (`q … Q`), so the fade can never escape the shape it was meant for. Decorative glows, highlight pills, badges and the line-chart fill are unchanged.
- **Layout no longer drifts inside itself:** `kpiCard`, `chip`, `plateBadge` and `drawBadge` capture/restore `doc.y`; `drawKpiGrid` is a pure exported `computeKpiGrid()` with one shared `y` per row (the 85 → 143.8 → 202.7 → 337.5 staircase is gone); `drawChartHeading` makes one measured advance; `drawProgressChart` captures one `y` per row; `drawSegmentedBar` gives labels `colWidth − 124` so text never collides with the value.
- **No cell wraps over the next row:** ledger rows/headers are 21 pt (was 19) with `lineBreak:false`, explicit `height` and ellipsis (badge 6.6 pt/13 pt, body 7.6 pt, mono 7.2 pt); `drawTable` uses 22/24 pt rows and 8.2 pt body with the same contract.
- **A cover that fills the page:** the ink band now runs to `PAGE_HEIGHT − 120` (**722 pt**, was ~484 pt) closed by a solid accent rule, the hero title auto-shrinks 30 → 26 → 22 pt to stay within two lines, and the drivers panel moved inside the band with a legible label.
- **Legibility is now a test, not a hope:** `pdfTextExtractor.js` gained `listDecodedStreams()`, `contentOperators()`, `readExtGStates()` and `analyzeAlphaUsage()`; `test_pdf_engine.js` (68 assertions) asserts **zero** text ops at `ca < 1` for the real report, proves the guard is non-vacuous (decorative ExtGStates still exist) and that a deliberately leaking PDF *is* flagged.
- **Short links verify themselves before they ship:** new probe route `GET /r/__saka_probe__` (+ `x-saka-shortlink` header) and `verifyShortLinkRoute()` (3 s timeout, 10-min cache, fail-soft). `shortenUrl()` only shortens when the branded base really answers the probe — a 302 to marketing, a 200 without the tag or a network error all mean "keep the working long URL". `SHORT_LINK_PROBE=off` trusts an explicit operator signal (offline suites).
- **Report links are shortened at the source:** `deliverReportPdf()` shortens the uploaded URL itself, so the WhatsApp reply, the follow-up worker and the email all carry the branded link (idempotent on an existing `/r/` link). `/internal/status` publishes `shortLinks {ready, base, reason, checkedAt}` and boot warms the probe.
- **Unknown or expired codes get an honest page:** `HTTP 404` with a plain "this link has expired or does not exist — links stay valid for 90 days" page and a pricing link, instead of silently bouncing users to the marketing site.
- **Env & secret parity is measurable:** new `src/services/envAudit.js` — `ENV_REGISTRY` (154 knobs, 21 canonical sections), `ENV_IGNORE` (35 platform/CI/alias names), `auditEnv()` (missing required/recommended, undocumented, registry↔template drift, template placeholders, `sha256` fingerprint over `NAME:length` pairs) and `formatEnvDigest()`. **No value is ever serialised.** `/internal/status` adds an `env` block for a `SENTINEL_SECRET` caller, `admin env` returns the digest (audited `ADMIN_ENV_AUDIT`), `npm run env:audit` audits locally / `--remote` (live revision) / `--cloud` (flags secrets mounted as plain env vars instead of `--set-secrets`), and `npm run health` now fails on a missing required key or registry drift.
- **Every env read is documented:** `.env.example` gained a "v1.32.4 — ENV PARITY" section (short-link probe, Sentinel stall watchdog, remediation tuning, hot-path caches, admin paging, legacy-VIN compat) — the registry, the template and the 169 code reads now agree exactly.
- **Chat quick wins from the live transcript:** "Send me as a detailed pdf" now routes to the report engine (deliverable-shaped requests count as reports), and `composeMessage()` rejects contentless renders through `isContentlessReply()` — "Got your vehicle details!", "Noted.", "Okay." can no longer be sent (the deterministic fact-bearing text is used instead). The core prompt and the composer prompt both carry NO EMPTY REPLIES plus the pdf/summary/correction/draft-conflict friction rules.
- **Receipt vendors are real merchants:** the vault stored the raw OCR note blob in `vendor`; it now stores `extractDocumentHints().vendor`, so receipt lists and duplicate notices print a shop name.
- **Deferred to v1.33.0:** notes keyword search, the single-day "summary for <date>" digest and the non-fuel odometer policy — all three rewrite the same entry pipeline as the editable ledger.
- **Tests:** `test_pdf_engine` (**68**), `test_link_shortener` (**45**), `test_env_audit` (**44**, new), `test_agent_training` (**121**), `test_quiz_flow` (**112**), `test_status_probe` (**14**).

## [1.32.3] - 2026-11-01

- **Stale state can no longer hijack a turn:** conversation history is bounded by `CHAT_HISTORY_MAX_AGE_MINUTES` (**45**), enforced in SQL *and* re-checked locally, so the 1 h 43 m-old turns behind the 08:49 "you are one step away" reply are never injected again. Database rows are kept; only the prompt is protected.
- **Quiz drafts expire and park:** `QUIZ_MAX_AGE_MINUTES` (**20**, 5–240) makes `getActiveQuiz()` the only sanctioned read of `session.quiz`; an untouched draft is cleared instead of owning every later message. `markQuizTurn()` stamps the inactivity clock and `abandonQuiz()` parks a draft (answers preserved for telemetry) when a read command needs the conversation.
- **Deterministic read commands always win:** reminder lists ("Report of recent tired alerts", "List recent tiered alerts"), the compliance card, expiry questions ("When does your insurance expire") and receipts/parts lists are answered by the engine even when a draft was open — the draft is parked and the read is served in the same turn. `carriesExplicitDate()` keeps date-bearing answers ("insurance expires 20/11/2026") out of every read detector, and negated replies ("no alerts yet") are ignored.
- **A bare "yes" no longer redeems a coupon:** the trial-extension branch now requires a prior coupon offer (`session.lastAssistantPrompt`) plus a code in the merged extraction.
- **Compliance PDFs are full:** `report_type: 'compliance'` renders through the new `complianceReportToPdf()` — cover highlights (overdue/due-soon), an itemized per-vehicle table with days-left chips, a category matrix and provenance notes. `buildComplianceReport()` now returns PDF-ready rows (policy numbers read from `vehicle_compliances`, `dueSoon` aggregation, plain-language category labels). The Apex cover gains an optional `coverHighlights` row and a dynamic hero band; "PRO REPORT" is now "APEX REPORT" and body text is larger.
- **Sentinel nudges are visible:** every stall nudge is persisted with `saveChatMessage()`, and the last-warning nudge releases a stalled quiz, so the model never references dialogue the user cannot see.
- **Prompt/doc sync:** `flowKnowledge` + `DEFAULT_SAKA_CORE_PROMPT` gain the READ COMMANDS WIN OVER DRAFTS contract; `.env.example` documents both freshness knobs; architecture §77 added; tests: `test_quiz_flow` (107), `test_vehicle_compliance` (62), `test_pdf_engine` (50).

## [1.32.2] - 2026-11-01

- **Short links are now domain-verified (live fix):** the default base moved to `https://app.sakafleet.com` (the Cloud Run custom subdomain; the root site stays marketing). New `SHORT_LINK_DOMAIN_READY` gate (default **off**) means messages carry the original working URL until the branded domain serves HTTPS — the 2026-11-01 dead-link incident (`sakafleet.com` parked → every `/r/<code>` 404) can never repeat.
- **Deterministic compliance & reminder answers (zero tokens):** "when does insurance expire?", "my compliance" and "my reminders"/"alerts report" are answered from `vehicle_compliances` + `reminders` with 🟢🟡🔴 chips and days-left — the three unanswered questions from the live chat are closed.
- **Typed expiry corrections are written:** "you read the document wrong … expiry is 2026-11-20" now updates the compliance ledger, the legacy vehicle column and the linked reminder through the same engine the document flow uses.
- **Compliance confirmations show days-left** ("Insurance: 2026-11-20 — in 19 days (C35343842)") so a misread date is visible instantly; insurance vault notes now carry `Expires <date>` instead of the commencement date.
- **Deploy LIVE alert fixed:** the `last_deployed_revision` upsert was missing `onConflict: 'key'`, so the marker stayed frozen at the 2026-10-28 revision. It now persists and warns on failure.
- **Prompt/doc sync:** `flowKnowledge` + `DEFAULT_SAKA_CORE_PROMPT` describe the ledger-facts contract; `.env.example` documents the new short-link knobs; tests: `test_link_shortener` (28), `test_vehicle_compliance` (44), `test_ocr_flow` (88), `test_quiz_flow` (95).

## [1.32.1] - 2026-11-01

- **OCR audit remediation (live evidence 2026-11-01):**
  - **Silent photo deaths fixed:** `session is not defined` in the route catch block masked the real error on two uploads (logbook) and left the user with only an ack. `session` is hoisted, the catch is optional-chained, and the original error is now persisted to `error_logs`.
  - **Insurance certificate ≠ logbook:** strong insurance markers (`CERTIFICATE OF INSURANCE`, `POLICY HOLDER`, `COMMENCING DATE`, `EXPIRING`, `ISSUED BY`, `COVER NOTE`, `UNDERWRITER`) now win over bare CHASSIS/VIN; e-TIMS fuel receipts no longer become `purchase_invoice` ("Buyer PIN" excluded).
  - **Kenya e-TIMS profile (Rule 36):** country-gated parsing reads the merchant after the legal marker, the TOTAL/CASH figure on the following line (VAT lines ignored) and qty×price litres; the GLOBAL profile is unchanged and a non-KE regression fixture proves no leakage.
  - **Duplicate protection (three layers):** OCR text hash stored on every receipt + 48 h content dedupe (`OCR_DUPLICATE_WINDOW_HOURS`), re-upload short-circuit (warm "already read" reply, no second quiz), and a write-time expense guard (same plate + amount + type + Nairobi day, 3 h; `OCR_EXPENSE_DEDUPE_HOURS`) — a different odometer reading proves a separate fill.
  - **OCR telemetry:** `public.ocr_requests` (status, provider, kind, confidence, attempts, latency, country — never text), one row per media turn written before any crash-prone branch; `admin ocr-stats [Nh]` deterministic digest (audited `ADMIN_OCR_STATS`).
  - **HEIC/HEIF** photos accepted; insurance hints gain the certificate-number label and label-first expiry (COMMENCING date never becomes expiry); backfill migration corrects the three audited vault rows.
- **Rule 36 — Global-audience parsing & dedupe design** added to `.clinerules`; `test_ocr_flow.js` covers the e-TIMS fixture, the Bima Yangu insurance fixture, a non-KE regression, Buyer-PIN classification, duplicate comparator and OCR digest formatting.

All notable changes to Saka Fleet. Versions mirror the release tracker at the top
of `SAKA_FLEET_ARCHITECTURE.md`; every entry names the commit it shipped in.
Generated from the real git history — never from memory.

## [1.32.0] - 2026-11-01
- **Financial PDF presentation (from the real KAS 628T artifact):** the cover period chip no longer shows a timezone (`Africa/Nairobi`) - single-vehicle financials now read **"Financial & Cost Report - KAS 628T"** with a plate badge, make/model subtitle and **"All recorded activity"**. Zero earnings/net are neutral (never emerald), the KPI grid is filled to six centered cards (spend, earnings, net, transactions, fuel logged, distance), the redundant one-row per-vehicle table became a **Vehicle snapshot** panel, the dash-only "Cost efficiency" callout is hidden when no cost metric exists, the ledger title is scope-aware ("Transaction ledger - KAS 628T"), the Summary is condensed to eight lines, and the footer reads "APEX REPORT".
- **Chat-driven alias:** "Generate a profile report for KAS" now routes to the vehicle deep-dive (`vehicle profile report`, `profile report`).
- **Short links everywhere (self-hosted):** new `src/services/linkShortener.js` + `GET /r/:code` redirect present every long user link as `https://sakafleet.com/r/<8-char-code>` (90-day TTL, code reuse, TTL purge, fail-soft to the original URL). Report PDF links (WhatsApp follow-ups, vehicle summaries, the monthly audit) and **all** Paystack checkout links (upgrade, switch-to-annual, add-on, cancel-save, trial digests, winback, dunning, renewal, quiz checkout) are shortened.
- **Schema/ops:** `public.short_links` via `npm run migrate:short-links` (idempotent) + boot ensure + staging DDL + clean-slate reset coverage; optional `PUBLIC_APP_URL` base documented in `.env.example`.
- **Proof:** test_link_shortener 25 · test_report_builders 83 · test_pdf_engine 29 · test_fleet_reports 42 · test_quiz_flow 95 · test_trial_engine 73 · test_subscription_billing 75 · test_dunning_reengagement 15 · test_followups 12 · test_vehicle_summary 14 · test_report_metrics 25 · test_expense_catalog 66 · test_variable_catalogs 96 · test_demo_seed 30 · test_agent_training 109.

## [1.31.0] - 2026-11-01
- **Reminder DNA — asset-aware reminder catalog:** new `src/services/reminderCatalog.js` defines 21 reminder types (Oil change, Service, Fuel filter, Air filter, Brake pads, Tyres, Battery, Timing belt, Hydraulic service, Undercarriage, Generator service, Hull service, Engine service, Insurance Renewal, Inspection, Road License, Road Service Licence/PSL, Driver License, Permit/speed limiter, Deadline, Other) with aliases, meters and asset-kind menus. The quiz menu now follows the asset (a generator sees Generator service + Hydraulic service, never Road License) and free text resolves: "fuel filter and air filter" → Fuel filter, "hydraulic service" → Hydraulic service (hours), "PSL expires" → Road Service Licence, "front tyres" → Tyres.
- **Earnings have a type:** new `src/services/earningCatalog.js` (Trip fares, Daily takings, Cargo & freight, Vehicle hire, Equipment hire, Contract & charter, Transport service, Other). The earnings quiz asks one optional question and both the quiz and the one-line quick path store `private_earnings.earning_type` (migration `npm run migrate:earning-type`, boot ensure, staging DDL). Ledger earning rows now read "Cargo & freight - Nairobi to Mombasa".
- **Global compliance catalogs:** 17 new vehicle compliance catalogs (DE, FR, ES, IT, NL, BR, MX, GH, EG, SA, PK, BD, MY, SG, JP, PH, TR, CN, ID, NZ) alongside the existing ones, with local items (TÜV, contrôle technique, ITV, APK, CRLV, tenencia, Puspakom, Shaken, WoF…) mapped to the universal categories; catalog version 2026.17.0. New `driverComplianceCatalog.js` (licence, PSV badge, PDP, CPC, operator card, medical, defensive driving).
- **Vehicle attribute expansion:** brands include truck/bus/motorcycle makes (Scania, MAN TGX, DAF, Hino, Fuso, Sinotruk, Shacman, Ashok Leyland, Bajaj, TVS…), 10 new colours and 11 new accessories (trailer, toolbox, canopy, bike rack, fire extinguisher, first aid, reflectors, spare wheel, dashcam, GPS tracker, seat covers).
- **Catalog precedence fixed:** catalog resolvers now run before menu-alias matching, so "fuel filter" is Parts (never Fuel) and "hydraulic service" is Hydraulic service (never Service); generic words like "reminder"/"expires" no longer hijack specific types.
- **Guarded demo fleet:** `npm run demo:seed -- --confirm` inserts one demo owner (dedicated phone), eight asset kinds + an EV, **all 19 expense types**, **all 8 earning types**, date/distance/hours reminders and Kenya compliance rows; it removes its previous run first and never touches real users. `test_demo_seed.js` proves the payload (30 assertions) without any DB write.
- **Latent reminder bug fixed:** the live `reminders` table was missing `updated_at`, so date-based reminders (`createExpiryReminder`) failed at write time. `npm run migrate:earning-type` now adds it idempotently, and the demo seeder proved the full reminder path end to end.
- **Proof:** test_variable_catalogs 96 · test_expense_catalog 66 · test_quiz_flow 95 · test_fleet_reports 42 · test_report_builders 67 · test_report_metrics 25 · test_pdf_engine 29 · test_agent_training 109 · maintenance reminders 46 · vehicle compliance 28 · natural intake 19.

## [1.30.0] - 2026-11-01
- **Expense DNA — one exhaustive catalog for every asset:** new `src/services/expenseCatalog.js` defines **18 report categories** and **19 canonical expense types** (Fuel, Charging, Maintenance, Parts, Tyres, Repairs, Bodywork & Paint, Washing, Parking, Tolls, Fines, Insurance, Accessories, Subscriptions, Towing & Recovery, Crew Wages, Consumables, Mooring & Berthing, Other) with aliases, asset-kind applicability and ledger badges. It replaces the three private classifiers in `fleetReports`, `reportLedger` and `reportMetrics`; every builder now classifies through it.
- **Real chats drove the tweaks:** "Parts" is now a first-class quiz choice; "I repaired a puncture… front tyre" → Tyres; "fuel filter / air filter" → Parts; "oil change" → Maintenance; "diesel"/"topped up fuel" → Fuel; parking/tolls/fines/licences all resolve. The trigger word "expense" is deliberately not an alias, so "log expense" never pre-fills the type.
- **Asset-kind menus:** the expense quiz is catalog-driven and WhatsApp-short (8 choices). Road assets get Fuel · Maintenance · Parts · Tyres · Repairs · Parking · Insurance · Other; EVs swap Fuel for Charging; generators/machinery/watercraft get Consumables + Crew Wages and never Tyres/Parking. Any other type remains reachable by free text.
- **Odometer label fixed (live complaint):** the field now reads "Odometer at the time of this expense" with the hint "the reading when it happened — fill-up, service or repair", instead of implying every expense is a fill-up.
- **Write-time canonicalisation:** the quiz executor and the WhatsApp one-liner quick path both normalise `expense_type` through the catalog, so stored rows are consistent (diesel → Fuel, puncture → Tyres, wash → Washing).
- **Reports & ledgers follow automatically:** financial totals gain the new categories additively (legacy fuel/maintenance/parts/tolls/other keys unchanged), the Apex segmented bars show real labels, and ledger badges now include TYRES, REPAIRS, WASH, PARKING, FINES, WAGES, FLUIDS, MOORING and more. Category accumulators are initialised from the catalog, so new types can never produce NaN.
- **Prompt & docs sync:** `flowKnowledge` log_expense (trigger, fields, rules) and the core prompt now carry the canonical catalog + examples; `test_expense_catalog.js` added to the stateless health suite.
- **Proof:** test_expense_catalog 66 · test_quiz_flow 95 · test_fleet_reports 42 · test_report_metrics 25 · test_report_builders 67 · test_pdf_engine 29 · test_agent_training 109 · doc sync 24 · natural intake 19.

## [1.29.0] - 2026-11-01
- **Saka Apex PDF design system (still pdfkit — zero new dependencies):** new palette (Midnight Slate / Tech Teal / Emerald / Coral / Amber), semantic KPI tones, licence-plate cover badge, **itemized transaction ledgers** (Date · Type badge · Description · Odometer · Unit cost · Total, with month groups, subtotals, zebra rows, a TOTAL band and a "nothing hidden" footer), **segmented proportional bars**, **earnings-vs-expenses bars** and **insight callouts**.
- **Phantom-page bug fixed:** fixed cover/footer text sat below the content area and made pdfkit add pages silently (a cover-only report was 6 pages). The footer/cover text now draws with a zeroed bottom margin — a cover is 1 page and the Apex test report is 3.
- **Full transparency contract:** real numeric zeros render explicitly (`KES 0`), only missing data renders `—`; every Apex report adds a **Data completeness** panel (records scanned, ledger rows shown, lane exclusions) and no ledger rows are truncated — pagination repeats the header instead.
- **Five report categories:** upgraded Fleet executive/financial summaries (financial-health block + fleet ledger), new **Vehicle Deep-Dive** (`vehicle_deep_dive`: plate badge, cost/km or cost/hour, fuel economy, compliance runway, full ledger), new **Owner Portfolio** (`owner_portfolio`: multi-asset distribution, per-vehicle performance, net payouts, consolidated vehicle-column ledger), new **Driver Performance & Compliance** (`driver_performance`: adherence, fill-type discipline, compliance verification, daily activity log + driver ledger), and bespoke reports now include their filtered ledger and an earnings-vs-expenses chart.
- **Routing & lanes:** `vehicle_deep_dive`, `owner_portfolio` and `driver_performance` aliases; exact underscored `report_type` keys now resolve; all three are owner/admin-only. The background report worker carries the active plate into deep-dives.
- **Prompt & docs sync:** `flowKnowledge` REQUEST_REPORT catalogue (plus Apex semantics), the core prompt report-access block, regenerated training docs, architecture §47.2–§47.7 (Apex engine + data blueprint) and the new `test_report_builders.js`.
- **Proof:** test_pdf_engine 29 · test_report_builders 67 · test_fleet_reports 42 · test_report_metrics 25 · test_report_access 33 · agent training 109 · doc sync 24 · asset metrics 70.

## [1.28.9] - 2026-11-01
- **Asset metrics are now a first-class registry:** `src/services/assetMetrics.js` is the single source of truth for what each of the eight asset kinds can measure. Road assets (vehicle, motorcycle, truck, bus) use odometer + litres + km/L (or kWh + km/kWh when electric); heavy equipment, machinery, generators and watercraft use engine hours + litres + L/h; generators add kWh output; trucks and buses add trips/jobs.
- **No more odometer-on-a-generator:** registration summaries and PDFs take the primary meter from the registry (`assetMetricSummaryLines`), electric assets show “Energy charged” instead of a fuel type, and the legacy Cloud Run audit report (`reports.js`) renders EV/HEAVY/ICE KPIs from the same registry instead of its own private map.
- **Bespoke reports fit the fleet:** `metricsForAccess()` now filters by asset kinds — a generator-only fleet never sees “Distance”, and hours/kWh metrics are offered instead (`operating_hours`, `energy_kwh` added to the metric catalog). `metricAppliesToAssetKinds()` is exported for reuse.
- **Saka speaks the right metric everywhere:** `SAKA_METRIC_GLOSSARY` (generated from the registry) is embedded in the core prompt and re-exported through `sakaAi.js`, `productQa` publishes one authoritative “what can I log for my <asset>” fact per kind, and the training suite asserts both.
- **Formatting is canonical + localized:** `formatMetricValue()` converts km↔mi, L↔gal, km/L↔MPG, L/h↔gal/h and km/kWh↔mi/kWh, always storing km/litres/hours/kWh; nullish values render “—”, never “0”.
- **Proof:** new `test_asset_metrics.js` 70 assertions (coverage of all 8 kinds, electric swap, hours-led rules, conversions, summaries, report menus, glossary) · agent training 109 · report metrics 25 · vehicle summary 14 · fleet reports 42 · product Q&A 147.

## [1.28.8] - 2026-11-01
- **OCR unpaused, end to end:** `isOcrEnabled()` is env-driven again (`OCR_ENABLED=on` by default; `off|false|0` pauses). Receipt photos, logbooks, insurance policies and odometer photos are read by Vision, PDFs keep using the local text layer, and quiz upload hints are ON by default (`UPLOAD_HINTS_ENABLED=on`). Ack-first stays on, low-confidence reads still ask for confirmation and nothing is written without YES.
- **Always-on self-learning:** a 15-minute internal tick (`SENTINEL_LEARN_INTERVAL_MS`) runs `runConversationRefinement` with an overlap guard — learning no longer depends on the external Sentinel endpoint, so gated prompt learnings actually accumulate.
- **Country communication styles:** `deriveCountryCommStyles()` turns recent transcripts into deterministic per-country profiles (greeting vocabulary, brevity, formality, emoji rate), Sentinel upserts them into `country_comm_styles`, and each turn appends a cached `COUNTRY COMMUNICATION STYLE (KE…)` line to the jurisdiction context. No AI tokens, no guessing.
- **Abandoned-checkout recovery:** a link issued but not converted triggers a 3-step ladder — T+30 min (same link + local price + coupon), T+24 h (value recap), coupon T-2 days (last reminder, explicitly "a discount, not free days"). Capped at 3, stops the moment the account converts. `checkout_started_at` now keeps the FIRST open time so nudges cannot reset the clock.
- **Post-expiry benefit nudges:** a plan that ended and was not renewed gets D+7 ("what's waiting for you", local prices) and D+30 ("your data is safe") — the existing D+15 WINBACK40 sits between them, so the ladder is 7/15/30 with a hard cap. Never sent to a renewed, canceling or opted-out account.
- **Schema:** `npm run migrate:recovery` adds `trial_sessions.checkout_reminder_count/last_checkout_reminder_at`, `profiles.renewal_nudge_count/last_renewal_nudge_at` and the `country_comm_styles` table (the boot DDL mirrors the column adds).
- **Proof:** new `test_recovery_ladders.js` 30 assertions (stage ladders, local-currency copy, max caps, style derivation/injection) · OCR flow 54 · trial engine 73 · subscription billing 75 · flow suite green.

## [1.28.7] - 2026-11-01
- **Reports always arrive:** a queued report could previously die silently after the "Building your report…" ACK (the live 21:06/21:07 requests produced no follow-up at all). `runFleetReport` is now fully fail-soft, `processPendingFollowUps` sends a deterministic recovery line when a report job fails, and `deliverReportPdf` never leaves an empty link.
- **PDF glyph safety:** the embedded fonts cannot draw WhatsApp emoji or Unicode symbols, which made reports illegible (tofu boxes). `pdfSafeText()` maps symbols to ASCII, strips emoji and drops non-Latin-1 glyphs; every string drawn by `buildProReportPdf` passes through it. New `test_pdf_engine.js` (15 assertions) proves a valid `%PDF` with a page object and a clean trailer.
- **Storage self-heal:** `uploadReportToSupabase` creates the `fleet-reports` public bucket once when missing, retries the upload, and falls back to a 24-hour signed URL — the link can no longer come back empty.
- **Trial reward is locale/currency-correct:** the activation reward now states the expiry in the owner's locale/timezone, shows **monthly and yearly** prices in the owner's local currency (derived from the phone's country when the profile has no currency), explains that the coupon is a **discount on the first payment, not free days**, and points to "extend trial" for more free days. The activation coupon is now stamped onto `trial_sessions.coupon_code`, so the nudge checkout actually carries ACTIVATE20; the winback checkout is local-currency too.
- **Operations list, front and centre:** `SAKA_OPERATIONS` (owner + driver lanes) is the single registry behind the first-contact welcome, the on-demand `help` / "what can you do" menu (guaranteed by a deterministic append in `renderActionDiscovery`) and the core prompt (`SAKA_OPERATIONS_PROMPT_BLOCK`). Welcome emoji rule is now explicitly one anchor per operation line.
- **Reminder clarity:** `describeThresholdSpec()` renders relative thresholds as "in 5,000 km" and absolute targets as "at 370,000 km" (also "in 36 operating hours").
- **Proof:** PDF engine 15 · greetings 83 · quiz flow 95 · trial engine 73 · maintenance reminders 46 · follow-ups 12 · agent training (operations registry embedded).

## [1.28.6] - 2026-10-31
- **Report requests are never logging flows:** "Give me a fuel report for kas" / "Give me fuel report" were misclassified as LOG_EXPENSE and started the expense quiz. `looksLikeReportRequest()` now blocks the quiz and the route upgrades the intent to REQUEST_REPORT, so the report engine (with its quota/access rules) answers.
- **Proof:** quiz engine 95 assertions (the live report messages never start the quiz; "log fuel" still does).

- **Mileage reminders now save:** a distance-based reminder ("due at 370,000 km") was collected correctly but the insert was rejected because the legacy `reminders.due_date` column is NOT NULL. `npm run migrate:reminder-due-date` relaxes it (and the boot DDL applies the same ALTER), so threshold reminders persist with `threshold_unit`, `target_value` and no date.
- **Trigger sentence banking:** "Log an oil change reminder. To happen @370,000km" now fills the reminder type and the 370,000 km threshold in one turn — no re-asking type or due.
- **Phantom-plate guard widened:** prose like "CAR A 1991" can no longer pass as a plate (common-word part blocklist).
- **Proof:** quiz engine 88 assertions (live reminder sequence + threshold row without `due_date` + migration/DDL guards).

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
