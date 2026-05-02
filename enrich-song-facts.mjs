#!/usr/bin/env node

/**
 * Enrich songs with 3 one-sentence, source-backed candidate facts.
 *
 * Usage:
 *   node enrich-song-facts.mjs input.json output.json --limit 25
 *   node enrich-song-facts.mjs input.json output.json --overwrite --delay-ms 2000
 *
 * Requirements:
 *   Node 18+ for built-in fetch.
 *
 * Notes:
 *   This script uses Wikipedia's public MediaWiki API.
 *   Automated matching can be wrong for songs with common titles.
 *   Review entries marked needs_review before publishing.
 */

import fs from "node:fs/promises";

const DEFAULT_DELAY_MS = 2000;
const DEFAULT_LIMIT = Number.POSITIVE_INFINITY;
const MAX_HTTP_RETRIES = 4;
const DEFAULT_USER_AGENT =
  "songs-json-fact-enricher/1.0 (metadata enrichment; contact: local-user)";

function parseArgs(argv) {
  const args = {
    inputPath: argv[2],
    outputPath: argv[3],
    limit: DEFAULT_LIMIT,
    offset: 0,
    delayMs: DEFAULT_DELAY_MS,
    overwrite: false,
    dryRun: false,
    onlyEra: null,
    onlyGenre: null,
    saveEvery: 50,
    userAgent: DEFAULT_USER_AGENT,
  };

  for (let i = 4; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--overwrite") args.overwrite = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--offset") args.offset = Number(argv[++i]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--only-era") args.onlyEra = argv[++i];
    else if (arg === "--only-genre") args.onlyGenre = argv[++i];
    else if (arg === "--save-every") args.saveEvery = Number(argv[++i]);
    else if (arg === "--user-agent") args.userAgent = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.inputPath || !args.outputPath) {
    throw new Error(
      "Usage: node enrich-song-facts.mjs input.json output.json [--limit N] [--overwrite]"
    );
  }

  if (!Number.isFinite(args.limit) && args.limit !== Number.POSITIVE_INFINITY) {
    throw new Error("--limit must be a number");
  }

  if (!Number.isFinite(args.offset) || args.offset < 0) {
    throw new Error("--offset must be a non-negative number");
  }

  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative number");
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestStartedAt = 0;

async function waitForRequestWindow(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;

  const now = Date.now();
  const earliestNextStart = lastRequestStartedAt + delayMs;
  if (now < earliestNextStart) {
    await sleep(earliestNextStart - now);
  }

  lastRequestStartedAt = Date.now();
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function sentenceSplit(text) {
  const clean = compactText(text)
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\((listen|audio|help·info)\)/gi, "")
    .trim();

  const matches = clean.match(/[^.!?]+[.!?](?=\s|$)/g) ?? [];
  return matches
    .map((sentence) => compactText(sentence))
    .filter((sentence) => sentence.length >= 35 && sentence.length <= 280)
    .filter((sentence) => !/^for other uses/i.test(sentence))
    .filter((sentence) => !/may refer to/i.test(sentence));
}

function uniqueSentences(sentences) {
  const seen = new Set();
  const output = [];

  for (const sentence of sentences) {
    const key = normalizeText(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(sentence);
  }

  return output;
}

function buildSearchQueries(song) {
  const title = song.song ?? "";
  const artist = song.artist ?? "";
  const albumName = song.album?.name ?? "";

  return [
    `"${title}" "${artist}" song`,
    `${title} ${artist} song`,
    `${title} song`,
    albumName ? `"${title}" "${albumName}"` : null,
  ].filter(Boolean);
}

async function fetchJson(url, userAgent, delayMs) {
  function getRetryAfterMs(response) {
    const retryAfter = response.headers.get("retry-after");
    if (!retryAfter) return null;

    const asSeconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.max(0, Math.round(asSeconds * 1000));
    }

    const asDate = Date.parse(retryAfter);
    if (Number.isNaN(asDate)) return null;
    return Math.max(0, asDate - Date.now());
  }

  for (let attempt = 1; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    await waitForRequestWindow(delayMs);

    const response = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
      },
    });

    if (response.ok) {
      return response.json();
    }

    const isRateLimited = response.status === 429;
    const isTransientServerError = response.status >= 500 && response.status < 600;
    const canRetry = attempt < MAX_HTTP_RETRIES && (isRateLimited || isTransientServerError);

    if (!canRetry) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const retryAfterMs = getRetryAfterMs(response);
    const baseBackoff = Math.max(delayMs, 1000) * attempt;
    const waitMs = retryAfterMs ?? baseBackoff;
    await sleep(waitMs);
  }

  throw new Error(`HTTP request failed after retries for ${url}`);
}

async function wikipediaSearch(query, userAgent, delayMs) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrlimit", "6");
  url.searchParams.set("prop", "extracts|info|pageprops");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("inprop", "url");
  url.searchParams.set("redirects", "1");

  const payload = await fetchJson(url.toString(), userAgent, delayMs);
  const pages = Object.values(payload.query?.pages ?? {});
  return pages.filter((page) => page.extract && page.fullurl);
}

function candidateScore(candidate, song) {
  const titleNorm = normalizeText(song.song);
  const artistNorm = normalizeText(song.artist);
  const pageTitleNorm = normalizeText(candidate.title);
  const extractNorm = normalizeText(candidate.extract);
  const combined = `${pageTitleNorm} ${extractNorm}`;

  let score = 0;
  const notes = [];

  if (pageTitleNorm.includes(titleNorm)) {
    score += 4;
    notes.push("page title contains song title");
  }

  if (combined.includes(artistNorm)) {
    score += 4;
    notes.push("page/extract contains artist");
  }

  if (combined.includes(" song")) {
    score += 2;
    notes.push("page/extract indicates song context");
  }

  if (/\bsingle\b|\breleased\b|\brecorded\b|\balbum\b|\bwritten\b|\bproduced\b|\bchart\b|\bgrammy\b/i.test(candidate.extract)) {
    score += 2;
    notes.push("extract contains music-history terms");
  }

  if (candidate.pageprops?.disambiguation !== undefined || /\bdisambiguation\b/i.test(candidate.title)) {
    score -= 8;
    notes.push("candidate appears to be disambiguation");
  }

  if (!pageTitleNorm.includes(titleNorm) && !extractNorm.includes(titleNorm)) {
    score -= 3;
    notes.push("candidate weakly matches title");
  }

  return { score, notes };
}

async function findBestWikipediaCandidate(song, userAgent, delayMs) {
  const queries = buildSearchQueries(song);
  const candidates = [];
  const queryErrors = [];

  for (const query of queries) {
    let pages = [];
    try {
      pages = await wikipediaSearch(query, userAgent, delayMs);
    } catch (error) {
      queryErrors.push(`${query}: ${String(error?.message ?? error)}`);
      continue;
    }

    for (const page of pages) {
      const scored = candidateScore(page, song);
      candidates.push({
        ...page,
        query,
        score: scored.score,
        scoreNotes: scored.notes,
      });
    }
  }

  if (candidates.length === 0 && queryErrors.length > 0) {
    throw new Error(queryErrors[0]);
  }

  candidates.sort((a, b) => b.score - a.score);

  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (seen.has(candidate.pageid)) continue;
    seen.add(candidate.pageid);
    unique.push(candidate);
  }

  return unique[0] ?? null;
}

function extractFacts(candidate, song) {
  if (!candidate) return [];

  const titleNorm = normalizeText(song.song);
  const artistNorm = normalizeText(song.artist);
  const sentences = uniqueSentences(sentenceSplit(candidate.extract));

  const weighted = sentences
    .map((sentence, index) => {
      const norm = normalizeText(sentence);
      let score = 0;

      if (norm.includes(titleNorm)) score += 3;
      if (norm.includes(artistNorm)) score += 3;
      if (/\breleased\b|\bsingle\b|\balbum\b|\bwritten\b|\bproduced\b|\brecorded\b|\bchart\b|\bgrammy\b|\bnumber one\b|\bcertified\b/i.test(sentence)) {
        score += 2;
      }

      // Keep earlier summary sentences slightly preferred.
      score += Math.max(0, 2 - index * 0.25);

      return { sentence, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return weighted.slice(0, 3).map((item) => item.sentence);
}

function ensureSongFacts(song) {
  if (!song.songFacts || typeof song.songFacts !== "object") {
    song.songFacts = {
      status: "pending",
      targetFactCount: 3,
      sentenceRule: "Each fact should be exactly one sentence.",
      facts: [],
      source: null,
      review: {
        needsReview: true,
        notes: [],
      },
    };
  }

  if (!Array.isArray(song.songFacts.facts)) song.songFacts.facts = [];
  if (!song.songFacts.review) song.songFacts.review = { needsReview: true, notes: [] };
}

function shouldProcessSong(song, args) {
  ensureSongFacts(song);

  if (args.overwrite) return true;
  return song.songFacts.facts.length < 3;
}

function getAllSongRefs(data, args) {
  const refs = [];

  for (const era of data.eras ?? []) {
    if (args.onlyEra && era.era !== args.onlyEra) continue;

    for (const genre of era.genres ?? []) {
      if (args.onlyGenre && genre.genre !== args.onlyGenre) continue;

      for (const song of genre.songs ?? []) {
        refs.push({ era: era.era, genre: genre.genre, song });
      }
    }
  }

  return refs;
}

async function writeOutput(path, data, dryRun) {
  if (dryRun) return;
  await fs.writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = await fs.readFile(args.inputPath, "utf8");
  const data = JSON.parse(raw);

  data.metadata = data.metadata ?? {};
  data.metadata.songFactEnrichment = {
    ...(data.metadata.songFactEnrichment ?? {}),
    generatedAt: new Date().toISOString(),
    source: "Wikipedia via MediaWiki API",
    warning:
      "Automated matching can be wrong. Review needs_review entries before publishing.",
  };

  const refs = getAllSongRefs(data, args).filter(({ song }) => shouldProcessSong(song, args));
  const selected = refs.slice(args.offset, args.offset + args.limit);

  const stats = {
    candidates: refs.length,
    selected: selected.length,
    enriched: 0,
    needsReview: 0,
    notFound: 0,
    errors: 0,
  };

  for (let i = 0; i < selected.length; i += 1) {
    const { era, genre, song } = selected[i];
    ensureSongFacts(song);

    const label = `${i + 1}/${selected.length} ${era} | ${genre} | ${song.artist} - ${song.song}`;
    console.log(label);

    try {
      const candidate = await findBestWikipediaCandidate(song, args.userAgent, args.delayMs);
      const facts = extractFacts(candidate, song);

      if (!candidate) {
        song.songFacts.status = "not_found";
        song.songFacts.facts = [];
        song.songFacts.source = null;
        song.songFacts.review = {
          needsReview: true,
          notes: ["No Wikipedia candidate found."],
        };
        stats.notFound += 1;
      } else {
        const confidence = Math.max(0, Math.min(1, candidate.score / 12));
        song.songFacts.status = facts.length === 3 && confidence >= 0.65 ? "enriched" : "needs_review";
        song.songFacts.facts = facts.map((fact, index) => ({
          factNumber: index + 1,
          text: fact,
          sentenceCount: 1,
          sourceName: "Wikipedia",
          sourceUrl: candidate.fullurl,
        }));
        song.songFacts.source = {
          name: "Wikipedia",
          pageTitle: candidate.title,
          pageUrl: candidate.fullurl,
          query: candidate.query,
          confidence,
          score: candidate.score,
          scoreNotes: candidate.scoreNotes,
          fetchedAt: new Date().toISOString(),
        };
        song.songFacts.review = {
          needsReview: song.songFacts.status !== "enriched",
          notes:
            song.songFacts.status === "enriched"
              ? []
              : ["Review this match before publishing.", "Fewer than 3 strong facts or lower confidence match."],
        };

        if (song.songFacts.status === "enriched") stats.enriched += 1;
        else stats.needsReview += 1;
      }
    } catch (error) {
      song.songFacts.status = "error";
      song.songFacts.review = {
        needsReview: true,
        notes: [String(error?.message ?? error)],
      };
      stats.errors += 1;
    }

    if ((i + 1) % args.saveEvery === 0) {
      await writeOutput(args.outputPath, data, args.dryRun);
      console.log(`Saved checkpoint to ${args.outputPath}`);
    }
  }

  data.metadata.songFactEnrichment.summary = {
    ...stats,
    completedAt: new Date().toISOString(),
  };

  await writeOutput(args.outputPath, data, args.dryRun);
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
