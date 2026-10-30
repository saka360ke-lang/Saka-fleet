import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

/**
 * Saka Fleet — "Saka Pro" PDF Design System (v1.18.0)
 * ---------------------------------------------------
 * A deterministic, premium report renderer: embedded open-source fonts,
 * a calm professional palette, KPI cards, vector charts (bar / donut / line /
 * progress) and centered A4 layouts with page headers and footers.
 *
 * No AI touches the numbers: every figure comes from structured report data.
 */

export const SAKA_PDF_THEME = Object.freeze({
  ink: '#0B1220',
  slate: '#334155',
  muted: '#64748B',
  line: '#E2E8F0',
  panel: '#F8FAFC',
  white: '#FFFFFF',
  accents: Object.freeze({
    fleet: '#2563EB',
    financial: '#0EA5E9',
    compliance: '#F59E0B',
    maintenance: '#10B981',
    fuel_economy: '#8B5CF6',
    driver_daybook: '#10B981',
    vehicle_health: '#14B8A6',
    driver_compliance_card: '#F59E0B',
    driver_scorecard: '#6366F1',
    year_review: '#EC4899',
    eco_footprint: '#22C55E',
    custom: '#6366F1',
    default: '#2563EB'
  }),
  status: Object.freeze({ good: '#10B981', warn: '#F59E0B', bad: '#EF4444', info: '#38BDF8' })
});

export function getReportAccent(reportType = 'fleet') {
  return SAKA_PDF_THEME.accents[reportType] || SAKA_PDF_THEME.accents.default;
}

const PAGE_MARGIN = 48;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
const FONT_FILES = {
  body: 'Manrope-Regular.ttf',
  display: 'Barlow-SemiBold.ttf',
  mono: 'JetBrainsMono-Regular.ttf'
};

/** Register vendored fonts with a Helvetica fallback (never throws). */
export function registerReportFonts(doc) {
  const fonts = { body: 'Helvetica', bold: 'Helvetica-Bold', display: 'Helvetica-Bold', mono: 'Courier' };
  for (const [role, file] of Object.entries(FONT_FILES)) {
    const target = path.join(FONT_DIR, file);
    try {
      if (fs.existsSync(target)) {
        doc.registerFont(`saka-${role}`, target);
        fonts[role] = `saka-${role}`;
      }
    } catch { /* fall back to a built-in font */ }
  }
  fonts.bold = fonts.display;
  return fonts;
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function withAlpha(doc, hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  doc.fillColor([r, g, b], alpha);
}

function money(value, currency) {
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency || 'USD'} ${Math.round(amount).toLocaleString()}`;
  }
}

function number(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '—');
  return numeric.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function statusColor(status) {
  const clean = String(status || '').toLowerCase();
  if (/(expired|overdue|critical|bad|failed)/.test(clean)) return SAKA_PDF_THEME.status.bad;
  if (/(due|warn|pending|soon|attention)/.test(clean)) return SAKA_PDF_THEME.status.warn;
  if (/(active|good|valid|ok|paid|completed)/.test(clean)) return SAKA_PDF_THEME.status.good;
  return SAKA_PDF_THEME.status.info;
}

function ensureSpace(doc, needed, fonts, accent, title) {
  if (doc.y + needed < PAGE_HEIGHT - 70) return;
  doc.addPage();
  contentHeader(doc, fonts, accent, title);
}

function contentHeader(doc, fonts, accent, title) {
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, 6).fill(accent);
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(8.5)
    .text('SAKA FLEET  ·  PRO REPORT', PAGE_MARGIN, 24, { characterSpacing: 1.2 });
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.display).fontSize(10.5)
    .text(String(title || 'Fleet report').slice(0, 70), PAGE_MARGIN, 38, { width: CONTENT_WIDTH - 120, ellipsis: true });
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.6).moveTo(PAGE_MARGIN, 58).lineTo(PAGE_WIDTH - PAGE_MARGIN, 58).stroke();
  doc.restore();
  doc.y = 74;
}

function sectionTitle(doc, fonts, text, accent, subtitle = null) {
  ensureSpace(doc, subtitle ? 58 : 44, fonts, accent, text);
  doc.fillColor(accent).font(fonts.bold).fontSize(12.5).text(String(text).toUpperCase(), PAGE_MARGIN, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.25);
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.8).moveTo(PAGE_MARGIN, doc.y + 2).lineTo(PAGE_WIDTH - PAGE_MARGIN, doc.y + 2).stroke();
  doc.y += 10;
  if (subtitle) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(9).text(subtitle, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.y += 8;
  }
}

function chip(doc, fonts, x, y, text, color, { filled = false } = {}) {
  const label = String(text || '');
  doc.font(fonts.body).fontSize(7.6);
  const width = Math.min(doc.widthOfString(label) + 16, 150);
  if (filled) {
    doc.roundedRect(x, y, width, 16, 8).fill(color);
    doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(7.4).text(label, x + 8, y + 4.6, { width: width - 16, ellipsis: true });
  } else {
    doc.roundedRect(x, y, width, 16, 8).lineWidth(0.8).strokeColor(color).stroke();
    doc.fillColor(color).font(fonts.body).fontSize(7.4).text(label, x + 8, y + 4.6, { width: width - 16, ellipsis: true });
  }
  return width;
}

function kpiCard(doc, fonts, { x, y, w, h, label, value, hint, accent }) {
  doc.roundedRect(x, y, w, h, 10).fill(SAKA_PDF_THEME.white);
  doc.roundedRect(x, y, w, h, 10).lineWidth(0.8).strokeColor(SAKA_PDF_THEME.line).stroke();
  doc.rect(x, y, 3.2, h).fill(accent);
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(7.6)
    .text(String(label || '').toUpperCase(), x + 14, y + 11, { width: w - 22, characterSpacing: 0.6, ellipsis: true });
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(15)
    .text(String(value ?? '—'), x + 14, y + 24, { width: w - 22, ellipsis: true });
  if (hint) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(7.2)
      .text(String(hint), x + 14, y + h - 17, { width: w - 22, ellipsis: true });
  }
}

function reportTypeLabel(type) {
  const labels = {
    fleet: 'Fleet status', financial: 'Financial & cost', compliance: 'Compliance & expiry',
    maintenance: 'Maintenance & service', fuel_economy: 'Fuel economy', driver_daybook: 'Driver daybook',
    vehicle_health: 'Vehicle health', driver_compliance_card: 'Compliance card', custom: 'Bespoke report',
    driver_scorecard: 'Driver scorecard', year_review: 'Year in review', eco_footprint: 'Eco footprint'
  };
  return labels[type] || 'Fleet report';
}

function drawCover(doc, fonts, report, accent) {
  const { title, subtitle, periodLabel, owner, drivers, reportType } = report;
  doc.rect(0, 0, PAGE_WIDTH, 430).fill(SAKA_PDF_THEME.ink);
  withAlpha(doc, accent, 0.18);
  doc.circle(PAGE_WIDTH - 70, 70, 150).fill();
  withAlpha(doc, accent, 0.10);
  doc.circle(PAGE_WIDTH - 10, 250, 210).fill();

  doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(15)
    .text('SAKA FLEET', PAGE_MARGIN, 64, { characterSpacing: 2.4 });
  doc.fillColor(SAKA_PDF_THEME.status.info).font(fonts.body).fontSize(8.5)
    .text('FLEET INTELLIGENCE  ·  PRO REPORT', PAGE_MARGIN, 86, { characterSpacing: 1.8 });

  doc.fillColor(SAKA_PDF_THEME.white).font(fonts.display).fontSize(30)
    .text(String(title || 'Fleet Report'), PAGE_MARGIN, 150, { width: CONTENT_WIDTH - 40, lineGap: 2 });
  if (subtitle) {
    doc.fillColor('#CBD5E1').font(fonts.body).fontSize(10.5)
      .text(String(subtitle), PAGE_MARGIN, doc.y + 10, { width: CONTENT_WIDTH - 90 });
  }
  let chipX = PAGE_MARGIN;
  const chipY = 300;
  chipX += chip(doc, fonts, chipX, chipY, reportTypeLabel(reportType), accent, { filled: true }) + 8;
  if (periodLabel) chipX += chip(doc, fonts, chipX, chipY, periodLabel, SAKA_PDF_THEME.status.info) + 8;
  chip(doc, fonts, chipX, chipY, 'Verified data', SAKA_PDF_THEME.status.good);

  const cardY = 348;
  doc.roundedRect(PAGE_MARGIN, cardY, CONTENT_WIDTH, 58, 12).fill(SAKA_PDF_THEME.white);
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(7.5)
    .text('PREPARED FOR', PAGE_MARGIN + 16, cardY + 12, { characterSpacing: 0.8 });
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(12.5)
    .text(owner?.name || 'Fleet owner', PAGE_MARGIN + 16, cardY + 24, { width: CONTENT_WIDTH - 32, ellipsis: true });
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(8)
    .text([owner?.email, owner?.phone, owner?.plan].filter(Boolean).join('  ·  ') || 'Saka Fleet account', PAGE_MARGIN + 16, cardY + 42, { width: CONTENT_WIDTH - 190, ellipsis: true });
  doc.fillColor(accent).font(fonts.bold).fontSize(8)
    .text(String(owner?.language || 'English').toUpperCase(), PAGE_WIDTH - PAGE_MARGIN - 130, cardY + 24, { width: 114, align: 'right' });

  let peopleY = 430;
  if (drivers?.length) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(8)
      .text('DRIVERS ON THIS FLEET', PAGE_MARGIN, peopleY + 10, { characterSpacing: 1 });
    peopleY += 28;
    let x = PAGE_MARGIN;
    for (const driver of drivers.slice(0, 3)) {
      const w = Math.min(150, (CONTENT_WIDTH - 16) / Math.max(drivers.length, 1) - 8);
      doc.roundedRect(x, peopleY, w, 46, 9).fill(SAKA_PDF_THEME.panel);
      doc.roundedRect(x, peopleY, w, 46, 9).lineWidth(0.7).strokeColor(SAKA_PDF_THEME.line).stroke();
      doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(9)
        .text(driver.name || 'Driver', x + 10, peopleY + 9, { width: w - 20, ellipsis: true });
      doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(7.4)
        .text([driver.plate, driver.licenceLabel].filter(Boolean).join(' · ') || 'Assigned driver', x + 10, peopleY + 24, { width: w - 20, ellipsis: true });
      const color = statusColor(driver.status);
      doc.circle(x + 12, peopleY + 36, 2.4).fill(color);
      doc.fillColor(color).font(fonts.body).fontSize(6.8)
        .text(String(driver.status || 'active').toUpperCase(), x + 18, peopleY + 33, { width: w - 28, ellipsis: true });
      x += w + 8;
    }
  }

  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(7.4)
    .text(`Generated ${report.generatedAt || new Date().toLocaleString()}  ·  sakafleet.com`, PAGE_MARGIN, PAGE_HEIGHT - 46, { width: CONTENT_WIDTH, align: 'center' });
}

function drawKpiGrid(doc, fonts, kpis, accent) {
  const items = (kpis || []).slice(0, 6);
  if (!items.length) return;
  const gap = 10;
  const cardW = (CONTENT_WIDTH - gap * 2) / 3;
  const cardH = 66;
  for (let i = 0; i < items.length; i += 1) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    ensureSpace(doc, cardH + gap, fonts, accent, 'Key metrics');
    kpiCard(doc, fonts, {
      x: PAGE_MARGIN + col * (cardW + gap),
      y: doc.y + row * (cardH + gap),
      w: cardW,
      h: cardH,
      label: items[i].label,
      value: items[i].value,
      hint: items[i].hint,
      accent
    });
  }
  doc.y += Math.ceil(items.length / 3) * (cardH + gap) + 6;
}

function drawChartHeading(doc, fonts, chart, accent) {
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(9.5).text(String(chart.title || ''), PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  if (chart.note) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(7.4).text(String(chart.note), PAGE_MARGIN, doc.y + 1, { width: CONTENT_WIDTH });
  }
  doc.y += chart.note ? 16 : 6;
}

function drawBarChart(doc, fonts, chart, accent) {
  const series = (chart.series || []).slice(0, 7).map((item) => ({ label: String(item.label || ''), value: Number(item.value) || 0, color: item.color }));
  if (!series.length) return;
  ensureSpace(doc, 165, fonts, accent, chart.title);
  drawChartHeading(doc, fonts, chart, accent);
  const chartH = 92;
  const max = Math.max(...series.map((item) => item.value), 1);
  const gap = 12;
  const barW = Math.max(18, (CONTENT_WIDTH - gap * (series.length + 1)) / series.length);
  const baseY = doc.y + chartH;
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.6).moveTo(PAGE_MARGIN, baseY).lineTo(PAGE_WIDTH - PAGE_MARGIN, baseY).stroke();
  let barX = PAGE_MARGIN + gap;
  series.forEach((item, index) => {
    const h = Math.max(2, (item.value / max) * (chartH - 16));
    const color = item.color || (index % 2 === 0 ? accent : SAKA_PDF_THEME.status.info);
    doc.roundedRect(barX, baseY - h, barW, h, 3).fill(color);
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(6.6)
      .text(number(item.value), barX - 4, baseY - h - 11, { width: barW + 8, align: 'center' });
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(6.4)
      .text(item.label.slice(0, 12), barX - 6, baseY + 4, { width: barW + 12, align: 'center' });
    barX += barW + gap;
  });
  doc.y = baseY + 22;
}

function drawDonut(doc, fonts, chart, accent) {
  const series = (chart.series || []).filter((item) => Number(item.value) > 0).slice(0, 6);
  if (!series.length) return;
  ensureSpace(doc, 165, fonts, accent, chart.title);
  drawChartHeading(doc, fonts, chart, accent);
  const total = series.reduce((sum, item) => sum + Number(item.value), 0) || 1;
  const cx = PAGE_MARGIN + 78;
  const cy = doc.y + 62;
  const radius = 46;
  const palette = [accent, SAKA_PDF_THEME.status.info, SAKA_PDF_THEME.status.good, SAKA_PDF_THEME.status.warn, '#8B5CF6', '#EC4899'];
  let angle = -90;
  let drawn = false;
  try {
    series.forEach((item, index) => {
      const sweep = (Number(item.value) / total) * 360;
      doc.save();
      doc.moveTo(cx, cy);
      doc.arc(cx, cy, radius, angle, angle + sweep);
      doc.closePath().fill(item.color || palette[index % palette.length]);
      doc.restore();
      angle += sweep;
      drawn = true;
    });
    doc.circle(cx, cy, radius * 0.56).fill(SAKA_PDF_THEME.white);
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(11).text(number(total), cx - 34, cy - 9, { width: 68, align: 'center' });
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(6.6).text(String(chart.totalLabel || 'total'), cx - 34, cy + 6, { width: 68, align: 'center' });
  } catch {
    drawn = false;
  }
  if (!drawn) {
    let barX = PAGE_MARGIN;
    series.forEach((item, index) => {
      const w = (Number(item.value) / total) * (CONTENT_WIDTH * 0.55);
      doc.rect(barX, cy - 8, w, 16).fill(item.color || palette[index % palette.length]);
      barX += w;
    });
  }
  let legendY = cy - radius + 4;
  series.forEach((item, index) => {
    const color = item.color || palette[index % palette.length];
    doc.circle(PAGE_MARGIN + 300, legendY + 4, 3.2).fill(color);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(7.4)
      .text(String(item.label).slice(0, 26), PAGE_MARGIN + 310, legendY, { width: 150, ellipsis: true });
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.mono).fontSize(6.8)
      .text(`${Math.round((Number(item.value) / total) * 100)}%`, PAGE_WIDTH - PAGE_MARGIN - 40, legendY, { width: 40, align: 'right' });
    legendY += 15;
  });
  doc.y = cy + radius + 18;
}

function drawLineChart(doc, fonts, chart, accent) {
  const series = (chart.series || []).slice(0, 12);
  if (series.length < 2) return;
  ensureSpace(doc, 160, fonts, accent, chart.title);
  drawChartHeading(doc, fonts, chart, accent);
  const chartH = 88;
  const values = series.map((item) => Number(item.value) || 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const stepX = CONTENT_WIDTH / (series.length - 1);
  const baseY = doc.y + chartH;
  const points = series.map((item, index) => ({
    x: PAGE_MARGIN + index * stepX,
    y: baseY - ((Number(item.value) - min) / range) * (chartH - 18) - 6
  }));
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.6).moveTo(PAGE_MARGIN, baseY).lineTo(PAGE_WIDTH - PAGE_MARGIN, baseY).stroke();
  doc.save();
  doc.moveTo(points[0].x, baseY);
  points.forEach((point) => doc.lineTo(point.x, point.y));
  doc.lineTo(points[points.length - 1].x, baseY);
  doc.closePath();
  withAlpha(doc, accent, 0.14);
  doc.fill();
  doc.restore();
  doc.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => doc.lineTo(point.x, point.y));
  doc.lineWidth(1.8).strokeColor(accent).stroke();
  points.forEach((point) => doc.circle(point.x, point.y, 2.4).fill(accent));
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(6.4)
    .text(String(series[0].label || ''), PAGE_MARGIN, baseY + 4, { width: 120 });
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(6.4)
    .text(String(series[series.length - 1].label || ''), PAGE_WIDTH - PAGE_MARGIN - 120, baseY + 4, { width: 120, align: 'right' });
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(6.6)
    .text(`${number(min)} – ${number(max)}`, PAGE_MARGIN, doc.y - 2, { width: 140 });
  doc.y = baseY + 22;
}

function drawProgressChart(doc, fonts, chart, accent) {
  const series = (chart.series || []).slice(0, 8);
  if (!series.length) return;
  ensureSpace(doc, 40 + series.length * 20, fonts, accent, chart.title);
  drawChartHeading(doc, fonts, chart, accent);
  series.forEach((item) => {
    const ratio = Math.max(0, Math.min(1, Number(item.value) / (Number(chart.max) || 100)));
    const color = item.color || (ratio > 0.5 ? SAKA_PDF_THEME.status.good : ratio > 0.2 ? SAKA_PDF_THEME.status.warn : SAKA_PDF_THEME.status.bad);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(7.4)
      .text(String(item.label).slice(0, 34), PAGE_MARGIN, doc.y, { width: 150, ellipsis: true });
    doc.roundedRect(PAGE_MARGIN + 158, doc.y + 1, CONTENT_WIDTH - 210, 8, 4).fill(SAKA_PDF_THEME.panel);
    doc.roundedRect(PAGE_MARGIN + 158, doc.y + 1, Math.max(4, (CONTENT_WIDTH - 210) * ratio), 8, 4).fill(color);
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(7)
      .text(String(item.text || number(item.value)), PAGE_WIDTH - PAGE_MARGIN - 44, doc.y - 1, { width: 44, align: 'right' });
    doc.y += 18;
  });
  doc.y += 4;
}

function drawChart(doc, fonts, chart, accent) {
  const type = String(chart.type || 'bar').toLowerCase();
  if (type === 'donut' || type === 'pie') return drawDonut(doc, fonts, chart, accent);
  if (type === 'line') return drawLineChart(doc, fonts, chart, accent);
  if (type === 'progress') return drawProgressChart(doc, fonts, chart, accent);
  return drawBarChart(doc, fonts, chart, accent);
}

function drawTable(doc, fonts, table, accent) {
  const columns = (table.columns || []).slice(0, 6);
  const rows = (table.rows || []).slice(0, 40);
  if (!columns.length) return;
  sectionTitle(doc, fonts, table.title || 'Details', accent, table.subtitle || null);
  const totalWeight = columns.reduce((sum, column) => sum + (Number(column.width) || 1), 0);
  const widths = columns.map((column) => ((Number(column.width) || 1) / totalWeight) * CONTENT_WIDTH);
  const headerH = 20;
  const rowH = 22;
  ensureSpace(doc, headerH + rowH * Math.min(rows.length, 4) + 10, fonts, accent, table.title);
  const headerY = doc.y;
  doc.rect(PAGE_MARGIN, headerY, CONTENT_WIDTH, headerH).fill(SAKA_PDF_THEME.ink);
  let cellX = PAGE_MARGIN;
  columns.forEach((column, index) => {
    doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(7.2)
      .text(String(column.label || '').toUpperCase(), cellX + 8, headerY + 6.5, {
        width: widths[index] - 16,
        align: column.align === 'right' ? 'right' : 'left',
        ellipsis: true
      });
    cellX += widths[index];
  });
  doc.y = headerY + headerH;
  rows.forEach((row, rowIndex) => {
    ensureSpace(doc, rowH, fonts, accent, table.title);
    const rowY = doc.y;
    if (rowIndex % 2 === 1) {
      doc.rect(PAGE_MARGIN, rowY, CONTENT_WIDTH, rowH).fill(SAKA_PDF_THEME.panel);
    }
    doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.4).moveTo(PAGE_MARGIN, rowY + rowH).lineTo(PAGE_WIDTH - PAGE_MARGIN, rowY + rowH).stroke();
    let x = PAGE_MARGIN;
    columns.forEach((column, columnIndex) => {
      const raw = row[column.key];
      const value = column.type === 'money'
        ? money(raw, table.currency)
        : column.type === 'number'
          ? number(raw)
          : String(raw ?? '—');
      const isStatus = column.type === 'status';
      const color = isStatus ? statusColor(raw) : SAKA_PDF_THEME.slate;
      if (isStatus) doc.circle(x + 12, rowY + 11, 2.6).fill(color);
      doc.fillColor(color).font(isStatus ? fonts.bold : fonts.body).fontSize(7.6)
        .text(value, x + (isStatus ? 19 : 8), rowY + 7, {
          width: widths[columnIndex] - (isStatus ? 25 : 16),
          align: column.align === 'right' ? 'right' : 'left',
          ellipsis: true
        });
      x += widths[columnIndex];
    });
    doc.y = rowY + rowH;
  });
  doc.y += 10;
}

function drawSection(doc, fonts, section, accent) {
  const rows = section.rows || [];
  const lines = section.lines || [];
  if (!rows.length && !lines.length) return;
  sectionTitle(doc, fonts, section.title || 'Notes', accent, section.subtitle || null);
  rows.forEach((row) => {
    ensureSpace(doc, 20, fonts, accent, section.title);
    const y = doc.y;
    const status = row.status ? statusColor(row.status) : null;
    if (status) doc.circle(PAGE_MARGIN + 4, y + 6, 2.6).fill(status);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(8.2)
      .text(String(row.label || ''), PAGE_MARGIN + (status ? 12 : 0), y, { width: CONTENT_WIDTH * 0.62, ellipsis: true });
    doc.fillColor(row.valueColor || SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(8.2)
      .text(String(row.value ?? '—'), PAGE_WIDTH - PAGE_MARGIN - CONTENT_WIDTH * 0.34, y, { width: CONTENT_WIDTH * 0.34, align: 'right', ellipsis: true });
    doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.35).moveTo(PAGE_MARGIN, y + 15).lineTo(PAGE_WIDTH - PAGE_MARGIN, y + 15).stroke();
    doc.y = y + 19;
  });
  lines.forEach((line) => {
    ensureSpace(doc, 16, fonts, accent, section.title);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(8.4)
      .text(`•  ${String(line)}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.y += 4;
  });
  doc.y += 8;
}

function drawFooter(doc, fonts, pageNumber, pageCount, accent) {
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.5).moveTo(PAGE_MARGIN, PAGE_HEIGHT - 44).lineTo(PAGE_WIDTH - PAGE_MARGIN, PAGE_HEIGHT - 44).stroke();
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(7)
    .text('SAKA FLEET  ·  PRO REPORT', PAGE_MARGIN, PAGE_HEIGHT - 34, { width: CONTENT_WIDTH * 0.6, characterSpacing: 0.6 });
  doc.fillColor(accent).font(fonts.bold).fontSize(7)
    .text(`Page ${pageNumber} of ${pageCount}`, PAGE_WIDTH - PAGE_MARGIN - 110, PAGE_HEIGHT - 34, { width: 110, align: 'right' });
}

/**
 * Render a complete Saka Pro report to a PDF Buffer.
 * `report` shape:
 * { title, subtitle, reportType, periodLabel, generatedAt, owner, drivers,
 *   kpis[], charts[], tables[], sections[], notes[] }
 */
export function buildProReportPdf(report = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 70, bottom: 60, left: PAGE_MARGIN, right: PAGE_MARGIN },
        bufferPages: true,
        info: {
          Title: report.title || 'Saka Fleet Report',
          Author: 'Saka Fleet',
          Creator: 'Saka Fleet Pro Reports v1.18.0',
          Subject: report.subtitle || 'Fleet intelligence report'
        }
      });
      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const fonts = registerReportFonts(doc);
      const accent = getReportAccent(report.reportType);
      const prepared = {
        ...report,
        generatedAt: report.generatedAt || new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' })
      };

      drawCover(doc, fonts, prepared, accent);

      const hasContent = (report.kpis?.length || report.charts?.length || report.tables?.length || report.sections?.length || report.notes?.length);
      if (hasContent) {
        doc.addPage();
        contentHeader(doc, fonts, accent, report.title);
        drawKpiGrid(doc, fonts, report.kpis || [], accent);
        for (const chart of report.charts || []) {
          ensureSpace(doc, 150, fonts, accent, report.title);
          drawChart(doc, fonts, chart, accent);
        }
        for (const table of report.tables || []) drawTable(doc, fonts, table, accent);
        for (const section of report.sections || []) drawSection(doc, fonts, section, accent);
        if (report.notes?.length) {
          sectionTitle(doc, fonts, 'Notes', accent);
          report.notes.forEach((note) => {
            ensureSpace(doc, 16, fonts, accent, 'Notes');
            doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(8)
              .text(String(note), PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
            doc.y += 5;
          });
        }
      }

      const range = doc.bufferedPageRange();
      for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(range.start + index);
        drawFooter(doc, fonts, index + 1, range.count, accent);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export default {
  SAKA_PDF_THEME,
  getReportAccent,
  registerReportFonts,
  buildProReportPdf
};






