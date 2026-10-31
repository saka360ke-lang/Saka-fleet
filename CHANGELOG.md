# Changelog

All notable changes to Saka Fleet. Versions mirror the release tracker at the top
of `SAKA_FLEET_ARCHITECTURE.md`; every entry names the commit it shipped in.
Generated from the real git history — never from memory.

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
