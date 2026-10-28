import { execSync } from 'child_process';

// Optional dependencies are loaded lazily so a missing SDK (e.g. in a minimal CI
// runner) can never block the primary WhatsApp deployment-notification channel.
let Resend = null;
try {
  ({ Resend } = await import('resend'));
} catch {}

try {
  const { config } = await import('dotenv');
  config?.();
} catch {}

export async function sendAdminDeploymentAlert(customData = {}) {
  const superadminPhone = process.env.SUPERADMIN_PHONE;
  const superadminEmail = process.env.SUPERADMIN_EMAIL || 'saka360ke@gmail.com';
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;
  const resendApiKey = process.env.RESEND_API_KEY;

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

  let emailSuccess = false;
  if (resendApiKey && superadminEmail && Resend) {
    try {
      const resend = new Resend(resendApiKey);
      const { error } = await resend.emails.send({
        from: 'Saka Fleet Deployment <reports@reports.sakafleet.com>',
        to: [superadminEmail],
        subject: `🚀 Deployment Alert: Saka Fleet (${commitHash})`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
            <h2 style="color: #0284c7; border-bottom: 2px solid #0284c7; padding-bottom: 10px; margin-top: 0;">Saka Fleet Deployment Alert 🛠️</h2>
            <p>A new code version has been pushed and is now live.</p>
            <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
              <tr><td style="padding: 8px 0; font-weight: bold; width: 100px;">Commit:</td><td style="padding: 8px 0;"><code>${commitHash}</code></td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold;">Branch:</td><td style="padding: 8px 0;">${branch}</td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold;">Author:</td><td style="padding: 8px 0;">${author}</td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold;">Summary:</td><td style="padding: 8px 0;">${commitMessage}</td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold;">Time (EAT):</td><td style="padding: 8px 0;">${timestamp}</td></tr>
            </table>
            <p style="margin-top: 20px; font-weight: bold; color: #16a34a;">Status: Live & Operational ✅</p>
          </div>
        `
      });
      if (error) {
        console.error('[notify_git_push] Resend API Error:', error);
      } else {
        console.log(`✅ Email deployment alert dispatched to ${superadminEmail}.`);
        emailSuccess = true;
      }
    } catch (err) {
      console.error('[notify_git_push] Email Exception:', err.message);
    }
  }

  return { success: waSuccess || emailSuccess, waSuccess, emailSuccess };
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

