/**
 * Saka Fleet — Speech-to-Text (STT) service (v1.79.0, Phase 18)
 * ------------------------------------------------------------
 * WhatsApp voice notes are downloaded from Meta (ocrService.downloadWhatsAppMedia)
 * and transcribed with Google Cloud Speech-to-Text v1 (`speech:recognize`).
 * DeepSeek is text-only, so STT is the bridge that lets Saka "hear" a voice note
 * and treat the transcript exactly like a typed message.
 *
 * Design rules (mirrors src/services/ocrService.js):
 *  - No new npm dependency: Google Speech is called through the global fetch.
 *  - Never throws: every failure returns { text: null, error } so the chat turn
 *    can degrade to the deterministic v1.61.15 fallback line.
 *  - Hard timeouts, one retry on abort/timeout only, size/duration guards.
 *  - Global audience (rule 7): the language pair comes from the phone's country
 *    (KE → sw-KE primary, en-KE/en-US alternatives; everyone else → en-US + sw-KE).
 *  - The sync recognizer is capped by Google at 60 seconds / 10 MB, so the
 *    duration guard clamps to STT_MAX_DURATION_SECONDS (default 55 s, max 60 s).
 */

const DEFAULT_STT_ENDPOINT = 'https://speech.googleapis.com/v1/speech:recognize';

function clampNumber(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Speech-to-Text request budget (sync recognize of ≤60 s audio). */
export const STT_TIMEOUT_MS = clampNumber(process.env.STT_TIMEOUT_MS, 25000, { min: 1000, max: 60000 });
/** One retry on abort/timeout (idempotent recognize); HTTP/credential errors never retry. */
export const STT_MAX_ATTEMPTS = clampNumber(process.env.STT_MAX_ATTEMPTS, 2, { min: 1, max: 3 });
/** Google caps synchronous recognition at 60 s; 55 s keeps a safety margin. */
export const STT_MAX_DURATION_SECONDS = clampNumber(process.env.STT_MAX_DURATION_SECONDS, 55, { min: 5, max: 60 });
/** WhatsApp voice notes are OGG/OPUS at ~16 kbps; used only for the duration estimate. */
export const STT_ESTIMATED_BITRATE = clampNumber(process.env.STT_ESTIMATED_BITRATE, 16000, { min: 1000 });

/**
 * v1.88.0 — the explicit sample rate sent with OGG_OPUS (default 16000, the
 * WhatsApp opus rate). Google's sync `speech:recognize` REQUIRES
 * `sampleRateHertz` for OGG_OPUS; without it the API reads rate 0 from the
 * container and rejects the request live:
 *   `Invalid recognition 'config': Opus sample rate (0) not in supported rates …`
 * (live proof 2026-11-09, ocr_requests provider='google_speech' + error_logs
 * /webhook/whatsapp/voice). Resolved per call so an operator can change the
 * knob without a module reload; clamped to Google's supported 8000-48000.
 */
export function resolveSpeechSampleRate(raw = process.env.STT_SAMPLE_RATE_HZ) {
  return clampNumber(raw, 16000, { min: 8000, max: 48000 });
}

/** STT is ON by default (testing phase); STT_ENABLED=off|false|0 pauses it. */
export function isSttEnabled() {
  return !/^(?:off|false|0)$/i.test(String(process.env.STT_ENABLED || 'on'));
}

/**
 * Country-resolved recognition languages (rule 7). Kenya speaks Swahili + English
 * (and Sheng), so sw-KE leads with en-KE/en-US as alternatives; every other
 * country leads with English and keeps Swahili available.
 */
export function resolveSpeechLanguage(countryCode = 'GLOBAL') {
  const code = String(countryCode || 'GLOBAL').trim().toUpperCase();
  if (code === 'KE') {
    return { languageCode: 'sw-KE', alternativeLanguageCodes: ['en-KE', 'en-US'] };
  }
  return { languageCode: 'en-US', alternativeLanguageCodes: ['sw-KE'] };
}

/**
 * Meta mime type → Speech-to-Text encoding. WhatsApp voice notes are
 * `audio/ogg; codecs=opus`; other audio shapes are mapped where Google supports
 * them, and an unknown type omits `encoding` so the API auto-detects.
 */
export function resolveSpeechEncoding(mimeType = '') {
  const type = String(mimeType || '').toLowerCase();
  if (/ogg/.test(type)) return 'OGG_OPUS';
  if (/webm/.test(type)) return 'WEBM_OPUS';
  if (/mpeg|mp3/.test(type)) return 'MP3';
  if (/flac/.test(type)) return 'FLAC';
  if (/wav|linear|pcm/.test(type)) return 'LINEAR16';
  if (/amr-wb/.test(type)) return 'AMR_WB';
  if (/amr/.test(type)) return 'AMR';
  return null;
}

/** Byte-size → approximate duration. Used only for the sync-API 60 s guard. */
export function estimateAudioDurationSeconds(bytes = 0, bitrate = STT_ESTIMATED_BITRATE) {
  const size = Math.max(0, Number(bytes) || 0);
  const rate = Number(bitrate) > 0 ? Number(bitrate) : 16000;
  return Math.round((size * 8) / rate);
}

/** True while the estimated duration fits the sync recognizer budget. */
export function isAudioWithinDurationLimit(bytes = 0) {
  return estimateAudioDurationSeconds(bytes) <= STT_MAX_DURATION_SECONDS;
}

function timeoutSignal(ms = STT_TIMEOUT_MS) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

/** Abort/timeout detection — only these failures are worth a retry. */
function isTimeoutError(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || '');
  return name === 'AbortError'
    || name === 'TimeoutError'
    || /aborted due to timeout|timed? ?out/i.test(message);
}

const NO_SPEECH_ERROR = 'No speech detected in the voice note';
const MISSING_KEY_ERROR = 'No Speech-to-Text key configured (GCP_SPEECH_API_KEY / GCP_VISION_API_KEY)';

/**
 * Transcribe an audio buffer with Google Cloud Speech-to-Text v1.
 * Auth: GCP_SPEECH_API_KEY (dedicated) or GCP_VISION_API_KEY (same GCP project) —
 * never logged. Returns { text, confidence, languageCode, attempts, error }.
 */
export async function transcribeAudioBuffer({
  buffer,
  countryCode = 'GLOBAL',
  mimeType = 'audio/ogg',
  apiKey = process.env.GCP_SPEECH_API_KEY || process.env.GCP_VISION_API_KEY
} = {}) {
  if (!buffer || !buffer.length) {
    return { text: null, confidence: null, languageCode: null, error: 'No audio buffer', attempts: 0 };
  }

  if (!isSttEnabled()) {
    return {
      text: null,
      confidence: null,
      languageCode: null,
      error: 'STT paused by configuration',
      skipped: true,
      attempts: 0
    };
  }

  if (!apiKey) {
    return { text: null, confidence: null, languageCode: null, error: MISSING_KEY_ERROR, attempts: 0 };
  }

  const endpoint = process.env.GCP_SPEECH_ENDPOINT || DEFAULT_STT_ENDPOINT;
  const language = resolveSpeechLanguage(countryCode);
  const encoding = resolveSpeechEncoding(mimeType);

  const config = {
    languageCode: language.languageCode,
    alternativeLanguageCodes: language.alternativeLanguageCodes,
    enableAutomaticPunctuation: true
  };
  if (encoding) config.encoding = encoding;
  // v1.88.0 — OGG_OPUS REQUIRES an explicit sampleRateHertz (Google reads 0
  // from WhatsApp's container and rejects the config); other encodings keep
  // auto-detection.
  if (encoding === 'OGG_OPUS') config.sampleRateHertz = resolveSpeechSampleRate();

  const requestBody = {
    config,
    audio: { content: Buffer.from(buffer).toString('base64') }
  };

  let attempts = 0;
  let lastError = null;

  while (attempts < STT_MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: timeoutSignal(STT_TIMEOUT_MS)
      });

      let data = null;
      try { data = await res.json(); } catch { data = null; }

      if (!res.ok) {
        const message = data?.error?.message || `Speech-to-Text failed (HTTP ${res.status})`;
        return { text: null, confidence: null, languageCode: language.languageCode, error: message, attempts };
      }

      const results = Array.isArray(data?.results) ? data.results : [];
      const alternatives = results.map((result) => result?.alternatives?.[0]).filter(Boolean);
      const text = alternatives
        .map((alternative) => String(alternative?.transcript || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();

      const confidence = alternatives
        .map((alternative) => Number(alternative?.confidence))
        .find((value) => Number.isFinite(value) && value > 0) ?? null;
      const languageCode = results?.[0]?.languageCode || language.languageCode;

      if (!text) {
        return { text: null, confidence: null, languageCode, error: NO_SPEECH_ERROR, attempts };
      }

      return { text, confidence, languageCode, error: null, attempts };
    } catch (err) {
      lastError = `Speech-to-Text request error: ${err.message}`;
      if (!isTimeoutError(err)) break;
      // Timeout/abort → one more attempt while budget allows.
    }
  }

  return { text: null, confidence: null, languageCode: language.languageCode, error: lastError || 'Speech-to-Text request failed', attempts };
}

export default {
  transcribeAudioBuffer,
  resolveSpeechLanguage,
  resolveSpeechEncoding,
  resolveSpeechSampleRate,
  estimateAudioDurationSeconds,
  isAudioWithinDurationLimit,
  isSttEnabled,
  STT_TIMEOUT_MS,
  STT_MAX_ATTEMPTS,
  STT_MAX_DURATION_SECONDS,
  STT_ESTIMATED_BITRATE
};
