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
  TRANSFER_OPEN_STATUSES
} from './dashboard.js';

export const ADMIN_ACTION_WORDS = Object.freeze({
  impersonate: 'IMPERSONATE',
  reset: 'RESET',
  extendTrial: 'EXTEND',
  email: 'SEND'
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
  emailHtmlFromText
};




