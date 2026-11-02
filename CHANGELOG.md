# Changelog

## [1.39.3] - 2026-11-02

- **New accounts are explicitly Free.** The live `profiles` schema carries a legacy `subscription_tier` default of `SOLO`, which the entitlement engine normalizes to `solo_pro` — and with a null status that resolves to ACTIVE, granting paid access to brand-new signups. Both creation paths (web onboarding + WhatsApp first-contact) now insert `subscription_tier: 'free'` explicitly; the welcome trial still upgrades the account at vehicle registration exactly as before (rules 23-26).
- **Live E2E proof:** the full web handshake ran against production — `POST /api/onboard` → OTP row → `POST /api/onboard/verify` → `email_verified=true`, no trial row, explicit Free tier — and every test row was deleted afterwards (rule 10).

## [1.39.2] - 2026-11-02

- **Hostinger deploy workflow fixed.** The first two deploy runs failed instantly (zero jobs) because the `secrets` context is not available in a job-level `if`. The guard now runs as a bash step that emits a `ready` output; the FTP step deploys only when all three `HOSTINGER_FTP_*` secrets exist — and the run stays green (with a "skipping" note) while they are absent.

## [1.39.1] - 2026-11-02

- **GFE-safe uptime probe.** Google's edge intercepts `/healthz` on some Cloud Run deployments (documented v1.24.4), so the landing uptime widget now probes `/api/health` first and falls back to `/healthz` for legacy revisions — the status card can never report "down" for a healthy backend.
- **Data Deletion page.** New `landing/data-deletion.html` preserves the previous site's deletion affordance: account deletion via WhatsApp, per-entry deletion, email requests (30-day response, KDPA/GDPR rights, ODPC contact). Linked from the footer of every page, the sitemap and `llms.txt`.
- **Tests:** `test_landing_static` (**52** — data-deletion page, probe fallback chain, footer/sitemap/llms references).

## [1.39.0] - 2026-11-01

- **Marketing website + onboarding portal (`landing/`).** A vibrant, conversion-optimized static site for sakafleet.com: hero with a WhatsApp chat mock, features grid, pricing from the tier registry, live changelog, live uptime probe (`app.sakafleet.com/healthz`) and a multi-step signup modal — details (E.164 phone, default +254) → exhaustive legal gate with a mandatory Terms & Privacy checkbox → inline 6-digit email OTP card (60 s resend cooldown) → success with a wa.me deep link. Full `privacy.html` (KDPA 2019 + GDPR) and `terms.html` (Saka 360, Kenya), 404, and a complete SEO/AEO layer: JSON-LD (Organization, WebSite, SoftwareApplication, FAQPage), `sitemap.xml`, `robots.txt` welcoming GPTBot/ClaudeBot/PerplexityBot/Google-Extended, `llms.txt`, OpenGraph/Twitter cards and `humans.txt`. Zero secrets client-side (rule 6); no frameworks.
- **Web onboarding handshake.** New `POST /api/onboard`, `/api/onboard/verify`, `/api/onboard/resend` backed by `src/services/webOnboarding.js` + the idempotent `public.web_onboard_otps` table (`npm run migrate:web-onboard`, boot-ensured). Strict payload gate, 10-minute OTP TTL, 3-attempt lockout, 60-second resend cooldown, audited profile flip (`email_verified=true`) and — per rule 26 — the welcome trial is NEVER started at web signup. CORS via `LANDING_ORIGINS` opens only `/api/onboard*` and the health probes. Optional `META_WELCOME_TEMPLATE_NAME` fires a business-initiated welcome on verification; the guaranteed channel is the wa.me deep link plus a new WhatsApp fallback: a bare 6-digit code from a registered-but-unverified user (never during a quiz/onboarding/OTP/PIN phase) verifies their web code in chat.
- **Odometer policy (research-backed).** Is a mileage reading necessary for every submission? No — the catalog now declares `odometerMode` per type: full-tank fuel fills REQUIRE the odometer (Skip is refused; it anchors the km/L math), top-ups/Charging/service events ask with Skip allowed, and Parking, Tolls, Fines, Washing, Insurance, Accessories, Subscriptions, Towing, Wages, Mooring, Bodywork and Other are never asked. Hours-led assets (machines, generators, boats) substitute the engine-hours meter, stored in the entry notes. Enforced in `quizEngine.expenseReadingFields()` and synced through `flowKnowledge`, the core prompt and the composer (rule 13).
- **Hostinger deployment.** `.github/workflows/deploy_landing.yml` deploys only `landing/**` to shared hosting over FTP (GitHub secrets `HOSTINGER_FTP_*`; the job self-skips until secrets exist), `landing/.htaccess` ships HTTPS redirect, security headers and caching, and `docs/LANDING_DEPLOYMENT.md` is the operator walkthrough. The backend repo never reaches Hostinger.
- **Tests:** `test_web_onboarding` (**30**, new — stateless in-memory double: payload gate, session lifecycle, lockout/expiry/cooldown, subscription-untouched profile upsert, WhatsApp fallback), `test_landing_static` (**49**, new — required files, JSON-LD parse, llms/sitemap/robots, secret scan, reference resolution, conversion architecture), `test_expense_catalog` (**82** — odometer policy registry + quiz questions), `test_quiz_flow` (**128**), `test_agent_training` (**137** — ODOMETER POLICY + WEB SIGNUPS prompt sync). Both new suites registered in `scripts/health_audit.js`.
- **Blog generator verdict:** deferred — a small in-repo markdown-to-HTML generator is planned for a later release; no third-party AI blog SaaS now.

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
