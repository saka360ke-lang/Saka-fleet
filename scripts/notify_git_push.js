import { execSync } from 'child_process';

// dotenv is loaded lazily so a missing dependency can never block the primary
// WhatsApp deployment-notification channel. (Resend was removed in v1.14.1:
// deployment emails are muted by policy to protect the daily email quota.)
try {
  const { config } = await import('dotenv');
  config?.();
} catch {}

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

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
  const cleanPhone = superadminPhone ? superadminPhone.replace(/[^\d]/g, '') : null;

  const waMessage = 
`🚀 *Saka Fleet Deployment Alert* 🛠️

A new code version has been pushed/deployed:
• *Commit:* \`${commitHash}\`
• *Branch:* \`${branch}\`
• *Author:* ${author}
• *Summary:* "${commitMessage}"
• *Server Time (EAT):* ${timestamp}
• *Status:* Live & Operational ✅

_Automated deployment hook dispatched to Superadmin._`;

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

