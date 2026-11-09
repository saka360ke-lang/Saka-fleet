import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

/**
 * Saka Fleet — "Saka Apex" PDF Design System (v1.29.0)
 * ---------------------------------------------------
 * A deterministic, premium report renderer: embedded open-source fonts,
 * a calm professional palette (Midnight Slate / Tech Teal / Emerald / Coral),
 * KPI cards, vector charts (bar / donut / line / progress / segmented / vs),
 * itemized transaction ledgers with type badges, insight callouts and centered
 * A4 layouts with page headers and footers.
 *
 * No AI touches the numbers: every figure comes from structured report data.
 * Full transparency: real zeros are surfaced ("KES 0"), only missing data is "—".
 */

export const SAKA_PDF_THEME = Object.freeze({
  ink: '#0F172A',        // Deep Midnight Slate — structure & primary text
  slate: '#334155',      // secondary text
  muted: '#64748B',      // labels, hints
  line: '#E2E8F0',       // hairlines & card borders
  panel: '#F8FAFC',      // neutral card containers
  white: '#FFFFFF',
  // v1.83.0 (Phase 22) — the PDF wears the dashboard's lime brand. #65A30D is
  // the TEXT-SAFE shade (AA on white); #B8EF5C is decorative only (fills,
  // tints) and never carries body text. Tech Teal #0EA5E9 retires as the
  // default accent.
  brand: '#65A30D',      // text-safe lime — brand accent
  lime: '#B8EF5C',       // decorative lime (fills/tints only)
  positive: '#10B981',   // Emerald — earnings, healthy balances
  negative: '#EF4444',   // Coral — expenses, net losses
  warn: '#F59E0B',       // Warm Amber — expiring / attention
  accents: Object.freeze({
    fleet: '#65A30D',
    financial: '#65A30D',
    compliance: '#F59E0B',
    maintenance: '#10B981',
    fuel_economy: '#8B5CF6',
    driver_daybook: '#10B981',
    vehicle_health: '#14B8A6',
    driver_compliance_card: '#F59E0B',
    driver_scorecard: '#6366F1',
    year_review: '#EC4899',
    eco_footprint: '#22C55E',
    vehicle_deep_dive: '#65A30D',
    owner_portfolio: '#65A30D',
    driver_performance: '#6366F1',
    custom: '#6366F1',
    default: '#65A30D'
  }),
  status: Object.freeze({ good: '#10B981', warn: '#F59E0B', bad: '#EF4444', info: '#65A30D' })
});

export function getReportAccent(reportType = 'fleet') {
  return SAKA_PDF_THEME.accents[reportType] || SAKA_PDF_THEME.accents.default;
}

/**
 * v1.28.7 — PDF glyph safety.
 *
 * The embedded Manrope/Barlow/JetBrains fonts (and the Helvetica fallback) cannot
 * render WhatsApp emoji or many Unicode symbols: they were the source of the
 * "boxes / garbled text" reports. Every string drawn into the PDF passes through
 * this sanitiser: common symbols become readable ASCII, emoji are removed and
 * characters outside Latin-1 are dropped instead of rendering as tofu.
 */
const PDF_GLYPH_MAP = Object.freeze({
  '—': '-', '–': '-', '‑': '-', '−': '-', '·': '-', '→': '->', '←': '<-',
  '≥': '>=', '≤': '<=', '≈': '~', '×': 'x',
  '✓': 'ok', '✔': 'ok', '☑': 'ok',
  '’': "'", '‘': "'", '“': '"', '”': '"', '…': '...',
  '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₦': 'NGN', '₨': 'Rs'
});

export function pdfSafeText(value) {
  let text = String(value ?? '');
  if (!text) return '';
  // 1. Map every glyph we KNOW a readable equivalent for (before emoji stripping,
  //    because several mapped symbols live inside the pictograph ranges).
  for (const [glyph, replacement] of Object.entries(PDF_GLYPH_MAP)) {
    if (text.includes(glyph)) text = text.split(glyph).join(replacement);
  }
  // 2. Remove emoji / pictographs (the historical tofu-box source).
  text = text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u2022\u25CF\u25AA]/g, '-')
    .replace(/[^\x09\x0A\x20-\xFF]/g, (ch) => PDF_GLYPH_MAP[ch] ?? '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

const PAGE_MARGIN = 48;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

/**
 * v1.83.0 (Phase 22) — the layout contract is exported so a suite can pin it:
 * A4 with the 48 pt mobile-friendly margins that keep every line inside the
 * printable area.
 * v1.93.0 (Phase 30, Task 1) — the same contract now carries a VARIANT: the
 * standard A4 set below plus the phone-shaped `mobile` set (A5 portrait, 36 pt
 * margins, a hard 10 pt font floor). `SAKA_PDF_GEOMETRY` stays the A4 default so
 * every existing pin and the default render remain byte-identical.
 */
export const SAKA_PDF_GEOMETRY = Object.freeze({
  pageWidth: PAGE_WIDTH,
  pageHeight: PAGE_HEIGHT,
  margin: PAGE_MARGIN,
  contentWidth: CONTENT_WIDTH,
  minFontFloor: 0
});

/** v1.93.0 — A5 portrait: 419 x 595 pt, 36 pt margins, 10 pt font floor. */
export const SAKA_PDF_GEOMETRY_MOBILE = Object.freeze({
  pageWidth: 419,
  pageHeight: 595,
  margin: 36,
  contentWidth: 419 - 72,
  minFontFloor: 10
});

/** Variant whitelist: anything unknown renders the standard A4 layout. */
export function normalizePdfVariant(variant) {
  return String(variant || '').trim().toLowerCase() === 'mobile' ? 'mobile' : 'a4';
}

/** Resolve the frozen geometry for a variant (never null). */
export function resolvePdfGeometry(variant) {
  return normalizePdfVariant(variant) === 'mobile' ? SAKA_PDF_GEOMETRY_MOBILE : SAKA_PDF_GEOMETRY;
}

/** Font size through the variant's floor (A4 has none → byte-identical). */
function fontSizeFor(size, G) {
  const floor = Number(G?.minFontFloor) || 0;
  return floor > 0 ? Math.max(size, floor) : size;
}

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
// v1.83.0 (Phase 22) — D2, revised by the live audit: Sora is the dashboard's
// display face, but fontkit's WOFF2 subsetting throws mid-build ("Offset is
// outside the bounds of the DataView") on a second document in the same
// process, so PDFs NEVER load woff2. The attempt is restricted to a vendored
// TTF/OTF drop; with none present today the vendored Barlow SemiBold remains
// the display face (guaranteed fallback, never throws).
const PREMIUM_DISPLAY_FILES = ['Sora-600.ttf', 'Sora-SemiBold.ttf', 'Sora-600.otf'];
const FONT_FILES = {
  body: 'Manrope-Regular.ttf',
  display: 'Barlow-SemiBold.ttf',
  mono: 'JetBrainsMono-Regular.ttf'
};

/** Register vendored fonts with a Helvetica fallback (never throws). */
export function registerReportFonts(doc) {
  const fonts = { body: 'Helvetica', bold: 'Helvetica-Bold', display: 'Helvetica-Bold', mono: 'Courier' };
  // 1. Premium display: a vendored Sora TTF/OTF beats Barlow when present.
  for (const file of PREMIUM_DISPLAY_FILES) {
    const target = path.join(FONT_DIR, file);
    try {
      if (fs.existsSync(target)) {
        doc.registerFont('saka-display-premium', target);
        fonts.display = 'saka-display-premium';
        break;
      }
    } catch (err) {
      // Never silent: a broken premium font is reported, then Barlow wins.
      console.warn('[pdfEngine] premium display font skipped:', err.message);
    }
  }
  // 2. Vendored body + mono; Barlow only when Sora did not register.
  for (const [role, file] of Object.entries(FONT_FILES)) {
    if (role === 'display' && fonts.display === 'saka-display-premium') continue;
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

/**
 * v1.32.4 — PAINT-SCOPED alpha (the illegible-report root cause).
 *
 * The old `withAlpha(doc, hex, alpha)` called `doc.fillColor(rgb, alpha)`, which
 * writes the alpha into the PAGE graphics state (`/GSn gs`) and NEVER resets it.
 * Every later fill, stroke and text op on that page inherited the fade: the
 * cover drew 9 of 20 text ops at `ca < 1`, and the ledger page 22 of 40 after a
 * badge tint leaked `ca 0.13`.
 *
 * Alpha is now applied only inside a save()/restore() pair, which PDFKit
 * compiles to `q … Q` — the graphics state (including `ca`) is restored, so the
 * fade can never escape the shape it was meant for.
 */
function paintAlpha(doc, hex, alpha, draw = null) {
  const { r, g, b } = hexToRgb(hex);
  const clamped = Math.max(0, Math.min(1, Number(alpha)));
  doc.save();
  try {
    doc.fillColor([r, g, b], clamped);
    if (typeof draw === 'function') draw();
    else doc.fill();
  } finally {
    doc.restore();
  }
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
  if (/(inactive|paused|due|warn|pending|soon|attention|missing|invalid)/.test(clean)) return SAKA_PDF_THEME.status.warn;
  if (/(active|good|valid|ok|paid|completed)/.test(clean)) return SAKA_PDF_THEME.status.good;
  return SAKA_PDF_THEME.status.info;
}

/** Semantic tone → color (v1.29.0 Apex design system). */
function toneColor(tone) {
  switch (String(tone || '').toLowerCase()) {
    case 'positive': case 'good': case 'earning': return SAKA_PDF_THEME.positive;
    case 'negative': case 'bad': case 'expense': case 'loss': return SAKA_PDF_THEME.negative;
    case 'warn': case 'warning': case 'compliance': return SAKA_PDF_THEME.warn;
    case 'brand': case 'info': case 'fuel': return SAKA_PDF_THEME.brand;
    default: return SAKA_PDF_THEME.slate;
  }
}

/** Ledger badge tone from a transaction kind (never colour-only meaning). */
function ledgerTone(kind) {
  const clean = String(kind || '').toLowerCase();
  if (/(earning|revenue|income)/.test(clean)) return 'positive';
  if (/(fuel|energy|charge)/.test(clean)) return 'brand';
  if (/(service|maintenance|repair|part|tyre|tire|battery|body|wash|consumable|accessor)/.test(clean)) return 'warn';
  if (/(compliance|insurance|inspection|licence|license|permit)/.test(clean)) return 'warn';
  if (/(expense|cost|toll|parking|fine|wage|towing|subscription|berth)/.test(clean)) return 'negative';
  return 'neutral';
}

/**
 * v1.29.0 — Full transparency: an ACTUAL numeric zero is a real, surfaced
 * figure ("KES 0", "0"); only missing/unpopulated values render "—".
 */
function moneyCell(value, currency) {
  if (value === null || value === undefined || value === '') return '—';
  return money(value, currency);
}

function numberCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return number(value);
}

function ensureSpace(doc, needed, fonts, accent, title, G = SAKA_PDF_GEOMETRY) {
  if (doc.y + needed < G.pageHeight - 70) return;
  doc.addPage();
  contentHeader(doc, fonts, accent, title, G);
}

function contentHeader(doc, fonts, accent, title, G = SAKA_PDF_GEOMETRY) {
  doc.save();
  doc.rect(0, 0, G.pageWidth, 6).fill(accent);
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(8.5, G))
    .text('SAKA FLEET  ·  APEX REPORT', G.margin, 24, { characterSpacing: 1.2 });
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.display).fontSize(fontSizeFor(10.5, G))
    .text(String(title || 'Fleet report').slice(0, 70), G.margin, 38, { width: G.contentWidth - 120, ellipsis: true });
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.6).moveTo(G.margin, 58).lineTo(G.pageWidth - G.margin, 58).stroke();
  doc.restore();
  doc.y = 74;
}

function sectionTitle(doc, fonts, text, accent, subtitle = null, G = SAKA_PDF_GEOMETRY) {
  ensureSpace(doc, subtitle ? 58 : 44, fonts, accent, text, G);
  doc.fillColor(accent).font(fonts.bold).fontSize(fontSizeFor(12.5, G)).text(String(text).toUpperCase(), G.margin, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.25);
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.8).moveTo(G.margin, doc.y + 2).lineTo(G.pageWidth - G.margin, doc.y + 2).stroke();
  doc.y += 10;
  if (subtitle) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(9, G)).text(subtitle, G.margin, doc.y, { width: G.contentWidth });
    doc.y += 8;
  }
}

function chip(doc, fonts, x, y, text, color, { filled = false } = {}, G = SAKA_PDF_GEOMETRY) {
  const label = String(text || '');
  // v1.32.4 — absolute-position helper: never leak the cursor it moves.
  const cursorY = doc.y;
  const size = fontSizeFor(7.6, G);
  const height = G.minFontFloor ? 20 : 16;
  doc.font(fonts.body).fontSize(size);
  const width = Math.min(doc.widthOfString(label) + 16, G.minFontFloor ? 190 : 150);
  const textY = G.minFontFloor ? y + (height - size) / 2 - 0.6 : y + 4.6;
  if (filled) {
    doc.roundedRect(x, y, width, height, height / 2).fill(color);
    doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(size).text(label, x + 8, textY, { width: width - 16, ellipsis: true, lineBreak: false });
  } else {
    doc.roundedRect(x, y, width, height, height / 2).lineWidth(0.8).strokeColor(color).stroke();
    doc.fillColor(color).font(fonts.body).fontSize(size).text(label, x + 8, textY, { width: width - 16, ellipsis: true, lineBreak: false });
  }
  doc.y = cursorY;
  return width;
}

function kpiCard(doc, fonts, { x, y, w, h, label, value, hint, accent, tone = null }, G = SAKA_PDF_GEOMETRY) {
  // v1.32.4 — the card is absolutely positioned; the cursor must not move, or
  // the KPI grid walked down the page one card at a time (the "staircase").
  const cursorY = doc.y;
  doc.roundedRect(x, y, w, h, 10).fill(SAKA_PDF_THEME.white);
  doc.roundedRect(x, y, w, h, 10).lineWidth(0.8).strokeColor(SAKA_PDF_THEME.line).stroke();
  doc.rect(x, y, 3.2, h).fill(accent);
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(7.6, G))
    .text(String(label || '').toUpperCase(), x + 14, y + 11, { width: w - 22, characterSpacing: 0.6, ellipsis: true, lineBreak: false, height: 12 });
  // v1.86.0 (Phase 25) — a long figure (KES 1,234,567) shrinks one step instead
  // of being silently ellipsised: the number must always be readable on a phone.
  const valueText = String(value ?? '—');
  const valueSize = fontSizeFor(valueText.length > 12 ? 13.5 : 15, G);
  doc.fillColor(tone ? toneColor(tone) : SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(valueSize)
    .text(valueText, x + 14, y + 24, { width: w - 22, ellipsis: true, lineBreak: false, height: 20 });
  if (hint) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(7.2, G))
      .text(String(hint), x + 14, y + h - 17, { width: w - 22, ellipsis: true, lineBreak: false, height: 12 });
  }
  doc.y = cursorY;
}

function reportTypeLabel(type) {
  const labels = {
    fleet: 'Fleet status', financial: 'Financial & cost', compliance: 'Compliance & expiry',
    maintenance: 'Maintenance & service', fuel_economy: 'Fuel economy', driver_daybook: 'Driver daybook',
    vehicle_health: 'Vehicle health', driver_compliance_card: 'Compliance card', custom: 'Bespoke report',
    driver_scorecard: 'Driver scorecard', year_review: 'Year in review', eco_footprint: 'Eco footprint',
    vehicle_deep_dive: 'Vehicle deep dive', owner_portfolio: 'Owner portfolio', driver_performance: 'Driver performance'
  };
  return labels[type] || 'Fleet report';
}

/** Licence-plate style badge used on covers for vehicle-scoped reports. */
function plateBadge(doc, fonts, x, y, plate, G = SAKA_PDF_GEOMETRY) {
  const label = pdfSafeText(plate).toUpperCase();
  if (!label) return 0;
  const cursorY = doc.y;
  doc.font(fonts.mono).fontSize(fontSizeFor(10, G));
  const width = Math.max(96, Math.min(doc.widthOfString(label) + 26, 170));
  const height = 30;
  doc.roundedRect(x, y, width, height, 6).fill('#FDE68A');
  doc.roundedRect(x, y, width, height, 6).lineWidth(1).strokeColor(SAKA_PDF_THEME.ink).stroke();
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(fontSizeFor(10, G))
    .text(label, x + 8, y + 10, { width: width - 16, align: 'center', characterSpacing: 1.2, lineBreak: false });
  doc.y = cursorY;
  return width;
}

const COVER_BAND_FLOOR = 120;

/** v1.32.4 — shrink the hero title until it fits two lines (30 → 26 → 22 pt). */
function coverTitleSize(doc, fonts, text, maxWidth) {
  for (let size = 30; size >= 22; size -= 2) {
    doc.font(fonts.display).fontSize(size);
    if (doc.heightOfString(text, { width: maxWidth, lineGap: 2 }) <= size * 2.7) return size;
  }
  return 22;
}

function drawCover(doc, fonts, report, accent, G = SAKA_PDF_GEOMETRY) {
  const { title, subtitle, periodLabel, owner, drivers, reportType } = report;
  // v1.32.3 — optional highlight row fills the void under the cover chips on
  // reports that have no drivers panel (e.g. a single-vehicle compliance PDF).
  const highlights = (Array.isArray(report.coverHighlights) ? report.coverHighlights : []).slice(0, 3);
  const highlightY = 330;
  const highlightH = 56;
  const cardY = highlights.length ? highlightY + highlightH + 16 : 348;
  const cardH = 58;
  // v1.32.4 — the band carries the whole top of the page (842 - 120 = 722 pt,
  // instead of stopping at ~484 pt and leaving 42% of the cover blank), closed
  // by a solid accent rule.
  const bandHeight = G.pageHeight - COVER_BAND_FLOOR;
  doc.rect(0, 0, G.pageWidth, bandHeight).fill(SAKA_PDF_THEME.ink);
  doc.rect(0, bandHeight - 8, G.pageWidth, 8).fill(accent);
  paintAlpha(doc, accent, 0.18, () => doc.circle(G.pageWidth - 70, 70, 150).fill());
  paintAlpha(doc, accent, 0.1, () => doc.circle(G.pageWidth - 10, 430, 250).fill());

  doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(fontSizeFor(15, G))
    .text('SAKA FLEET', G.margin, 64, { characterSpacing: 2.4 });
  doc.fillColor(SAKA_PDF_THEME.status.info).font(fonts.body).fontSize(fontSizeFor(8.5, G))
    .text('FLEET INTELLIGENCE  ·  APEX REPORT', G.margin, 86, { characterSpacing: 1.8 });

  const titleText = String(title || 'Fleet Report');
  const titleWidth = G.contentWidth - 40;
  doc.fillColor(SAKA_PDF_THEME.white).font(fonts.display)
    .fontSize(coverTitleSize(doc, fonts, titleText, titleWidth))
    .text(titleText, G.margin, 150, { width: titleWidth, lineGap: 2 });
  if (subtitle) {
    // Chips own y = 300, so the subtitle is clamped and single-line.
    doc.fillColor('#CBD5E1').font(fonts.body).fontSize(fontSizeFor(10.5, G))
      .text(String(subtitle), G.margin, Math.min(doc.y + 10, 284), { width: G.contentWidth - 90, lineBreak: false, ellipsis: true });
  }
  let chipX = G.margin;
  const chipY = 300;
  chipX += chip(doc, fonts, chipX, chipY, reportTypeLabel(reportType), accent, { filled: true }, G) + 8;
  if (periodLabel) chipX += chip(doc, fonts, chipX, chipY, periodLabel, SAKA_PDF_THEME.status.info, {}, G) + 8;
  chip(doc, fonts, chipX, chipY, 'Verified data', SAKA_PDF_THEME.status.good, {}, G);

  // v1.29.0 — licence-plate badge for vehicle-scoped reports (KAS 628T).
  const plateLabel = pdfSafeText(report.plate || '').toUpperCase();
  if (plateLabel) {
    doc.font(fonts.mono).fontSize(fontSizeFor(10, G));
    const plateWidth = Math.max(96, Math.min(doc.widthOfString(plateLabel) + 26, 170));
    const badgeX = G.pageWidth - G.margin - plateWidth;
    if (chipX + 12 < badgeX) plateBadge(doc, fonts, badgeX, chipY - 7, report.plate);
  }

  if (highlights.length) {
    const gap = 10;
    const w = (G.contentWidth - gap * (highlights.length - 1)) / highlights.length;
    highlights.forEach((item, index) => {
      const x = G.margin + index * (w + gap);
      paintAlpha(doc, SAKA_PDF_THEME.white, 0.07, () => doc.roundedRect(x, highlightY, w, highlightH, 10).fill());
      paintAlpha(doc, toneColor(item.tone), 0.2, () => doc.roundedRect(x, highlightY, w, highlightH, 10).fill());
      paintAlpha(doc, toneColor(item.tone), 0.95, () => doc.rect(x, highlightY + 14, 3, highlightH - 28).fill());
      doc.fillOpacity(1);
      doc.fillColor('#94A3B8').font(fonts.body).fontSize(fontSizeFor(7, G))
        .text(pdfSafeText(String(item.label || '')).toUpperCase(), x + 15, highlightY + 13, {
          width: w - 28,
          ellipsis: true,
          characterSpacing: 0.8
        });
      doc.fillColor(SAKA_PDF_THEME.white).font(fonts.display).fontSize(fontSizeFor(21, G))
        .text(pdfSafeText(String(item.value ?? '-')), x + 15, highlightY + 25, { width: w - 28, ellipsis: true });
    });
  }

  doc.fillOpacity(1);
  doc.roundedRect(G.margin, cardY, G.contentWidth, cardH, 12).fill(SAKA_PDF_THEME.white);
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(7.5, G))
    .text('PREPARED FOR', G.margin + 16, cardY + 12, { characterSpacing: 0.8 });
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(fontSizeFor(12.5, G))
    .text(owner?.name || 'Fleet owner', G.margin + 16, cardY + 24, { width: G.contentWidth - 32, ellipsis: true });
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(8, G))
    .text([owner?.email, owner?.phone, owner?.plan].filter(Boolean).join('  ·  ') || 'Saka Fleet account', G.margin + 16, cardY + 42, { width: G.contentWidth - 190, ellipsis: true });
  doc.fillColor(accent).font(fonts.bold).fontSize(fontSizeFor(8, G))
    .text(String(owner?.language || 'English').toUpperCase(), G.pageWidth - G.margin - 130, cardY + 24, { width: 114, align: 'right' });

  // v1.32.4 — the drivers panel sits INSIDE the extended band, right under the
  // "prepared for" card, with a label that stays legible on dark ink.
  let peopleY = cardY + cardH + 26;
  if (drivers?.length) {
    doc.fillColor('#94A3B8').font(fonts.body).fontSize(fontSizeFor(8, G))
      .text('DRIVERS ON THIS FLEET', G.margin, peopleY + 10, { characterSpacing: 1, lineBreak: false });
    peopleY += 28;
    let x = G.margin;
    for (const driver of drivers.slice(0, 3)) {
      const w = Math.min(150, (G.contentWidth - 16) / Math.max(drivers.length, 1) - 8);
      doc.roundedRect(x, peopleY, w, 46, 9).fill(SAKA_PDF_THEME.panel);
      doc.roundedRect(x, peopleY, w, 46, 9).lineWidth(0.7).strokeColor(SAKA_PDF_THEME.line).stroke();
      doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(fontSizeFor(9, G))
        .text(driver.name || 'Driver', x + 10, peopleY + 9, { width: w - 20, ellipsis: true });
      doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(7.4, G))
        .text([driver.plate, driver.licenceLabel].filter(Boolean).join(' · ') || 'Assigned driver', x + 10, peopleY + 24, { width: w - 20, ellipsis: true });
      const color = statusColor(driver.status);
      doc.circle(x + 12, peopleY + 36, 2.4).fill(color);
      doc.fillColor(color).font(fonts.body).fontSize(fontSizeFor(6.8, G))
        .text(String(driver.status || 'active').toUpperCase(), x + 18, peopleY + 33, { width: w - 28, ellipsis: true });
      x += w + 8;
    }
  }

  const previousBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(7.4, G))
    .text(`Generated ${report.generatedAt || new Date().toLocaleString()}  ·  sakafleet.com`, G.margin, G.pageHeight - 46, { width: G.contentWidth, align: 'center', lineBreak: false });
  doc.page.margins.bottom = previousBottom;
}

const KPI_GAP = 10;
const KPI_CARD_H = 66;

/**
 * v1.32.4 — PURE KPI grid geometry (exported so the layout can be tested
 * without rendering a PDF). `startY` is the top of the first row; every card in
 * a row shares that exact y, which is what stops the old "staircase" where each
 * card drifted a further `cardH + gap` down the page.
 */
export function computeKpiGrid({
  count = 0,
  contentWidth = CONTENT_WIDTH,
  startY = 0,
  gap = KPI_GAP,
  cardH = KPI_CARD_H,
  columns = 3,
  margin = PAGE_MARGIN
} = {}) {
  const total = Math.max(0, Math.min(Number(count) || 0, 6));
  const cols = Math.max(1, Number(columns) || 3);
  const cardW = (contentWidth - gap * (cols - 1)) / cols;
  const cards = [];
  for (let i = 0; i < total; i += 1) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // Centre an incomplete last row instead of leaving a ragged gap.
    const itemsInRow = Math.min(cols, total - row * cols);
    const offset = ((cols - itemsInRow) * (cardW + gap)) / 2;
    cards.push({
      index: i,
      row,
      col,
      x: margin + offset + col * (cardW + gap),
      y: startY + row * (cardH + gap),
      w: cardW,
      h: cardH
    });
  }
  const rows = Math.ceil(total / cols);
  return {
    cards,
    rows,
    cardW,
    cardH,
    gap,
    startY,
    height: rows ? rows * (cardH + gap) : 0
  };
}

function drawKpiGrid(doc, fonts, kpis, accent, G = SAKA_PDF_GEOMETRY) {
  const items = (kpis || []).slice(0, 6);
  if (!items.length) return;
  const mobile = Boolean(G.minFontFloor);
  const cardH = mobile ? 86 : KPI_CARD_H;
  ensureSpace(doc, cardH + KPI_GAP, fonts, accent, 'Key metrics', G);
  const startY = doc.y;
  const grid = computeKpiGrid({
    count: items.length,
    startY,
    columns: mobile ? 2 : 3,
    cardH,
    contentWidth: G.contentWidth,
    margin: G.margin
  });
  for (const card of grid.cards) {
    const item = items[card.index];
    kpiCard(doc, fonts, {
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      label: item.label,
      value: item.value,
      hint: item.hint,
      tone: item.tone || null,
      accent
    }, G);
  }
  doc.y = startY + grid.height + 6;
}

function drawChartHeading(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  // v1.32.4 — deterministic cursor: one measured block, one advance, no double
  // `doc.y +=` (the old code advanced from the post-text cursor AND added 16).
  const startY = doc.y;
  const titleH = 12;
  const noteH = chart.note ? 10 : 0;
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(fontSizeFor(9.5, G))
    .text(String(chart.title || ''), G.margin, startY, { width: G.contentWidth, lineBreak: false, ellipsis: true });
  if (chart.note) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(7.4, G))
      .text(String(chart.note), G.margin, startY + titleH, { width: G.contentWidth, lineBreak: false, ellipsis: true });
  }
  doc.y = startY + titleH + noteH + 4;
}

function drawBarChart(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  const series = (chart.series || []).slice(0, 7).map((item) => ({ label: String(item.label || ''), value: Number(item.value) || 0, color: item.color }));
  if (!series.length) return;
  ensureSpace(doc, 165, fonts, accent, chart.title, G);
  drawChartHeading(doc, fonts, chart, accent, G);
  const mobile = Boolean(G.minFontFloor);
  const chartH = mobile ? 104 : 92;
  const max = Math.max(...series.map((item) => item.value), 1);
  const gap = 12;
  const barW = Math.max(18, (G.contentWidth - gap * (series.length + 1)) / series.length);
  const baseY = doc.y + chartH;
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.6).moveTo(G.margin, baseY).lineTo(G.pageWidth - G.margin, baseY).stroke();
  let barX = G.margin + gap;
  series.forEach((item, index) => {
    const h = Math.max(2, (item.value / max) * (chartH - 16));
    const color = item.color || (index % 2 === 0 ? accent : SAKA_PDF_THEME.status.info);
    doc.roundedRect(barX, baseY - h, barW, h, 3).fill(color);
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(fontSizeFor(6.6, G))
      .text(number(item.value), barX - 4, baseY - h - (mobile ? 13 : 11), { width: barW + 8, align: 'center' });
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(6.4, G))
      .text(item.label.slice(0, 12), barX - 6, baseY + 4, { width: barW + 12, align: 'center' });
    barX += barW + gap;
  });
  doc.y = baseY + (mobile ? 30 : 22);
}

function drawDonut(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  const series = (chart.series || []).filter((item) => Number(item.value) > 0).slice(0, 6);
  if (!series.length) return;
  ensureSpace(doc, 165, fonts, accent, chart.title, G);
  drawChartHeading(doc, fonts, chart, accent, G);
  const mobile = Boolean(G.minFontFloor);
  const total = series.reduce((sum, item) => sum + Number(item.value), 0) || 1;
  const cx = G.margin + 78;
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
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(fontSizeFor(11, G)).text(number(total), cx - 34, cy - 9, { width: 68, align: 'center' });
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(6.6, G)).text(String(chart.totalLabel || 'total'), cx - 34, cy + 6, { width: 68, align: 'center' });
  } catch {
    drawn = false;
  }
  if (!drawn) {
    let barX = G.margin;
    series.forEach((item, index) => {
      const w = (Number(item.value) / total) * (G.contentWidth * 0.55);
      doc.rect(barX, cy - 8, w, 16).fill(item.color || palette[index % palette.length]);
      barX += w;
    });
  }
  const legendX = mobile ? G.margin + G.contentWidth * 0.52 : PAGE_MARGIN + 300;
  const legendLabelWidth = mobile ? 108 : 150;
  const legendStep = mobile ? 20 : 15;
  let legendY = cy - radius + 4;
  series.forEach((item, index) => {
    const color = item.color || palette[index % palette.length];
    doc.circle(legendX, legendY + 4, 3.2).fill(color);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(7.4, G))
      .text(String(item.label).slice(0, 26), legendX + 10, legendY, { width: legendLabelWidth, ellipsis: true });
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.mono).fontSize(fontSizeFor(6.8, G))
      .text(`${Math.round((Number(item.value) / total) * 100)}%`, G.pageWidth - G.margin - 40, legendY, { width: 40, align: 'right' });
    legendY += legendStep;
  });
  doc.y = cy + radius + (mobile ? 30 : 18);
}

function drawLineChart(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  const series = (chart.series || []).slice(0, 12);
  if (series.length < 2) return;
  ensureSpace(doc, 160, fonts, accent, chart.title, G);
  drawChartHeading(doc, fonts, chart, accent, G);
  const chartH = 88;
  const values = series.map((item) => Number(item.value) || 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const stepX = G.contentWidth / (series.length - 1);
  const baseY = doc.y + chartH;
  const points = series.map((item, index) => ({
    x: G.margin + index * stepX,
    y: baseY - ((Number(item.value) - min) / range) * (chartH - 18) - 6
  }));
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.6).moveTo(G.margin, baseY).lineTo(G.pageWidth - G.margin, baseY).stroke();
  doc.save();
  doc.moveTo(points[0].x, baseY);
  points.forEach((point) => doc.lineTo(point.x, point.y));
  doc.lineTo(points[points.length - 1].x, baseY);
  doc.closePath();
  // v1.32.4 — the fill alpha stays inside this q/Q block and is reset explicitly.
  doc.fillOpacity(0.14);
  doc.fill();
  doc.fillOpacity(1);
  doc.restore();
  doc.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => doc.lineTo(point.x, point.y));
  doc.lineWidth(1.8).strokeColor(accent).stroke();
  points.forEach((point) => doc.circle(point.x, point.y, 2.4).fill(accent));
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(6.4, G))
    .text(String(series[0].label || ''), G.margin, baseY + 4, { width: 120 });
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(6.4, G))
    .text(String(series[series.length - 1].label || ''), G.pageWidth - G.margin - 120, baseY + 4, { width: 120, align: 'right' });
  doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(fontSizeFor(6.6, G))
    .text(`${number(min)} – ${number(max)}`, G.margin, doc.y - 2, { width: 140 });
  doc.y = baseY + (G.minFontFloor ? 30 : 22);
}

function drawProgressChart(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  const series = (chart.series || []).slice(0, 8);
  if (!series.length) return;
  const mobile = Boolean(G.minFontFloor);
  ensureSpace(doc, 40 + series.length * (mobile ? 26 : 20), fonts, accent, chart.title, G);
  drawChartHeading(doc, fonts, chart, accent, G);
  series.forEach((item) => {
    // v1.32.4 — one row = one captured y. Reading `doc.y` after each `text()`
    // call made the label, bar and value drift apart inside the same row.
    const y = doc.y;
    const ratio = Math.max(0, Math.min(1, Number(item.value) / (Number(chart.max) || 100)));
    const color = item.color || (ratio > 0.5 ? SAKA_PDF_THEME.status.good : ratio > 0.2 ? SAKA_PDF_THEME.status.warn : SAKA_PDF_THEME.status.bad);
    const labelWidth = mobile ? 118 : 150;
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(7.4, G))
      .text(String(item.label).slice(0, 34), G.margin, y, { width: labelWidth, ellipsis: true, lineBreak: false });
    doc.roundedRect(G.margin + labelWidth + 8, y + 1, G.contentWidth - labelWidth - 60, 8, 4).fill(SAKA_PDF_THEME.panel);
    doc.roundedRect(G.margin + labelWidth + 8, y + 1, Math.max(4, (G.contentWidth - labelWidth - 60) * ratio), 8, 4).fill(color);
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(fontSizeFor(7, G))
      .text(String(item.text || number(item.value)), G.pageWidth - G.margin - 44, y - 1, { width: 44, align: 'right', lineBreak: false });
    doc.y = y + (mobile ? 24 : 18);
  });
  doc.y += 4;
}

function drawChart(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  const type = String(chart.type || 'bar').toLowerCase();
  if (type === 'donut' || type === 'pie') return drawDonut(doc, fonts, chart, accent, G);
  if (type === 'line') return drawLineChart(doc, fonts, chart, accent, G);
  if (type === 'progress') return drawProgressChart(doc, fonts, chart, accent, G);
  if (type === 'segment' || type === 'segmented' || type === 'split') return drawSegmentedBar(doc, fonts, chart, accent, G);
  if (type === 'vs' || type === 'compare' || type === 'earnings_vs_expenses') return drawVsBars(doc, fonts, chart, accent, G);
  return drawBarChart(doc, fonts, chart, accent, G);
}

function drawTable(doc, fonts, table, accent, G = SAKA_PDF_GEOMETRY) {
  const columns = (table.columns || []).slice(0, 6);
  const rows = (table.rows || []).slice(0, 40);
  if (!columns.length) return;
  const mobile = Boolean(G.minFontFloor);
  sectionTitle(doc, fonts, table.title || 'Details', accent, table.subtitle || null, G);
  const totalWeight = columns.reduce((sum, column) => sum + (Number(column.width) || 1), 0);
  const widths = columns.map((column) => ((Number(column.width) || 1) / totalWeight) * G.contentWidth);
  // v1.32.4 — taller rows + single-line cells: a 90-character value used to
  // wrap into 2-3 lines inside a 22 pt row and print on top of the next row.
  const headerH = mobile ? 30 : 22;
  const rowH = mobile ? 32 : 24;
  ensureSpace(doc, headerH + rowH * Math.min(rows.length, 4) + 10, fonts, accent, table.title, G);
  const headerY = doc.y;
  doc.rect(G.margin, headerY, G.contentWidth, headerH).fill(SAKA_PDF_THEME.ink);
  let cellX = G.margin;
  columns.forEach((column, index) => {
    doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(fontSizeFor(7.8, G))
      .text(String(column.label || '').toUpperCase(), cellX + 8, headerY + (mobile ? 10 : 7.6), {
        width: widths[index] - 16,
        align: column.align === 'right' ? 'right' : 'left',
        ellipsis: true,
        lineBreak: false,
        height: headerH - 9
      });
    cellX += widths[index];
  });
  doc.y = headerY + headerH;
  rows.forEach((row, rowIndex) => {
    ensureSpace(doc, rowH, fonts, accent, table.title, G);
    const rowY = doc.y;
    if (rowIndex % 2 === 1) {
      doc.rect(G.margin, rowY, G.contentWidth, rowH).fill(SAKA_PDF_THEME.panel);
    }
    doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.4).moveTo(G.margin, rowY + rowH).lineTo(G.pageWidth - G.margin, rowY + rowH).stroke();
    let x = G.margin;
    columns.forEach((column, columnIndex) => {
      const raw = row[column.key];
      const value = column.type === 'money'
        ? moneyCell(raw, table.currency)
        : column.type === 'number'
          ? numberCell(raw)
          : String(raw ?? '—');
      const isStatus = column.type === 'status';
      const color = isStatus ? statusColor(raw) : SAKA_PDF_THEME.slate;
      if (isStatus) doc.circle(x + 12, rowY + rowH / 2, 2.6).fill(color);
      doc.fillColor(color).font(isStatus ? fonts.bold : fonts.body).fontSize(fontSizeFor(8.2, G))
        .text(value, x + (isStatus ? 19 : 8), rowY + (mobile ? 10 : 7.8), {
          width: widths[columnIndex] - (isStatus ? 25 : 16),
          align: column.align === 'right' ? 'right' : 'left',
          ellipsis: true,
          lineBreak: false,
          height: rowH - 9
        });
      x += widths[columnIndex];
    });
    doc.y = rowY + rowH;
  });
  doc.y += 10;
}

/* ------------------------------------------------------------------ */
/* v1.29.0 — Apex components: badges, segmented bars, callouts, ledger  */
/* ------------------------------------------------------------------ */

/** Pill badge: tinted fill + coloured text + hairline border. */
function drawBadge(doc, fonts, x, y, text, tone = 'neutral', { size = null, height = null, maxWidth = 96 } = {}, G = SAKA_PDF_GEOMETRY) {
  const label = pdfSafeText(text).toUpperCase();
  if (!label) return 0;
  const color = toneColor(tone);
  const cursorY = doc.y;
  const badgeSize = size === null ? fontSizeFor(6.4, G) : size;
  const badgeHeight = height === null ? (G.minFontFloor ? 20 : 12) : height;
  doc.font(fonts.bold).fontSize(badgeSize);
  const width = Math.max(24, Math.min(doc.widthOfString(label) + 12, maxWidth));
  paintAlpha(doc, color, 0.13, () => doc.roundedRect(x, y, width, badgeHeight, badgeHeight / 2).fill());
  doc.roundedRect(x, y, width, badgeHeight, badgeHeight / 2).lineWidth(0.6).strokeColor(color).stroke();
  doc.fillColor(color).font(fonts.bold).fontSize(badgeSize)
    .text(label, x + 5, y + (badgeHeight - badgeSize) / 2 + 0.6, { width: width - 10, align: 'center', ellipsis: true, lineBreak: false });
  doc.y = cursorY;
  return width;
}

/** Horizontal proportional split (Fuel vs maintenance vs other, per vehicle…). */
function drawSegmentedBar(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  const raw = chart.segments || chart.series || [];
  const segments = raw
    .map((item) => ({ label: String(item.label || ''), value: Number(item.value) || 0, color: item.color }))
    .filter((item) => item.value !== 0);
  const mobile = Boolean(G.minFontFloor);
  ensureSpace(doc, 100, fonts, accent, chart.title, G);
  drawChartHeading(doc, fonts, chart, accent, G);
  const total = segments.reduce((sum, item) => sum + Math.abs(item.value), 0);
  if (!total) {
    doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(8, G))
      .text('No activity recorded in this period.', G.margin, doc.y, { width: G.contentWidth });
    doc.y += 24;
    return;
  }
  const palette = ['#65A30D', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#14B8A6', '#6366F1', '#64748B'];
  const barY = doc.y;
  const barH = 18;
  doc.save();
  doc.roundedRect(G.margin, barY, G.contentWidth, barH, 9).clip();
  let x = G.margin;
  segments.forEach((item, index) => {
    const width = (Math.abs(item.value) / total) * G.contentWidth;
    doc.rect(x, barY, Math.max(width, 2), barH).fill(item.color || palette[index % palette.length]);
    x += width;
  });
  doc.restore();

  const columns = segments.length > 4 ? 2 : 1;
  const colWidth = G.contentWidth / columns;
  const step = mobile ? 20 : 15;
  segments.forEach((item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const lx = G.margin + col * colWidth;
    const ly = barY + barH + 10 + row * step;
    const color = item.color || palette[index % palette.length];
    doc.circle(lx + 3.5, ly + 4, 3.2).fill(color);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(7.2, G))
      .text(pdfSafeText(item.label).slice(0, 26), lx + 11, ly, { width: Math.max(40, colWidth - 124), ellipsis: true, lineBreak: false });
    const pct = Math.round((Math.abs(item.value) / total) * 100);
    const valueText = `${chart.currency ? `${money(item.value, chart.currency)}  ` : ''}${pct}%`;
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(fontSizeFor(6.6, G))
      .text(pdfSafeText(valueText), lx + colWidth - 100, ly, { width: 96, align: 'right', ellipsis: true, lineBreak: false });
  });
  doc.y = barY + barH + 16 + Math.ceil(segments.length / columns) * step;
}

/** Earnings vs expenses pair bars with an explicit net verdict. */
function drawVsBars(doc, fonts, chart, accent, G = SAKA_PDF_GEOMETRY) {
  const earnings = Number(chart.earnings ?? chart.income ?? 0) || 0;
  const expenses = Number(chart.expenses ?? 0) || 0;
  ensureSpace(doc, 96, fonts, accent, chart.title, G);
  drawChartHeading(doc, fonts, chart, accent, G);
  const max = Math.max(Math.abs(earnings), Math.abs(expenses), 1);
  const barMaxW = G.contentWidth - 190;
  [
    { label: 'Earnings', value: earnings, color: SAKA_PDF_THEME.positive },
    { label: 'Expenses', value: expenses, color: SAKA_PDF_THEME.negative }
  ].forEach((item) => {
    const y = doc.y;
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(7.6, G))
      .text(item.label, G.margin, y + 2, { width: 80 });
    doc.roundedRect(G.margin + 84, y + 1, barMaxW, 10, 5).fill(SAKA_PDF_THEME.panel);
    doc.roundedRect(G.margin + 84, y + 1, Math.max(3, (Math.abs(item.value) / max) * barMaxW), 10, 5).fill(item.color);
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(fontSizeFor(7.2, G))
      .text(moneyCell(item.value, chart.currency), G.margin + 84 + barMaxW + 8, y + 1, { width: 92, align: 'right' });
    doc.y = y + 17;
  });
  const net = earnings - expenses;
  doc.fillColor(net >= 0 ? SAKA_PDF_THEME.positive : SAKA_PDF_THEME.negative).font(fonts.bold).fontSize(fontSizeFor(8, G))
    .text(`${net >= 0 ? 'Net surplus' : 'Net shortfall'}: ${money(Math.abs(net), chart.currency)}`, G.margin, doc.y + 2, { width: G.contentWidth });
  doc.y += 22;
}

/** Insight callout: accent rail + plain-language verdict. */
function drawCallout(doc, fonts, callout, accent, G = SAKA_PDF_GEOMETRY) {
  const color = toneColor(callout.tone || 'brand');
  const title = pdfSafeText(callout.title || '');
  const body = pdfSafeText(callout.body || '');
  if (!title && !body) return;
  doc.font(fonts.body).fontSize(fontSizeFor(8.2, G));
  const bodyHeight = body ? doc.heightOfString(body, { width: G.contentWidth - 40 }) : 0;
  const height = 18 + (title ? 12 : 0) + bodyHeight + 10;
  ensureSpace(doc, height + 10, fonts, accent, 'Insight', G);
  const y = doc.y;
  doc.roundedRect(G.margin, y, G.contentWidth, height, 9).fill(SAKA_PDF_THEME.panel);
  doc.roundedRect(G.margin, y, G.contentWidth, height, 9).lineWidth(0.7).strokeColor(SAKA_PDF_THEME.line).stroke();
  doc.rect(G.margin, y, 4, height).fill(color);
  let textY = y + 10;
  if (title) {
    doc.fillColor(color).font(fonts.bold).fontSize(fontSizeFor(8.4, G))
      .text(title.toUpperCase(), G.margin + 16, textY, { width: G.contentWidth - 32, characterSpacing: 0.5, ellipsis: true });
    textY += 13;
  }
  if (body) {
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(8.2, G))
      .text(body, G.margin + 16, textY, { width: G.contentWidth - 32, lineGap: 1 });
  }
  doc.y = y + height + 8;
}

const LEDGER_COLUMNS = Object.freeze([
  { key: 'date', label: 'Date', width: 0.9 },
  { key: 'kindLabel', label: 'Type', width: 0.85 },
  { key: 'description', label: 'Description', width: 2.5 },
  { key: 'odometer', label: 'Odometer', width: 0.9, align: 'right' },
  { key: 'unitCost', label: 'Unit cost', width: 0.9, align: 'right' },
  { key: 'amount', label: 'Total', width: 1.05, align: 'right' }
]);

const LEDGER_COLUMNS_WITH_VEHICLE = Object.freeze([
  { key: 'date', label: 'Date', width: 0.8 },
  { key: 'vehicle', label: 'Vehicle', width: 0.8 },
  { key: 'kindLabel', label: 'Type', width: 0.8 },
  { key: 'description', label: 'Description', width: 2.05 },
  { key: 'odometer', label: 'Odometer', width: 0.8, align: 'right' },
  { key: 'unitCost', label: 'Unit cost', width: 0.8, align: 'right' },
  { key: 'amount', label: 'Total', width: 0.95, align: 'right' }
]);

/**
 * v1.93.0 (Phase 30, Task 1) — the phone (A5) ledger keeps every ROW but shows
 * the columns that read at 10 pt: Date, Type badge, Description, Total (plus
 * Vehicle on a fleet-wide ledger). Nothing is hidden from the record; the full
 * column set stays on the A4 variant and the records page.
 */
const LEDGER_COLUMNS_COMPACT = Object.freeze([
  { key: 'date', label: 'Date', width: 0.9 },
  { key: 'kindLabel', label: 'Type', width: 0.9 },
  { key: 'description', label: 'Description', width: 2.1 },
  { key: 'amount', label: 'Total', width: 1.0, align: 'right' }
]);

const LEDGER_COLUMNS_COMPACT_WITH_VEHICLE = Object.freeze([
  { key: 'date', label: 'Date', width: 0.8 },
  { key: 'vehicle', label: 'Vehicle', width: 0.85 },
  { key: 'kindLabel', label: 'Type', width: 0.8 },
  { key: 'description', label: 'Description', width: 1.75 },
  { key: 'amount', label: 'Total', width: 0.9, align: 'right' }
]);

/**
 * v1.86.0 (Phase 25) — the ledger's reading column takes its NAME from the
 * ledger payload (`reportLedger.buildLedgerGroups` -> fleetReports). A machine
 * ledger prints "Engine hours"; a mixed fleet prints "Reading"; only a road
 * ledger prints "Odometer". Exported so the label is provable without rendering.
 * v1.93.0 — `compact` returns the phone column set (no reading/unit-cost).
 */
export function buildLedgerColumns({ showVehicle = false, meterLabel = 'Odometer', compact = false } = {}) {
  const label = pdfSafeText(meterLabel) || 'Odometer';
  if (compact) {
    const compactBase = showVehicle ? LEDGER_COLUMNS_COMPACT_WITH_VEHICLE : LEDGER_COLUMNS_COMPACT;
    return compactBase.map((column) => ({ ...column }));
  }
  const base = showVehicle ? LEDGER_COLUMNS_WITH_VEHICLE : LEDGER_COLUMNS;
  return base.map((column) => (column.key === 'odometer' ? { ...column, label } : { ...column }));
}

function monthLabelFromKey(key) {
  const date = new Date(`${key}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'Activity';
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Groups supplied by builders win; otherwise derive month groups from ISO dates. */
function ledgerGroups(ledger) {
  if (Array.isArray(ledger.groups) && ledger.groups.length) return ledger.groups;
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  if (!rows.length) return [];
  const map = new Map();
  for (const row of rows) {
    const at = String(row.at || row.date || '');
    const match = at.match(/^(\d{4})-(\d{2})/);
    const key = match ? `${match[1]}-${match[2]}` : 'activity';
    if (!map.has(key)) map.set(key, { key, label: match ? monthLabelFromKey(key) : 'Activity', rows: [] });
    map.get(key).rows.push(row);
  }
  return [...map.values()].sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

/**
 * Itemized Activity & Ledger (v1.29.0): Date | Vehicle? | Type badge |
 * Description | Odometer | Unit cost | Total, month groups with subtotals,
 * zebra rows, a bold total band and an explicit "nothing hidden" footer.
 */
function drawLedger(doc, fonts, ledger, accent, G = SAKA_PDF_GEOMETRY) {
  const groups = ledgerGroups(ledger);
  if (!groups.length) return;
  const currency = ledger.currency || null;
  const mobile = Boolean(G.minFontFloor);
  const columns = buildLedgerColumns({ showVehicle: ledger.showVehicle, meterLabel: ledger.meterLabel, compact: mobile });
  const title = ledger.title || 'Itemized activity & ledger';
  const totalWeight = columns.reduce((sum, column) => sum + column.width, 0);
  const widths = columns.map((column) => (column.width / totalWeight) * G.contentWidth);
  // v1.32.4 — 21 pt rows (was 19) with single-line cells: descriptions were
  // wrapping into a second line and printing over the following row.
  // v1.86.0 (Phase 25) — 23 pt rows and a 8pt type floor: a report is read on a
  // phone at 100% zoom, so no cell may print below 8pt.
  // v1.93.0 (Phase 30) — the phone variant uses 32 pt rows under a 10 pt floor.
  const headerH = mobile ? 30 : 23;
  const rowH = mobile ? 32 : 23;

  sectionTitle(doc, fonts, title, accent, ledger.subtitle || null, G);

  const drawHeader = () => {
    const y = doc.y;
    doc.rect(G.margin, y, G.contentWidth, headerH).fill(SAKA_PDF_THEME.ink);
    let x = G.margin;
    columns.forEach((column, index) => {
      doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(fontSizeFor(8, G))
        .text(pdfSafeText(column.label).toUpperCase(), x + 5, y + (mobile ? 10 : 7.4), {
          width: widths[index] - 10,
          align: column.align === 'right' ? 'right' : 'left',
          ellipsis: true,
          lineBreak: false,
          height: headerH - 10
        });
      x += widths[index];
    });
    doc.y = y + headerH;
  };

  const ensureRow = (needed) => {
    ensureSpace(doc, needed, fonts, accent, title, G);
    if (doc.y <= 78) drawHeader();
  };

  ensureRow(headerH + rowH * 3);
  drawHeader();

  let zebra = 0;
  const allRows = [];
  for (const group of groups) {
    const rows = group.rows || [];
    if (!rows.length) continue;
    allRows.push(...rows);
    ensureRow(24 + rowH);
    const bandY = doc.y;
    doc.rect(G.margin, bandY, G.contentWidth, 19).fill(SAKA_PDF_THEME.line);
    doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(fontSizeFor(7.4, G))
      .text(pdfSafeText(group.label || 'Activity'), G.margin + 6, bandY + 5.6, { width: G.contentWidth * 0.4, ellipsis: true, lineBreak: false, height: 12 });
    const groupExpenses = Number(group.expenseTotal ?? 0);
    const groupEarnings = Number(group.earningTotal ?? 0);
    const groupParts = [];
    if (groupExpenses) groupParts.push(`Spent ${money(groupExpenses, currency)}`);
    if (groupEarnings) groupParts.push(`Earned ${money(groupEarnings, currency)}`);
    if (!groupParts.length) groupParts.push(`${rows.length} record${rows.length === 1 ? '' : 's'}`);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.mono).fontSize(fontSizeFor(6.8, G))
      .text(pdfSafeText(groupParts.join('  ·  ')), G.margin + G.contentWidth * 0.4, bandY + 5.8, {
        width: G.contentWidth * 0.6 - 6,
        align: 'right',
        ellipsis: true,
        lineBreak: false,
        height: 12
      });
    doc.y = bandY + 21;

    for (const row of rows) {
      ensureRow(rowH);
      const y = doc.y;
      if (zebra % 2 === 1) doc.rect(G.margin, y, G.contentWidth, rowH).fill(SAKA_PDF_THEME.panel);
      let x = G.margin;
      const kindLabel = row.kindLabel || row.kind || 'LOG';
      columns.forEach((column, index) => {
        const width = widths[index];
        const cellText = { width: width - (column.align === 'right' ? 8 : 10), ellipsis: true, lineBreak: false, height: rowH - 9 };
        const textY = y + (mobile ? 10 : 7.2);
        if (column.key === 'kindLabel') {
          drawBadge(doc, fonts, x + 4, y + (mobile ? 6 : 4), kindLabel, ledgerTone(row.kind || kindLabel), mobile
            ? { size: fontSizeFor(6.6, G), height: 20, maxWidth: width - 8 }
            : { size: 6.6, height: 13, maxWidth: width - 8 }, G);
        } else if (column.key === 'date') {
          doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(8.2, G))
            .text(pdfSafeText(row.date ?? '—'), x + 5, textY, cellText);
        } else if (column.key === 'vehicle') {
          doc.fillColor(SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(fontSizeFor(8.2, G))
            .text(pdfSafeText(row.vehicle ?? '—'), x + 5, textY, cellText);
        } else if (column.key === 'description') {
          doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(8.2, G))
            .text(pdfSafeText(row.description ?? '—'), x + 5, textY, cellText);
        } else if (column.key === 'odometer') {
          doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.mono).fontSize(fontSizeFor(8, G))
            .text(numberCell(row.odometer), x + 4, y + (mobile ? 10.2 : 7.4), { ...cellText, align: 'right' });
        } else if (column.key === 'unitCost') {
          doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.mono).fontSize(fontSizeFor(8, G))
            .text(moneyCell(row.unitCost, row.unitCurrency || currency), x + 4, y + (mobile ? 10.2 : 7.4), { ...cellText, align: 'right' });
        } else if (column.key === 'amount') {
          const earning = /earning|revenue|income/i.test(String(row.kind || ''));
          doc.fillColor(earning ? SAKA_PDF_THEME.positive : SAKA_PDF_THEME.ink).font(fonts.mono).fontSize(fontSizeFor(8.2, G))
            .text(moneyCell(row.amount, row.currency || currency), x + 4, textY, { ...cellText, align: 'right' });
        } else {
          doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(8.2, G))
            .text(pdfSafeText(row[column.key] ?? '—'), x + 5, textY, cellText);
        }
        x += width;
      });
      doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.35)
        .moveTo(G.margin, y + rowH).lineTo(G.pageWidth - G.margin, y + rowH).stroke();
      doc.y = y + rowH;
      zebra += 1;
    }
  }

  const totals = ledger.totals || {};
  const isEarningRow = (row) => /earning|revenue|income/i.test(String(row.kind || ''));
  const expenseTotal = Number(totals.expenseTotal ?? allRows.reduce((sum, row) => sum + (isEarningRow(row) ? 0 : Number(row.amount) || 0), 0));
  const earningTotal = Number(totals.earningTotal ?? allRows.reduce((sum, row) => sum + (isEarningRow(row) ? Number(row.amount) || 0 : 0), 0));
  const net = earningTotal - expenseTotal;

  ensureSpace(doc, 42, fonts, accent, title, G);
  const totalY = doc.y;
  doc.rect(G.margin, totalY, G.contentWidth, 23).fill(SAKA_PDF_THEME.ink);
  doc.fillColor(SAKA_PDF_THEME.white).font(fonts.bold).fontSize(fontSizeFor(7, G))
    .text(`TOTAL · ${allRows.length} RECORD${allRows.length === 1 ? '' : 'S'}`, G.margin + 8, totalY + (mobile ? 9 : 7.6), {
      width: G.contentWidth * 0.4,
      characterSpacing: 0.5
    });
  const totalParts = [];
  if (expenseTotal || earningTotal) {
    totalParts.push(`Spent ${money(expenseTotal, currency)}`);
    if (earningTotal) totalParts.push(`Earned ${money(earningTotal, currency)}`, `Net ${money(net, currency)}`);
  } else {
    totalParts.push('No amounts recorded');
  }
  doc.fillColor(SAKA_PDF_THEME.white).font(fonts.mono).fontSize(fontSizeFor(6.8, G))
    .text(pdfSafeText(totalParts.join('  ·  ')), G.margin + G.contentWidth * 0.3, totalY + (mobile ? 9 : 7.7), {
      width: G.contentWidth * 0.7 - 8,
      align: 'right',
      ellipsis: true
    });
  doc.y = totalY + 23 + 6;

  const scanned = Number(totals.scanned ?? allRows.length);
  const shown = Number(totals.shown ?? allRows.length);
  const footnote = ledger.footnote
    || (scanned > shown
      ? `Showing ${shown} of ${scanned} records scanned in this period.`
      : `All ${shown} record(s) in this period are shown — nothing hidden.`);
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(6.8, G))
    .text(pdfSafeText(footnote), G.margin, doc.y, { width: G.contentWidth });
  doc.y += 18;
}

function drawSection(doc, fonts, section, accent, G = SAKA_PDF_GEOMETRY) {
  const rows = section.rows || [];
  const lines = section.lines || [];
  if (!rows.length && !lines.length) return;
  sectionTitle(doc, fonts, section.title || 'Notes', accent, section.subtitle || null, G);
  rows.forEach((row) => {
    ensureSpace(doc, 20, fonts, accent, section.title, G);
    const y = doc.y;
    const status = row.status ? statusColor(row.status) : null;
    if (status) doc.circle(G.margin + 4, y + 6, 2.6).fill(status);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(8.6, G))
      .text(String(row.label || ''), G.margin + (status ? 12 : 0), y, { width: G.contentWidth * 0.62, ellipsis: true });
    doc.fillColor(row.valueColor || SAKA_PDF_THEME.ink).font(fonts.bold).fontSize(fontSizeFor(8.6, G))
      .text(String(row.value ?? '—'), G.pageWidth - G.margin - G.contentWidth * 0.34, y, { width: G.contentWidth * 0.34, align: 'right', ellipsis: true });
    doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.35).moveTo(G.margin, y + 15).lineTo(G.pageWidth - G.margin, y + 15).stroke();
    doc.y = y + 19;
  });
  lines.forEach((line) => {
    ensureSpace(doc, 16, fonts, accent, section.title, G);
    doc.fillColor(SAKA_PDF_THEME.slate).font(fonts.body).fontSize(fontSizeFor(8.4, G))
      .text(`•  ${String(line)}`, G.margin, doc.y, { width: G.contentWidth });
    doc.y += 4;
  });
  doc.y += 8;
}

function drawFooter(doc, fonts, pageNumber, pageCount, accent, G = SAKA_PDF_GEOMETRY) {
  const previousBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.strokeColor(SAKA_PDF_THEME.line).lineWidth(0.5).moveTo(G.margin, G.pageHeight - 44).lineTo(G.pageWidth - G.margin, G.pageHeight - 44).stroke();
  doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(7, G))
    .text('SAKA FLEET  ·  APEX REPORT', G.margin, G.pageHeight - 34, { width: G.contentWidth * 0.6, characterSpacing: 0.6, lineBreak: false });
  doc.fillColor(accent).font(fonts.bold).fontSize(fontSizeFor(7, G))
    .text(`Page ${pageNumber} of ${pageCount}`, G.pageWidth - G.margin - 110, G.pageHeight - 34, { width: 110, align: 'right', lineBreak: false });
  doc.page.margins.bottom = previousBottom;
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
      // v1.93.0 (Phase 30, Task 1) — the variant decides the page: the default
      // (A4) path passes the frozen A4 set, so its output is byte-identical.
      const G = resolvePdfGeometry(report.variant);
      const mobile = G.minFontFloor > 0;
      const doc = new PDFDocument({
        size: mobile ? [G.pageWidth, G.pageHeight] : 'A4',
        margins: { top: 70, bottom: 60, left: G.margin, right: G.margin },
        bufferPages: true,
        info: {
          Title: report.title || 'Saka Fleet Report',
          Author: 'Saka Fleet',
          Creator: 'Saka Fleet Apex Reports v1.29.0',
          Subject: report.subtitle || 'Fleet intelligence report'
        }
      });
      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const fonts = report.useStandardFonts
        ? { body: 'Helvetica', bold: 'Helvetica-Bold', display: 'Helvetica-Bold', mono: 'Courier' }
        : registerReportFonts(doc);
      const accent = getReportAccent(report.reportType);
      const prepared = {
        ...report,
        generatedAt: report.generatedAt || new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' })
      };

      // v1.28.7 — sanitise EVERY string drawn into the document (cover, KPI
      // cards, charts, tables, sections, footer) so no emoji or unsupported
      // glyph can ever reach the page as a tofu box.
      const rawText = doc.text.bind(doc);
      doc.text = (value, ...args) => rawText(
        Array.isArray(value) ? value.map(pdfSafeText) : pdfSafeText(value),
        ...args
      );

      drawCover(doc, fonts, prepared, accent, G);

      const hasContent = (report.kpis?.length || report.charts?.length || report.ledgers?.length
        || report.tables?.length || report.callouts?.length || report.sections?.length || report.notes?.length);
      if (hasContent) {
        doc.addPage();
        contentHeader(doc, fonts, accent, report.title, G);
        drawKpiGrid(doc, fonts, report.kpis || [], accent, G);
        for (const chart of report.charts || []) {
          ensureSpace(doc, 150, fonts, accent, report.title, G);
          drawChart(doc, fonts, chart, accent, G);
        }
        for (const ledger of report.ledgers || []) drawLedger(doc, fonts, ledger, accent, G);
        for (const table of report.tables || []) drawTable(doc, fonts, table, accent, G);
        for (const callout of report.callouts || []) drawCallout(doc, fonts, callout, accent, G);
        for (const section of report.sections || []) drawSection(doc, fonts, section, accent, G);
        if (report.notes?.length) {
          sectionTitle(doc, fonts, 'Notes', accent, null, G);
          report.notes.forEach((note) => {
            ensureSpace(doc, 16, fonts, accent, 'Notes', G);
            doc.fillColor(SAKA_PDF_THEME.muted).font(fonts.body).fontSize(fontSizeFor(8.6, G))
              .text(String(note), G.margin, doc.y, { width: G.contentWidth });
            doc.y += 5;
          });
        }
      }

      const range = doc.bufferedPageRange();
      for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(range.start + index);
        drawFooter(doc, fonts, index + 1, range.count, accent, G);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export default {
  SAKA_PDF_THEME,
  SAKA_PDF_GEOMETRY,
  SAKA_PDF_GEOMETRY_MOBILE,
  resolvePdfGeometry,
  normalizePdfVariant,
  getReportAccent,
  registerReportFonts,
  computeKpiGrid,
  buildLedgerColumns,
  buildProReportPdf
};






