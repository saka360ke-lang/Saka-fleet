import assert from 'assert';
import fs from 'node:fs';
import {
  transcribeAudioBuffer,
  resolveSpeechLanguage,
  resolveSpeechEncoding,
  resolveSpeechSampleRate,
  estimateAudioDurationSeconds,
  isAudioWithinDurationLimit,
  isSttEnabled,
  STT_MAX_DURATION_SECONDS,
  STT_MAX_ATTEMPTS
} from './src/services/sttService.js';

/**
 * Saka Fleet — voice-note Speech-to-Text suite (v1.79.0, Phase 18)
 * ---------------------------------------------------------------
 * Proves the STT lane is country-resolved (rule 7), payload-correct (base64
 * audio.content + OGG_OPUS), guarded (55 s / retry-on-timeout only) and that a
 * failure always degrades to the deterministic v1.61.15 fallback instead of a
 * dead turn. Stateless: fetch is mocked, no database rows are written.
 *
 * Run: node test_stt_service.js
 */

let passed = 0;
function check(condition, label) {
  if (!condition) throw new Error(`❌ ${label}`);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

const realFetch = global.fetch;
function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}
const AUDIO = Buffer.from('OggS voice-note bytes');

async function run() {
  console.log('=== SAKA FLEET — VOICE-NOTE STT TESTS (v1.79.0) ===\n');

  console.log('--- Test 1: country-resolved language pairs (rule 7) ---');
  const ke = resolveSpeechLanguage('KE');
  check(ke.languageCode === 'sw-KE' && ke.alternativeLanguageCodes.join(',') === 'en-KE,en-US', 'Kenya leads with Swahili + English alternatives');
  const ug = resolveSpeechLanguage('UG');
  check(ug.languageCode === 'en-US' && ug.alternativeLanguageCodes.join(',') === 'sw-KE', 'every other country leads with English and keeps Swahili available');
  check(resolveSpeechLanguage(undefined).languageCode === 'en-US', 'GLOBAL stays neutral (en-US primary)');

  console.log('\n--- Test 2: encodings & duration guards ---');
  check(resolveSpeechEncoding('audio/ogg; codecs=opus') === 'OGG_OPUS', 'WhatsApp voice notes map to OGG_OPUS');
  check(resolveSpeechEncoding('audio/mpeg') === 'MP3', 'mp3 audio maps to MP3');
  check(resolveSpeechEncoding('audio/x-unknown') === null, 'unknown audio types omit encoding (API auto-detects)');
  check(STT_MAX_DURATION_SECONDS >= 5 && STT_MAX_DURATION_SECONDS <= 60, `the duration guard (${STT_MAX_DURATION_SECONDS}s) sits inside Google's 60 s sync cap`);
  check(estimateAudioDurationSeconds(120000, 16000) === 60, 'a 120,000-byte 16 kbps opus note estimates 60 s');
  const withinBytes = Math.floor((STT_MAX_DURATION_SECONDS - 5) * 16000 / 8);
  const overBytes = Math.ceil((STT_MAX_DURATION_SECONDS + 5) * 16000 / 8);
  check(isAudioWithinDurationLimit(withinBytes) === true && isAudioWithinDurationLimit(overBytes) === false, 'the guard accepts a note under the cap and rejects one over it');

  console.log('\n--- Test 3: recognition request shape + transcript ---');
  process.env.GCP_VISION_API_KEY = 'test-speech-key';
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return jsonResponse({
      results: [
        { alternatives: [{ transcript: 'Nimeweka lita arobaini', confidence: 0.93 }], languageCode: 'sw-KE' },
        { alternatives: [{ transcript: 'kwa shilingi elfu tano na mia tano.', confidence: 0.88 }] }
      ]
    });
  };
  const note = await transcribeAudioBuffer({ buffer: AUDIO, countryCode: 'KE', mimeType: 'audio/ogg; codecs=opus' });
  check(note.error === null && note.text === 'Nimeweka lita arobaini kwa shilingi elfu tano na mia tano.', 'multi-result transcripts are joined into one turn');
  check(note.confidence === 0.93 && note.languageCode === 'sw-KE' && note.attempts === 1, 'confidence, language and attempts are captured');
  check(captured.url.includes('speech:recognize?key=test-speech-key'), 'the REST endpoint carries the key as a query param');
  check(captured.body.config.encoding === 'OGG_OPUS' && captured.body.config.languageCode === 'sw-KE' && captured.body.config.alternativeLanguageCodes.includes('en-KE') && captured.body.config.enableAutomaticPunctuation === true, 'config carries encoding, languages and punctuation');
  check(captured.body.audio.content === AUDIO.toString('base64'), 'the audio rides as base64 in audio.content');

  console.log('\n--- Test 3b: OGG_OPUS sample rate (v1.88.0 live fix) ---');
  // Live proof 2026-11-09: Google rejected the config with "Opus sample rate (0)
  // not in supported rates" because OGG_OPUS carried no sampleRateHertz.
  check(captured.body.config.sampleRateHertz === 16000, 'OGG_OPUS carries the default sampleRateHertz 16000 (the live 400 fix)');
  check(resolveSpeechSampleRate() === 16000, 'the resolver defaults to 16000');
  process.env.STT_SAMPLE_RATE_HZ = '8000';
  global.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return jsonResponse({ results: [{ alternatives: [{ transcript: 'hello', confidence: 0.9 }] }] });
  };
  await transcribeAudioBuffer({ buffer: AUDIO, countryCode: 'KE', mimeType: 'audio/ogg' });
  check(captured.body.config.sampleRateHertz === 8000, 'a custom STT_SAMPLE_RATE_HZ=8000 reaches the request');
  check(resolveSpeechSampleRate('6000') === 8000 && resolveSpeechSampleRate('96000') === 48000, 'out-of-range values clamp to Google\'s 8000-48000 band');
  check(resolveSpeechSampleRate('nope') === 16000, 'a non-numeric value falls back to 16000');
  process.env.STT_SAMPLE_RATE_HZ = '48000';
  global.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return jsonResponse({ results: [{ alternatives: [{ transcript: 'hello' }] }] });
  };
  await transcribeAudioBuffer({ buffer: AUDIO, countryCode: 'GLOBAL', mimeType: 'audio/x-unknown' });
  check(captured.body.config.encoding === undefined && captured.body.config.sampleRateHertz === undefined, 'an unknown encoding omits BOTH encoding and sampleRateHertz (auto-detect stays untouched)');
  delete process.env.STT_SAMPLE_RATE_HZ;
  check(resolveSpeechSampleRate() === 16000, 'unsetting the knob returns the 16000 default');

  console.log('\n--- Test 4: empty read + non-retryable HTTP error ---');
  global.fetch = async () => jsonResponse({ results: [] });
  const silent = await transcribeAudioBuffer({ buffer: AUDIO, countryCode: 'KE' });
  check(silent.text === null && /No speech detected/.test(String(silent.error)), 'silence returns the explicit no-speech reason');
  let calls = 0;
  global.fetch = async () => { calls += 1; return jsonResponse({ error: { message: 'Bad audio encoding' } }, false, 400); };
  const rejected = await transcribeAudioBuffer({ buffer: AUDIO, countryCode: 'KE' });
  check(rejected.text === null && /Bad audio encoding/.test(String(rejected.error)) && rejected.attempts === 1 && calls === 1, 'HTTP/credential errors are never retried');

  console.log('\n--- Test 5: timeout retry, missing key, pause switch ---');
  calls = 0;
  global.fetch = async () => {
    calls += 1;
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  const timedOut = await transcribeAudioBuffer({ buffer: AUDIO, countryCode: 'KE' });
  check(timedOut.text === null && timedOut.attempts === STT_MAX_ATTEMPTS && calls === STT_MAX_ATTEMPTS, `timeouts retry while attempts remain (${STT_MAX_ATTEMPTS})`);
  const savedSpeechKey = process.env.GCP_SPEECH_API_KEY;
  delete process.env.GCP_SPEECH_API_KEY;
  delete process.env.GCP_VISION_API_KEY;
  let keyFetch = false;
  global.fetch = async () => { keyFetch = true; return jsonResponse({}); };
  const noKey = await transcribeAudioBuffer({ buffer: AUDIO });
  check(noKey.text === null && /Speech-to-Text key/.test(String(noKey.error)) && keyFetch === false, 'a missing key degrades without any network call');
  process.env.GCP_VISION_API_KEY = 'test-speech-key';
  if (savedSpeechKey !== undefined) process.env.GCP_SPEECH_API_KEY = savedSpeechKey;
  process.env.STT_ENABLED = 'off';
  check(isSttEnabled() === false, 'STT_ENABLED=off pauses transcription');
  let pausedFetch = false;
  global.fetch = async () => { pausedFetch = true; return jsonResponse({}); };
  const paused = await transcribeAudioBuffer({ buffer: AUDIO });
  check(paused.skipped === true && pausedFetch === false, 'a paused switch never downloads or calls Speech');
  process.env.STT_ENABLED = 'on';
  check(isSttEnabled() === true, 'STT_ENABLED=on re-enables transcription (default)');
  delete process.env.STT_ENABLED;

  console.log('\n--- Test 6: lane wiring + leaf boundary (source pins) ---');
  const mediaSource = fs.readFileSync('src/routes/whatsapp/media.js', 'utf8');
  check(mediaSource.includes('VOICE_LISTENING_ACK') && mediaSource.includes('startAudioTranscription'), 'media.js carries the listening ack + transcription lane as data');
  check(/startAudioTranscription[\s\S]{0,1600}downloadWhatsAppMedia/.test(mediaSource) && mediaSource.includes('transcribeAudioBuffer'), 'the lane reuses the Meta downloader and the STT service');
  check(!mediaSource.includes('sendWhatsAppReply('), 'media.js never sends — the processor does');
  const messagesSource = fs.readFileSync('src/routes/whatsapp/messages.js', 'utf8');
  check(messagesSource.includes('voice_note_fallback') && messagesSource.includes('voiceTranscript'), 'the processor keeps the fallback and injects the transcript at the text seam');
  check(messagesSource.includes("'/webhook/whatsapp/voice'"), 'a failed transcription is logged, never silently swallowed (rule 50)');

  global.fetch = realFetch;
  delete process.env.GCP_VISION_API_KEY;
  console.log(`\n🎉 ALL VOICE-NOTE STT TESTS PASSED (${passed} assertions).`);
  console.log('Stateless suite: fetch was mocked; no database rows were written.');
}

try {
  await run();
} catch (err) {
  global.fetch = realFetch;
  console.error('\n❌ Voice-note STT suite failed:', err.message);
  process.exit(1);
}
