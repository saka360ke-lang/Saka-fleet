/**
 * Saka Fleet — superadmin write actions (v1.91.0, Phase 28A)
 * ----------------------------------------------------------
 * The render layer + read-only loaders behind the six superadmin tools:
 * impersonate (read-only), reset, extend trial, passbook view, facilitate a
 * transfer and email-as-Saka. Every route lives in `src/routes/dashboard.js`
 * and keeps the guard stack there (flag gate → Origin → admin session →
 * 5/5-min rate limit → typed confirmation → reason → audit → 303).
 * Nothing here writes data: loaders only read, renderers only shape HTML.
 */

import {
  adminNav,
  escapeHtml,
  maskEmail,
  maskPhone,
  renderPageShell,
  renderErrorPage,
  TRANSFER_OPEN_STATUSES
} from './dashboard.js';
// v1.97.0 — the user-management CRM resolves plans through the canonical matrix
// and recognises the superadmin identity (never invents a tier or a price).
import { getTierDefinition, listPaidTierKeys, normalizeTierKey } from './subscriptionTiers.js';
import { isSuperadminPhone } from './superadminIdentity.js';

export const ADMIN_ACTION_WORDS = Object.freeze({
  impersonate: 'IMPERSONATE',
  reset: 'RESET',
  extendTrial: 'EXTEND',
  email: 'SEND',
  // v1.97.0 — the user-management CRM (every write is typed-confirmed).
  identity: 'UPDATE',
  tier: 'TIER',
  verify: 'VERIFY',
  logout: 'LOGOUT',
  wipe: 'WIPE'
});

export const TRANSFER_STATUS_ADMIN_COPY = Object.freeze({
  PENDING_TARGET_DETAILS: 'Step 2 — buyer details (do it here)',
  PENDING_OWNER_RELEASE_OTP: 'Step 3 — owner release PIN',
  PENDING_BUYER_ACCEPTANCE: 'Step 4 — waiting for the buyer ACCEPT on WhatsApp',
  PENDING_BUYER_OTP: 'Step 5 — waiting for the buyer email code',
  PENDING_BUYER_UPGRADE: 'Paused — the buyer must free a plan slot first'
});

/** `••••••4352` — enough to compare, not enough to leak. */
export function maskIdentifier(value, visible = 4) {
  const text = String(value ?? '');
  if (!text) return '—';
  if (text.length <= visible) return '•'.repeat(text.length);
  return `${'•'.repeat(6)}${text.slice(-visible)}`;
}

/** A masked value that reveals the full one on click (server-rendered, no JS). */
export function revealHtml(value, label = 'Reveal') {
  const text = String(value ?? '');
  if (!text) return '<span class="muted">—</span>';
  return `<details class="reveal"><summary>${escapeHtml(maskIdentifier(text))}</summary><code>${escapeHtml(text)}</code> <span class="muted">${escapeHtml(label)}</span></details>`;
}

/** Hour:minute in Africa/Nairobi (rule 7 canonical timezone). */
export function formatImpersonationExpiry(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'soon';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

/** The sticky yellow strip (D1) — rendered on every impersonated page. */
export function renderImpersonationBanner({ targetName, expiresAt } = {}) {
  const name = escapeHtml(targetName || 'this account');
  const until = escapeHtml(formatImpersonationExpiry(expiresAt));
  return `<div class="as-banner" role="status" style="position:sticky;top:0;z-index:60;background:#FDE68A;color:#3F2A00;border-bottom:1px solid #E0B44A;padding:10px 16px;text-align:center;font-weight:600;font-size:14px;">🟡 Impersonating ${name} — expires ${until} · <a href="/d/admin/exit-as" style="color:#3F2A00;text-decoration:underline;font-weight:700;">Exit</a></div>`;
}

/** Inject the banner right after the shared shell's header. */
export function withImpersonationBanner(html, ctx = {}) {
  const text = String(html ?? '');
  const banner = renderImpersonationBanner(ctx);
  if (!text) return banner;
  if (text.includes('</header>')) return text.replace('</header>', `</header>\n${banner}`);
  return `${banner}\n${text}`;
}

/* ------------------------------------------------------------------ */
/* Renderers                                                           */
/* ------------------------------------------------------------------ */

/**
 * The typed-confirmation page. The button stays disabled until the exact word
 * is typed (client JS) and the route re-validates the same word server-side —
 * the JS is never the gate.
 */
export function renderConfirmActionPage({
  title,
  heading,
  description = null,
  targetLabel = null,
  word,
  reasonRequired = true,
  formAction,
  submitLabel = 'Continue',
  fields = [],
  warning = null,
  error = null
} = {}) {
  const fieldHtml = (fields || []).map((field) => {
    // v1.97.0 — a select field (the manual tier picker) renders as a real
    // <select>; everything else keeps the original typed-input behaviour.
    if (field.type === 'select') {
      const options = (field.options || []).map((option) => {
        const value = typeof option === 'string' ? option : option.value;
        const label = typeof option === 'string' ? option : option.label;
        return `<option value="${escapeHtml(value)}"${field.value === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('');
      return `<label>${escapeHtml(field.label || field.name)}<select name="${escapeHtml(field.name)}"${field.required === false ? '' : ' required'}>${options}</select></label>`;
    }
    const attrs = [
      field.type === 'number' ? 'type="number"' : 'type="text"',
      `name="${escapeHtml(field.name)}"`,
      field.min !== undefined ? `min="${Number(field.min)}"` : '',
      field.max !== undefined ? `max="${Number(field.max)}"` : '',
      field.value !== undefined ? `value="${escapeHtml(field.value)}"` : '',
      field.required === false ? '' : 'required'
    ].filter(Boolean).join(' ');
    return `<label>${escapeHtml(field.label || field.name)}<input ${attrs}></label>`;
  }).join('');
  const reasonBlock = reasonRequired
    ? '<label>Reason (required — stored in the audit log)<textarea name="reason" rows="3" minlength="3" maxlength="300" required placeholder="Why is this action needed?"></textarea></label>'
    : '';
  const body = `
<h1>${escapeHtml(heading || title || 'Confirm')}</h1>
${targetLabel ? `<p class="muted">${escapeHtml(targetLabel)}</p>` : ''}
${description ? `<p>${escapeHtml(description)}</p>` : ''}
${warning ? `<div class="card" style="border-color:#E0B44A;"><p class="muted">${escapeHtml(warning)}</p></div>` : ''}
${error ? `<div class="card" style="border-color:#FCA5A5;"><p>${escapeHtml(error)}</p></div>` : ''}
<div class="card">
<form method="POST" action="${escapeHtml(formAction)}" autocomplete="off">
  ${fieldHtml}
  ${reasonBlock}
  <label>Type <strong>${escapeHtml(word)}</strong> to confirm<input type="text" name="confirm" id="typedConfirm" autocomplete="off" required></label>
  <p><button type="submit" id="typedSubmit" disabled>${escapeHtml(submitLabel)}</button></p>
</form>
</div>
<script>
(function () {
  var input = document.getElementById('typedConfirm');
  var button = document.getElementById('typedSubmit');
  var word = ${JSON.stringify(String(word || ''))};
  function sync() { button.disabled = String((input && input.value) || '').trim() !== word; }
  if (input) { input.addEventListener('input', sync); sync(); }
})();
</script>`;
  return renderPageShell(title || 'Confirm action', body, { headerRight: adminNav() });
}

export function renderAdminPassbookPage({ vehicle, owner, transfers = [] } = {}) {
  const plate = vehicle?.nickname || vehicle?.plate_number || 'Asset';
  const rows = (transfers || []).map((row) => `
      <tr>
        <td>${escapeHtml(row.status || '—')}</td>
        <td>${escapeHtml(row.to_owner_phone ? maskPhone(row.to_owner_phone) : '—')}</td>
        <td>${escapeHtml(row.to_owner_email ? maskEmail(row.to_owner_email) : '—')}</td>
        <td>${row.is_free_transfer ? 'free' : `${escapeHtml(String(row.fee_amount ?? '—'))} ${escapeHtml(String(row.fee_currency || ''))}`}</td>
        <td>${escapeHtml(String(row.initiated_at || '').slice(0, 16).replace('T', ' '))}</td>
      </tr>`).join('');
  const table = rows
    ? `<div class="card table-wrap"><table class="rec"><thead><tr><th>Status</th><th>Buyer phone</th><th>Buyer email</th><th>Fee</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="card"><p class="muted">No handover has ever been started for this asset.</p></div>';
  const body = `
<p class="muted"><a href="/d/admin">← Owners</a> · <a href="/d/admin/owners/${encodeURIComponent(vehicle?.owner_id || '')}">Owner's fleet</a></p>
<h1>Passbook — ${escapeHtml(plate)}</h1>
<p class="muted">${escapeHtml(vehicle?.plate_number || '')}${vehicle?.make_model ? ` · ${escapeHtml(vehicle.make_model)}` : ''} · owner ${escapeHtml(owner?.full_name || 'unknown')} · <span class="chip">${escapeHtml(String(vehicle?.status || 'ACTIVE'))}</span></p>
<div class="card">
  <h2 style="margin-top:0;">Permanent identifiers</h2>
  <p class="muted">Read-only. Reveal shows the full value; the VIN and passbook token can never be edited (rule 8).</p>
  <p>VIN: ${revealHtml(vehicle?.vin, 'reveal VIN')}</p>
  <p>Passbook token: ${revealHtml(vehicle?.qr_passbook_token, 'reveal token')}</p>
  <p>Serial: ${revealHtml(vehicle?.serial_number, 'reveal serial')}</p>
</div>
<h2>Transfer history</h2>
${table}`;
  return renderPageShell(`Passbook — ${plate}`, body, { headerRight: adminNav() });
}

export function renderAdminTransferPage({ vehicle, owner, openTransfer = null, notice = null, error = null, vehicleId = '' } = {}) {
  const plate = vehicle?.nickname || vehicle?.plate_number || 'Asset';
  const base = `/d/admin/transfer/${encodeURIComponent(vehicleId || vehicle?.id || '')}`;
  const status = openTransfer?.status || null;
  let stepBlock = '';
  if (!openTransfer) {
    stepBlock = `<div class="card"><h2 style="margin-top:0;">Step 1 — start the handover</h2>
      <p class="muted">The engine records the handover against the owner's account. No fee is invented here: the first handover per asset per year is free, later ones carry the engine fee at the buyer's payment step.</p>
      <form method="POST" action="${base}/step1"><p><button type="submit">Start handover for ${escapeHtml(plate)}</button></p></form></div>`;
  } else if (status === 'PENDING_TARGET_DETAILS') {
    stepBlock = `<div class="card"><h2 style="margin-top:0;">Step 2 — buyer details</h2>
      <p class="muted">The 6-digit release PIN is emailed ONLY to the owner. Ask the owner for it in WhatsApp — it is never shown here and never copied to you.</p>
      <form method="POST" action="${base}/step2">
        <input type="hidden" name="transfer_id" value="${escapeHtml(openTransfer.id)}">
        <label>Buyer WhatsApp number<input type="text" name="buyer_phone" placeholder="+254 712 345 678" required></label>
        <label>Buyer email<input type="text" name="buyer_email" required></label>
        <p><button type="submit">Save details and email the owner's PIN</button></p>
      </form></div>`;
  } else if (status === 'PENDING_OWNER_RELEASE_OTP') {
    stepBlock = `<div class="card"><h2 style="margin-top:0;">Step 3 — release PIN</h2>
      <p class="muted">Ask the owner for the 6-digit PIN just emailed to them, then type it here. The buyer is messaged on WhatsApp only after a correct PIN.</p>
      <form method="POST" action="${base}/step3">
        <input type="hidden" name="transfer_id" value="${escapeHtml(openTransfer.id)}">
        <label>Release PIN (from the owner)<input type="text" name="release_pin" inputmode="numeric" maxlength="6" required></label>
        <p><button type="submit">Authorise the release</button></p>
      </form>
      <form method="POST" action="${base}/cancel"><input type="hidden" name="transfer_id" value="${escapeHtml(openTransfer.id)}"><p><button type="submit" class="muted">Cancel this handover</button></p></form></div>`;
  } else {
    stepBlock = `<div class="card"><h2 style="margin-top:0;">${escapeHtml(TRANSFER_STATUS_ADMIN_COPY[status] || status || 'In progress')}</h2>
      <p class="muted">Steps 4 and 5 stay on WhatsApp — the buyer replies ACCEPT and then enters the 6-digit code emailed to them. The handover completes only after both consents.</p>
      <p><a href="${base}">Refresh status</a></p>
      <form method="POST" action="${base}/cancel"><input type="hidden" name="transfer_id" value="${escapeHtml(openTransfer.id)}"><p><button type="submit" class="muted">Cancel this handover</button></p></form></div>`;
  }
  const body = `
<p class="muted"><a href="/d/admin">← Owners</a> · <a href="${base}">Refresh</a></p>
<div class="card" style="border-color:#E0B44A;"><p><strong>🛡️ Admin-facilitated transfer</strong> — you drive steps 1-3; the buyer's ACCEPT and email code stay on WhatsApp. The release PIN goes only to the owner.</p></div>
${notice ? `<div class="card" style="border-color:#B8EF5C;"><p>${escapeHtml(notice)}</p></div>` : ''}
${error ? `<div class="card" style="border-color:#FCA5A5;"><p>${escapeHtml(error)}</p></div>` : ''}
<h1>Handover — ${escapeHtml(plate)}</h1>
<p class="muted">Owner ${escapeHtml(owner?.full_name || 'unknown')} · ${escapeHtml(owner?.phone_number ? maskPhone(owner.phone_number) : '—')}${owner?.email ? ` · ${escapeHtml(maskEmail(owner.email))}` : ' · no email on file'}</p>
${openTransfer ? `<p class="muted">Transfer ${escapeHtml(String(openTransfer.id).slice(0, 8))} · ${escapeHtml(String(openTransfer.status || ''))} · started ${escapeHtml(String(openTransfer.initiated_at || '').slice(0, 16).replace('T', ' '))}</p>` : '<p class="muted">No handover in flight.</p>'}
${stepBlock}`;
  return renderPageShell(`Handover — ${plate}`, body, { headerRight: adminNav() });
}

export function renderAdminEmailDraftPage({ profile, subject = '', body: draft = '', error = null, formAction } = {}) {
  const to = profile?.email || null;
  const content = `
<h1>Email as Saka</h1>
<p class="muted">To ${escapeHtml(to ? maskEmail(to) : 'no email on file')} · ${escapeHtml(profile?.full_name || 'account')}</p>
<p class="muted">From <strong>Saka Fleet &lt;reports@reports.sakafleet.com&gt;</strong> — a preview always comes before sending.</p>
${error ? `<div class="card" style="border-color:#FCA5A5;"><p>${escapeHtml(error)}</p></div>` : ''}
<div class="card"><form method="POST" action="${escapeHtml(formAction || '')}" autocomplete="off">
  <input type="hidden" name="action" value="preview">
  <label>Subject<input type="text" name="subject" maxlength="200" value="${escapeHtml(subject)}" required></label>
  <label>Message<textarea name="body" rows="8" maxlength="5000" required>${escapeHtml(draft)}</textarea></label>
  <p><button type="submit">Preview</button></p>
</form></div>`;
  return renderPageShell('Email as Saka', content, { headerRight: adminNav() });
}

export function renderAdminEmailPreviewPage({ profile, subject, body: message, formAction, error = null } = {}) {
  const paragraphs = String(message || '').split('\n').map((line) => escapeHtml(line)).join('<br>');
  const content = `
<h1>Preview</h1>
<p class="muted">To ${escapeHtml(profile?.email ? maskEmail(profile.email) : '—')} · From <strong>Saka Fleet &lt;reports@reports.sakafleet.com&gt;</strong></p>
${error ? `<div class="card" style="border-color:#FCA5A5;"><p>${escapeHtml(error)}</p></div>` : ''}
<div class="card"><h2 style="margin-top:0;">${escapeHtml(subject || '(no subject)')}</h2><p>${paragraphs}</p></div>
<div class="card"><form method="POST" action="${escapeHtml(formAction || '')}" autocomplete="off">
  <input type="hidden" name="action" value="send">
  <input type="hidden" name="subject" value="${escapeHtml(subject)}">
  <textarea name="body" style="display:none">${escapeHtml(message)}</textarea>
  <label>Reason (required — stored in the audit log)<textarea name="reason" rows="2" minlength="3" maxlength="300" required></textarea></label>
  <label>Type <strong>SEND</strong> to confirm<input type="text" name="confirm" id="typedConfirm" autocomplete="off" required></label>
  <p><button type="submit" id="typedSubmit" disabled>Send this email</button></p>
</form></div>
<script>
(function () {
  var input = document.getElementById('typedConfirm');
  var button = document.getElementById('typedSubmit');
  function sync() { button.disabled = String((input && input.value) || '').trim() !== 'SEND'; }
  if (input) { input.addEventListener('input', sync); sync(); }
})();
</script>`;
  return renderPageShell('Email preview', content, { headerRight: adminNav() });
}

/* ------------------------------------------------------------------ */
/* v1.97.0 — user management CRM: list, detail, identity patch          */
/* ------------------------------------------------------------------ */

const PROFILE_SCAN_LIMIT = 2000; // TODO(pagination): a truncated read understates profiles.
const PROFILE_LIST_MAX = 200;
const IDENTITY_UNITS = Object.freeze(['metric', 'imperial']);
const STATUS_WEIGHT = Object.freeze({ superadmin: 0, paid: 1, trial: 2, free: 3, shell: 4 });

function trialDaysLeft(iso, nowMs) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - nowMs) / 86400000);
}

/**
 * `/d/admin/profiles` (v1.97.0) — EVERY live profile (owners, drivers, shells),
 * merged in JS from three reads. Fail-soft per source (rule 50): a failed
 * vehicles/trials read degrades a chip, never the list.
 */
export async function buildAdminProfilesList({ supabase, search = '', limit = 100, now = new Date() } = {}) {
  if (!supabase) return { ok: false };
  const degraded = [];
  try {
    const fullColumns = 'id, full_name, phone_number, email, email_verified, country, subscription_tier, subscription_status, created_at';
    let profiles = [];
    let profileError = null;
    ({ data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select(fullColumns)
      .is('deleted_at', null)
      .limit(PROFILE_SCAN_LIMIT));
    if (profileError) {
      // Rule 50 — a schema without the newer context columns still lists pages.
      ({ data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name, phone_number, email, created_at')
        .is('deleted_at', null)
        .limit(PROFILE_SCAN_LIMIT));
      degraded.push('profile_columns');
    }
    if (profileError) return { ok: false };
    profiles = profiles || [];

    const fleetByOwner = new Map();
    const vehicleRead = await supabase
      .from('vehicles')
      .select('id, owner_id, status')
      .is('deleted_at', null)
      .limit(PROFILE_SCAN_LIMIT);
    if (vehicleRead.error) degraded.push('vehicles');
    for (const row of vehicleRead.data || []) {
      if (!row.owner_id) continue;
      const entry = fleetByOwner.get(row.owner_id) || { total: 0, active: 0 };
      entry.total += 1;
      if (String(row.status || 'ACTIVE').toUpperCase() === 'ACTIVE') entry.active += 1;
      fleetByOwner.set(row.owner_id, entry);
    }

    const trialEndsByOwner = new Map();
    const trialRead = await supabase
      .from('trial_sessions')
      .select('owner_id, ends_at, status')
      .eq('status', 'ACTIVE')
      .limit(PROFILE_SCAN_LIMIT);
    if (trialRead.error) degraded.push('trials');
    for (const row of trialRead.data || []) {
      if (!row.owner_id || !row.ends_at) continue;
      const current = trialEndsByOwner.get(row.owner_id);
      if (!current || new Date(row.ends_at).getTime() > new Date(current).getTime()) {
        trialEndsByOwner.set(row.owner_id, row.ends_at);
      }
    }

    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const term = String(search || '').trim().toLowerCase();
    const termDigits = term.replace(/\D/g, '');
    const rows = profiles.map((person) => {
      const name = person.full_name || null;
      const email = person.email || null;
      const phone = person.phone_number || '';
      const phoneDigits = String(phone).replace(/\D/g, '');
      const fleet = fleetByOwner.get(person.id) || { total: 0, active: 0 };
      const trialEnds = trialEndsByOwner.get(person.id) || null;
      const daysLeft = trialEnds ? trialDaysLeft(trialEnds, nowMs) : null;
      const tierKey = normalizeTierKey(person.subscription_tier) || 'free';
      const status = String(person.subscription_status || '').toUpperCase();
      let statusKey = 'free';
      let statusLabel = 'Free';
      let statusKind = '';
      if (isSuperadminPhone(phone)) {
        statusKey = 'superadmin'; statusLabel = 'Superadmin'; statusKind = 'ok';
      } else if (status === 'PAST_DUE') {
        statusKey = 'paid'; statusLabel = 'Past due'; statusKind = 'bad';
      } else if ((status === 'ACTIVE' || status === 'CANCELING') && tierKey !== 'free') {
        statusKey = 'paid';
        statusLabel = status === 'CANCELING'
          ? `Paid · ${getTierDefinition(tierKey)?.label || tierKey} (canceling)`
          : `Paid · ${getTierDefinition(tierKey)?.label || tierKey}`;
        statusKind = 'ok';
      } else if (trialEnds && daysLeft !== null && daysLeft >= 0) {
        statusKey = 'trial';
        statusLabel = daysLeft === 0 ? 'Trial · ends today' : `Trial · ${daysLeft} d left`;
        statusKind = 'due';
      } else if (trialEnds) {
        statusKey = 'trial'; statusLabel = 'Trial ended'; statusKind = 'bad';
      } else if (!name && !email) {
        statusKey = 'shell'; statusLabel = 'Shell'; statusKind = 'bad';
      }
      return {
        id: person.id,
        name: name || 'Unnamed profile',
        phoneMasked: maskPhone(phone),
        phoneDigits,
        email,
        emailMasked: email ? maskEmail(email) : '—',
        country: person.country || '—',
        statusKey,
        statusLabel,
        statusKind,
        vehicleCount: fleet.total,
        activeCount: fleet.active,
        trialEndsAt: trialEnds,
        trialDaysLeft: daysLeft,
        createdAt: person.created_at || null
      };
    });
    const filtered = rows.filter((row) => {
      if (!term) return true;
      return row.name.toLowerCase().includes(term)
        || String(row.email || '').toLowerCase().includes(term)
        || row.phoneMasked.toLowerCase().includes(term)
        || (termDigits.length >= 3 && row.phoneDigits.includes(termDigits));
    });
    filtered.sort((a, b) => (STATUS_WEIGHT[a.statusKey] - STATUS_WEIGHT[b.statusKey])
      || (b.activeCount - a.activeCount)
      || String(a.name).localeCompare(String(b.name)));
    const cap = Math.max(1, Math.min(PROFILE_LIST_MAX, Number(limit) || 100));
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      profiles: filtered.slice(0, cap),
      totalProfiles: rows.length,
      matchedProfiles: filtered.length,
      degraded
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * One profile row for the write lanes (`select *`, so new columns ride along
 * without a migration). Returns null when the profile does not exist.
 */
export async function loadAdminProfileRow(supabase, id) {
  if (!supabase || !id) return null;
  try {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

/**
 * `/d/admin/profiles/:id` (v1.97.0) — everything about one account. Each
 * optional block degrades independently (rule 50); `degraded` names what failed
 * so the page can say so honestly.
 */
export async function buildAdminProfileDetail({ supabase, id, entitlements = null, now = new Date() } = {}) {
  if (!supabase || !id) return { ok: false, reason: 'not_found' };
  const degraded = [];
  try {
    let profile = null;
    let error = null;
    ({ data: profile, error } = await supabase
      .from('profiles')
      .select('id, full_name, phone_number, email, email_verified, country, country_code, country_source, unit_system, subscription_tier, subscription_status, billing_interval, trial_used_at, created_at, deleted_at')
      .eq('id', id)
      .maybeSingle());
    if (error) {
      ({ data: profile, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone_number, email, country, created_at, deleted_at')
        .eq('id', id)
        .maybeSingle());
      degraded.push('profile_columns');
    }
    if (error || !profile || profile.deleted_at) return { ok: false, reason: 'not_found' };

    const vehicleRead = await supabase
      .from('vehicles')
      .select('id, plate_number, nickname, status, created_at, deleted_at')
      .eq('owner_id', id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (vehicleRead.error) degraded.push('vehicles');

    let tickets = [];
    const phone = profile.phone_number || null;
    const email = profile.email || null;
    if (phone || email) {
      const orParts = [];
      if (phone) orParts.push(`whatsapp_number.eq.${phone}`);
      if (email) orParts.push(`sender_email.eq.${String(email).toLowerCase()}`);
      const ticketRead = await supabase
        .from('support_tickets')
        .select('id, status, priority, issue_category, subject, whatsapp_number, sender_email, created_at')
        .or(orParts.join(','))
        .order('created_at', { ascending: false })
        .limit(3);
      if (ticketRead.error) degraded.push('tickets');
      else tickets = ticketRead.data || [];
    }

    let auditRows = [];
    const auditRead = await supabase
      .from('admin_audit_logs')
      .select('id, action, admin_phone, details, created_at')
      .order('created_at', { ascending: false })
      .limit(300);
    if (auditRead.error) degraded.push('audit');
    else {
      auditRows = (auditRead.data || []).filter((row) => row?.details && row.details.targetId === id);
    }
    const notes = auditRows.filter((row) => row.action === 'ADMIN_PROFILE_NOTE').slice(0, 5);
    const history = auditRows.slice(0, 10);

    return {
      ok: true,
      profile,
      entitlements,
      vehicles: vehicleRead.data || [],
      tickets,
      notes,
      history,
      degraded,
      generatedAt: now instanceof Date ? now.toISOString() : String(now)
    };
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err.message };
  }
}

/**
 * Pure identity whitelist (no DB): name, email, country and units ONLY.
 * Changing the email defaults `email_verified=false` (the new address must be
 * proven) unless the admin ticks "Force Verify" in the same submit. A country
 * change is stamped `country_source='user'` so `reconcile:country` never fights
 * an explicit operator decision. Phone, tier, trial and every identity lock are
 * structurally unreachable here (rules 8/18).
 */
export function applyAdminIdentityUpdate({ profile = {}, body = {} } = {}) {
  const patch = {};
  const before = {};
  const forceVerify = body.force_verify === true || String(body.force_verify || '').toLowerCase() === 'on';

  if (body.full_name !== undefined) {
    const name = String(body.full_name || '').trim().slice(0, 120);
    if (!name) return { ok: false, error: 'Name cannot be empty.' };
    if (name !== (profile.full_name || '')) {
      patch.full_name = name;
      before.full_name = profile.full_name || null;
    }
  }
  if (body.email !== undefined) {
    const emailValue = String(body.email || '').trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(emailValue)) {
      return { ok: false, error: 'Enter a valid email address.' };
    }
    const current = String(profile.email || '').toLowerCase();
    if (emailValue !== current) {
      patch.email = emailValue;
      before.email = profile.email || null;
      // A changed address must be proven again unless the admin explicitly
      // forces verification in the same submit (operator instruction, v1.97.0).
      patch.email_verified = forceVerify === true;
      before.email_verified = profile.email_verified === true;
    } else if (forceVerify === true && profile.email_verified !== true) {
      patch.email_verified = true;
      before.email_verified = false;
    }
  }
  if (body.country !== undefined) {
    const country = String(body.country || '').trim().slice(0, 80);
    if (!country) return { ok: false, error: 'Country cannot be empty.' };
    if (country !== (profile.country || '')) {
      patch.country = country;
      // An explicit operator choice is a user-level lock (reconcile never fights it).
      patch.country_source = 'user';
      before.country = profile.country || null;
    }
  }
  if (body.unit_system !== undefined) {
    const units = String(body.unit_system || '').trim().toLowerCase();
    if (!IDENTITY_UNITS.includes(units)) return { ok: false, error: 'Units must be metric or imperial.' };
    if (units !== String(profile.unit_system || 'metric').toLowerCase()) {
      patch.unit_system = units;
      before.unit_system = profile.unit_system || null;
    }
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'Nothing changed.' };
  return { ok: true, patch, before };
}

/** `/d/admin/profiles` (v1.97.0) — the cross-tenant master list. */
export function renderAdminProfilesPage({ data, search = '', notice = null } = {}) {
  if (!data?.ok) return renderErrorPage(503, 'The profile list could not be loaded just now. Please try again in a moment.').html;
  const rows = (data.profiles || []).map((row) => `
        <tr>
          <td><a href="/d/admin/profiles/${encodeURIComponent(row.id)}">${escapeHtml(row.name)}</a></td>
          <td>${escapeHtml(row.phoneMasked)}</td>
          <td>${escapeHtml(row.emailMasked)}</td>
          <td><span class="chip${row.statusKind ? ` ${row.statusKind}` : ''}">${escapeHtml(row.statusLabel)}</span></td>
          <td class="num">${Number(row.vehicleCount)}${row.activeCount !== row.vehicleCount ? ` <span class="muted">(${Number(row.activeCount)} active)</span>` : ''}</td>
          <td>${escapeHtml(String(row.createdAt || '').slice(0, 10) || '—')}</td>
          <td class="admin-actions"><a href="/d/admin/profiles/${encodeURIComponent(row.id)}">Open</a> · <a href="/d/admin/as-user/${encodeURIComponent(row.id)}">Impersonate</a> · <a href="/d/admin/email/${encodeURIComponent(row.id)}">Email</a></td>
        </tr>`).join('');
  const table = (data.profiles || []).length
    ? `<div class="card table-wrap"><table class="rec">
        <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th class="num">Vehicles</th><th>Joined</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : `<div class="card"><p class="muted">${search ? 'No profile matches that search.' : 'No profiles on file yet.'}</p></div>`;
  const degraded = Array.isArray(data.degraded) && data.degraded.length
    ? `<div class="card" style="border-color:#E0B44A;"><p class="muted">Some data could not be loaded (${data.degraded.map((entry) => escapeHtml(entry)).join(', ')}) — the list still shows everything the database answered.</p></div>`
    : '';
  const body = `
<h1>Profiles</h1>
<p class="muted">${Number(data.totalProfiles || 0)} live profile${Number(data.totalProfiles || 0) === 1 ? '' : 's'}${search ? ` · ${Number(data.matchedProfiles || 0)} match this search` : ''} · owners, drivers and shells · every write is typed-confirmed, reason-stamped and audited</p>
${notice ? `<div class="card" style="border-color:#B8EF5C;"><p>${escapeHtml(notice)}</p></div>` : ''}
${degraded}
<form method="GET" action="/d/admin/profiles" class="filters card">
  <label>Search by name, email or phone<input type="text" name="q" maxlength="60" value="${escapeHtml(search)}"></label>
  <div class="filters-actions"><button type="submit">Search</button><a href="/d/admin/profiles">Clear</a></div>
</form>
${table}`;
  return renderPageShell('Profiles', body, { headerRight: adminNav() });
}

function identitySection(profile, error = null) {
  const id = encodeURIComponent(profile.id);
  const units = String(profile.unit_system || 'metric').toLowerCase();
  return `<div class="card">
<h2 style="margin-top:0;">Identity</h2>
${error ? `<div class="card" style="border-color:#FCA5A5;"><p>${escapeHtml(error)}</p></div>` : ''}
<form method="POST" action="/d/admin/profiles/${id}/identity" data-typed="UPDATE" autocomplete="off">
  <label>Full name<input type="text" name="full_name" maxlength="120" value="${escapeHtml(profile.full_name || '')}"></label>
  <label>Email<input type="email" name="email" maxlength="160" value="${escapeHtml(profile.email || '')}"></label>
  <label style="display:flex;gap:10px;align-items:flex-start;"><input type="checkbox" name="force_verify" style="width:auto;margin-top:4px;"><span>Force Verify — keep this address verified. A CHANGED email must be verified again unless this is ticked.</span></label>
  <label>Country<input type="text" name="country" maxlength="80" value="${escapeHtml(profile.country || '')}"></label>
  <label>Units<select name="unit_system"><option value="metric"${units === 'metric' ? ' selected' : ''}>Metric (km, litres)</option><option value="imperial"${units === 'imperial' ? ' selected' : ''}>Imperial (mi, gallons)</option></select></label>
  <label>Reason (required — stored in the audit log)<textarea name="reason" rows="2" minlength="3" maxlength="300" required></textarea></label>
  <label>Type <strong>UPDATE</strong> to confirm<input type="text" name="confirm" autocomplete="off" required></label>
  <p><button type="submit" data-typed-submit disabled>Save identity</button></p>
</form>
<p class="muted-small">Phone, plan, trial and asset identifiers can never be edited here.</p>
</div>`;
}

function subscriptionSection(profile, entitlements = null) {
  const id = encodeURIComponent(profile.id);
  const currentTier = normalizeTierKey(profile.subscription_tier) || 'free';
  const tierOptions = ['free', ...listPaidTierKeys()].map((key) => {
    const label = key === 'free' ? 'Free' : (getTierDefinition(key)?.label || key);
    return `<option value="${escapeHtml(key)}"${currentTier === key ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  const ent = entitlements;
  const planFacts = ent
    ? `<p class="muted">Engine view: <strong>${escapeHtml(ent.tierKey || currentTier)}</strong> · ${ent.isPaid ? 'paid' : 'no paid plan'}${ent.isTrial ? ` · trial (${Number(ent.trialDaysLeft) || 0} d left)` : ''} · capacity ${Number(ent.effectiveVehicleCapacity) || 1}</p>`
    : '<p class="muted">Entitlements could not be loaded just now — the stored profile facts are shown; the plan engine stays the source of truth.</p>';
  return `<div class="card">
<h2 style="margin-top:0;">Subscription &amp; trial</h2>
<p class="muted">Stored: <strong>${escapeHtml(currentTier)}</strong> · ${escapeHtml(String(profile.subscription_status || '—'))}${profile.billing_interval ? ` · ${escapeHtml(String(profile.billing_interval))}` : ''}${profile.email_verified === false ? ' · email unverified' : ''}</p>
${planFacts}
<p><a class="btn btn-primary" href="/d/admin/extend-trial/${id}" style="padding:10px 18px;">Extend trial</a></p>
<form method="POST" action="/d/admin/profiles/${id}/tier" data-typed="TIER" autocomplete="off">
  <h3>Manual tier override</h3>
  <p class="muted-small">For an offline payment or a support correction. No money moves here, and the billing ledger gains a line marked <em>manual</em>.</p>
  <label>Tier<select name="tier">${tierOptions}</select></label>
  <label>Billing interval<select name="interval"><option value="monthly"${String(profile.billing_interval || 'monthly') !== 'annual' ? ' selected' : ''}>Monthly</option><option value="annual"${String(profile.billing_interval || '') === 'annual' ? ' selected' : ''}>Annual</option></select></label>
  <label>Reason (required — stored in the audit log)<textarea name="reason" rows="2" minlength="3" maxlength="300" required></textarea></label>
  <label>Type <strong>TIER</strong> to confirm<input type="text" name="confirm" autocomplete="off" required></label>
  <p><button type="submit" data-typed-submit disabled>Apply the tier</button></p>
</form>
${profile.email && profile.email_verified !== true ? `<form method="POST" action="/d/admin/profiles/${id}/verify-email" data-typed="VERIFY" autocomplete="off">
  <h3>Force-verify email</h3>
  <p class="muted-small">Marks ${escapeHtml(maskEmail(profile.email))} verified without a code. Only do this when the address is proven by another channel.</p>
  <label>Reason (required — stored in the audit log)<textarea name="reason" rows="2" minlength="3" maxlength="300" required></textarea></label>
  <label>Type <strong>VERIFY</strong> to confirm<input type="text" name="confirm" autocomplete="off" required></label>
  <p><button type="submit" data-typed-submit disabled>Mark verified</button></p>
</form>` : ''}
</div>`;
}

function fleetSection(vehicles = []) {
  const rows = (vehicles || []).map((vehicle) => `
      <tr>
        <td>${escapeHtml(vehicle.nickname || vehicle.plate_number || 'Asset')}${vehicle.nickname && vehicle.plate_number ? ` <span class="muted">(${escapeHtml(vehicle.plate_number)})</span>` : ''}</td>
        <td>${escapeHtml(String(vehicle.status || '—'))}</td>
        <td>${escapeHtml(String(vehicle.created_at || '').slice(0, 10) || '—')}</td>
        <td><a href="/d/admin/passbook/${encodeURIComponent(vehicle.id)}">Passbook</a> · <a href="/d/admin/owners/${encodeURIComponent(vehicle.owner_id || '')}">Fleet</a></td>
      </tr>`).join('');
  return `<div class="card">
<h2 style="margin-top:0;">Fleet</h2>
${rows ? `<div class="table-wrap"><table class="rec"><thead><tr><th>Asset</th><th>Status</th><th>Added</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">No assets on file.</p>'}
</div>`;
}

function supportSection(tickets = [], degraded = false) {
  if (degraded) {
    return `<div class="card"><h2 style="margin-top:0;">Support</h2><p class="muted">Support tickets could not be loaded just now — the rest of this page is unaffected.</p></div>`;
  }
  const rows = (tickets || []).map((ticket) => `
      <tr>
        <td>${escapeHtml(String(ticket.status || '—'))}</td>
        <td>${escapeHtml(String(ticket.priority || '—'))}</td>
        <td>${escapeHtml(ticket.subject || ticket.issue_category || '—')}</td>
        <td>${escapeHtml(String(ticket.created_at || '').slice(0, 16).replace('T', ' ') || '—')}</td>
      </tr>`).join('');
  return `<div class="card">
<h2 style="margin-top:0;">Support</h2>
${rows ? `<div class="table-wrap"><table class="rec"><thead><tr><th>Status</th><th>Priority</th><th>Subject</th><th>Opened</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">No support tickets for this phone or email.</p>'}
</div>`;
}

function notesSection(profile, notes = []) {
  const id = encodeURIComponent(profile.id);
  const list = (notes || []).map((note) => `
    <li><span class="muted">${escapeHtml(String(note.created_at || '').slice(0, 16).replace('T', ' '))}${note.admin_phone ? ` · ${escapeHtml(maskPhone(note.admin_phone))}` : ''}</span><br>${escapeHtml(String(note.details?.note || ''))}</li>`).join('');
  return `<div class="card">
<h2 style="margin-top:0;">Internal notes</h2>
${list ? `<ul class="plain">${list}</ul>` : '<p class="muted">No notes yet.</p>'}
<form method="POST" action="/d/admin/profiles/${id}/note" autocomplete="off">
  <label>New note (3-500 characters — stored in the audit log with your number)<textarea name="note" rows="3" minlength="3" maxlength="500" required placeholder="Called David — he will pay next week."></textarea></label>
  <p><button type="submit">Save note</button></p>
</form>
</div>`;
}

function securitySection(profile) {
  const id = encodeURIComponent(profile.id);
  return `<div class="card">
<h2 style="margin-top:0;">Security</h2>
<p class="muted">Force logout ends every live dashboard session for this account (owner and driver lanes) and clears any impersonation row pointing at it. Their WhatsApp access is untouched.</p>
<form method="POST" action="/d/admin/profiles/${id}/force-logout" data-typed="LOGOUT" autocomplete="off">
  <label>Reason (required — stored in the audit log)<textarea name="reason" rows="2" minlength="3" maxlength="300" required></textarea></label>
  <label>Type <strong>LOGOUT</strong> to confirm<input type="text" name="confirm" autocomplete="off" required></label>
  <p><button type="submit" data-typed-submit disabled>Force logout</button></p>
</form>
</div>`;
}

function dangerSection(profile) {
  const id = encodeURIComponent(profile.id);
  return `<div class="card" style="border-color:#FCA5A5;">
<h2 style="margin-top:0;color:#F87171;">Danger zone</h2>
<p class="muted">Wipe erases the profile, its fleet rows, dashboard sessions and impersonations. Historical logs are preserved per the deletion policy. This cannot be undone; the person can sign up fresh afterwards.</p>
<form method="POST" action="/d/admin/profiles/${id}/wipe" data-typed="WIPE" autocomplete="off">
  <label>Reason (required — stored in the audit log)<textarea name="reason" rows="2" minlength="3" maxlength="300" required></textarea></label>
  <label>Type <strong>WIPE</strong> to confirm<input type="text" name="confirm" autocomplete="off" required></label>
  <p><button type="submit" data-typed-submit disabled style="background:#B91C1C;color:#fff;">Wipe this profile</button></p>
</form>
</div>`;
}

function historySection(history = []) {
  const rows = (history || []).map((row) => `
      <tr>
        <td>${escapeHtml(String(row.action || '—'))}</td>
        <td>${escapeHtml(row.admin_phone ? maskPhone(row.admin_phone) : '—')}</td>
        <td>${escapeHtml(String(row.created_at || '').slice(0, 16).replace('T', ' '))}</td>
        <td>${escapeHtml(String(row.details?.reason || '—').slice(0, 120))}</td>
      </tr>`).join('');
  return `<div class="card">
<h2 style="margin-top:0;">Audit history</h2>
${rows ? `<div class="table-wrap"><table class="rec"><thead><tr><th>Action</th><th>Admin</th><th>When</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">No admin actions recorded for this profile yet.</p>'}
</div>`;
}

/** `/d/admin/profiles/:id` (v1.97.0) — the single-account CRM page. */
export function renderAdminProfileDetailPage({ data, done = null, error = null } = {}) {
  if (!data?.ok) return renderErrorPage(404, 'That account does not exist.').html;
  const profile = data.profile;
  const degraded = Array.isArray(data.degraded) ? data.degraded : [];
  const notices = {
    updated: 'Identity saved — the audit log carries the before/after values.',
    tier: 'Tier override applied and appended to the billing ledger.',
    verified: 'Email marked verified.',
    logout: 'Every dashboard session for this account was ended.',
    note: 'Internal note saved.'
  };
  const notice = notices[done] || null;
  const impersonate = isSuperadminPhone(profile.phone_number)
    ? '<p class="muted-small">The superadmin account can never be impersonated.</p>'
    : `<p><a class="btn btn-ghost" href="/d/admin/as-user/${encodeURIComponent(profile.id)}" style="padding:10px 18px;">Impersonate (read-only)</a> <a class="btn btn-ghost" href="/d/admin/email/${encodeURIComponent(profile.id)}" style="padding:10px 18px;">Email as Saka</a></p>`;
  const trialLine = profile.trial_used_at
    ? `<p class="muted-small">Welcome trial used: ${escapeHtml(String(profile.trial_used_at).slice(0, 10))} · never repeatable.</p>`
    : '';
  const body = `
<h1>${escapeHtml(profile.full_name || 'Unnamed profile')}</h1>
<p class="muted">${escapeHtml(maskPhone(profile.phone_number))} · ${escapeHtml(profile.email ? maskEmail(profile.email) : 'no email on file')} · joined ${escapeHtml(String(profile.created_at || '').slice(0, 10) || '—')} · ${escapeHtml(profile.country || '—')} · ${escapeHtml(String(profile.unit_system || 'metric'))}</p>
${notice ? `<div class="card" style="border-color:#B8EF5C;"><p>${escapeHtml(notice)}</p></div>` : ''}
${error ? `<div class="card" style="border-color:#FCA5A5;"><p>${escapeHtml(error)}</p></div>` : ''}
${degraded.length ? `<div class="card" style="border-color:#E0B44A;"><p class="muted">Degraded: ${degraded.map((entry) => escapeHtml(entry)).join(', ')} — the page shows everything the database answered.</p></div>` : ''}
${trialLine}
${impersonate}
${identitySection(profile)}
${subscriptionSection(profile, data.entitlements)}
${fleetSection(data.vehicles)}
${supportSection(data.tickets, degraded.includes('tickets'))}
${notesSection(profile, data.notes)}
${historySection(data.history)}
${securitySection(profile)}
${dangerSection(profile)}
<script>
(function () {
  var forms = document.querySelectorAll('form[data-typed]');
  for (var i = 0; i < forms.length; i += 1) {
    (function (form) {
      var word = form.getAttribute('data-typed');
      var input = form.querySelector('input[name="confirm"]');
      var button = form.querySelector('[data-typed-submit]');
      if (!input || !button) return;
      function sync() { button.disabled = String(input.value || '').trim() !== word; }
      input.addEventListener('input', sync);
      sync();
    })(forms[i]);
  }
})();
</script>`;
  return renderPageShell(`Profile — ${profile.full_name || 'account'}`, body, { headerRight: adminNav() });
}

/* ------------------------------------------------------------------ */
/* Read-only loaders                                                   */
/* ------------------------------------------------------------------ */

export async function loadAdminPassbook({ supabase, vehicleId } = {}) {
  if (!supabase || !vehicleId) return { ok: false, reason: 'not_found' };
  try {
    const { data: vehicle, error } = await supabase.from('vehicles').select('*').eq('id', vehicleId).maybeSingle();
    if (error || !vehicle || vehicle.deleted_at) return { ok: false, reason: 'not_found' };
    const { data: owner } = await supabase
      .from('profiles')
      .select('id, full_name, phone_number, email')
      .eq('id', vehicle.owner_id)
      .maybeSingle();
    const { data: transfers } = await supabase
      .from('passbook_transfers')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('initiated_at', { ascending: false })
      .limit(25);
    return { ok: true, vehicle, owner: owner || null, transfers: transfers || [] };
  } catch {
    return { ok: false, reason: 'db_error' };
  }
}

export async function buildAdminTransferView({ supabase, vehicleId } = {}) {
  const passbook = await loadAdminPassbook({ supabase, vehicleId });
  if (!passbook.ok) return passbook;
  const openTransfer = (passbook.transfers || []).find((row) => TRANSFER_OPEN_STATUSES.includes(row.status)) || null;
  return { ...passbook, openTransfer };
}

/** Escaped, line-preserving HTML for the outgoing email (never raw HTML). */
export function emailHtmlFromText(message) {
  const lines = String(message || '').split('\n').map((line) => escapeHtml(line)).join('<br>');
  return `<div style="font-family:Arial,sans-serif;color:#333;line-height:1.5;">${lines}</div>`;
}

export default {
  ADMIN_ACTION_WORDS,
  TRANSFER_STATUS_ADMIN_COPY,
  maskIdentifier,
  revealHtml,
  formatImpersonationExpiry,
  renderImpersonationBanner,
  withImpersonationBanner,
  renderConfirmActionPage,
  renderAdminPassbookPage,
  renderAdminTransferPage,
  renderAdminEmailDraftPage,
  renderAdminEmailPreviewPage,
  loadAdminPassbook,
  buildAdminTransferView,
  emailHtmlFromText,
  // v1.97.0 — the user-management CRM.
  buildAdminProfilesList,
  loadAdminProfileRow,
  buildAdminProfileDetail,
  applyAdminIdentityUpdate,
  renderAdminProfilesPage,
  renderAdminProfileDetailPage
};




