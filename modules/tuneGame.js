import fs from "node:fs/promises";
import { randomInt as cryptoRandomInt } from "node:crypto";
import { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  createRandomSongClip,
  downloadSongMp3,
  incrementSongPlayCount,
  loadSongsCatalog
} from "./downloader.js";
import { getGuildLeaderboard, recordGameResult } from "./tuneGameStats.js";
import { VoiceSession } from "./tuneGameVoice.js";
import { synthesizeTts } from "./tuneGameTts.js";
import { bakeOverlaysIntoClip } from "./tuneGameMixer.js";

const ROUND_TIME_SECONDS = Number(process.env.TUNEGAME_ROUND_SECONDS || "60");
const ROUND_TIME_MS = ROUND_TIME_SECONDS * 1000;
const HINT_COUNT = 3;
const HINT_INTERVAL_MS = Math.max(1000, Math.floor(ROUND_TIME_MS / (HINT_COUNT + 1)));
const TUNEGAME_VOICE_CHANNEL_ID =
  process.env.TUNEGAME_VOICE_CHANNEL_ID || "1013871528380727362";
const DEFAULT_TOTAL_QUESTIONS = 10;
const RECENT_SONG_HISTORY_LIMIT = Number(
  process.env.TUNEGAME_RECENT_HISTORY_LIMIT || "200"
);
const MAX_PREP_RETRIES_PER_ROUND = Math.max(
  1,
  Number(process.env.TUNEGAME_MAX_PREP_RETRIES_PER_ROUND || "3")
);
const TITLE_MATCH_PERCENT = Number(process.env.TUNEGAME_TITLE_MATCH_PERCENT || "95");
const TITLE_MATCH_THRESHOLD = Math.max(0, Math.min(100, TITLE_MATCH_PERCENT)) / 100;
const LAST_ROUND_DELETE_DELAY_MS = Math.max(
  0,
  Number(process.env.TUNEGAME_LAST_ROUND_DELETE_DELAY_MS || "3000")
);
const LEADING_MATCH_IGNORED_WORDS = new Set(["the", "of", "a", "an"]);

const activeGamesByGuild = new Map();
const recentSongKeysByGuild = new Map();

export const tuneGameCommand = new SlashCommandBuilder()
  .setName("tunegame")
  .setDescription("Play and manage the tune game")
  .addSubcommand(subcommand =>
    subcommand
      .setName("start")
      .setDescription("Start a tune guessing game")
      .addStringOption(opt =>
        opt
          .setName("genre")
          .setDescription("Optional genre filter, e.g. pop, hip hop, r&b")
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt
          .setName("decade")
          .setDescription("Optional decade/era filter, e.g. 1990 or 1990s")
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt
          .setName("artist")
          .setDescription("Optional artist filter(s), e.g. The Beatles, Queen")
          .setRequired(false)
      )
      .addIntegerOption(opt =>
        opt
          .setName("questions")
          .setDescription("How many questions to play")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName("stop")
      .setDescription("Stop the currently running tune game")
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName("genres")
      .setDescription("List available tune game genres")
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName("decades")
      .setDescription("List available tune game decades")
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName("artists")
      .setDescription("List available tune game artists")
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName("stats")
      .setDescription("Show all-time tune game leaderboard for this server")
  );

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleForGuessMatch(value) {
  const words = normalizeText(value).split(" ").filter(Boolean);

  while (words.length > 1 && LEADING_MATCH_IGNORED_WORDS.has(words[0])) {
    words.shift();
  }

  return words.join(" ");
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

function similarityRatio(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  if (!left || !right) return 0;

  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(left, right);
  return 1 - distance / maxLen;
}

function isGuessCorrect(guess, expectedTitle) {
  const normalizedGuess = normalizeTitleForGuessMatch(guess);
  const normalizedExpected = normalizeTitleForGuessMatch(expectedTitle);

  if (!normalizedGuess || !normalizedExpected) {
    return false;
  }

  if (normalizedGuess === normalizedExpected) {
    return true;
  }

  return similarityRatio(normalizedGuess, normalizedExpected) >= TITLE_MATCH_THRESHOLD;
}

function parseDecadeInput(rawDecade) {
  if (!rawDecade) return null;

  const normalized = String(rawDecade).trim().toLowerCase();

  const shortDecadeMatch = normalized.match(/^(19|20)\d{2}s$/);
  if (shortDecadeMatch) {
    const year = Number.parseInt(shortDecadeMatch[0].slice(0, 4), 10);
    return `${year}-${year + 10}`;
  }

  const exactYearMatch = normalized.match(/^(19|20)\d{2}$/);
  if (exactYearMatch) {
    const year = Number.parseInt(exactYearMatch[0], 10);
    return `${year}-${year + 10}`;
  }

  if (normalized.endsWith("+")) {
    return normalized;
  }

  const matchedYear = normalized.match(/(19|20)\d{2}/);

  if (!matchedYear) {
    return normalized;
  }

  const startYear = Number.parseInt(matchedYear[0], 10);
  const decadeStart = startYear - (startYear % 10);
  return `${decadeStart}-${decadeStart + 10}`;
}

function maskSongTitle(title) {
  const normalized = String(title ?? "");
  const masked = normalized
    .split("")
    .map((char, index) => {
      if (char === " ") return " ";
      if (index === 0) return char;
      if (index % 3 === 0) return char;
      return "-";
    })
    .join("");

  // Space out visible/masked characters for readability in Discord.
  return masked.split("").join(" ");
}

function formatDate(dateValue) {
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function buildSongPool() {
  const catalog = loadSongsCatalog();
  const songs = [];

  for (const eraEntry of catalog?.eras || []) {
    for (const genreEntry of eraEntry?.genres || []) {
      for (const songEntry of genreEntry?.songs || []) {
        if (!songEntry?.artist || !songEntry?.song) continue;

        songs.push({
          artist: songEntry.artist,
          title: songEntry.song,
          era: eraEntry.era,
          genre: genreEntry.genre,
          plays: Number.isFinite(Number(songEntry?.plays)) ? Number(songEntry.plays) : 0,
          albumName: songEntry?.album?.name || null,
          releaseDate: songEntry?.album?.releaseDate || null,
          facts: Array.isArray(songEntry?.songFacts?.facts)
            ? songEntry.songFacts.facts
              .map(fact => String(fact?.text ?? "").trim())
              .filter(Boolean)
            : [],
          albumArtUrl:
            songEntry?.albumArt?.url600 ||
            songEntry?.albumArt?.url1200 ||
            songEntry?.albumArt?.url100 ||
            null
        });
      }
    }
  }

  return songs;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { sensitivity: "base" })
  );
}

function getAvailableGenres(songs) {
  return uniqueSorted(songs.map(song => song.genre));
}

function getAvailableDecades(songs) {
  const normalizedDecades = songs
    .map(song => parseDecadeInput(song.era))
    .filter(Boolean)
    .map(value => {
      const matched = value.match(/^(\d{4})-(\d{4})$/);
      if (!matched) return value;
      return `${matched[1]} (${matched[1]}s)`;
    });

  return uniqueSorted(normalizedDecades);
}

function getAvailableArtists(songs) {
  return uniqueSorted(songs.map(song => song.artist));
}

function chunkLines(lines, maxLength = 1800) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArtistFilterList(rawArtistFilter) {
  if (!rawArtistFilter) return [];

  return String(rawArtistFilter)
    .split(/[,;|]/)
    .map(value => value.trim())
    .filter(Boolean);
}

async function replyWithList(interaction, heading, values) {
  if (values.length === 0) {
    await interaction.reply({
      content: `${heading}: none found.`,
      ephemeral: true
    });
    return;
  }

  const lines = values.map(value => `- ${value}`);
  const chunks = chunkLines(lines);

  await interaction.reply({
    content: `${heading} (${values.length}):\n${chunks[0]}`,
    ephemeral: true
  });

  for (let index = 1; index < chunks.length; index += 1) {
    await interaction.followUp({
      content: chunks[index],
      ephemeral: true
    });
  }
}

function matchesFilters(song, filters) {
  if (filters.genre) {
    if (!normalizeText(song.genre).includes(normalizeText(filters.genre))) {
      return false;
    }
  }

  if (filters.decade) {
    const targetDecade = parseDecadeInput(filters.decade);
    if (!normalizeText(song.era).includes(normalizeText(targetDecade))) {
      return false;
    }
  }

  if (filters.artist) {
    const artistFilters = parseArtistFilterList(filters.artist);
    if (artistFilters.length === 0) {
      return true;
    }

    const normalizedSongArtist = normalizeText(song.artist);
    const artistMatched = artistFilters.some(artistFilter =>
      normalizedSongArtist.includes(normalizeText(artistFilter))
    );

    if (!artistMatched) {
      return false;
    }
  }

  return true;
}

function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = cryptoRandomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function songKey(song) {
  return `${normalizeText(song.artist)}|${normalizeText(song.title)}|${normalizeText(song.era)}|${normalizeText(song.genre)}`;
}

function rememberPlayedSongs(guildId, songs) {
  const existing = recentSongKeysByGuild.get(guildId) || [];
  const next = [...existing, ...songs.map(song => songKey(song))];
  const clipped = next.slice(-RECENT_SONG_HISTORY_LIMIT);
  recentSongKeysByGuild.set(guildId, clipped);
}

function pickRandomSongsForGame(filteredSongs, guildId, count) {
  const rankByLeastPlays = songs => {
    const groups = new Map();

    for (const song of songs) {
      const plays = Number.isFinite(Number(song?.plays)) ? Number(song.plays) : 0;
      const existing = groups.get(plays) || [];
      existing.push(song);
      groups.set(plays, existing);
    }

    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, groupSongs]) => shuffle(groupSongs));
  };

  const recentKeys = new Set(recentSongKeysByGuild.get(guildId) || []);

  const freshSongs = filteredSongs.filter(song => !recentKeys.has(songKey(song)));
  const freshSelection = rankByLeastPlays(freshSongs).slice(0, count);

  if (freshSelection.length === count) {
    return freshSelection;
  }

  const selectedKeys = new Set(freshSelection.map(song => songKey(song)));
  const fallbackPool = filteredSongs.filter(song => !selectedKeys.has(songKey(song)));
  const fallbackSelection = rankByLeastPlays(fallbackPool).slice(0, count - freshSelection.length);

  return [...freshSelection, ...fallbackSelection];
}

function renderScoreboard(gameState) {
  const entries = [...gameState.scores.entries()]
    .sort((a, b) => b[1].points - a[1].points);

  if (entries.length === 0) {
    return "No correct guesses this game.";
  }

  return entries
    .map(([userId, score], index) => `${index + 1}. <@${userId}> - ${score.points} point(s)`)
    .join("\n");
}

function addPoints(gameState, user, points) {
  const existing = gameState.scores.get(user.id);
  if (existing) {
    existing.points += points;
    return;
  }

  gameState.scores.set(user.id, {
    username: user.username,
    points
  });
}

function makeHintList(song) {
  const factHints = [];
  const nonFactHints = [];

  if (song.artist) {
    nonFactHints.push(`${song.artist}`);
  }

  if (song.albumName) {
    nonFactHints.push(`Album: ${song.albumName}`);
  }

  for (const fact of song.facts || []) {
    factHints.push(`${fact}`);
  }

  const titleHint = `Title: ${maskSongTitle(song.title)}`;
  const shuffledFacts = shuffle(factHints);
  const shuffledNonFacts = shuffle(nonFactHints);

  // Prefer fact hints before artist/album hints when facts are available.
  return [...shuffledFacts, ...shuffledNonFacts, titleHint];
}

function buildRoundPromptEmbed(song, roundNumber, totalQuestions) {
  return new EmbedBuilder()
    .setTitle(`:question: Name That Song :question:\r\nQuestion ${roundNumber} of ${totalQuestions}`)
    .setColor(0x3498db)
    .addFields(
      { name: "Category", value: `Genre: ${song.genre}` },
      { name: "Era", value: song.era }
    )
    .setFooter({ text: `Type your guess in chat. You have ${ROUND_TIME_SECONDS} seconds.` });
}

function buildSongResultEmbed(song, winnerName = null, youtubeUrl = null, pointsAwarded = null) {
  const artistText = song.artist || "Unknown";
  const albumText = song.albumName || "Unknown";
  const releaseDateText = formatDate(song.releaseDate) || "Unknown";
  const videoText = youtubeUrl ? `[Video](${youtubeUrl})` : "Unavailable";
  const pointsSuffix =
    winnerName && pointsAwarded
      ? `+${pointsAwarded} point${pointsAwarded === 1 ? "" : "s"}`
      : "";
  const titleText = winnerName
    ? `:white_check_mark:\t${winnerName} ${pointsSuffix}`
    : ":alarm_clock: Time's up :alarm_clock:";

  const embed = new EmbedBuilder()
    .setTitle(titleText)
    .setColor(0x2ecc71)
    .setDescription(
      `**${song.title}**\n` +
      `${artistText}\n` +
      `${albumText}\n` +
      `${releaseDateText} - ${videoText}`
    );

  if (song.albumArtUrl) {
    embed.setThumbnail(song.albumArtUrl);
  }

  return embed;
}

function getGameWinners(gameState) {
  const entries = [...gameState.scores.entries()]
    .map(([userId, score]) => ({ userId, points: score.points }))
    .sort((a, b) => b.points - a.points);

  if (entries.length === 0) {
    return [];
  }

  const topPoints = entries[0].points;
  return entries.filter(entry => entry.points === topPoints);
}

function clearHintTimers(gameState) {
  for (const timer of gameState.activeHintTimers) {
    clearTimeout(timer);
  }
  gameState.activeHintTimers = [];
}

function untrackMessage(gameState, messageId) {
  gameState.botMessageIds = gameState.botMessageIds.filter(id => id !== messageId);
}

async function sendTrackedMessage(gameState, payload) {
  const message = await gameState.channel.send(payload);
  gameState.botMessageIds.push(message.id);
  return message;
}

async function deleteMessagesByIds(gameState, messageIds) {
  await Promise.all(
    messageIds.map(async messageId => {
      await gameState.channel.messages.delete(messageId).catch(() => {});
      untrackMessage(gameState, messageId);
    })
  );
}

async function deleteTrackedMessages(gameState) {
  const messageIds = [...gameState.botMessageIds];
  gameState.botMessageIds = [];

  await Promise.all(
    messageIds.map(messageId =>
      gameState.channel.messages.delete(messageId).catch(() => {})
    )
  );
}

function buildRoundSummaryLines(gameState) {
  return gameState.roundResults.map(result => {
    if (result.status === "skipped") {
      return `• ${result.roundNumber}. **Skipped**: ${result.reason}`;
    }

    const winnerText = result.winnerId ? `<@${result.winnerId}>` : "No winner";
    const youtubeText = result.youtubeUrl ? ` ([YouTube](${result.youtubeUrl}))` : "";
    return `• ${result.roundNumber}. **${result.title}** - ${result.artist} -> ${winnerText}${youtubeText}`;
  });
}

function buildGameSummaryEmbed(gameState, reason) {
  const winners = getGameWinners(gameState);
  const playedRounds = gameState.roundResults.filter(result => result.status === "played");
  const scoreEntries = [...gameState.scores.entries()]
    .map(([userId, score]) => ({ userId, points: score.points }))
    .sort((a, b) => b.points - a.points);

  let winnerLine = "No winner";
  if (winners.length === 1) {
    winnerLine = `<@${winners[0].userId}> - **${winners[0].points}** points`;
  } else if (winners.length > 1) {
    winnerLine = `${winners.map(entry => `<@${entry.userId}>`).join(", ")} - **${winners[0].points}** points`;
  }

  const roundLines =
    playedRounds.length > 0
      ? playedRounds.map((result, index) => {
        const songText = result.youtubeUrl ? `[${result.title}](${result.youtubeUrl})` : result.title;
        const artistText = result.artist || "Unknown";
        const winnerText = result.winnerId ? `<@${result.winnerId}>` : "None";
        return `${index + 1}.\t${songText}\t${artistText}\t${winnerText}`;
      })
      : ["No rounds completed."];
  const roundChunks = chunkLines(roundLines, 1024);
  const roundFields = roundChunks.map((chunk, index) => ({
    name: index === 0 ? "Song List" : `Song List (cont. ${index + 1})`,
    value: chunk,
    inline: false
  }));
  const scoreLines =
    scoreEntries.length > 0
      ? scoreEntries.map((entry, index) => `${index + 1}. <@${entry.userId}> - ${entry.points} point(s)`)
      : ["No correct guesses this game."];
  const scoreChunks = chunkLines(scoreLines, 1024);
  const scoreFields = scoreChunks.map((chunk, index) => ({
    name: index === 0 ? "Final Scores" : `Final Scores (cont. ${index + 1})`,
    value: chunk,
    inline: false
  }));

  const commandLine =
    "**/tunegame start** - start a new match.\n-------\n*created by: " +
    `<@${gameState.hostUserId}>*`;

  const embed = new EmbedBuilder()
    .setTitle("🏁 Tune Game Match Summary 🏁")
    .setColor(0xf1c40f)
    .setDescription(`** Round Winner **\n\n${winnerLine}\n\n`);

  embed.addFields(...roundFields);

  embed.addFields(...scoreFields);
  embed.addFields({
    name: "-------",
    value: commandLine,
    inline: false
  });

  if (reason === "stopped") {
    embed.setFooter({ text: "Game stopped early." });
  }

  return embed;
}

async function cleanupRoundFiles(gameState) {
  const files = gameState.activeRoundFiles;
  gameState.activeRoundFiles = [];

  await Promise.all(files.map(filePath => fs.unlink(filePath).catch(() => {})));
}

async function runSingleRound(gameState, song, roundNumber) {
  const { channel } = gameState;
  const roundMessageIds = [];
  const sendRoundMessage = async payload => {
    const message = await sendTrackedMessage(gameState, payload);
    roundMessageIds.push(message.id);
    return message;
  };

  if (gameState.stopRequested) return { stopped: true };

  // Kick off the download immediately so it can run while we announce the question.
  const downloadPromise = downloadSongMp3({
    artist: song.artist,
    title: song.title,
    logger: console
  });

  // Announce the upcoming question over voice while the download is in flight.
  const introParts = [`Question ${roundNumber} of ${gameState.totalQuestions}.`];
  if (song.genre) introParts.push(`Genre, ${song.genre}.`);
  if (song.era) introParts.push(`Era, ${song.era}.`);
  introParts.push("Get ready... here comes your tune!");
  await gameState.voice.speakTts(introParts.join(" "));

  const { filePath: downloadedFilePath, youtubeUrl } = await downloadPromise;

  let clipFilePath;
  try {
    const clipResult = await createRandomSongClip({
      inputFilePath: downloadedFilePath,
      clipDurationSeconds: ROUND_TIME_SECONDS,
      logger: console
    });
    clipFilePath = clipResult.clipFilePath;
  } catch (error) {
    await fs.unlink(downloadedFilePath).catch(() => {});
    throw error;
  }

  // Pre-render hint TTS audio and bake them into a single mixed clip mp3.
  const hints = makeHintList(song);
  const playableHints = hints.slice(0, HINT_COUNT);
  let bakedClipFilePath = clipFilePath;
  const hintTtsFiles = [];
  try {
    const ttsPaths = await Promise.all(
      playableHints.map((hint, index) =>
        synthesizeTts(`Hint ${index + 1}. ${hint}`)
      )
    );
    const overlays = ttsPaths
      .map((filePath, index) => filePath ? {
        filePath,
        offsetMs: HINT_INTERVAL_MS * (index + 1)
      } : null)
      .filter(Boolean);
    overlays.forEach(o => hintTtsFiles.push(o.filePath));

    if (overlays.length > 0) {
      const bakedPath = clipFilePath.replace(/\.mp3$/i, ".mixed.mp3");
      await bakeOverlaysIntoClip({
        baseFilePath: clipFilePath,
        overlays,
        outputFilePath: bakedPath
      });
      bakedClipFilePath = bakedPath;
    }
  } catch (error) {
    console.warn("[tuneGame] Failed to bake hint TTS into clip:", error.message);
  }

  gameState.activeRoundFiles = [downloadedFilePath, clipFilePath];
  if (bakedClipFilePath !== clipFilePath) {
    gameState.activeRoundFiles.push(bakedClipFilePath);
  }

  if (gameState.stopRequested) {
    await cleanupRoundFiles(gameState);
    return { stopped: true };
  }

  const embed = buildRoundPromptEmbed(song, roundNumber, gameState.totalQuestions);

  const attachment = new AttachmentBuilder(bakedClipFilePath, {
    name: `tunegame-round-${roundNumber}.mp3`
  });

  const roundPromptMessage = await sendRoundMessage({
    embeds: [embed],
    files: [attachment]
  });

  await gameState.voice.playClip(bakedClipFilePath);

  gameState.roundSolved = false;
  gameState.currentPoints = HINT_COUNT;
  gameState.activeHintTimers = playableHints.map((hint, index) =>
    setTimeout(() => {
      if (gameState.stopRequested || gameState.roundSolved) return;
      gameState.currentPoints = Math.max(1, HINT_COUNT - index - 1);
      sendRoundMessage(`Hint ${index + 1}: ${hint}`).catch(() => {});
    }, HINT_INTERVAL_MS * (index + 1))
  );

  const result = await new Promise(resolve => {
    let winningMessage = null;

    const collector = channel.createMessageCollector({
      filter: message => !message.author.bot && message.channelId === gameState.channelId,
      time: ROUND_TIME_MS
    });

    gameState.activeCollector = collector;

    collector.on("collect", message => {
      if (isGuessCorrect(message.content, song.title)) {
        winningMessage = message;
        gameState.roundSolved = true;
        collector.stop("guessed");
      }
    });

    collector.on("end", () => {
      gameState.activeCollector = null;

      if (gameState.stopRequested) {
        resolve({ stopped: true });
        return;
      }

      if (winningMessage) {
        resolve({
          winner: winningMessage.author,
          guess: winningMessage.content
        });
        return;
      }

      resolve({ winner: null });
    });
  });

  clearHintTimers(gameState);
  gameState.voice.stopClip();
  await cleanupRoundFiles(gameState);

  if (result.stopped) {
    return { ...result, roundMessageIds };
  }

  if (result.winner) {
    const pointsAwarded = gameState.currentPoints ?? 1;
    addPoints(gameState, result.winner, pointsAwarded);
    await sendRoundMessage({
      embeds: [buildSongResultEmbed(song, result.winner.username, youtubeUrl, pointsAwarded)]
    });
    gameState.voice.speakTts(
      `${result.winner.username} got it! ${song.title} by ${song.artist}. ${pointsAwarded} point${pointsAwarded === 1 ? "" : "s"}!`
    ).catch(() => {});
    return {
      winnerId: result.winner.id,
      roundNumber,
      title: song.title,
      artist: song.artist,
      youtubeUrl,
      roundMessageIds
    };
  }

  await sendRoundMessage({
    embeds: [buildSongResultEmbed(song, null, youtubeUrl)]
  });
  gameState.voice.speakTts(
    `Time's up! The answer was ${song.title} by ${song.artist}.`
  ).catch(() => {});

  return {
    winnerId: null,
    roundNumber,
    title: song.title,
    artist: song.artist,
    youtubeUrl,
    roundMessageIds
  };
}

async function finishGame(gameState, reason) {
  if (gameState.finished) return;

  gameState.finished = true;
  gameState.stopRequested = true;

  clearHintTimers(gameState);

  if (gameState.activeCollector) {
    gameState.activeCollector.stop("stopped");
  }

  await cleanupRoundFiles(gameState);

  const winners = getGameWinners(gameState);
  let outroLine;
  if (reason === "stopped") {
    outroLine = "That's a wrap! The game has been stopped. Thanks for playing!";
  } else if (winners.length === 1) {
    const champ = gameState.scores.get(winners[0].userId)?.username || "our champion";
    outroLine = `That's the game! Our champion is ${champ} with ${winners[0].points} point${winners[0].points === 1 ? "" : "s"}! Well played, everyone!`;
  } else if (winners.length > 1) {
    outroLine = `It's a tie! Our champions share ${winners[0].points} point${winners[0].points === 1 ? "" : "s"} apiece. What a game!`;
  } else {
    outroLine = "That's the game! No correct guesses this time. Better luck next round!";
  }
  await gameState.voice.speakTts(outroLine);

  gameState.voice.teardown();

  await deleteTrackedMessages(gameState);

  const summaryEmbed = buildGameSummaryEmbed(gameState, reason);
  await gameState.channel.send({ embeds: [summaryEmbed] });

  try {
    await recordGameResult({
      guildId: gameState.guildId,
      scores: gameState.scores,
      winners: getGameWinners(gameState)
    });
  } catch (error) {
    console.error("[tuneGame] Failed to record game stats:", error);
  }

  activeGamesByGuild.delete(gameState.guildId);
}

export async function handleTuneGameStats(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true
    });
    return;
  }

  const leaderboard = getGuildLeaderboard(guildId, { limit: 10 });

  if (leaderboard.length === 0) {
    await interaction.reply({
      content: "No tune game stats recorded yet. Play a game first!",
      ephemeral: true
    });
    return;
  }

  const lines = leaderboard.map((player, index) => {
    const winRate = player.gamesPlayed
      ? Math.round((player.gamesWon / player.gamesPlayed) * 100)
      : 0;
    return (
      `${index + 1}. <@${player.userId}> - **${player.totalPoints}** pts ` +
      `(best: ${player.bestScore}, won ${player.gamesWon}/${player.gamesPlayed} - ${winRate}%)`
    );
  });

  const embed = new EmbedBuilder()
    .setTitle("🏆 Tune Game All-Time Leaderboard")
    .setColor(0xf1c40f)
    .setDescription(lines.join("\n"));

  await interaction.reply({ embeds: [embed] });
}

export async function handleTuneGameStart(interaction) {
  const guildId = interaction.guildId;

  if (!guildId || !interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({
      content: "This command can only be used in a server text channel.",
      ephemeral: true
    });
    return;
  }

  const existing = activeGamesByGuild.get(guildId);
  if (existing && !existing.finished) {
    await interaction.reply({
      content: `A tune game is already running in <#${existing.channelId}>. Use /tunegame stop there first.`,
      ephemeral: true
    });
    return;
  }

  const filters = {
    genre: interaction.options.getString("genre"),
    decade: interaction.options.getString("decade"),
    artist: interaction.options.getString("artist")
  };
  const totalQuestions = interaction.options.getInteger("questions") ?? DEFAULT_TOTAL_QUESTIONS;

  const allSongs = buildSongPool();
  const filteredSongs = allSongs.filter(song => matchesFilters(song, filters));

  if (filteredSongs.length < totalQuestions) {
    await interaction.reply({
      content: `Not enough songs for this filter set. Need at least ${totalQuestions}, found ${filteredSongs.length}.`,
      ephemeral: true
    });
    return;
  }

  const songQueue = pickRandomSongsForGame(filteredSongs, guildId, filteredSongs.length);

  const gameState = {
    guildId,
    hostUserId: interaction.user.id,
    channelId: interaction.channel.id,
    channel: interaction.channel,
    scores: new Map(),
    activeCollector: null,
    activeHintTimers: [],
    activeRoundFiles: [],
    roundResults: [],
    botMessageIds: [],
    totalQuestions,
    roundSolved: false,
    stopRequested: false,
    finished: false,
    voice: new VoiceSession()
  };

  activeGamesByGuild.set(guildId, gameState);

  await gameState.voice.join(interaction.guild, TUNEGAME_VOICE_CHANNEL_ID);

  const activeFilters = [
    filters.genre ? `genre=${filters.genre}` : null,
    filters.decade ? `decade=${filters.decade}` : null,
    filters.artist
      ? `artist=${parseArtistFilterList(filters.artist).join(" | ") || filters.artist}`
      : null
  ].filter(Boolean);

  await interaction.reply({
    content:
      activeFilters.length > 0
        ? `Starting tune game with filters: ${activeFilters.join(", ")} in ${interaction.channel}.`
        : `Starting tune game in ${interaction.channel}.`,
    ephemeral: true
  });

  const optionsText =
    activeFilters.length > 0
      ? activeFilters.join(", ")
      : "none";

  const startEmbed = new EmbedBuilder()
    .setTitle(":musical_note: Tune Game Starting")
    .setColor(0x1abc9c)
    .setDescription("Type your guesses in chat. Faster guesses score more points!")
    .addFields(
      { name: "Options", value: optionsText, inline: false },
      { name: "Questions", value: String(totalQuestions), inline: true },
      { name: "Time per round", value: `${ROUND_TIME_SECONDS}s`, inline: true },
      {
        name: "Scoring",
        value: "Before hint 1: **3 pts**\nAfter hint 1: **2 pts**\nAfter hint 2+: **1 pt**",
        inline: false
      },
      { name: "Host", value: `<@${gameState.hostUserId}>`, inline: false }
    );

  await sendTrackedMessage(gameState, { embeds: [startEmbed] });

  await gameState.voice.speakTts(
    `Welcome to Tune Game! ${totalQuestions} question${totalQuestions === 1 ? "" : "s"}, ${ROUND_TIME_SECONDS} seconds each. Faster guesses score more points. Let's play!`
  );

  try {
    const playedSongs = [];
    let queueIndex = 0;
    let previousRoundMessageIds = [];

    for (let roundNumber = 1; roundNumber <= totalQuestions; roundNumber += 1) {
      if (gameState.stopRequested) {
        break;
      }

      let roundCompleted = false;
      let attempts = 0;

      while (
        !roundCompleted &&
        !gameState.stopRequested &&
        attempts < MAX_PREP_RETRIES_PER_ROUND &&
        queueIndex < songQueue.length
      ) {
        const song = songQueue[queueIndex];
        queueIndex += 1;
        attempts += 1;

        try {
          const roundResult = await runSingleRound(gameState, song, roundNumber);

          if (roundResult.stopped) {
            gameState.stopRequested = true;
            break;
          }

          if (previousRoundMessageIds.length > 0) {
            await deleteMessagesByIds(gameState, previousRoundMessageIds);
          }

          previousRoundMessageIds = roundResult.roundMessageIds || [];

          gameState.roundResults.push({ ...roundResult, status: "played" });
          playedSongs.push(song);
          song.plays = (Number.isFinite(Number(song.plays)) ? Number(song.plays) : 0) + 1;

          const updatedPlays = incrementSongPlayCount(song);
          if (!updatedPlays) {
            console.warn(`Could not persist play count for song: ${song.artist} - ${song.title}`);
          }

          roundCompleted = true;
        } catch (error) {
          console.warn(
            `Skipping song due to round preparation failure: ${song.artist} - ${song.title}`,
            error
          );
          // Make sure any partial round files are cleaned up.
          await cleanupRoundFiles(gameState).catch(() => {});
        }
      }

      if (gameState.stopRequested) {
        break;
      }

      if (!roundCompleted) {
        gameState.roundResults.push({
          status: "skipped",
          roundNumber,
          reason: `Download/clip failed after ${attempts} attempt(s).`
        });

        if (queueIndex >= songQueue.length) {
          break;
        }
      }
    }

    if (previousRoundMessageIds.length > 0) {
      await wait(LAST_ROUND_DELETE_DELAY_MS);
      await deleteMessagesByIds(gameState, previousRoundMessageIds);
    }

    if (playedSongs.length > 0) {
      rememberPlayedSongs(guildId, playedSongs);
    }

    await finishGame(gameState, gameState.stopRequested ? "stopped" : "completed");
  } catch (error) {
    console.error("tunegame failed:", error);
    await sendTrackedMessage(gameState, "Tune game encountered an error and has been stopped.");
    await finishGame(gameState, "stopped");
  }
}

export async function handleTuneGameGenres(interaction) {
  const songs = buildSongPool();
  await replyWithList(interaction, "Available genres", getAvailableGenres(songs));
}

export async function handleTuneGameDecades(interaction) {
  const songs = buildSongPool();
  await replyWithList(interaction, "Available decades", getAvailableDecades(songs));
}

export async function handleTuneGameArtists(interaction) {
  const songs = buildSongPool();
  await replyWithList(interaction, "Available artists", getAvailableArtists(songs));
}

export async function handleTuneGameStop(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true
    });
    return;
  }

  const gameState = activeGamesByGuild.get(guildId);

  if (!gameState || gameState.finished) {
    await interaction.reply({
      content: "No active tune game is running.",
      ephemeral: true
    });
    return;
  }

  if (interaction.user.id !== gameState.hostUserId) {
    await interaction.reply({
      content: `Only the user who started this game can stop it (<@${gameState.hostUserId}>).`,
      ephemeral: true
    });
    return;
  }

  gameState.stopRequested = true;

  if (gameState.activeCollector) {
    gameState.activeCollector.stop("stopped");
  }

  await interaction.reply({
    content: "Stopping the active tune game.",
    ephemeral: true
  });
}
