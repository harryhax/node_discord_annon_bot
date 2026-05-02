#!/usr/bin/env node
/**
 * Enrich top-songs JSON with album art URLs, album metadata, and artist metadata.
 *
 * No external npm packages required. Requires Node 18+ for global fetch.
 *
 * Usage:
 *   node enrich-top-songs-metadata.mjs input.json output.enriched.json
 *
 * Optional flags:
 *   --limit 50                 Process only the first N songs, useful for testing.
 *   --delay-ms 250             Delay between Apple/iTunes requests.
 *   --musicbrainz              Also fetch artist metadata from MusicBrainz.
 *   --musicbrainz-delay-ms 1100 Delay between MusicBrainz requests. Keep this conservative.
 *   --coverart-fallback        Try Cover Art Archive when Apple artwork is missing.
 *   --resume output.json       Resume from an existing output file.
 *
 * Recommended first run:
 *   node enrich-top-songs-metadata.mjs top_songs_by_era_and_genre_with_1970s_50_per_category.json top_songs_enriched_test.json --limit 25 --musicbrainz
 *
 * Full run:
 *   node enrich-top-songs-metadata.mjs top_songs_by_era_and_genre_with_1970s_50_per_category.json top_songs_enriched.json --musicbrainz --coverart-fallback
 */

import fs from "node:fs/promises";

const USER_AGENT = "top-songs-json-enricher/1.0 (metadata lookup; contact: local-user)";

function parseArgs(argv) {
  const args = {
    input: argv[2],
    output: argv[3],
    limit: 0,
    delayMs: 250,
    musicbrainz: false,
    musicbrainzDelayMs: 1100,
    coverartFallback: false,
    resume: null,
    retries: 2,
    rateLimitBackoffMs: 12000,
  };

  for (let i = 4; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--musicbrainz") args.musicbrainz = true;
    else if (arg === "--musicbrainz-delay-ms") args.musicbrainzDelayMs = Number(argv[++i]);
    else if (arg === "--coverart-fallback") args.coverartFallback = true;
    else if (arg === "--resume") args.resume = argv[++i];
    else if (arg === "--retries") args.retries = Number(argv[++i]);
    else if (arg === "--rate-limit-backoff-ms") args.rateLimitBackoffMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.input || !args.output) {
    throw new Error("Usage: node enrich-top-songs-metadata.mjs input.json output.json [--musicbrainz] [--coverart-fallback]");
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error("--limit must be a number >= 0");
  }

  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitedError(error) {
  const text = String(error?.message ?? "");
  return text.includes("HTTP 429") || text.includes("HTTP 403 Forbidden");
}

async function withRetries(work, options = {}) {
  const retries = Number(options.retries ?? 0);
  const backoffMs = Number(options.backoffMs ?? 0);
  const label = options.label ?? "request";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const canRetry = attempt < retries && isRateLimitedError(error);
      if (!canRetry) throw error;

      const waitMs = backoffMs * (attempt + 1);
      console.warn(`  WARN: ${label} rate-limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(waitMs);
    }
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(feat|ft|featuring)\b\.?/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|remastered|mono|stereo|single|version|edit|radio|explicit|clean)\b/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSet(value) {
  const normalized = normalizeText(value);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter(Boolean));
}

function jaccard(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function exactish(a, b) {
  return normalizeText(a) === normalizeText(b);
}

function parseEraBounds(eraName) {
  const text = String(eraName ?? "");
  if (text.endsWith("+")) {
    const start = Number(text.replace("+", ""));
    return { start, end: 9999 };
  }

  const match = text.match(/^(\d{4})-(\d{4})$/);
  if (!match) return { start: null, end: null };

  return { start: Number(match[1]), end: Number(match[2]) };
}

function yearFromDate(value) {
  const match = String(value ?? "").match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function scoreItunesCandidate(song, candidate, eraName) {
  const titleScore = jaccard(song.song, candidate.trackName);
  const artistScore = jaccard(song.artist, candidate.artistName);
  const exactTitleBonus = exactish(song.song, candidate.trackName) ? 0.15 : 0;
  const exactArtistBonus = exactish(song.artist, candidate.artistName) ? 0.10 : 0;

  const releaseYear = yearFromDate(candidate.releaseDate);
  const { start, end } = parseEraBounds(eraName);
  let eraScore = 0.05;
  if (releaseYear && start && end) {
    eraScore = releaseYear >= start && releaseYear <= end ? 0.10 : -0.05;
  }

  const score = Math.max(
    0,
    Math.min(1, titleScore * 0.55 + artistScore * 0.30 + exactTitleBonus + exactArtistBonus + eraScore)
  );

  return Number(score.toFixed(4));
}

function resizeItunesArtwork(url, size) {
  if (!url) return null;

  return String(url)
    .replace(/\/\d+x\d+bb\.(jpg|jpeg|png|webp)$/i, `/${size}x${size}bb.$1`)
    .replace(/\/\d+x\d+-75\.(jpg|jpeg|png|webp)$/i, `/${size}x${size}bb.$1`);
}

function getSongRefs(root) {
  const refs = [];
  for (const era of root.eras ?? []) {
    for (const genre of era.genres ?? []) {
      for (const song of genre.songs ?? []) {
        refs.push({ era, genre, song });
      }
    }
  }
  return refs;
}

async function fetchJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchItunes(song, eraName) {
  const term = `${song.artist ?? ""} ${song.song ?? ""}`.trim();
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", term);
  url.searchParams.set("entity", "song");
  url.searchParams.set("media", "music");
  url.searchParams.set("limit", "10");

  const data = await fetchJson(url);
  const candidates = Array.isArray(data.results) ? data.results : [];

  if (candidates.length === 0) {
    return {
      metadataMatch: {
        status: "unmatched",
        source: "itunes-search-api",
        confidence: 0,
        notes: ["No iTunes result returned"],
      },
      album: null,
      albumArt: null,
      artistDetails: null,
    };
  }

  const scored = candidates
    .filter(item => item.kind === "song")
    .map(item => ({
      item,
      score: scoreItunesCandidate(song, item, eraName),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0] ?? { item: candidates[0], score: 0 };
  const item = best.item;
  const status =
    best.score >= 0.78 ? "matched" :
    best.score >= 0.58 ? "low_confidence" :
    "needs_review";

  return {
    metadataMatch: {
      status,
      source: "itunes-search-api",
      confidence: best.score,
      notes: status === "matched" ? [] : ["Review this match before using it in production"],
      matchedTrackName: item.trackName ?? null,
      matchedArtistName: item.artistName ?? null,
    },
    album: {
      name: item.collectionName ?? null,
      censoredName: item.collectionCensoredName ?? null,
      collectionId: item.collectionId ?? null,
      collectionViewUrl: item.collectionViewUrl ?? null,
      releaseDate: item.releaseDate ?? null,
      trackNumber: item.trackNumber ?? null,
      trackCount: item.trackCount ?? null,
      discNumber: item.discNumber ?? null,
      discCount: item.discCount ?? null,
      primaryGenreName: item.primaryGenreName ?? null,
      country: item.country ?? null,
      explicitness: item.trackExplicitness ?? null,
      durationMs: item.trackTimeMillis ?? null,
      previewUrl: item.previewUrl ?? null,
      trackViewUrl: item.trackViewUrl ?? null,
    },
    albumArt: {
      source: "itunes-search-api",
      url100: item.artworkUrl100 ?? null,
      url600: resizeItunesArtwork(item.artworkUrl100, 600),
      url1200: resizeItunesArtwork(item.artworkUrl100, 1200),
      coverArtArchiveUrl: null,
    },
    artistDetails: {
      name: item.artistName ?? song.artist ?? null,
      type: null,
      country: null,
      beginDate: null,
      endDate: null,
      disambiguation: null,
      itunesArtistId: item.artistId ?? null,
      itunesArtistViewUrl: item.artistViewUrl ?? null,
      musicBrainzArtistId: null,
      musicBrainzUrl: null,
    },
  };
}

function pickBestMusicBrainzArtist(artistName, artists) {
  const scored = (artists ?? []).map(artist => {
    const nameScore = jaccard(artistName, artist.name);
    const sortNameScore = jaccard(artistName, artist["sort-name"]);
    const mbScore = Number(artist.score ?? 0) / 100;
    return {
      artist,
      score: Number(Math.max(nameScore, sortNameScore) * 0.70 + mbScore * 0.30).toFixed(4),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

async function searchMusicBrainzArtist(song) {
  const url = new URL("https://musicbrainz.org/ws/2/artist/");
  url.searchParams.set("query", song.artist ?? "");
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "5");

  const data = await fetchJson(url);
  const best = pickBestMusicBrainzArtist(song.artist, data.artists);
  if (!best) return null;

  const artist = best.artist;
  return {
    matchConfidence: Number(best.score),
    name: artist.name ?? null,
    type: artist.type ?? null,
    country: artist.country ?? null,
    beginDate: artist["life-span"]?.begin ?? null,
    endDate: artist["life-span"]?.end ?? null,
    disambiguation: artist.disambiguation ?? null,
    musicBrainzArtistId: artist.id ?? null,
    musicBrainzUrl: artist.id ? `https://musicbrainz.org/artist/${artist.id}` : null,
    tags: Array.isArray(artist.tags) ? artist.tags.map(tag => tag.name).slice(0, 10) : [],
  };
}

function pickFirstReleaseId(recordingData, eraName) {
  const recordings = Array.isArray(recordingData.recordings) ? recordingData.recordings : [];
  const { start, end } = parseEraBounds(eraName);

  const releases = [];
  for (const recording of recordings) {
    for (const release of recording.releases ?? []) {
      const releaseYear = yearFromDate(release.date);
      let score = 0;
      if (releaseYear && start && end && releaseYear >= start && releaseYear <= end) score += 2;
      if (release.status === "Official") score += 1;
      releases.push({ release, score });
    }
  }

  releases.sort((a, b) => b.score - a.score);
  return releases[0]?.release?.id ?? null;
}

async function coverArtArchiveFallback(song, eraName) {
  const recUrl = new URL("https://musicbrainz.org/ws/2/recording/");
  recUrl.searchParams.set("query", `${song.song ?? ""} ${song.artist ?? ""}`);
  recUrl.searchParams.set("fmt", "json");
  recUrl.searchParams.set("limit", "5");
  recUrl.searchParams.set("inc", "releases");

  const recordingData = await fetchJson(recUrl);
  const releaseId = pickFirstReleaseId(recordingData, eraName);
  if (!releaseId) return null;

  const coverUrl = `https://coverartarchive.org/release/${releaseId}`;
  const coverData = await fetchJson(coverUrl);
  const front = (coverData.images ?? []).find(image => image.front) ?? coverData.images?.[0];
  if (!front) return null;

  return {
    source: "cover-art-archive",
    url100: front.thumbnails?.small ?? null,
    url600: front.thumbnails?.large ?? front.thumbnails?.small ?? null,
    url1200: front.image ?? null,
    coverArtArchiveUrl: coverUrl,
    musicBrainzReleaseId: releaseId,
  };
}

function mergeArtistDetails(existing, mbArtist) {
  if (!mbArtist) return existing;

  return {
    ...(existing ?? {}),
    type: existing?.type ?? mbArtist.type ?? null,
    country: existing?.country ?? mbArtist.country ?? null,
    beginDate: existing?.beginDate ?? mbArtist.beginDate ?? null,
    endDate: existing?.endDate ?? mbArtist.endDate ?? null,
    disambiguation: existing?.disambiguation ?? mbArtist.disambiguation ?? null,
    musicBrainzArtistId: mbArtist.musicBrainzArtistId ?? existing?.musicBrainzArtistId ?? null,
    musicBrainzUrl: mbArtist.musicBrainzUrl ?? existing?.musicBrainzUrl ?? null,
    musicBrainzMatchConfidence: mbArtist.matchConfidence,
    tags: mbArtist.tags ?? [],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const inputText = await fs.readFile(args.resume ?? args.input, "utf8");
  const root = JSON.parse(inputText);

  root.metadata = root.metadata ?? {};
  root.metadata.enrichment = {
    ...(root.metadata.enrichment ?? {}),
    generatedAt: new Date().toISOString(),
    sources: [
      "Apple/iTunes Search API",
      ...(args.musicbrainz ? ["MusicBrainz Web Service"] : []),
      ...(args.coverartFallback ? ["Cover Art Archive"] : []),
    ],
    warning: "Automated music matching can produce false positives. Review low_confidence and needs_review matches.",
  };

  const refs = getSongRefs(root);
  const total = args.limit > 0 ? Math.min(args.limit, refs.length) : refs.length;

  let processed = 0;
  let matched = 0;
  let lowConfidence = 0;
  let unmatched = 0;
  let errors = 0;

  for (let i = 0; i < refs.length; i += 1) {
    if (args.limit > 0 && processed >= args.limit) break;

    const { era, genre, song } = refs[i];

    if (song.metadataStatus === "enriched" || song.metadataStatus === "enriched_needs_review") {
      continue;
    }

    processed += 1;
    const label = `${processed}/${total} ${era.era} / ${genre.genre} - ${song.artist} - ${song.song}`;
    console.log(label);

    try {
      const itunes = await withRetries(
        () => searchItunes(song, era.era),
        {
          retries: args.retries,
          backoffMs: args.rateLimitBackoffMs,
          label: "iTunes lookup"
        }
      );

      song.metadataStatus = itunes.metadataMatch.status === "matched" ? "enriched" : "enriched_needs_review";
      song.metadataMatch = itunes.metadataMatch;
      song.album = itunes.album;
      song.albumArt = itunes.albumArt;
      song.artistDetails = {
        ...(song.artistDetails ?? {}),
        ...itunes.artistDetails,
      };

      if (!song.albumArt?.url100 && args.coverartFallback) {
        await sleep(args.musicbrainzDelayMs);
        const fallbackArt = await withRetries(
          () => coverArtArchiveFallback(song, era.era),
          {
            retries: args.retries,
            backoffMs: args.rateLimitBackoffMs,
            label: "Cover Art Archive lookup"
          }
        ).catch(error => {
          song.metadataMatch.notes.push(`Cover Art Archive fallback failed: ${error.message}`);
          return null;
        });
        if (fallbackArt) {
          song.albumArt = fallbackArt;
        }
      }

      if (args.musicbrainz) {
        await sleep(args.musicbrainzDelayMs);
        const mbArtist = await withRetries(
          () => searchMusicBrainzArtist(song),
          {
            retries: args.retries,
            backoffMs: args.rateLimitBackoffMs,
            label: "MusicBrainz artist lookup"
          }
        ).catch(error => {
          song.metadataMatch.notes.push(`MusicBrainz artist lookup failed: ${error.message}`);
          return null;
        });
        song.artistDetails = mergeArtistDetails(song.artistDetails, mbArtist);
      }

      if (song.metadataMatch.status === "matched") matched += 1;
      else if (song.metadataMatch.status === "low_confidence" || song.metadataMatch.status === "needs_review") lowConfidence += 1;
      else unmatched += 1;
    } catch (error) {
      errors += 1;
      song.metadataStatus = "enrichment_error";
      song.metadataMatch = {
        status: "error",
        source: "itunes-search-api",
        confidence: 0,
        notes: [error.message],
      };
      console.error(`  ERROR: ${error.message}`);
    }

    await fs.writeFile(args.output, JSON.stringify(root, null, 2), "utf8");
    await sleep(args.delayMs);
  }

  root.metadata.enrichment.summary = {
    processed,
    matched,
    lowConfidence,
    unmatched,
    errors,
    completedAt: new Date().toISOString(),
  };

  await fs.writeFile(args.output, JSON.stringify(root, null, 2), "utf8");

  console.log("\nDone.");
  console.log(JSON.stringify(root.metadata.enrichment.summary, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
