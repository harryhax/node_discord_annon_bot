import { spawn } from "node:child_process";

// Discord voice expects 48kHz stereo signed 16-bit little-endian PCM.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE;

/** Convert milliseconds to a byte offset aligned to a stereo frame. */
function msToByteOffset(ms) {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  return samples * BYTES_PER_FRAME;
}

/** Decode an audio file (mp3, wav, etc.) to a PCM Buffer (s16le, 48kHz, stereo). */
export function decodeFileToPcm(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", filePath,
      "-f", "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "pipe:1"
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";

    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg decode exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

/** Encode a PCM Buffer (s16le, 48kHz, stereo) to an mp3 file. */
export function encodePcmToMp3(pcmBuffer, outputFilePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-i", "pipe:0",
      "-codec:a", "libmp3lame",
      "-b:a", "128k",
      outputFilePath
    ];
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(outputFilePath);
      else reject(new Error(`ffmpeg encode exited ${code}: ${stderr.slice(0, 300)}`));
    });

    child.stdin.on("error", reject);
    child.stdin.end(pcmBuffer);
  });
}

/**
 * Mix a base PCM track with one or more overlay PCM tracks, each placed at a
 * specific time offset. The base track is ducked while any overlay is active.
 * Returns a PCM buffer the same length as basePcm.
 */
export function renderMixedPcm(basePcm, overlays, {
  duckedGain = 0.3,
  overlayGain = 1.0,
  duckSmoothing = 0.005
} = {}) {
  const totalBytes = basePcm.length;
  const out = Buffer.alloc(totalBytes);

  const ranges = (overlays || [])
    .filter(o => o && o.pcm && o.pcm.length > 0)
    .map(o => {
      const start = Math.max(0, msToByteOffset(o.offsetMs || 0));
      return { pcm: o.pcm, start, end: start + o.pcm.length };
    });

  let baseGain = 1.0;

  for (let i = 0; i < totalBytes; i += BYTES_PER_SAMPLE) {
    const baseSample = basePcm.readInt16LE(i);

    let overlayActive = false;
    let overlayMix = 0;
    for (const r of ranges) {
      if (i >= r.start && i + BYTES_PER_SAMPLE <= r.end) {
        overlayActive = true;
        overlayMix += r.pcm.readInt16LE(i - r.start);
      }
    }

    const targetGain = overlayActive ? duckedGain : 1.0;
    baseGain += (targetGain - baseGain) * duckSmoothing;

    let mixed = baseSample * baseGain + overlayMix * overlayGain;
    if (mixed > 32767) mixed = 32767;
    else if (mixed < -32768) mixed = -32768;
    out.writeInt16LE(mixed | 0, i);
  }

  return out;
}

/**
 * Take a base audio file and a list of overlay files (each with a start offset
 * in ms), mix them with ducking, and write the result as an mp3.
 */
export async function bakeOverlaysIntoClip({
  baseFilePath,
  overlays, // [{ filePath, offsetMs }]
  outputFilePath,
  duckedGain
}) {
  const [basePcm, ...overlayPcms] = await Promise.all([
    decodeFileToPcm(baseFilePath),
    ...overlays.map(o => decodeFileToPcm(o.filePath))
  ]);

  const overlaySpecs = overlays.map((o, i) => ({
    pcm: overlayPcms[i],
    offsetMs: o.offsetMs
  }));

  const mixed = renderMixedPcm(basePcm, overlaySpecs, { duckedGain });
  await encodePcmToMp3(mixed, outputFilePath);
  return outputFilePath;
}
