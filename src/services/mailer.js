import { Resend } from 'resend';

function getResendClient() {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY is missing in environment');
    return new Resend(key);
}

export async function sendReportByEmail(targetEmail, plateNumber, pdfBuffer) {
    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Assistant <reports@reports.sakafleet.com>', 
            to: [targetEmail],
            subject: `Vehicle Audit Report - ${plateNumber}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h2>Saka Vehicle & Asset Assistant</h2>
                    <p>Hello,</p>
                    <p>Please find attached your official vehicle audit report for <strong>${plateNumber}</strong>.</p>
                    <p>Best regards,<br><strong>Saka Assistant</strong></p>
                </div>
            `,
            attachments: [
                {
                    filename: `saka-report-${plateNumber.replace(/\s+/g, '_')}.pdf`,
                    content: pdfBuffer, // Native Buffer support
                }
            ]
        });

        if (error) {
            console.error('Resend API Error:', error);
            throw new Error(`Failed to send email: ${error.message}`);
        }

        console.log(`[Resend] Email successfully dispatched to ${targetEmail}. ID: ${data.id}`);
        return true;
    } catch (err) {
        console.error('Resend Mailer Exception:', err.message);
        throw err;
    }
}

export async function sendMfaEmail(targetEmail, code) {
    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Security <security@reports.sakafleet.com>',
            to: [targetEmail],
            subject: 'Saka Security Alert: Account Deactivation Verification Code',
            html: `
                <div style="font-family: Arial, sans-serif; color: #333; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px;">
                    <h2 style="color: #0f172a;">Saka Security Verification</h2>
                    <p>Hello,</p>
                    <p>A request was made to deactivate your Saka account via WhatsApp. To finalize account deactivation and soft-deletion of your profile, please use the following verification code:</p>
                    <div style="background-color: #f1f5f9; padding: 15px; font-size: 28px; font-weight: bold; letter-spacing: 6px; text-align: center; border-radius: 6px; color: #0284c7; margin: 20px 0;">
                        ${code}
                    </div>
                    <p style="font-size: 12px; color: #64748b;">This code is valid for 5 minutes. If you did not initiate this request, please ignore this email and contact support.</p>
                </div>
            `
        });

        if (error) {
            console.error('Resend MFA API Error:', error);
            throw new Error(`Failed to send MFA email: ${error.message}`);
        }

        console.log(`[Resend MFA] Verification code dispatched to ${targetEmail}. ID: ${data.id}`);
        return true;
    } catch (err) {
        console.error('Resend MFA Mailer Exception:', err.message);
        throw err;
    }
}

export async function sendAdminNotificationEmail(subject, htmlContent) {
    const targetEmail = process.env.SUPERADMIN_EMAIL;
    if (!targetEmail || !process.env.RESEND_API_KEY) return false;

    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Admin Alert <security@reports.sakafleet.com>',
            to: [targetEmail],
            subject: subject,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px;">
                    <h2 style="color: #0f172a;">🔒 Saka Fleet Superadmin Notification</h2>
                    <div>${htmlContent}</div>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin-top: 20px;">
                    <p style="font-size: 12px; color: #64748b;">This notification was dispatched automatically by Saka Fleet Backend Sentinel.</p>
                </div>
            `
        });

        if (error) {
            console.error('[Resend Admin Email Error]:', error.message);
            return false;
        }

        console.log(`[Resend Admin Notification] Email sent to ${targetEmail}. ID: ${data.id}`);
        return true;
    } catch (err) {
        console.error('[Resend Admin Email Exception]:', err.message);
        return false;
    }
}

/**
 * Remediation proposal approval request (v1.10.0).
 * Dual-channel companion to the WhatsApp summary; never throws.
 */
export async function sendRemediationProposalEmail({
    proposalCode,
    title,
    riskLevel = 'low',
    overview = '',
    changes = [],
    evidenceCount = 0
} = {}) {
    const targetEmail = process.env.SUPERADMIN_EMAIL;
    if (!targetEmail || !process.env.RESEND_API_KEY) return false;

    const esc = (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const rows = (Array.isArray(changes) ? changes : []).slice(0, 8).map((change, index) => `
        <tr>
            <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${index + 1}</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;"><code>${esc(change.file)}</code></td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${esc(change.change)}</td>
        </tr>`).join('');

    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Remediation <security@reports.sakafleet.com>',
            to: [targetEmail],
            subject: `Approval required: ${proposalCode} (${riskLevel} risk)`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 640px; margin: auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px;">
                    <h2 style="color: #0f172a; margin-top: 0;">Autonomous Remediation Approval</h2>
                    <p><strong>Saka Sentinel</strong> audited the last 24 hours of logs and <strong>Cline</strong> drafted a scoped fix. No code will change without your explicit approval.</p>
                    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                        <tr><td style="padding: 6px 8px; font-weight: bold; width: 140px;">Proposal:</td><td style="padding: 6px 8px;"><code>${esc(proposalCode)}</code></td></tr>
                        <tr><td style="padding: 6px 8px; font-weight: bold;">Title:</td><td style="padding: 6px 8px;">${esc(title)}</td></tr>
                        <tr><td style="padding: 6px 8px; font-weight: bold;">Risk level:</td><td style="padding: 6px 8px;">${esc(riskLevel)}</td></tr>
                        <tr><td style="padding: 6px 8px; font-weight: bold;">Evidence rows:</td><td style="padding: 6px 8px;">${Number(evidenceCount) || 0}</td></tr>
                    </table>
                    <p>${esc(overview)}</p>
                    ${rows ? `<h3 style="margin-bottom: 8px;">Proposed changes</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        <thead><tr style="background: #f8fafc;"><th style="text-align: left; padding: 6px 8px;">#</th><th style="text-align: left; padding: 6px 8px;">File</th><th style="text-align: left; padding: 6px 8px;">Change</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>` : ''}
                    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 16px; margin-top: 20px;">
                        <p style="margin: 0 0 8px 0; font-weight: bold;">Reply on WhatsApp to decide:</p>
                        <p style="margin: 4px 0;"><code>admin accept fix ${esc(proposalCode)}</code></p>
                        <p style="margin: 4px 0;"><code>admin decline fix ${esc(proposalCode)}</code></p>
                        <p style="margin: 4px 0;"><code>admin modify fix ${esc(proposalCode)} &lt;your guidance&gt;</code></p>
                    </div>
                    <p style="font-size: 12px; color: #64748b; margin-top: 20px;">Tests run before and after execution. A failed suite aborts the run and no code is pushed.</p>
                </div>
            `
        });

        if (error) {
            console.error('[Resend Remediation Email Error]:', error.message);
            return false;
        }

        console.log(`[Resend Remediation] Approval request sent to ${targetEmail}. ID: ${data?.id}`);
        return true;
    } catch (err) {
        console.error('[Resend Remediation Email Exception]:', err.message);
        return false;
    }
}

export async function sendEmailOtp(targetEmail, code) {
    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Security <security@reports.sakafleet.com>',
            to: [targetEmail],
            subject: 'Saka Fleet: Your Verification Code',
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 520px; margin: auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px; background: #ffffff;">
                    <h2 style="color: #0f172a; margin-top: 0;">Saka Fleet Verification</h2>
                    <p>Hello,</p>
                    <p>Please enter the following 6-digit verification code in WhatsApp to verify your email address and finalize your vehicle passbook:</p>
                    <div style="background-color: #f0f9ff; border: 1px solid #bae6fd; padding: 16px; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; border-radius: 8px; color: #0284c7; margin: 24px 0;">
                        ${code}
                    </div>
                    <p style="font-size: 13px; color: #64748b;">This verification code is valid for 10 minutes. If you did not request this verification, please disregard this email.</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin-top: 24px;">
                    <p style="font-size: 12px; color: #94a3b8; margin-bottom: 0;">Saka Fleet Operating System • Automated Verification Service</p>
                </div>
            `
        });

        if (error) {
            console.error('[Resend Email OTP Error]:', error);
            throw new Error(`Failed to send Email OTP: ${error.message}`);
        }

        console.log(`[Resend OTP] Dispatched code to ${targetEmail}. ID: ${data?.id}`);
        return true;
    } catch (err) {
        console.error('[Resend Email OTP Exception]:', err.message);
        throw err;
    }
}

/**
 * Owner-side driver-assignment verification code. Sent by email (never by
 * WhatsApp) so the code never appears in chat logs.
 */
export async function sendDriverAssignmentOtp(targetEmail, code, { plate = 'your vehicle', driverPhone = '' } = {}) {
    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Security <security@reports.sakafleet.com>',
            to: [targetEmail],
            subject: `Saka Fleet: Driver assignment verification — ${plate}`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 520px; margin: auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px; background: #ffffff;">
                    <h2 style="color: #0f172a; margin-top: 0;">Driver Assignment Verification</h2>
                    <p>Hello,</p>
                    <p>You requested to assign <strong>${driverPhone || 'a driver'}</strong> to <strong>${plate}</strong> on Saka Fleet.</p>
                    <p>Enter this 6-digit code in WhatsApp to confirm the assignment:</p>
                    <div style="background-color: #f0f9ff; border: 1px solid #bae6fd; padding: 16px; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; border-radius: 8px; color: #0284c7; margin: 24px 0;">
                        ${code}
                    </div>
                    <p style="font-size: 13px; color: #64748b;">This code is valid for 10 minutes. If you did not request this assignment, ignore this email and reply Cancel in WhatsApp.</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin-top: 24px;">
                    <p style="font-size: 12px; color: #94a3b8; margin-bottom: 0;">Saka Fleet Operating System • Automated Verification Service</p>
                </div>
            `
        });

        if (error) {
            console.error('[Resend Assignment OTP Error]:', error);
            throw new Error(`Failed to send assignment OTP: ${error.message}`);
        }

        console.log(`[Resend Assignment OTP] Dispatched code to ${targetEmail}. ID: ${data?.id}`);
        return true;
    } catch (err) {
        console.error('[Resend Assignment OTP Exception]:', err.message);
        throw err;
    }
}



export async function sendPassbookWelcomeEmail({ targetEmail, plateNumber, makeModel, yom, vin, token, fuelType, mileage }) {
    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Fleet <reports@reports.sakafleet.com>',
            to: [targetEmail],
            subject: `Vehicle Passbook Issued - ${plateNumber} (VIN: ${vin})`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 580px; margin: auto; border: 1px solid #e2e8f0; padding: 28px; border-radius: 12px; background: #ffffff;">
                    <div style="border-bottom: 2px solid #0284c7; padding-bottom: 12px; margin-bottom: 20px;">
                        <h2 style="color: #0f172a; margin: 0;">Official Vehicle Passbook</h2>
                        <p style="color: #64748b; margin: 4px 0 0 0; font-size: 14px;">Saka Fleet Intelligent Asset Record</p>
                    </div>
                    <p>Congratulations! Your vehicle asset record has been verified and permanently issued on Saka Fleet.</p>
                    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin: 20px 0;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                            <tr><td style="padding: 6px 0; color: #64748b;">Registration Plate:</td><td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${plateNumber}</td></tr>
                            <tr><td style="padding: 6px 0; color: #64748b;">Make & Model:</td><td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${makeModel} (${yom})</td></tr>
                            <tr><td style="padding: 6px 0; color: #64748b;">Fuel Type:</td><td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${fuelType}</td></tr>
                            <tr><td style="padding: 6px 0; color: #64748b;">Initial Mileage:</td><td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${Number(mileage).toLocaleString()} km</td></tr>
                            <tr><td style="padding: 6px 0; color: #64748b;">VIN (Chassis):</td><td style="padding: 6px 0; font-weight: bold; color: #0284c7; font-family: monospace;">${vin}</td></tr>
                        </table>
                    </div>
                    <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin: 20px 0; text-align: center;">
                        <p style="font-size: 12px; color: #065f46; text-transform: uppercase; font-weight: bold; letter-spacing: 1px; margin: 0 0 6px 0;">Immutable Passbook Token</p>
                        <div style="font-size: 22px; font-weight: bold; color: #047857; font-family: monospace; letter-spacing: 2px;">
                            ${token}
                        </div>
                    </div>
                    <p style="font-size: 13px; color: #475569;">
                        🔒 <strong>VIN Immutability Notice:</strong> This passbook is permanently locked to VIN <code>${vin}</code>. All maintenance logs, fuel statements, and compliance audits will accrue to this digital asset ledger.
                    </p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
                    <p style="font-size: 12px; color: #94a3b8; margin: 0;">Saka Fleet Operating System • Verified Asset Passbook Service</p>
                </div>
            `
        });

        if (error) {
            console.error('[Resend Passbook Email Error]:', error);
            return false;
        }

        console.log(`[Resend Passbook] Sent passbook to ${targetEmail} for ${plateNumber}. ID: ${data?.id}`);
        return true;
    } catch (err) {
        console.error('[Resend Passbook Email Exception]:', err.message);
        return false;
    }
}

export async function sendSupportEscalationEmail({ userPhone, userEmail, userName, subscriptionTier, issueParagraph, vehiclesList = [] }) {
    const targetEmail = 'support@sakafleet.com';
    try {
        const formattedVehicles = vehiclesList.length > 0
            ? vehiclesList.map(v => `${v.plate_number} (${v.make_model || 'Vehicle'}, VIN: ${v.vin || 'N/A'})`).join(', ')
            : 'None';

        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Support <reports@reports.sakafleet.com>',
            to: [targetEmail],
            reply_to: userEmail || undefined,
            subject: `Support Escalation Ticket: ${userPhone} (${userName || 'User'})`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px; background: #ffffff;">
                    <h2 style="color: #0f172a; margin-top: 0; border-bottom: 2px solid #0284c7; padding-bottom: 8px;">🚨 Saka Fleet Support Escalation</h2>
                    <p>A user on WhatsApp requires support / administrator intervention.</p>
                    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
                        <p style="margin: 0 0 8px 0; font-weight: bold; color: #0284c7;">User Description:</p>
                        <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #0f172a;">${issueParagraph}</p>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 16px;">
                        <tr><td style="padding: 6px 0; color: #64748b; width: 140px;">Phone Number:</td><td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${userPhone}</td></tr>
                        <tr><td style="padding: 6px 0; color: #64748b;">User Name:</td><td style="padding: 6px 0; color: #0f172a;">${userName || 'N/A'}</td></tr>
                        <tr><td style="padding: 6px 0; color: #64748b;">Email Address:</td><td style="padding: 6px 0; color: #0f172a;">${userEmail || 'N/A'}</td></tr>
                        <tr><td style="padding: 6px 0; color: #64748b;">Subscription Tier:</td><td style="padding: 6px 0; color: #0f172a;">${subscriptionTier || 'free'}</td></tr>
                        <tr><td style="padding: 6px 0; color: #64748b;">Registered Vehicles:</td><td style="padding: 6px 0; color: #0f172a;">${formattedVehicles}</td></tr>
                        <tr><td style="padding: 6px 0; color: #64748b;">Escalated At:</td><td style="padding: 6px 0; color: #0f172a;">${new Date().toISOString()}</td></tr>
                    </table>
                </div>
            `
        });
        if (error) {
            console.error('[Resend Support Error]:', error);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[Resend Support Exception]:', err.message);
        return false;
    }
}

export async function sendTrialExtensionReminderEmail({ targetEmail, ownerName, plateNumber, vin, couponCode, trialEndDate }) {
    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Fleet <reports@reports.sakafleet.com>',
            to: [targetEmail],
            subject: `Action Required: Your Saka Fleet Trial for ${plateNumber} Ends in 3 Days!`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 540px; margin: auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px; background: #ffffff;">
                    <h2 style="color: #0f172a; margin-top: 0;">Trial Expiration Reminder</h2>
                    <p>Hello ${ownerName || 'Fleet Owner'},</p>
                    <p>Your 1-month free trial for vehicle <strong>${plateNumber}</strong> (VIN: <code>${vin}</code>) is scheduled to end on <strong>${trialEndDate || 'in 3 days'}</strong>.</p>
                    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 18px; margin: 20px 0; text-align: center;">
                        <p style="font-size: 13px; color: #166534; font-weight: bold; margin: 0 0 6px 0;">YOUR 30-DAY EXTENSION COUPON CODE</p>
                        <div style="font-size: 26px; font-weight: bold; color: #15803d; letter-spacing: 3px; font-family: monospace;">
                            ${couponCode}
                        </div>
                    </div>
                    <p style="font-size: 14px; color: #475569;">
                        👉 <strong>To activate instantly:</strong> Simply reply <strong>"Yes"</strong> to Saka on WhatsApp, or reply with your coupon code, and we'll add 30 free days immediately!
                    </p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                    <p style="font-size: 12px; color: #94a3b8; margin: 0;">Saka Fleet Operating System • Asset Lifecycle Service</p>
                </div>
            `
        });

        if (error) {
            console.error('[Resend Extension Reminder Error]:', error);
            return false;
        }

        console.log(`[Resend Reminder] Sent trial extension email to ${targetEmail}. ID: ${data?.id}`);
        return true;
    } catch (err) {
        console.error('[Resend Extension Reminder Exception]:', err.message);
        return false;
    }
}

export async function sendTransferReleasePinEmail({ targetEmail, ownerName, plateNumber, vin, releasePin }) {
    try {
        const { data, error } = await getResendClient().emails.send({
            from: 'Saka Security <security@reports.sakafleet.com>',
            to: [targetEmail],
            subject: `Security Verification: Authorize Passbook Transfer for ${plateNumber}`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 520px; margin: auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px; background: #ffffff;">
                    <h2 style="color: #0f172a; margin-top: 0;">Passbook Transfer Release PIN</h2>
                    <p>Hello ${ownerName || 'Fleet Owner'},</p>
                    <p>A request was initiated on WhatsApp to transfer ownership of vehicle <strong>${plateNumber}</strong> (VIN: <code>${vin}</code>).</p>
                    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0; text-align: center;">
                        <p style="font-size: 12px; color: #991b1b; font-weight: bold; letter-spacing: 1px; margin: 0 0 6px 0;">YOUR 6-DIGIT RELEASE PIN</p>
                        <div style="font-size: 32px; font-weight: bold; color: #b91c1c; letter-spacing: 8px; font-family: monospace;">
                            ${releasePin}
                        </div>
                    </div>
                    <p style="font-size: 13px; color: #dc2626; font-weight: bold;">
                        ⚠️ Warning: Entering this PIN in WhatsApp authorizes unlinking this vehicle asset from your account and handing full control to the new buyer.
                    </p>
                    <p style="font-size: 13px; color: #64748b;">This release PIN is valid for 10 minutes. If you did not initiate this transfer, do not share this code and contact Saka support immediately.</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                    <p style="font-size: 12px; color: #94a3b8; margin: 0;">Saka Fleet Security Verification Service</p>
                </div>
            `
        });

        if (error) {
            console.error('[Resend Transfer PIN Error]:', error);
            return false;
        }

        console.log(`[Resend Transfer PIN] Dispatched release PIN to ${targetEmail}. ID: ${data?.id}`);
        return true;
    } catch (err) {
        console.error('[Resend Transfer PIN Exception]:', err.message);
        return false;
    }
}


