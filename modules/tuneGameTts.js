import fs from "node:fs/promises";
import { existsSync, createWriteStream, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_CACHE_DIR = path.resolve(__dirname, "..", "data", "downloads", "tts");

// Edge "neural" voices currently available on the free consumer endpoint.
// Game-show-host friendly picks (verified live):
//   en-US-AndrewNeural     - American male, warm/conversational
//   en-US-BrianNeural      - American male, warm
//   en-US-ChristopherNeural- American male, deeper
//   en-US-GuyNeural        - American male, classic announcer
//   en-US-EricNeural       - American male
//   en-US-RogerNeural      - American male
//   en-US-SteffanNeural    - American male
//   en-GB-RyanNeural       - British male, polished
//   en-AU-WilliamMultilingualNeural - Australian male
// NOTE: Davis/Tony/Jason/Nancy/Sara have been removed from the free endpoint.
// NOTE: As of 2026, the free Edge consumer TTS endpoint no longer accepts
// <mstts:express-as> styles for any voice (StyleList is empty across the
// board). The TUNEGAME_TTS_STYLE env var is kept for forward-compat but is
// currently ignored.
//
// Env knobs (read fresh on every call so test harnesses can switch voices):
//   TUNEGAME_TTS_VOICE   default "en-US-AndrewNeural"
//   TUNEGAME_TTS_RATE    default "+10%"   e.g. -10%, +0%, +15%, +25%
//   TUNEGAME_TTS_PITCH   default "+0Hz"   e.g. -5Hz, +0Hz, +10Hz
//   TUNEGAME_TTS_VOLUME  default "+0%"    e.g. default, loud, x-loud, +6dB
function readConfig() {
  return {
    voice: process.env.TUNEGAME_TTS_VOICE || "en-US-AndrewNeural",
    rate: process.env.TUNEGAME_TTS_RATE || "+10%",
    pitch: process.env.TUNEGAME_TTS_PITCH || "+0Hz",
    volume: process.env.TUNEGAME_TTS_VOLUME || "+0%"
  };
}

function cacheKey(cfg, text) {
  return createHash("sha1")
    .update(`edge|${cfg.voice}|${cfg.rate}|${cfg.pitch}|${cfg.volume}||${text}`)
    .digest("hex");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSsml(cfg, text) {
  const inner = `<prosody rate="${cfg.rate}" pitch="${cfg.pitch}" volume="${cfg.volume}">${escapeXml(text)}</prosody>`;
  const lang = cfg.voice.split("-").slice(0, 2).join("-") || "en-US";
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
    `<voice name="${cfg.voice}">${inner}</voice></speak>`
  );
}

async function streamToFile(stream, filePath) {
  return await new Promise((resolve, reject) => {
    const out = createWriteStream(filePath);
    let settled = false;
    let bytesWritten = 0;
    const finish = err => {
      if (settled) return;
      settled = true;
      out.close(() => (err ? reject(err) : resolve(bytesWritten)));
    };
    stream.on("data", chunk => {
      bytesWritten += chunk.length;
      out.write(chunk);
    });
    stream.on("end", () => finish());
    stream.on("close", () => finish());
    stream.on("error", finish);
    out.on("error", finish);
  });
}

/**
 * Synthesize speech via Microsoft Edge's free neural TTS.
 * Returns a path to an MP3 file, or null on failure.
 * Results are cached on disk by hash of (voice + prosody + text).
 */
export async function synthesizeTts(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  const cfg = readConfig();

  await fs.mkdir(TTS_CACHE_DIR, { recursive: true });
  const filePath = path.join(TTS_CACHE_DIR, `${cacheKey(cfg, trimmed)}.mp3`);

  if (existsSync(filePath)) {
    try {
      if (statSync(filePath).size > 0) return filePath;
    } catch {}
    // Stale empty cache file - remove and re-synthesize.
    await fs.unlink(filePath).catch(() => {});
  }

  try {
    const tts = new MsEdgeTTS();
    // Some lib versions can't infer the locale from the voice short-name,
    // so derive it explicitly from the first two segments (e.g. "en-US").
    const voiceLocale = cfg.voice.split("-").slice(0, 2).join("-");
    await tts.setMetadata(
      cfg.voice,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      { voiceLocale }
    );

    const ssml = buildSsml(cfg, trimmed);

    // rawToStream sends our full SSML (with prosody) untouched.
    const { audioStream } = tts.rawToStream(ssml);
    const bytes = await streamToFile(audioStream, filePath);

    try { tts.close?.(); } catch {}

    if (!bytes || bytes < 100) {
      console.warn(
        `[tuneGameTts] Edge TTS returned no audio for voice=${cfg.voice}. ` +
        `The voice name may be invalid (the consumer endpoint silently rejects unknown voices). ` +
        `Run \`node test-tts.mjs --list\` to see verified options.`
      );
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    return filePath;
  } catch (error) {
    console.warn("[tuneGameTts] Edge TTS failed:", error.message);
    await fs.unlink(filePath).catch(() => {});
    return null;
  }
}
