import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SOURCE_URL = "https://www.dlnews.com/research/";
const DEFAULT_STATE_PATH = ".data/seen.json";
const DISCORD_EMBED_LIMIT = 10;

loadDotEnv();

const args = new Set(process.argv.slice(2));
const forceLatestArg = readArgValue("--force-latest");
const config = {
  sourceUrl: process.env.SOURCE_URL || DEFAULT_SOURCE_URL,
  statePath: process.env.STATE_PATH || DEFAULT_STATE_PATH,
  dryRun: args.has("--dry-run") || process.env.DRY_RUN === "true",
  forceLatest: forceLatestArg ? Number.parseInt(forceLatestArg, 10) : 0,
  maxArticles: Math.min(
    DISCORD_EMBED_LIMIT,
    Number.parseInt(process.env.MAX_ARTICLES_PER_RUN || "5", 10),
  ),
  seedOnFirstRun: process.env.SEED_ON_FIRST_RUN !== "false",
  sendLatestOnFirstRun: process.env.SEND_LATEST_ON_FIRST_RUN === "true",
  requireOpenAi: process.env.REQUIRE_OPENAI === "true",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
};

async function main() {
  const html = await fetchText(config.sourceUrl);
  const articles = extractResearchArticles(html);

  if (articles.length === 0) {
    throw new Error(`No research articles found at ${config.sourceUrl}`);
  }

  const state = await readState(config.statePath);
  let candidates = selectNewArticles(articles, state);

  if (config.forceLatest > 0) {
    candidates = articles.slice(0, config.forceLatest);
  }

  if (!state.exists && config.seedOnFirstRun && !config.sendLatestOnFirstRun && config.forceLatest === 0) {
    if (!config.dryRun) {
      await writeState(config.statePath, articles);
      console.log(`Seeded ${articles.length} existing articles. No Discord message sent.`);
    } else {
      console.log(`Would seed ${articles.length} existing articles. No Discord message sent.`);
    }
    return;
  }

  if (candidates.length === 0) {
    console.log("No new research articles found.");
    return;
  }

  const selected = candidates.slice(0, config.maxArticles);
  const detailedArticles = [];

  for (const article of selected) {
    const detail = await fetchArticleDetail(article);
    const summary = await summarizeJapanese(detail);
    detailedArticles.push({ ...article, ...detail, summary });
  }

  await sendDiscord(detailedArticles);

  if (!config.dryRun) {
    await writeState(config.statePath, articles);
  }
}

function readArgValue(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,ja;q=0.8",
      "user-agent":
        "Mozilla/5.0 (compatible; DeFiLlamaResearchNotifier/1.0; +https://github.com/hiyokko/DeFiLlama-Research)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

function extractResearchArticles(html) {
  const readable = normalizeSerializedHtml(html);
  const urlPattern = /https:\/\/www\.dlnews\.com\/research\/internal\/[a-z0-9-]+\/?/gi;
  const bySlug = new Map();
  let match;

  while ((match = urlPattern.exec(readable)) !== null) {
    const url = canonicalizeUrl(match[0]);
    const slug = extractSlug(url);
    if (!slug || bySlug.has(slug)) continue;

    const nearby = readable.slice(Math.max(0, match.index - 2500), match.index + 6000);
    const after = readable.slice(match.index, match.index + 6000);
    const title =
      pickFirst(after, [
        /"children":"([^"]{8,220})"/,
        /"alt":"([^"]{8,220})"/,
        /"headline":"([^"]{8,220})"/,
      ]) ||
      pickFirst(nearby, [
        /"headline":"([^"]{8,220})"/,
        /<h[12][^>]*>([\s\S]*?)<\/h[12]>/,
      ]);

    const publishedAt =
      pickFirst(nearby, [
        /"dateString":"([^"]+)"/,
        /"display_date":"([^"]+)"/,
        /<time[^>]+dateTime="([^"]+)"/,
      ]) || "";

    if (!title) continue;

    bySlug.set(slug, {
      slug,
      title: cleanText(title),
      url,
      publishedAt,
    });
  }

  return [...bySlug.values()].sort((a, b) => {
    const aTime = Date.parse(a.publishedAt) || 0;
    const bTime = Date.parse(b.publishedAt) || 0;
    return bTime - aTime;
  });
}

async function fetchArticleDetail(article) {
  const html = await fetchText(article.url);
  const title = cleanText(extractFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/) || article.title);
  const paragraphs = [...html.matchAll(/<p[^>]*class="[^"]*cs-article-text-type-element[^"]*"[^>]*>([\s\S]*?)<\/p>/g)]
    .map((match) => cleanText(match[1]))
    .filter((paragraph) => paragraph.length > 0);

  const imageUrl =
    extractFirst(html, /<meta property="og:image" content="([^"]+)"/) ||
    extractFirst(html, /<meta name="twitter:image" content="([^"]+)"/) ||
    "";

  return {
    title,
    imageUrl,
    text: paragraphs.join("\n\n"),
  };
}

async function summarizeJapanese(article) {
  if (!article.text) {
    return "本文を抽出できませんでした。記事リンクから内容を確認してください。";
  }

  if (!config.openAiApiKey) {
    if (config.requireOpenAi) {
      throw new Error("OPENAI_API_KEY is required for Japanese summaries.");
    }

    return fallbackJapaneseSummary(article);
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openAiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.openAiModel,
      input: [
        {
          role: "system",
          content:
            "You summarize English crypto research articles for Japanese Discord readers. Be accurate, concise, and avoid investment advice.",
        },
        {
          role: "user",
          content: [
            "次の記事を日本語で3点以内に要約してください。",
            "各点は80字以内、重要な数値や固有名詞は残してください。",
            "誇張せず、投資助言にしないでください。",
            "",
            `Title: ${article.title}`,
            "",
            article.text.slice(0, 12000),
          ].join("\n"),
        },
      ],
      temperature: 0.2,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`OpenAI API failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  const text = payload.output_text || extractOpenAiText(payload);
  if (!text) {
    throw new Error("OpenAI API returned no summary text.");
  }

  return text.trim();
}

function fallbackJapaneseSummary(article) {
  const lead = article.text
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(" ")
    .slice(0, 700);

  return [
    "OPENAI_API_KEY が未設定のため、日本語要約は簡易抽出です。",
    `主題: ${article.title}`,
    `本文冒頭: ${lead}`,
  ].join("\n");
}

function extractOpenAiText(payload) {
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

async function sendDiscord(articles) {
  const embeds = articles.map((article) => ({
    title: article.title.slice(0, 256),
    url: article.url,
    description: article.summary.slice(0, 3900),
    color: 0x237bff,
    fields: article.publishedAt
      ? [
          {
            name: "Published",
            value: formatDateJst(article.publishedAt),
            inline: true,
          },
        ]
      : [],
    image: article.imageUrl ? { url: article.imageUrl } : undefined,
    footer: {
      text: "Source: DL Research",
    },
  }));

  const payload = {
    username: "DeFiLlama Research",
    content: `DeFiLlama Research 新着記事 ${articles.length}件`,
    embeds,
  };

  if (config.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!config.discordWebhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL is required.");
  }

  const response = await fetch(config.discordWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook failed: HTTP ${response.status} ${text}`);
  }
}

function selectNewArticles(articles, state) {
  const seen = new Set(state.seenSlugs || []);
  return articles.filter((article) => !seen.has(article.slug));
}

async function readState(statePath) {
  try {
    const text = await fs.readFile(statePath, "utf8");
    return { exists: true, ...JSON.parse(text) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, seenSlugs: [] };
    }
    throw error;
  }
}

async function writeState(statePath, articles) {
  const state = {
    updatedAt: new Date().toISOString(),
    seenSlugs: articles.map((article) => article.slug),
  };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function normalizeSerializedHtml(html) {
  return html
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

function cleanText(value) {
  return decodeHtml(String(value).replace(/<script[\s\S]*?<\/script>/gi, " "))
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function canonicalizeUrl(url) {
  return `${url.replace(/\/+$/, "")}/`;
}

function extractSlug(url) {
  return extractFirst(url, /\/research\/internal\/([^/]+)\/?$/);
}

function extractFirst(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : "";
}

function pickFirst(text, patterns) {
  for (const pattern of patterns) {
    const value = extractFirst(text, pattern);
    if (value) return value;
  }
  return "";
}

function formatDateJst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function loadDotEnv() {
  try {
    const text = fsSync.readFileSync(".env", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;

      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ||= value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
