import 'dotenv/config';
import fs from 'node:fs';
import { downloadWhatsAppMedia } from '../src/services/ocrService.js';
import { transcribeAudioBuffer } from '../src/services/sttService.js';

/**
 * Saka Fleet — STT audio probe (v1.88.1, Phase 27A deep-dive)
 * ----------------------------------------------------------
 * Downloads a REAL WhatsApp voice note from Meta and replays it against Google
 * Speech-to-Text with several config variants, printing the exact JSON so the
 * sample-rate mismatch can be proven live instead of guessed.
 *
 * Usage: node scripts/probe_audio.js [mediaId ...]
 * Writes test_voice.ogg (the first note) beside the repo root.
 */

const DEFAULT_MEDIA_IDS = ['2013939009274225', '1820666098981728', '1681294346834751'];
const ENDPOINT = process.env.GCP_SPEECH_ENDPOINT || 'https://speech.googleapis.com/v1/speech:recognize';

/** Read the OpusHead input sample rate (uint32 LE at OpusHead+12) + page count. */
function inspectOgg(buffer) {
  const head = buffer.indexOf(Buffer.from('OpusHead'));
  const inputRate = head >= 0 && buffer.length > head + 15 ? buffer.readUInt32LE(head + 12) : null;
  let pages = 0;
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x4f && buffer[i + 1] === 0x67 && buffer[i + 2] === 0x67 && buffer[i + 3] === 0x53) pages += 1;
  }
  // Last Ogg page granule position (offset 6..13 of the page header) / 48000.
  let durationSec = null;
  if (pages > 0) {
    let last = -1;
    for (let i = 0; i + 4 <= buffer.length; i += 1) {
      if (buffer[i] === 0x4f && buffer[i + 1] === 0x67 && buffer[i + 2] === 0x67 && buffer[i + 3] === 0x53) last = i;
    }
    if (last >= 0 && buffer.length >= last + 14) {
      const granule = Number(buffer.readBigUInt64LE(last + 6));
      if (Number.isFinite(granule) && granule > 0) durationSec = Number((granule / 48000).toFixed(2));
    }
  }
  return { opusHeadFound: head >= 0, inputSampleRate: inputRate, oggPages: pages, durationSec };
}

async function callSpeech(buffer, config) {
  const key = process.env.GCP_SPEECH_API_KEY || process.env.GCP_VISION_API_KEY;
  const started = Date.now();
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, audio: { content: Buffer.from(buffer).toString('base64') } })
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  const transcript = (data?.results || [])
    .map((r) => r?.alternatives?.[0]?.transcript || '')
    .filter(Boolean)
    .join(' ')
    .trim();
  const confidence = (data?.results || [])
    .map((r) => Number(r?.alternatives?.[0]?.confidence))
    .find((v) => Number.isFinite(v)) ?? null;
  return {
    http: res.status,
    ms: Date.now() - started,
    transcript: transcript || null,
    confidence,
    error: data?.error?.message || null,
    resultsCount: (data?.results || []).length
  };
}

async function run() {
  const mediaIds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MEDIA_IDS;
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) throw new Error('META_WHATSAPP_TOKEN missing in .env');
  if (!(process.env.GCP_SPEECH_API_KEY || process.env.GCP_VISION_API_KEY)) {
    throw new Error('No Speech key in .env (GCP_SPEECH_API_KEY / GCP_VISION_API_KEY)');
  }

  for (let i = 0; i < mediaIds.length; i += 1) {
    const mediaId = mediaIds[i];
    console.log(`\n=== Media ${mediaId} ===`);
    const download = await downloadWhatsAppMedia(mediaId, token);
    if (!download.buffer) {
      console.log('  download failed:', download.error);
      continue;
    }
    console.log(`  bytes=${download.buffer.length} mime=${download.mimeType}`);
    console.log('  first 64 bytes:', download.buffer.subarray(0, 64).toString('hex'));
    console.log('  ogg inspection:', JSON.stringify(inspectOgg(download.buffer)));
    if (i === 0) {
      fs.writeFileSync('test_voice.ogg', download.buffer);
      console.log('  saved test_voice.ogg');
    }

    const base = { languageCode: 'sw-KE', alternativeLanguageCodes: ['en-KE', 'en-US'], enableAutomaticPunctuation: true };
    const variants = [
      ['OGG_OPUS rate=16000 (current v1.88.0)', { ...base, encoding: 'OGG_OPUS', sampleRateHertz: 16000 }],
      ['OGG_OPUS rate=48000', { ...base, encoding: 'OGG_OPUS', sampleRateHertz: 48000 }],
      ['OGG_OPUS rate=24000', { ...base, encoding: 'OGG_OPUS', sampleRateHertz: 24000 }],
      ['OGG_OPUS rate=12000', { ...base, encoding: 'OGG_OPUS', sampleRateHertz: 12000 }],
      ['OGG_OPUS rate=8000', { ...base, encoding: 'OGG_OPUS', sampleRateHertz: 8000 }],
      ['OGG_OPUS no rate', { ...base, encoding: 'OGG_OPUS' }],
      ['encoding omitted (auto-detect)', { ...base }]
    ];
    for (const [label, config] of variants) {
      const result = await callSpeech(download.buffer, config);
      console.log(`  [${label}] ->`, JSON.stringify(result));
    }

    // End-to-end proof through the REAL service path (the code the webhook uses).
    const serviceResult = await transcribeAudioBuffer({
      buffer: download.buffer,
      countryCode: 'KE',
      mimeType: download.mimeType || 'audio/ogg'
    });
    console.log('  [service transcribeAudioBuffer] ->', JSON.stringify({
      text: serviceResult.text,
      confidence: serviceResult.confidence,
      languageCode: serviceResult.languageCode,
      attempts: serviceResult.attempts,
      error: serviceResult.error
    }));
  }
}

try {
  await run();
} catch (err) {
  console.error('probe failed:', err?.message || err);
  process.exit(1);
}
