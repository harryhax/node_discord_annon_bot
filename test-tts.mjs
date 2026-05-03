#!/usr/bin/env node
// Quick TTS sandbox: synthesize a phrase via the same module the bot uses
// (Microsoft Edge neural voices, free), save the MP3, and (on macOS) play it.
//
// Usage:
//   node test-tts.mjs                                       # default sample lines, default voice
//   node test-tts.mjs "Welcome to Tune Game!"               # speak a custom phrase
//   node test-tts.mjs --voice=en-GB-RyanNeural "Hello"      # override voice
//   node test-tts.mjs --rate=+25% --pitch=+5Hz "Hello"      # tweak prosody
//   node test-tts.mjs --style=excited "Big news!"           # try an SSML style
//   node test-tts.mjs --no-play "Hi"                        # synth only, don't auto-play
//   node test-tts.mjs --interactive                         # type phrases in a loop
//   node test-tts.mjs --list                                # list a curated set of voices
//   node test-tts.mjs --all "Try this line"                 # speak the line through every curated voice
//   node test-tts.mjs --all --no-play "Hello"               # synth all voices to disk
//   node test-tts.mjs --all --filter=en-US "Hello"          # only voices whose name matches
//   node test-tts.mjs --all --filter=male "Hello"           # filter by gender label

import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Curated list of game-show / announcer-friendly Edge neural voices.
// All entries below verified live against the consumer endpoint.
// (Davis/Tony/Jason/Nancy/Sara have been removed by Microsoft.)
const CURATED_VOICES = [
  // English (US) male
  { name: "en-US-AndrewNeural",         gender: "male",   accent: "US", note: "warm American" },
  { name: "en-US-AndrewMultilingualNeural", gender: "male", accent: "US", note: "American (multilingual)" },
  { name: "en-US-BrianNeural",          gender: "male",   accent: "US", note: "warm American" },
  { name: "en-US-BrianMultilingualNeural", gender: "male", accent: "US", note: "American (multilingual)" },
  { name: "en-US-ChristopherNeural",    gender: "male",   accent: "US", note: "deeper American" },
  { name: "en-US-EricNeural",           gender: "male",   accent: "US", note: "American" },
  { name: "en-US-GuyNeural",            gender: "male",   accent: "US", note: "classic American announcer" },
  { name: "en-US-RogerNeural",          gender: "male",   accent: "US", note: "American" },
  { name: "en-US-SteffanNeural",        gender: "male",   accent: "US", note: "American" },
  // English (US) female
  { name: "en-US-AriaNeural",           gender: "female", accent: "US", note: "American" },
  { name: "en-US-AvaNeural",            gender: "female", accent: "US", note: "American" },
  { name: "en-US-AvaMultilingualNeural",gender: "female", accent: "US", note: "American (multilingual)" },
  { name: "en-US-EmmaNeural",           gender: "female", accent: "US", note: "American" },
  { name: "en-US-EmmaMultilingualNeural", gender: "female", accent: "US", note: "American (multilingual)" },
  { name: "en-US-JennyNeural",          gender: "female", accent: "US", note: "American" },
  { name: "en-US-MichelleNeural",       gender: "female", accent: "US", note: "American" },
  { name: "en-US-AnaNeural",            gender: "female", accent: "US", note: "American (younger)" },
  // English (UK)
  { name: "en-GB-RyanNeural",           gender: "male",   accent: "UK", note: "polished British" },
  { name: "en-GB-ThomasNeural",         gender: "male",   accent: "UK", note: "British" },
  { name: "en-GB-SoniaNeural",          gender: "female", accent: "UK", note: "British" },
  { name: "en-GB-LibbyNeural",          gender: "female", accent: "UK", note: "British" },
  { name: "en-GB-MaisieNeural",         gender: "female", accent: "UK", note: "British" },
  // English (AU/CA/IE)
  { name: "en-AU-WilliamMultilingualNeural", gender: "male", accent: "AU", note: "Australian" },
  { name: "en-AU-NatashaNeural",        gender: "female", accent: "AU", note: "Australian" },
  { name: "en-CA-LiamNeural",           gender: "male",   accent: "CA", note: "Canadian" },
  { name: "en-CA-ClaraNeural",          gender: "female", accent: "CA", note: "Canadian" },
  { name: "en-IE-ConnorNeural",         gender: "male",   accent: "IE", note: "Irish" },
  { name: "en-IE-EmilyNeural",          gender: "female", accent: "IE", note: "Irish" }
];

// Allow CLI overrides for voice/model BEFORE importing the TTS module,
// since it reads them from env at call time (each call re-reads).
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const arg of args) {
  if (arg.startsWith("--")) {
    const [key, val] = arg.replace(/^--/, "").split("=");
    flags[key] = val ?? true;
  } else {
    positional.push(arg);
  }
}

if (flags.voice) process.env.TUNEGAME_TTS_VOICE = String(flags.voice);
if (flags.rate) process.env.TUNEGAME_TTS_RATE = String(flags.rate);
if (flags.pitch) process.env.TUNEGAME_TTS_PITCH = String(flags.pitch);
if (flags.volume) process.env.TUNEGAME_TTS_VOLUME = String(flags.volume);
if (flags.style !== undefined) process.env.TUNEGAME_TTS_STYLE = String(flags.style === true ? "" : flags.style);

const { synthesizeTts } = await import("./modules/tuneGameTts.js");

const DEFAULT_LINES = [
  "Welcome to Tune Game! Ten questions, sixty seconds each. Let's play!",
  "Question 5 of 10! Get ready... here comes your tune!",
  "Correct! Harry takes 3 points!",
  "Time's up! The answer was Bohemian Rhapsody by Queen.",
  "That's the game! Our champion is Harry with 27 points! Well played, everyone!"
];

function playFile(filePath) {
  // macOS has `afplay` built in.
  return new Promise((resolve, reject) => {
    const child = spawn("afplay", [filePath], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`afplay exited with code ${code}`));
    });
  });
}

async function speak(text) {
  const voice = process.env.TUNEGAME_TTS_VOICE || "en-US-DavisNeural";
  const rate = process.env.TUNEGAME_TTS_RATE || "+10%";
  const pitch = process.env.TUNEGAME_TTS_PITCH || "+0Hz";
  const style = process.env.TUNEGAME_TTS_STYLE || "-";
  console.log(`\n[${voice} rate=${rate} pitch=${pitch} style=${style}] "${text}"`);

  const filePath = await synthesizeTts(text);
  if (!filePath) {
    console.error("  -> Synthesis failed (see warning above).");
    return false;
  }

  console.log(`  -> ${path.relative(__dirname, filePath)}`);

  if (flags["no-play"]) return true;

  try {
    await playFile(filePath);
  } catch (error) {
    console.warn(`  -> Could not play locally (${error.message}). File is on disk.`);
  }
  return true;
}

function listVoices() {
  console.log("Curated voices (use --voice=<name>):\n");
  for (const v of CURATED_VOICES) {
    console.log(`  ${v.name.padEnd(28)} ${v.gender.padEnd(7)} ${v.accent.padEnd(3)}  ${v.note}`);
  }
  console.log("\nUse --all to try every voice on a single phrase.");
}

function filterVoices() {
  const f = String(flags.filter || "").toLowerCase();
  if (!f) return CURATED_VOICES;
  return CURATED_VOICES.filter(v =>
    v.name.toLowerCase().includes(f) ||
    v.gender.toLowerCase() === f ||
    v.accent.toLowerCase() === f
  );
}

async function speakAllVoices(text) {
  const voices = filterVoices();
  console.log(`\nTrying ${voices.length} voice(s) on: "${text}"\n`);

  const results = [];
  for (const v of voices) {
    process.env.TUNEGAME_TTS_VOICE = v.name;
    // Style is per-voice-supported, leave whatever the user passed (or env).
    const ok = await speak(text);
    results.push({ voice: v.name, ok });
  }

  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"}  ${r.voice}`);
  }
  const failed = results.filter(r => !r.ok).length;
  if (failed > 0) {
    console.log(`\n${failed} voice(s) failed. Try --style= (empty) to disable express-as, or pick a different style.`);
  }
}

if (flags.list) {
  listVoices();
  process.exit(0);
}

if (flags.all) {
  const text = positional.length > 0 ? positional.join(" ") : DEFAULT_LINES[0];
  await speakAllVoices(text);
  process.exit(0);
}

if (flags.interactive) {
  console.log("Interactive TTS mode. Type a phrase and press enter. Ctrl+C to quit.");
  console.log(`Voice: ${process.env.TUNEGAME_TTS_VOICE || "en-US-DavisNeural"}  Rate: ${process.env.TUNEGAME_TTS_RATE || "+10%"}  Pitch: ${process.env.TUNEGAME_TTS_PITCH || "+0Hz"}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  rl.on("line", async line => {
    const text = line.trim();
    if (text) {
      try { await speak(text); }
      catch (error) { console.error("Error:", error.message); }
    }
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
} else {
  const lines = positional.length > 0 ? [positional.join(" ")] : DEFAULT_LINES;
  for (const line of lines) {
    try { await speak(line); }
    catch (error) { console.error("Error:", error.message); }
  }
}
