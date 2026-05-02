import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE_PATH = path.resolve(__dirname, "..", "data", "tuneGameStats.json");

let cache = null;
let writeQueue = Promise.resolve();

function emptyStats() {
  return { guilds: {} };
}

function loadStatsSync() {
  if (cache) return cache;

  try {
    const raw = fs.readFileSync(STATS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : emptyStats();
    if (!cache.guilds || typeof cache.guilds !== "object") {
      cache.guilds = {};
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("[tuneGameStats] Failed to read stats file, starting fresh:", error.message);
    }
    cache = emptyStats();
  }

  return cache;
}

async function persistStats() {
  const data = JSON.stringify(cache, null, 2);
  await fsp.mkdir(path.dirname(STATS_FILE_PATH), { recursive: true });
  await fsp.writeFile(STATS_FILE_PATH, data, "utf8");
}

function ensureGuild(guildId) {
  const stats = loadStatsSync();
  if (!stats.guilds[guildId]) {
    stats.guilds[guildId] = {
      gamesPlayed: 0,
      lastPlayedAt: null,
      players: {}
    };
  }
  return stats.guilds[guildId];
}

function ensurePlayer(guildEntry, userId, username) {
  if (!guildEntry.players[userId]) {
    guildEntry.players[userId] = {
      username: username || null,
      totalPoints: 0,
      gamesPlayed: 0,
      gamesWon: 0,
      bestScore: 0,
      lastPlayedAt: null
    };
  } else if (username) {
    guildEntry.players[userId].username = username;
  }
  return guildEntry.players[userId];
}

/**
 * Record results of a finished game.
 *
 * @param {Object} params
 * @param {string} params.guildId
 * @param {Map<string, {username: string, points: number}>} params.scores
 * @param {Array<{userId: string}>} params.winners
 */
export async function recordGameResult({ guildId, scores, winners }) {
  if (!guildId) return;

  loadStatsSync();
  const guildEntry = ensureGuild(guildId);
  const nowIso = new Date().toISOString();

  guildEntry.gamesPlayed += 1;
  guildEntry.lastPlayedAt = nowIso;

  const winnerIds = new Set((winners || []).map(winner => winner.userId));

  for (const [userId, score] of scores.entries()) {
    const player = ensurePlayer(guildEntry, userId, score.username);
    player.totalPoints += score.points;
    player.gamesPlayed += 1;
    if (winnerIds.has(userId)) {
      player.gamesWon += 1;
    }
    if (score.points > player.bestScore) {
      player.bestScore = score.points;
    }
    player.lastPlayedAt = nowIso;
  }

  writeQueue = writeQueue.then(persistStats).catch(error => {
    console.error("[tuneGameStats] Failed to persist stats:", error);
  });
  await writeQueue;
}

export function getGuildLeaderboard(guildId, { limit = 10, sortBy = "totalPoints" } = {}) {
  loadStatsSync();
  const guildEntry = cache.guilds[guildId];
  if (!guildEntry) return [];

  const entries = Object.entries(guildEntry.players).map(([userId, player]) => ({
    userId,
    ...player
  }));

  entries.sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));

  return entries.slice(0, limit);
}

export function getGuildStats(guildId) {
  loadStatsSync();
  return cache.guilds[guildId] || null;
}
