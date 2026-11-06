# Saka Fleet - Meta template approval contract (v1.63.0, section 182)

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

Language: en (PROACTIVE_TEMPLATE_LANGUAGE).

------------------------------------------------------------
1. The 11 templates
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
   audience: superadmin
   category: Utility
   variables: none (static body)
   body: Saka update is LIVE. The new revision is now answering WhatsApp
         conversations.

10. eval_digest_ping
    env: META_TPL_EVAL_DIGEST_PING
    audience: superadmin
    category: Utility
    variables: none (static body)
    body: The 6-hour conversation eval digest just went out by email. Check
          your inbox for the summary.

11. care_escalation
    env: META_TPL_CARE_ESCALATION
    audience: care worker
    category: Utility
    variables: none (static body)
    body: New support ticket in Saka. Open the care console to review and
          reply.

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

The env registry registers all 11 knobs under META WHATSAPP, so a typo in a
knob name is reported (names only, never values).

------------------------------------------------------------
4. Fallback contract (never worse than today)
------------------------------------------------------------

- Knob unset -> free-form text, byte-identical to pre-v1.63.0 (proven by
  test_sentinel_policy and every sender suite).
- Knob set but a required variable is missing/empty -> free-form text.
- Knob set but Meta rejects the template send -> the text path still tries
  (it only delivers inside the window, exactly like today).
- Rollback: unset the knob(s). No schema, no migration, no flag needed.
