import dotenv from 'dotenv';
dotenv.config();
import { execSync } from 'child_process';

export async function sendAdminDeploymentAlert(customData = {}) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;

  if (!superadminPhone || !phoneNumberId || !token) {
    console.warn('[notify_git_push] Missing SUPERADMIN_PHONE, META_PHONE_NUMBER_ID, or META_WHATSAPP_TOKEN. Skipping WhatsApp alert.');
    return { skipped: true, reason: 'Missing credentials' };
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
      commitHash = commitHash || process.env.GITHUB_SHA?.slice(0, 7) || 'HEAD';
      author = author || process.env.GITHUB_ACTOR || 'Deploy Bot';
      commitMessage = commitMessage || 'Production deployment update';
    }
  }

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
  const cleanPhone = superadminPhone.replace(/[^\d]/g, '');

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
      return { success: false, error: data };
    }

    console.log(`✅ WhatsApp deployment alert dispatched to ${superadminPhone}. Message ID: ${data?.messages?.[0]?.id}`);
    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    console.error('[notify_git_push] Exception:', err.message);
    return { success: false, error: err.message };
  }
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
