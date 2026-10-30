import { execSync } from 'child_process';
import fs from 'node:fs';

// dotenv is loaded lazily so a missing dependency can never block the primary
// WhatsApp deployment-notification channel. (Resend was removed in v1.14.1:
// deployment emails are muted by policy to protect the daily email quota.)
try {
  const { config } = await import('dotenv');
  config?.();
} catch {}

function architectureHeadline(version) {
  try {
    const arch = fs.readFileSync('SAKA_FLEET_ARCHITECTURE.md', 'utf8');
    const normalized = (line) => line.replace(/\*/g, '').split('|').map((cell) => cell.trim());
    const row = arch.split('\n').find((line) => normalized(line)[1] === String(version));
    if (!row) return null;
    const cells = row.split('|').map((cell) => cell.trim());
    return cells[2] || null;
  } catch { return null; }
}

export function buildDeploymentAlertText({ version = 'unknown', commitHash = 'HEAD', branch = 'main', author = 'Deploy Bot', timestamp = '' } = {}) {
  const headline = architectureHeadline(version) || 'A new version of Saka is running.';
  const needsCheck = /migrat|secret|environment variable|env knob/i.test(headline);
  return [
    '✅ *Saka update is live* - v' + version,
    '',
    '*In plain words:* ' + headline,
    '*What this means:* this is the version now answering WhatsApp conversations.',
    '*Action needed:* ' + (needsCheck ? 'Check the release notes in SAKA_FLEET_ARCHITECTURE.md.' : 'None - everything is automatic.'),
    '',
    'Details: commit ' + commitHash + ' - branch ' + branch + ' - by ' + author + ' - ' + timestamp
  ].join('\n');
}

export async function sendAdminDeploymentAlert(customData = {}) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;

  if (!superadminPhone || !phoneNumberId || !token) {
    console.warn('[notify_git_push] Missing SUPERADMIN_PHONE, META_PHONE_NUMBER_ID, or META_WHATSAPP_TOKEN. WhatsApp alert may fail.');
  }

  let commitHash = customData.commitHash;
  let author = customData.author;
  let commitMessage = customData.commitMessage;
  let branch = customData.branch || 'main';

  // Extract from local git if not provided
  if (!commitHash || !author || !commitMessage) {
    try {
      const gitInfo = execSync('git --no-pager log -1 --format="%h|%an|%s"', { encoding: 'utf-8' }).trim();
      const parts = gitInfo.split('|');
      commitHash = commitHash || parts[0];
      author = author || parts[1];
      commitMessage = commitMessage || parts[2];
      try {
        branch = execSync('git --no-pager branch --show-current', { encoding: 'utf-8' }).trim() || branch;
      } catch {}
    } catch (e) {
      commitHash = commitHash || process.env.GITHUB_SHA?.slice(0, 7) || process.env.RENDER_GIT_COMMIT?.slice(0, 7) || 'HEAD';
      author = author || process.env.GITHUB_ACTOR || 'Deploy Bot';
      commitMessage = commitMessage || 'Production deployment update';
    }
  }

  let releaseVersion = 'unknown';
  try {
    const archText = fs.readFileSync('SAKA_FLEET_ARCHITECTURE.md', 'utf8');
    const versionMatch = archText.match(/\*\*Version:\*\*\s*([0-9]+\.[0-9]+\.[0-9]+)/);
    if (versionMatch) releaseVersion = versionMatch[1];
  } catch {}  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
  const cleanPhone = superadminPhone ? superadminPhone.replace(/[^\d]/g, '') : null;

  const waMessage = buildDeploymentAlertText({ version: releaseVersion, commitHash, branch, author, timestamp });

  let waSuccess = false;
  if (cleanPhone && phoneNumberId && token) {
    try {
      const res = await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanPhone,
          type: 'text',
          text: { body: waMessage }
        })
      });

      const data = await res.json();
      if (!res.ok) {
        console.error('[notify_git_push] WhatsApp API Error:', data);
      } else {
        console.log(`✅ WhatsApp deployment alert dispatched to ${superadminPhone}. Message ID: ${data?.messages?.[0]?.id}`);
        waSuccess = true;
      }
    } catch (err) {
      console.error('[notify_git_push] WhatsApp Exception:', err.message);
    }
  }

  // Deployment EMAIL alerts are muted by policy (v1.14.1) to protect the daily
  // Resend quota; WhatsApp remains the primary deployment channel. Re-enable by
  // restoring a Resend send block here - never silently re-add it.
  console.log('[deploy] Email deployment alert skipped - quota-protection policy (v1.14.1).');
  const emailSuccess = false;

  return { success: waSuccess, waSuccess, emailSuccess };
}

// Direct CLI invocation
if (process.argv[1] && process.argv[1].endsWith('notify_git_push.js')) {
  sendAdminDeploymentAlert()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal deployment alert error:', err);
      process.exit(1);
    });
}

