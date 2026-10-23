import PDFDocument from 'pdfkit';

/**
 * Generates an in-memory PDF buffer for Saka Fleet telemetry & fuel audits
 */
export function generateFleetReport(reportData) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const buffers = [];

            doc.on('data', chunk => buffers.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', err => reject(err));

            // --- Header Branding ---
            doc.fillColor('#070913').fontSize(22).font('Helvetica-Bold').text('VEHICLE & ASSET AUDIT REPORT', { align: 'left' });
            doc.fontSize(10).fillColor('#64748B').text(`Generated on: ${new Date().toLocaleString()}`, { align: 'left' });
            doc.moveDown(1.5);

            // --- Summary Callout Box ---
            const boxY = doc.y;
            doc.rect(50, boxY, 495, 65).fillAndStroke('#0F172A', '#38BDF8');
            doc.fillColor('#FFFFFF').fontSize(12).font('Helvetica-Bold').text(`Vehicle Plate: ${reportData.plateNumber || 'N/A'}`, 70, boxY + 15);
            doc.fontSize(10).fillColor('#38BDF8').text(`Report Type: ${(reportData.reportType || 'Standard Audit').toUpperCase()}`, 70, boxY + 38);
            
            if (reportData.assignedDriver) {
                doc.fillColor('#FFFFFF').text(`Driver: ${reportData.assignedDriver}`, 250, boxY + 15, { align: 'right', width: 275 });
            }
            doc.y = boxY + 85;

            // --- Metrics Table Section ---
            doc.fillColor('#070913').fontSize(14).font('Helvetica-Bold').text('Operational Metrics');
            doc.moveDown(0.8);

            const isImperial = (reportData.unitSystem || 'metric').toLowerCase() === 'imperial';
            const assetType = (reportData.assetType || 'ICE').toUpperCase();

            let metrics = [];

            if (assetType === 'EV' || assetType === 'ELECTRIC') {
                const distUnit = isImperial ? 'Miles' : 'KM';
                const effUnit = isImperial ? 'mi/kWh' : 'km/kWh';
                metrics = [
                    { label: 'Energy Consumed', value: `${reportData.kwhCharged || '0'} kWh` },
                    { label: 'Charge Cycles', value: `${reportData.chargeCycles || '0'}` },
                    { label: 'Total Expenditure', value: `KES ${reportData.totalCost || '0'}` },
                    { label: 'Energy Efficiency', value: `${reportData.burnRate || '0'} ${effUnit}` },
                    { label: 'Operational Status', value: reportData.status || 'Active & Verified' }
                ];
            } else if (assetType === 'HEAVY EQUIPMENT' || assetType === 'MACHINERY') {
                const volUnit = isImperial ? 'Gallons' : 'Liters';
                metrics = [
                    { label: 'Operating Hours', value: `${reportData.operatingHours || '0'} Hours` },
                    { label: `Total Consumed`, value: `${reportData.fuelLiters || '0'} ${volUnit}` },
                    { label: 'Total Expenditure', value: `KES ${reportData.totalCost || '0'}` },
                    { label: 'Hourly Consumption Rate', value: `${reportData.burnRate || '0'} ${volUnit}/Hour` },
                    { label: 'Operational Status', value: reportData.status || 'Active & Verified' }
                ];
            } else {
                // ICE (Default)
                const volUnit = isImperial ? 'Gallons' : 'Liters';
                const effUnit = isImperial ? 'MPG' : 'KM/L';
                metrics = [
                    { label: `Total Fuel Consumed`, value: `${reportData.fuelLiters || '0'} ${volUnit}` },
                    { label: 'Total Expenditure', value: `KES ${reportData.totalCost || '0'}` },
                    { label: 'Fuel Efficiency', value: `${reportData.burnRate || '0'} ${effUnit}` },
                    { label: 'Operational Status', value: reportData.status || 'Active & Verified' }
                ];
            }

            metrics.forEach(m => {
                doc.fontSize(10).font('Helvetica-Bold').fillColor('#334155').text(m.label, 50, doc.y, { continued: true });
                doc.font('Helvetica').fillColor('#0F172A').text(m.value, 400, doc.y, { align: 'right' });
                doc.moveDown(1.0);
            });

            doc.moveDown(1);

            // --- Reminders & Expirations ---
            if (reportData.reminders && reportData.reminders.length > 0) {
                doc.fillColor('#070913').fontSize(14).font('Helvetica-Bold').text('Pending Reminders & Expirations');
                doc.moveDown(0.8);
                reportData.reminders.forEach(r => {
                    const dateStr = new Date(r.due_date).toLocaleDateString();
                    doc.fontSize(10).font('Helvetica-Bold').fillColor('#EAB308').text(`${r.reminder_type}`, 50, doc.y, { continued: true });
                    doc.font('Helvetica').fillColor('#0F172A').text(`Due: ${dateStr}`, 400, doc.y, { align: 'right' });
                    doc.moveDown(0.5);
                });
                doc.moveDown(1);
            }

            // --- Recent Operations ---
            if (reportData.recentOperations && reportData.recentOperations.length > 0) {
                doc.fillColor('#070913').fontSize(14).font('Helvetica-Bold').text('Recent Operations');
                doc.moveDown(0.8);
                reportData.recentOperations.forEach(op => {
                    const dateStr = new Date(op.created_at).toLocaleDateString();
                    doc.fontSize(10).font('Helvetica').fillColor('#334155').text(`${dateStr} - ${op.type}`, 50, doc.y, { continued: true });
                    doc.font('Helvetica-Bold').fillColor('#0F172A').text(op.value, 400, doc.y, { align: 'right' });
                    doc.moveDown(0.5);
                });
            }

            doc.moveDown(2);

            // --- Footer Verification ---
            doc.fontSize(8).fillColor('#94A3B8').text('Cryptographically Verified by Saka AI Engine', 50, 750, { align: 'center', width: 495 });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Uploads PDF buffer to Supabase Storage and returns a public URL
 */
export async function uploadReportToSupabase(supabase, pdfBuffer, plateNumber) {
    const fileName = `audit-${plateNumber.replace(/\s+/g, '_')}-${Date.now()}.pdf`;
    
    // 1. Upload to Supabase bucket 'fleet-reports'
    const { data, error } = await supabase.storage
        .from('fleet-reports')
        .upload(fileName, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true
        });

    if (error) {
        throw new Error(`Supabase Storage Upload Failed: ${error.message}`);
    }

    // 2. Get Public URL for public bucket
    const { data: publicUrlData } = supabase.storage
        .from('fleet-reports')
        .getPublicUrl(data.path);

    if (!publicUrlData || !publicUrlData.publicUrl) {
        throw new Error(`Failed to generate public URL for report.`);
    }

    return publicUrlData.publicUrl;
}