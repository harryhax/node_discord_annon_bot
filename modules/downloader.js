import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SONGS_FILE_PATH = "data/songs_4900.json";
const SONGS_FILE_PATH = resolveSongsFilePath(
  process.env.TUNEGAME_SONGS_FILE_PATH || DEFAULT_SONGS_FILE_PATH
);
const DOWNLOADS_DIR = path.resolve(__dirname, "../data/downloads");

function resolveSongsFilePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(process.cwd(), filePath);
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSongValue(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function buildTrackPath(dataDir, artist, album, title) {
  const artistDir = sanitizeFileName(artist);
  const albumDir = sanitizeFileName(album);
  const trackFile = sanitizeFileName(title) + ".mp3";
  return path.join(dataDir, artistDir, albumDir, trackFile);
}

function trackExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_err) {
    return false;
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runYtDlp(query, outputTemplate) {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch1:${query}`,
      "--ignore-config",
      "--no-simulate",
      "--no-playlist",
      "--print",
      "webpage_url",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      outputTemplate,
    ];

    const child = spawn("yt-dlp", args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        const printedLines = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);
        const youtubeUrl = [...printedLines]
          .reverse()
          .find(line => /^https?:\/\//i.test(line)) || null;

        resolve({ youtubeUrl });
      } else {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      reject(error);
    });

    child.on("close", code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

async function getAudioDurationSeconds(filePath) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ];

  const { stdout } = await runCommand("ffprobe", args);
  const duration = Number.parseFloat(String(stdout).trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine audio duration for clip generation");
  }

  return duration;
}

export function loadSongsCatalog(songsFilePath = SONGS_FILE_PATH) {
  const resolvedSongsFilePath = resolveSongsFilePath(songsFilePath);
  const raw = fs.readFileSync(resolvedSongsFilePath, "utf8");
  return JSON.parse(raw);
}

export function incrementSongPlayCount(song, songsFilePath = SONGS_FILE_PATH) {
  const resolvedSongsFilePath = resolveSongsFilePath(songsFilePath);
  const catalog = loadSongsCatalog(resolvedSongsFilePath);

  const targetArtist = normalizeSongValue(song?.artist);
  const targetTitle = normalizeSongValue(song?.title);
  const targetEra = normalizeSongValue(song?.era);
  const targetGenre = normalizeSongValue(song?.genre);

  let updated = false;

  for (const eraEntry of catalog?.eras || []) {
    if (normalizeSongValue(eraEntry?.era) !== targetEra) continue;

    for (const genreEntry of eraEntry?.genres || []) {
      if (normalizeSongValue(genreEntry?.genre) !== targetGenre) continue;

      for (const songEntry of genreEntry?.songs || []) {
        if (normalizeSongValue(songEntry?.artist) !== targetArtist) continue;
        if (normalizeSongValue(songEntry?.song) !== targetTitle) continue;

        const currentPlays = Number(songEntry?.plays);
        songEntry.plays = Number.isFinite(currentPlays) && currentPlays >= 0
          ? currentPlays + 1
          : 1;
        updated = true;
        break;
      }

      if (updated) break;
    }

    if (updated) break;
  }

  if (!updated) {
    return false;
  }

  fs.writeFileSync(resolvedSongsFilePath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return true;
}

export function flattenSongs(catalog) {
  const songs = [];

  for (const eraEntry of catalog?.eras || []) {
    for (const genreEntry of eraEntry?.genres || []) {
      for (const songEntry of genreEntry?.songs || []) {
        if (!songEntry?.artist || !songEntry?.song) continue;

        songs.push({
          artist: songEntry.artist,
          title: songEntry.song,
          era: eraEntry.era,
          genre: genreEntry.genre
        });
      }
    }
  }

  return songs;
}

export function pickRandomSong(songsFilePath = SONGS_FILE_PATH) {
  const catalog = loadSongsCatalog(songsFilePath);
  const songs = flattenSongs(catalog);

  if (songs.length === 0) {
    throw new Error("No songs available in songs catalog");
  }

  return songs[randomInt(songs.length)];
}

export async function downloadSongMp3({ artist, title, downloadDir = DOWNLOADS_DIR, logger }) {
  const safeBase = `${sanitizeFileName(artist)} - ${sanitizeFileName(title)}`;
  const uniqueToken = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

  ensureDirectory(downloadDir);

  const outputTemplate = path.join(downloadDir, `${safeBase} __${uniqueToken}__.%(ext)s`);
  const query = `${artist} - ${title}`;

  if (logger) logger.info(`Downloading from YouTube: ${query}`);

  const { youtubeUrl } = await runYtDlp(query, outputTemplate);

  const candidates = fs
    .readdirSync(downloadDir)
    .filter(name => name.includes(uniqueToken))
    .map(name => {
      const candidatePath = path.join(downloadDir, name);
      return {
        filePath: candidatePath,
        mtimeMs: fs.statSync(candidatePath).mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error("yt-dlp completed but output file was not found");
  }

  const preferredMp3 = candidates.find(candidate => candidate.filePath.toLowerCase().endsWith(".mp3"));
  const selected = preferredMp3 || candidates[0];

  return { filePath: selected.filePath, query, youtubeUrl };
}

export async function createRandomSongClip({
  inputFilePath,
  clipDurationSeconds,
  logger
}) {
  const requestedClipDuration = Number(clipDurationSeconds);

  if (!Number.isFinite(requestedClipDuration) || requestedClipDuration <= 0) {
    throw new Error("Clip duration must be a positive number of seconds");
  }

  const totalDurationSeconds = await getAudioDurationSeconds(inputFilePath);
  const effectiveClipDuration = Math.min(requestedClipDuration, totalDurationSeconds);
  const maxStart = Math.max(totalDurationSeconds - effectiveClipDuration, 0);
  const clipStart = Math.random() * maxStart;

  const parsedPath = path.parse(inputFilePath);
  const outputFilePath = path.join(
    parsedPath.dir,
    `${parsedPath.name} clip-${Date.now()}.mp3`
  );

  if (logger) {
    logger.info(
      `Creating clip: start=${clipStart.toFixed(2)}s duration=${effectiveClipDuration.toFixed(2)}s`
    );
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    clipStart.toFixed(3),
    "-t",
    effectiveClipDuration.toFixed(3),
    "-i",
    inputFilePath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-q:a",
    "2",
    "-y",
    outputFilePath
  ];

  await runCommand("ffmpeg", args);

  if (!trackExists(outputFilePath)) {
    throw new Error("ffmpeg completed but clipped mp3 was not found");
  }

  return {
    clipFilePath: outputFilePath,
    clipStart,
    clipDurationSeconds: effectiveClipDuration,
    sourceDurationSeconds: totalDurationSeconds
  };
}

export async function downloadTrack({ artist, album, title, dataDir, logger }) {
  const filePath = buildTrackPath(dataDir, artist, album, title);

  if (trackExists(filePath)) {
    if (logger) logger.info(`Track already exists: ${filePath}`);
    return { filePath, downloaded: false, exists: true };
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const query = `${artist} - ${title}`;
  const outputTemplate = path.join(dir, `${sanitizeFileName(title)}.%(ext)s`);

  if (logger) logger.info(`Downloading: ${query} -> ${filePath}`);

  try {
    await runYtDlp(query, outputTemplate);

    if (trackExists(filePath)) {
      if (logger) logger.info(`Download complete: ${filePath}`);
      return { filePath, downloaded: true, exists: true };
    }

    if (logger) logger.error(`Download finished but file not found: ${filePath}`);
    return { filePath, downloaded: false, exists: false };
  } catch (error) {
    if (logger) logger.error(`Download failed for "${query}": ${error.message}`);
    return { filePath, downloaded: false, exists: false, error: error.message };
  }
}

export {
  sanitizeFileName,
  buildTrackPath,
  trackExists,
  runCommand,
  getAudioDurationSeconds,
  runYtDlp,
  SONGS_FILE_PATH,
  DOWNLOADS_DIR
};
