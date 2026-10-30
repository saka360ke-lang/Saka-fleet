import zlib from 'node:zlib';

/**
 * Saka Fleet — Zero-dependency PDF text extractor (v1.20.0)
 * ---------------------------------------------------------
 * Google Vision `images:annotate` cannot read PDFs directly, and the async
 * batch API would require a GCS bucket + polling. Most "uneditable" documents
 * (logbooks, insurance certificates, e-statements, licences) are digitally
 * generated PDFs that DO carry a text layer, so Saka extracts it locally:
 *
 *   1. Scan the raw file for `stream ... endstream` segments.
 *   2. Inflate `FlateDecode` streams with Node's built-in zlib.
 *   3. Walk PDF content operators (Tj, TJ, ', ") and decode literal + hex
 *      strings into reading order.
 *
 * Scanned (image-only) PDFs have no text layer; callers must fall back to
 * "send the pages as photos". This module never throws.
 */

const PDF_MAX_PAGES = (() => {
  const raw = Number(process.env.OCR_PDF_MAX_PAGES || 20);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 80) : 20;
})();

export const OCR_PDF_MAX_PAGES = PDF_MAX_PAGES;

function decodeLiteralString(source, start) {
  // start points at '(' — walk balanced parens, honouring escapes.
  let depth = 0;
  let out = '';
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (next in escapes) { out += escapes[next]; i += 2; continue; }
      const octal = source.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
      if (octal) { out += String.fromCharCode(parseInt(octal[0], 8)); i += 1 + octal[0].length; continue; }
      if (next === '\n') { i += 2; continue; }
      out += next || '';
      i += 2;
      continue;
    }
    if (ch === '(') { depth += 1; if (depth === 1) { i += 1; continue; } }
    if (ch === ')') { depth -= 1; if (depth === 0) return { text: out, end: i + 1 }; }
    out += ch;
    i += 1;
  }
  return { text: out, end: source.length };
}

function hexToString(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  // Heuristic for UTF-16BE text (many PDFs emit 00 41 00 42 for "AB").
  if (out.length > 1 && out.charCodeAt(0) === 0) {
    let utf16 = '';
    for (let i = 0; i + 1 < out.length; i += 2) {
      utf16 += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1));
    }
    return utf16;
  }
  return out;
}

/**
 * Walk a decoded content stream and return text in reading order.
 * Handles: (literal) Tj, [(a) -120 (b)] TJ, (x) ', plus Td/TD/T*.
 */
export function extractTextFromContentStream(content = '') {
  const source = String(content || '');
  let out = '';
  let i = 0;
  let inArray = false;
  let arrayParts = [];
  let pendingString = null;

  const flushArray = () => {
    if (!arrayParts.length) return;
    let joined = '';
    for (const part of arrayParts) {
      if (typeof part === 'string') joined += part;
      else if (Number(part) <= -120) joined += ' ';
    }
    out += `${joined.replace(/\s+/g, ' ').trim()} `;
    arrayParts = [];
    inArray = false;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '%') {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? source.length : eol + 1;
      continue;
    }

    if (source.startsWith('BT', i)) { out += '\n'; i += 2; continue; }
    if (ch === '[') { inArray = true; arrayParts = []; i += 1; continue; }
    if (ch === ']') { i += 1; continue; }

    if (ch === '(') {
      const literal = decodeLiteralString(source, i);
      i = literal.end;
      if (inArray) arrayParts.push(literal.text);
      else pendingString = literal.text;
      continue;
    }

    if (ch === '<' && source[i + 1] !== '<') {
      const end = source.indexOf('>', i);
      if (end > i) {
        const hex = hexToString(source.slice(i + 1, end));
        i = end + 1;
        if (inArray) arrayParts.push(hex);
        else pendingString = hex;
        continue;
      }
    }

    if (source.startsWith('TJ', i)) { flushArray(); pendingString = null; i += 2; continue; }
    if (source.startsWith('Tj', i)) {
      if (pendingString !== null) out += `${pendingString} `;
      pendingString = null;
      i += 2;
      continue;
    }
    if (source.startsWith('T*', i)) { out += '\n'; pendingString = null; i += 2; continue; }
    if (source.startsWith('Td', i) || source.startsWith('TD', i)) { out += '\n'; pendingString = null; i += 2; continue; }
    if (ch === "'" || ch === '"') {
      if (pendingString !== null) out += `\n${pendingString} `;
      pendingString = null;
      i += 1;
      continue;
    }

    // Numeric array items are kerning offsets.
    if (inArray && (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9'))) {
      let j = i;
      let num = '';
      while (j < source.length && /[-+0-9.]/.test(source[j])) { num += source[j]; j += 1; }
      if (num && !Number.isNaN(Number(num))) { arrayParts.push(Number(num)); i = j; continue; }
    }

    i += 1;
  }
  flushArray();
  return out;
}
function inflateStream(raw) {
  const attempts = [
    () => zlib.inflateSync(raw),
    () => zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
  ];
  for (const attempt of attempts) {
    try {
      const result = attempt();
      if (result && result.length) return result;
    } catch { /* try the next strategy */ }
  }
  return null;
}

function isTextual(buffer) {
  // Printable ASCII / whitespace ratio — rejects binary garbage from CID fonts.
  const sample = buffer.slice(0, 4000).toString('latin1');
  if (!sample.trim()) return false;
  let printable = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code > 160) printable += 1;
  }
  return printable / sample.length >= 0.55;
}

/**
 * Extract the text layer from a PDF buffer.
 * @returns {{ text: string|null, pages: number|null, error: string|null }}
 */
export function extractPdfText(buffer) {
  if (!buffer || !buffer.length) return { text: null, pages: null, error: 'No PDF buffer' };
  try {
    const head = buffer.slice(0, 5).toString('latin1');
    if (!head.startsWith('%PDF')) return { text: null, pages: null, error: 'Not a PDF document' };

    const raw = buffer.toString('latin1');
    const pageMatches = raw.match(/\/Type\s*\/Page\b/g);
    const pages = pageMatches ? pageMatches.length : null;
    if (pages && pages > PDF_MAX_PAGES) {
      return { text: null, pages, error: `PDF has ${pages} pages (max ${PDF_MAX_PAGES}) — send the first pages as photos` };
    }

    const chunks = [];
    let cursor = 0;
    while (chunks.length < 400) {
      const start = raw.indexOf('stream', cursor);
      if (start === -1) break;
      let dataStart = start + 'stream'.length;
      if (raw[dataStart] === '\r') dataStart += 1;
      if (raw[dataStart] === '\n') dataStart += 1;
      const end = raw.indexOf('endstream', dataStart);
      if (end === -1) break;

      const dictStart = raw.lastIndexOf('<<', start);
      const dictionary = dictStart === -1 ? '' : raw.slice(dictStart, start);
      const isFlate = /\/FlateDecode/.test(dictionary);
      const isImage = /\/Subtype\s*\/Image/.test(dictionary);
      const segment = buffer.slice(dataStart, end);

      if (!isImage) {
        let decoded = null;
        if (isFlate) decoded = inflateStream(segment);
        else if (!/\/Filter/.test(dictionary)) decoded = segment;
        if (decoded) {
          const text = extractTextFromContentStream(decoded.toString('latin1'));
          if (text && text.trim()) chunks.push(text);
        }
      }
      cursor = end + 'endstream'.length;
    }

    const text = chunks.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text || text.length < 4 || !isTextual(Buffer.from(text, 'latin1'))) {
      return {
        text: null,
        pages,
        error: 'No readable text layer in this PDF (it looks like a scan) — send the pages as photos'
      };
    }
    return { text: text.slice(0, 4000), pages, error: null };
  } catch (err) {
    return { text: null, pages: null, error: `PDF text extraction failed: ${err.message}` };
  }
}

export default { extractPdfText, extractTextFromContentStream, OCR_PDF_MAX_PAGES };

