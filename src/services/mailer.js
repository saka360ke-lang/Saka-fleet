import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendReportByEmail(targetEmail, plateNumber, pdfBuffer) {
    try {
        const { data, error } = await resend.emails.send({
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
        const { data, error } = await resend.emails.send({
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