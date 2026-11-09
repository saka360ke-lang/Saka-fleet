# Saka Fleet - Care Worker Guide (v1.58.18)

You are the customer-care worker for Saka Fleet. You work inside WhatsApp with the **care console**: every support request - from chat or from email at **support@reports.sakafleet.com** - becomes a tracked ticket you can read, reply to, classify, escalate and close.

This guide is the whole job. If a command is not in here, it is not yours to run.

---

## 1. What you can do

| Command | What it does |
| :--- | :--- |
| `care` or `care help` | the command list |
| `care inbox` | open tickets (also `care inbox high`, `care inbox all`) |
| `care read <id>` | the full ticket + thread |
| `care reply <id> <text>` | reply on WhatsApp **and** email |
| `care email <id> <text>` | email only (no WhatsApp on file) |
| `care note <id> <text>` | internal note (customers never see it) |
| `care take <id>` / `care release <id>` | claim / hand back a ticket |
| `care escalate <id>` | high priority + superadmin alert |
| `care deescalate <id>` | back to medium |
| `care close <id>` / `care reopen <id>` | lifecycle |
| `care search <word>` | find by phone, email or text |
| `care stats` | open / in-progress / high / resolved / closed |
| `care audit` | your recent actions (also visible to the superadmin) |

## 2. What you must never do

- **Never** change a ledger entry, expense, vehicle, VIN, plate, driver or subscription. You have no such command - do not promise one.
- **Never** promise a refund, discount, price, trial extension or payment outcome. The billing engine owns money; say you have escalated a billing case.
- **Never** share one customer's data with another, or repeat data you were not given.
- **Never** claim something was saved or sent unless the console confirms it.
- **Never** run or imitate `admin` commands - they are superadmin-only and the system blocks them.

## 2b. Superadmin web tools (v1.91.0) - not yours

The superadmin's `/d/admin` console now carries six write actions: impersonate an owner (**READ-ONLY, 30 minutes**, yellow banner, Exit never signs the admin out), reset a profile (typed `RESET` + reason), extend an account trial (engine-owned 45-day cap), view a passbook (VIN + passbook token masked, reveal on demand), facilitate a passbook transfer (steps 1-3 on the web; the release PIN is emailed **ONLY** to the owner and relayed in WhatsApp; the buyer ACCEPT and email code stay on WhatsApp) and email-as-Saka. Every action is typed-confirmed, reason-stamped and written to `admin_audit_logs`. Care workers never use, request or promise these tools - escalate to the superadmin (section 5).

## 3. How a ticket reaches you

- **WhatsApp:** the customer asks for support -> the engine opens a ticket, emails the support inbox and pings the superadmin when it is high priority.
- **Email:** a customer writes to **support@reports.sakafleet.com** -> the signature is verified, the message is classified (bug / billing / feature / driver / vehicle / logging / other + priority) and threaded into their open ticket. Replies to the same email thread join the same ticket (`CARE_THREAD_WINDOW_HOURS`, default 7 days).
- Every new or updated ticket pings you on WhatsApp with the sender, subject, category and priority.

## 3b. Amina — the autonomous care agent (v1.80.0)

When `CARE_AI_ENABLED=on`, **Amina** triages every inbound email BEFORE it reaches you:

- She **investigates**: the customer's profile and vehicles, the last errors that mention them, the last WhatsApp messages they exchanged with Saka and the local billing mirror (up to 3 tool rounds). She never guesses when a tool can tell her.
- She **answers** only when her confidence clears `CARE_AI_CONFIDENCE_FLOOR` (default 0.7) — the reply goes out by email and the ticket becomes **RESOLVED**.
- She **escalates** everything else — and money, refunds, duplicate charges, Paystack disputes, legal/account actions and high-priority mail go straight to you with **zero** AI time. The forward arrives at `CARE_ESCALATION_EMAIL` (default **support@sakafleet.com**) with a subject like `[SFC-ab12cd34] Re: …` and a body that says exactly what she checked and where she is stuck, plus her unsent draft.
- **Reply to that email and KEEP the `[SFC-…]` tag in the subject.** Your answer lands on the same ticket as an internal note, puts it IN_PROGRESS, assigns it to you, and teaches Amina one reusable rule (the newest 10 rules are read before her next investigation). Personal data, prices and refund promises are stripped/refused from lessons.
- **Ticket statuses:** 🔵 OPEN · 🟡 IN_PROGRESS · 🚨 **ESCALATED** (yours — Amina never re-answers it) · 🟢 RESOLVED · ⚪ CLOSED. `care inbox escalated`, `care read <id>` (shows Amina's draft) and the superadmin page **`/d/care`** (investigation log + drafts + lessons) are your lanes.
- A customer follow-up on a RESOLVED ticket **reopens the same ticket** — it never becomes a duplicate.
- Amina can never change a ledger entry, a VIN, a plan, a price or a refund. If an escalation needs money or data, it stays yours.

## 4. Your shift routine

1. `care stats` - get your bearings.
2. `care inbox high` - high priority first, then `care inbox`.
3. `care read <id>` - read the whole thread before replying.
4. `care take <id>` - claim it so two people do not answer it twice.
5. Reply with `care reply <id> <text>` (both channels) or `care email <id> <text>`.
6. `care note <id> <text>` - record anything the next person must know.
7. `care close <id>` when it is genuinely solved; `care reopen <id>` if it comes back.
8. `care escalate <id>` the moment it turns into money, legal, safety or a data request.

**Service targets:** first reply within **4 working hours**; an update at least every **24 hours** while open; close or escalate within **72 hours**. An unanswered high-priority ticket is a failure, not a queue item.

## 5. Escalation ladder

Escalate when any of these is true:

- a refund, chargeback, duplicate charge or subscription dispute;
- legal, regulatory, compliance or data-deletion request;
- safety, security or account-takeover concern;
- a complaint about Saka or a staff decision;
- two replies without a resolution.

`care escalate <id>` marks high priority and alerts the superadmin by **WhatsApp and email**. De-escalate with `care deescalate <id>` once it is a normal answered question again. Never close an escalated ticket without the superadmin's answer.

## 6. Tone (non-negotiable)

Plain language, short sentences, one clear next step. Warm, never sarcastic, never scolding, never shaming. Gender-neutral. No jargon. Numbers always with units and currency. One gentle emoji per line at most. Every country is welcome - greet the way the customer greets you and never assume a language, currency or date format.

## 7. Sample replies

**First contact**
> Thank you for flagging this. I can see your message and I am looking into it now. I will come back to you here within 4 hours with a clear next step.

**Refund / duplicate charge (escalate first)**
> I am sorry about the duplicate charge. I have escalated this to our billing lead as a high-priority case - you will hear from us by email and WhatsApp as soon as it is reviewed. I cannot promise a refund myself, but this is with the right person now.

**Complaint about Saka**
> That is fair feedback and I am sorry we made you repeat yourself. I have passed this to the team lead. Here is what I can do right now: [one concrete action].

**Follow-up**
> A quick update: this is still with [team] and I am watching it. Nothing is needed from you right now; I will update you again by [time].

**Closing**
> All sorted - [one-line summary]. I have closed this ticket; if anything comes back, just reply here and it reopens with the full history.

## 8. Training checklist (before your first shift)

- [ ] `care help` runs and you can name every command.
- [ ] You can read a ticket end-to-end and state its category and priority.
- [ ] You can explain what you may never touch (ledger, VIN, billing, refunds).
- [ ] You have replied on WhatsApp and by email from the console.
- [ ] You have escalated one ticket and de-escalated another.
- [ ] You know the SLA: 4 hours first reply, 24 hours update, 72 hours close-or-escalate.
- [ ] You know the support address: **support@reports.sakafleet.com**.

The superadmin can audit every action (`care audit`), so work as if your notes are read - because they are.
