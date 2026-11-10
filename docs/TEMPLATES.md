# Saka Fleet - Meta template approval contract (v1.87.1, sections 182 + 217)

This file is the approval contract between the code and Meta Business Manager.
WhatsApp only allows free-form business-initiated messages inside the 24-hour
customer-service window; outside it, Meta accepts the API call and silently
drops the message (section 87.3 is the deploy-alert post-mortem of exactly
that failure). Every proactive message family therefore has an approved
template slot, selected by an environment knob:

    META_TPL_<KIND> = <approved template name>

Unset (the default) = today's free-form text, byte-identical. Setting the knob
only matters once the matching template is APPROVED in Meta; the code never
carries a template body.

Variables are USER DATA ONLY (name, plate, days, tier, coupon). If a required
variable is missing or empty, the sender falls back to the free-form text -
a template can never fire with a broken body parameter.

Variable note: **re_engagement {{1}}=first name**: profiles may have null
full_name. `processSilentReengagement` now always passes a guaranteed fallback
("there"), so the template can never fire with an empty body parameter.

Language: en (PROACTIVE_TEMPLATE_LANGUAGE).

------------------------------------------------------------
1. The 18 templates
------------------------------------------------------------

Each entry: kind | env knob | audience | recommended category | variables

1. service_reminder
   env: META_TPL_SERVICE_REMINDER
   audience: owner + driver
   category: Utility
   variables: {{1}} = plate (for example KDA 123A)
   body: Hi! It's Saka. Your vehicle {{1}} is due for service soon. Reply
         reminders to see what is coming up.

2. expiry_reminder
   env: META_TPL_EXPIRY_REMINDER
   audience: owner + driver
   category: Utility
   variables: {{1}} = item (for example Insurance), {{2}} = due (for example
              in 7 day(s))
   body: Hi! It's Saka. {{1}} expires {{2}}. Reply reminders to see all due
         dates.

3. trial_ending
   env: META_TPL_TRIAL_ENDING
   audience: owner
   category: Utility
   variables: {{1}} = days left (for example 3)
   body: Hi! Your Saka trial ends in {{1}} day(s). Reply subscription to see
         your plan options.

4. trial_grace
   env: META_TPL_TRIAL_GRACE
   audience: owner
   category: Utility
   variables: {{1}} = fitted tier name (for example Growth)
   body: Hi! Your Saka trial has ended and your vehicles are safe. Reply keep
         all to continue on {{1}}, or subscription to review.

5. dunning
   env: META_TPL_DUNNING
   audience: owner
   category: Utility
   variables: {{1}} = tier name (for example Solo Pro), {{2}} = days left
              (for example 2)
   body: Hi! Your {{1}} renewal did not go through. {{2}} day(s) left to update
         payment. Reply subscription to fix it.

6. re_engagement  (v1.95.0 — Phase 32, Task 4: renamed saka_reengage, Utility)
   env: META_TPL_RE_ENGAGEMENT   (the env var name is unchanged)
   audience: owner
   category: Utility (D6 — the copy is service-flavoured, not promotional;
             picked for approval odds over the previous Marketing suggestion)
   variables: {{1}} = owner first name (fallback: there — guaranteed at send
              time, so the template can never fire with an empty variable)
   body: Hi {{1}}! It's Saka. I've been keeping your records safe. Anything
         new to log today?
   why: the 14-day silence nudge fires outside Meta's 24-hour window, where
        free-form text is silently dropped. Gate: REENGAGE_TEMPLATE_ENABLED
        (default off); knob-off keeps the v1.16.3 free-form copy verbatim.
   buttons (v1.95.1 — APPROVED): FOUR Quick Reply buttons — "Log Fuel",
        "Set Reminder", "Log Expense", "Dashboard". The send emits four
        parameter-free quick_reply components at explicit indexes 0-3 (a
        parameter on a quick reply is what Meta rejects with 131008). A tap
        returns its own TITLE; BUTTON_TITLE_PHRASES maps "Log Fuel" -> fuel,
        "Set Reminder" -> set reminder, "Log Expense" -> log expense and
        "Dashboard" -> dashboard — the exact typed phrases the live grammar
        already owns (fuel/expense quiz, reminder quiz, dashboard sign-in).
        Titles are the reliable signal because Meta may hand back a generated
        payload id; registered ids and quick-edit ids still win first.

7. driver_unassigned
   env: META_TPL_DRIVER_UNASSIGNED
   audience: driver
   category: Utility
   variables: {{1}} = plate
   body: Hi! You have been unassigned from vehicle {{1}} on Saka. Reply help
         if you need anything.

8. winback
   env: META_TPL_WINBACK
   audience: owner
   category: Marketing
   variables: {{1}} = coupon code (for example WINBACK40-ABCDEF)
   body: Hi! A special offer from Saka: use code {{1}} for 40% off an annual
         plan. Reply subscription to get started.

9. deploy_live
   env: META_TPL_DEPLOY_LIVE
   audience: superadmin - internal operations, superadmin recipient only
   category: Utility
   variables: {{1}} = version (for example v1.78.1)
              {{2}} = commit / Cloud Run revision (for example saka-fleet-00188-abc)
   body: 🚀 Saka is LIVE!
         {{1}}
         {{2}}
         The new revision is now answering WhatsApp conversations.

10. eval_digest_ping
    env: META_TPL_EVAL_DIGEST_PING
    audience: superadmin - internal operations, superadmin recipient only
    category: Utility
    variables: none (static body)
    body: The 6-hour conversation eval digest just went out by email. Check
          your inbox for the summary.

11. care_escalation
    env: META_TPL_CARE_ESCALATION
    audience: care worker - internal operations, superadmin recipient only
    category: Utility
    variables: none (static body)
    body: New support ticket in Saka. Open the care console to review and
          reply.

12. driver_activity
    env: META_TPL_DRIVER_ACTIVITY
    audience: owner
    category: Utility
    variables: {{1}} = driver name, {{2}} = plate
    body: Hi! It's Saka. Driver {{1}} submitted new activity on {{2}}. Open
          Saka to review the details.

13. fleet_auto_audit
    env: META_TPL_FLEET_AUTO_AUDIT
    audience: owner
    category: Utility
    variables: {{1}} = net earnings today (for example KES 4,250)
    body: Hi! It's Saka. Your Fleet Auto-Audit report is ready. Net earnings
          today: {{1}}. Open Saka to view the full report.

14. auth_otp  (v1.87.1 — Phase 26B; the FIRST Authentication template; v1.87.3 button)
    env: META_TPL_AUTH_OTP
    audience: any (dashboard sign-in code; the only WhatsApp OTP today)
    category: Authentication
    variables: {{1}} = the 6-digit numeric code (Meta allows ONLY this one
               free variable in an Authentication template)
    body: {{1}} is your Saka Fleet verification code. It expires in 10 minutes.
          Do not share it with anyone.
    button: the approved template carries a URL button at index 0; the code is
            ALSO sent as that button's parameter
            ({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: <code> }] }).
            v1.87.3 live proof: a body-only payload is rejected with
            131008 "Button at index 0 of type Url requires a parameter".
    why: the dashboard login minted a FREE-FORM text; Meta silently drops it
         after 24h of user silence, so returning users could not sign in.

15. driver_invite  (v1.87.1 — Phase 26B)
    env: META_TPL_DRIVER_INVITE
    audience: driver (a newly assigned driver who has never messaged Saka)
    category: Utility
    variables: {{1}} = plate (for example KAS 628T)
    body: Hi! A Saka Fleet owner invited you to take over {{1}}. Reply ACCEPT
          on WhatsApp to accept the assignment.

16. transfer_invite  (v1.87.1 — Phase 26B)
    env: META_TPL_TRANSFER_INVITE
    audience: buyer (a passbook buyer who has never messaged Saka)
    category: Utility
    variables: {{1}} = plate
    body: Hi! A Saka Fleet owner has started a passbook transfer for {{1}}.
          Reply ACCEPT to claim it, or DECLINE to reject.
    note: the buyer's 6-digit verification code is EMAILED (never WhatsApp), so
          only the invitation needs a template.

17. overdue_digest  (v1.92.0 — Phase 29)
    env: META_TPL_OVERDUE_DIGEST
    audience: owner
    category: Utility
    variables: {{1}} = count (for example 3), {{2}} = worst item (for example
               Insurance (KDA 123A)), {{3}} = worst days past due (for example 5)
    body: Hi! It's Saka. You have {{1}} overdue compliance item(s). The oldest
          is {{2}} — {{3}} day(s) past due. Reply reminders to see them all.
    note: D1 hybrid — the FIRST overdue item of an episode still fires its
          immediate one-shot alert; every later item is stamped but not sent,
          and this digest fires once at T+3 and once at T+7 of the episode
          (three messages maximum per episode regardless of item count).
    button (v1.92.1): the approved template carries a Quick Reply button
          (text "Reminders", Custom type), confirmed in Business Manager
          2026-11-09. Quick Reply buttons take NO parameters, so the send emits
          { type: 'button', sub_type: 'quick_reply', index: '0' } with no
          parameters — the v1.87.3 131008 rejection ("button requires a
          parameter") can never fire here. A tap returns the button text as a
          user message; the inbound `button_reply` path routes it to the
          deterministic reminders list (title alias "Reminders"/"Remind me" ->
          "reminders"). No extra environment knob is needed.

18. feature_tip  (v1.95.0 — Phase 32, Task 3)
    env: META_TPL_FEATURE_TIP
    audience: owner (an account whose trial activated; one feature per owner)
    category: Utility
    variables: {{1}} = the feature label (for example voice notes),
               {{2}} = the engine-owned link (for example
               https://app.sakafleet.com/d/login)
    body: 🎯 Tip: try {{1}} — {{2}}

          One minute and Saka does the rest.
    why: the T+12h tip can fire outside Meta's 24-hour window, where free-form
         text is silently dropped (section 87.3). The drip-feed sends ONE tip
         per owner (first unexplored feature), then ONE follow-up at T+48h and
         only while that feature is still unexplored (max 2 sends per feature).
         Gate: FEATURE_NUDGE_ENABLED (default off).
    approval note: this is the ONLY template in this file that deliberately
         carries a URL inside a body variable (operator decision D7, Phase 32).
         Submit it as Utility; if Meta's review rejects the URL variable, keep
         the knob UNSET — the free-form tip still delivers inside the 24-hour
         window and nothing else changes (the fallback contract below).

------------------------------------------------------------
2. Submission workflow (Meta Business Manager)
------------------------------------------------------------

1. Open Meta Business Manager -> WhatsApp Manager -> Account tools ->
   Message templates.
2. Create each template with the exact BODY above, language English (en),
   and the recommended category. Keep the {{1}}/{{2}} placeholders exactly as
   written; do not add links (the link-bearing rich copy still goes out as the
   free-form fallback inside the 24-hour window).
3. Submit for review. Approval is per template; unapproved kinds simply keep
   sending the free-form text.
4. Once approved, set the knob to the APPROVED template name (the name you
   typed in step 2, which may differ from the suggested name below).

Suggested template names:

    saka_service_reminder
    saka_expiry_reminder
    saka_trial_ending
    saka_trial_grace
    saka_dunning
    saka_reengage
    saka_driver_unassigned
    saka_winback
    saka_deploy_live
    saka_eval_digest_ping
    saka_care_escalation
    saka_driver_activity
    saka_fleet_auto_audit
    saka_otp                (category Authentication)
    saka_driver_invite
    saka_transfer_invite
    saka_overdue_digest
    saka_feature_tip

------------------------------------------------------------
3. Setting the knobs in Cloud Run
------------------------------------------------------------

One command per approved template (quote the value; never leave a comma list
unquoted in PowerShell - the v1.61.5 env lesson):

    gcloud run services update <SERVICE> --region=<REGION> ^
      --update-env-vars="META_TPL_SERVICE_REMINDER=saka_service_reminder"

Or a single quoted comma list when several are approved:

    gcloud run services update <SERVICE> --region=<REGION> ^
      --update-env-vars="META_TPL_SERVICE_REMINDER=saka_service_reminder,META_TPL_EXPIRY_REMINDER=saka_expiry_reminder"

Verify parity afterwards:

    npm run env:audit
    npm run health

The env registry registers every META template knob under META WHATSAPP, so a typo in a
knob name is reported (names only, never values).

------------------------------------------------------------
3.1 Deploy-live activation runbook (v1.78.0, Phase 17)
------------------------------------------------------------

Live evidence (2026-11-08): `saka-fleet` on Cloud Run (europe-west1) had NO
`META_TPL_*` variable set, so the boot LIVE alert degraded to free-form text
and Meta silently dropped it whenever the superadmin had not messaged Saka in
the last 24 hours (the section 87.3 failure). The "building" alert from
scripts/notify_git_push.js stays free-form BY DESIGN (D1, v1.78.0) - the boot
LIVE alert is the guaranteed channel, and it needs the template.

Activation steps (operator, once):

1. Meta Business Manager -> WhatsApp Manager -> Account tools -> Message
   templates -> Create template.
     name:      saka_deploy_live
     category:  Utility
     language:  English (en)
     variables: {{1}} = version (v1.78.1), {{2}} = commit/revision - the boot
                announcement fills both (v1.78.1)
     body:      🚀 Saka is LIVE!
                {{1}}
                {{2}}
                The new revision is now answering WhatsApp conversations.
2. Submit for review and wait for APPROVED. Nothing else changes while it is
   pending: the knob stays unset and the alert keeps its free-form fallback.
3. Set the knob on Cloud Run (creates one new revision; the next boot
   announces itself through the template):
     gcloud run services update saka-fleet --region=europe-west1 --update-env-vars="META_TPL_DEPLOY_LIVE=saka_deploy_live"
4. Verify parity: npm run env:audit (META WHATSAPP section) and npm run health
   - both green. The next deployed revision emits the LIVE alert through the
   approved template even outside the 24-hour window.
5. Rollback: unset the knob. No schema, no migration, no flag.

v1.78.1 note: the approved body now takes TWO variables. If the live
template still has the old static body, Meta rejects the two-parameter send
and the alert degrades to the free-form text (never a broken message) -
edit the template to the body above and re-submit for approval.


------------------------------------------------------------
4. Fallback contract (never worse than today)
------------------------------------------------------------

- Knob unset -> free-form text, byte-identical to pre-v1.63.0 (proven by
  test_sentinel_policy and every sender suite).
- Knob set but a required variable is missing/empty -> free-form text.
- Knob set but Meta rejects the template send -> the text path still tries
  (it only delivers inside the window, exactly like today).
- Rollback: unset the knob(s). No schema, no migration, no flag needed.
------------------------------------------------------------
5. Quick-reply button payload registry (v1.73.4, section 198B)
------------------------------------------------------------

Buttons are not yet registered on the templates; this registry is the
contract for when they are. The code mirrors it in
`BUTTON_PAYLOAD_PHRASES` (src/routes/whatsapp/interactive.js) and
resolves a tap to the typed phrase the user would otherwise send, so the
live grammar handles it - no new intents, no prompt changes.

| payload_id   | typed phrase | what the user gets                            |
|--------------|--------------|-----------------------------------------------|
| remind_me    | reminders    | the due-list (identical to typing "reminders")|
| reminders    | reminders    | idempotent - a payload equal to the operator  |
| subscription | subscription | the plan summary                              |
| keep_all     | keep all     | keep-everything / downsize flow               |
| help         | help         | the help menu                                 |

Rules:
- A payload id registered on the WABA MUST match a table row to receive
  its phrase; any unregistered payload falls back to the button's own
  title text, so Saka can always answer what the user just tapped.
- D1 (locked): remind_me maps to "reminders" (the LIST), never "remind
  me" (which starts the set_reminder quiz) - the reminder template body
  promises "Reply reminders to see what is coming up".
- Meta payload shapes handled: interactive.button_reply {id,title},
  interactive.list_reply {id,title,description} and the legacy
  button {text,payload}. Anything else (product, nfm_reply, ...) is
  logged under /webhook/whatsapp/interactive for diagnosis - never
  guessed.
- A quick-reply title is user-visible copy: keep it identical to the
  typed phrase (for example a title of "Reminders" for remind_me) so the
  tap and the typed message read the same.

------------------------------------------------------------
6. Operator test-fire & button audit (v1.96.0)
------------------------------------------------------------

Two superadmin-only WhatsApp commands (30-minute admin session required):

    admin tpl test <kind> [target_phone]   fire ONE approved template (default: SUPERADMIN_PHONE)
    admin tpl test all [target_phone]      pace the whole registry (5 sends / 10 minutes)
    admin tpl buttons                      audit every reply button (captured -> declared -> mapped)

Rules:
- The recipient defaults to SUPERADMIN_PHONE; pass a target phone to test on a
  regular device (for example `admin tpl test re_engagement 0734852529`). A
  local 07 number with exactly 10 digits resolves to +254; every other number
  must carry its full country code (+49..., 254..., 00...). The 5/10-minute
  window is keyed to the OPERATOR, and audit rows store the target masked to
  its last 4 digits - never the full number.
- The recipient is ALWAYS SUPERADMIN_PHONE (the operator's own number). If the
  knob `META_TPL_<KIND>` is unset, the command refuses that kind and names the
  expected template from the suggested-name list above - it never invents one.
- At most 5 sends per 10 minutes. `all` walks the registry in order, reports
  each kind, and stops at the window: "cooling down - run again in N minutes".
- The reply distinguishes outcomes honestly: sent (wamid printed), rejected by
  Meta (no wamid), delivery blocked (no wamid, no network call), credentials
  missing (no wamid), knob unset (expected template named).
- Delivery status lives in Cloud Logging / the Meta console under the printed
  wamid; failed receipts also land in `error_logs` (`/webhook/whatsapp/status`).
  There is no database delivery trail by design.
- After tapping buttons: the quiz-starting taps ("Log Fuel", "Set Reminder",
  "Log Expense") open REAL flows - reply `cancel` after each before running
  `admin tpl buttons`. "Dashboard" and "Reminders" are read lanes.
- `admin tpl buttons` reads captured taps from two live sources: `error_logs`
  on route `/webhook/whatsapp/interactive` (unrecognized shapes, superadmin
  number) and `chat_history` rows whose message EXACTLY equals a mapped target
  phrase (recognized taps arrive as the typed phrase). Any captured tap with no
  named claimant is flagged.


