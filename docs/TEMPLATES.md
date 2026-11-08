# Saka Fleet - Meta template approval contract (v1.63.1, section 182)

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

Variable note: **saka_re_engagement {{1}}=name**: profiles may have null
full_name. If you cannot guarantee a name at send time, either reword the
body to remove the name, or add a name fallback in resolveProactiveMode
before submitting this template for Meta approval.

Language: en (PROACTIVE_TEMPLATE_LANGUAGE).

------------------------------------------------------------
1. The 13 templates
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

6. re_engagement
   env: META_TPL_RE_ENGAGEMENT
   audience: owner
   category: Marketing
   variables: {{1}} = owner first name (fallback: there)
   body: Hi {{1}}! It's Saka. Log one expense today (for example: fuel 3000)
         and I will keep your costs, reminders and compliance dates accurate.

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
   variables: none (static body)
   body: Saka update is LIVE. The new revision is now answering WhatsApp
         conversations.

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
    saka_re_engagement
    saka_driver_unassigned
    saka_winback
    saka_deploy_live
    saka_eval_digest_ping
    saka_care_escalation
    saka_driver_activity
    saka_fleet_auto_audit

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

The env registry registers all 13 knobs under META WHATSAPP, so a typo in a
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
     variables: none (static body - leave the body exactly as written)
     body:      Saka update is LIVE. The new revision is now answering
                WhatsApp conversations.
2. Submit for review and wait for APPROVED. Nothing else changes while it is
   pending: the knob stays unset and the alert keeps its free-form fallback.
3. Set the knob on Cloud Run (creates one new revision; the next boot
   announces itself through the template):
     gcloud run services update saka-fleet --region=europe-west1 --update-env-vars="META_TPL_DEPLOY_LIVE=saka_deploy_live"
4. Verify parity: npm run env:audit (META WHATSAPP section) and npm run health
   - both green. The next deployed revision emits the LIVE alert through the
   approved template even outside the 24-hour window.
5. Rollback: unset the knob. No schema, no migration, no flag.


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

