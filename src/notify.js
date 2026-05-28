import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const READER_PREFIX = "https://r.jina.ai/http://r.jina.ai/http://";
const DEFAULT_SOURCE_URL = `${READER_PREFIX}https://defillama.com/research`;
const DEFAULT_STATE_PATH = ".data/seen.json";
const DISCORD_EMBED_LIMIT = 10;
const DETAIL_PREFETCH_LIMIT = 15;

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

  const detailCandidates =
    config.forceLatest > 0 ? candidates.slice(0, config.maxArticles) : candidates.slice(0, DETAIL_PREFETCH_LIMIT);
  const detailedArticles = await Promise.all(
    detailCandidates.map(async (article) => ({ ...article, ...(await fetchArticleDetail(article)) })),
  );

  let selected = detailedArticles;
  if (config.forceLatest === 0 && state.updatedAt) {
    const stateUpdatedAt = Date.parse(state.updatedAt) || 0;
    if (stateUpdatedAt > 0) {
      selected = selected.filter((article) => {
        const publishedAt = Date.parse(article.publishedAt) || 0;
        return publishedAt === 0 || publishedAt > stateUpdatedAt - 60 * 60 * 1000;
      });
    }
  }

  selected = sortArticles(selected).slice(0, config.maxArticles);

  if (selected.length === 0) {
    console.log("No new research articles found.");
    if (!config.dryRun) {
      await writeState(config.statePath, articles);
    }
    return;
  }

  for (const article of selected) {
    article.summary = await summarizeJapanese(article);
  }

  await sendDiscord(selected);

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
  const defillamaArticles = extractDefillamaArticles(readable);
  if (defillamaArticles.length > 0) {
    return defillamaArticles;
  }

  return extractDlnewsArticles(readable);
}

function extractDefillamaArticles(readable) {
  const latestStart = readable.indexOf("Latest from DefiLlama Research");
  const scopedReadable = latestStart === -1 ? readable : readable.slice(latestStart);
  const urlPattern =
    /https?:\/\/(?:www\.)?defillama\.com\/research\/(?:report|spotlight|interview|opinion|roundtables)\/[a-z0-9-]+\/?/gi;
  const bySlug = new Map();
  let match;

  while ((match = urlPattern.exec(scopedReadable)) !== null) {
    const url = canonicalizeUrl(match[0]);
    const slug = extractSlug(url);
    if (!slug || bySlug.has(slug)) continue;

    const nearby = scopedReadable.slice(Math.max(0, match.index - 700), match.index + 200);
    bySlug.set(slug, {
      index: bySlug.size,
      slug,
      title: extractDefillamaTitle(nearby, slug),
      url,
      publishedAt: extractReadableDate(nearby),
    });
  }

  return [...bySlug.values()];
}

function extractDefillamaTitle(text, slug) {
  const linkStart = Math.max(text.lastIndexOf("[!["), text.lastIndexOf("["));
  const rawLabel = linkStart === -1 ? "" : text.slice(linkStart + 1);
  const title = cleanMarkdownLabel(rawLabel);
  return title || titleFromSlug(slug);
}

function cleanMarkdownLabel(label) {
  const withoutImages = label
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\]\([^)]+\)/g, " ")
    .replace(/Image\s+\d+:\s*/gi, " ")
    .replace(/\b(?:INTERVIEW|SPOTLIGHT|ROUNDTABLES|REPORT|OPINION)\b/g, " ")
    .replace(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\b/gi, " ");
  const title = cleanText(withoutImages);
  if (title.length < 8 || title.startsWith("http")) return "";
  return title;
}

function extractReadableDate(text) {
  const matches = [...text.matchAll(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\b/gi)];
  return matches.length > 0 ? matches.at(-1)[0] : "";
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .map((part) => {
      if (/^(ai|ceo|dex|rwa|rwafi|zk|fhe|mpc|btcfi|tvl|l1|l2)$/i.test(part)) {
        return part.toUpperCase();
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function extractDlnewsArticles(readable) {
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
  const html = await fetchText(article.url.includes("defillama.com") ? readerUrl(article.url) : article.url);
  const readerDetail = extractReaderArticleDetail(html, article);
  if (readerDetail.text) {
    return readerDetail;
  }

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
    publishedAt: article.publishedAt,
    text: paragraphs.join("\n\n"),
  };
}

function extractReaderArticleDetail(text, article) {
  if (!text.includes("Markdown Content:")) {
    return { title: article.title, imageUrl: "", publishedAt: article.publishedAt, text: "" };
  }

  const markdown = text.slice(text.indexOf("Markdown Content:") + "Markdown Content:".length);
  return {
    title: cleanText(extractFirst(text, /^Title:\s*(.+)$/m) || article.title),
    imageUrl: extractFirst(markdown, /!\[[^\]]*]\((https?:\/\/[^)]+)\)/) || "",
    publishedAt: extractFirst(text, /^Published Time:\s*(.+)$/m) || article.publishedAt,
    text: markdownToPlainText(markdown),
  };
}

function markdownToPlainText(markdown) {
  return markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/\*\*/g, "")
    .split(/\n{2,}/)
    .map((paragraph) => cleanText(paragraph))
    .filter(Boolean)
    .join("\n\n");
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
  const sentences = article.text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanText(sentence))
    .filter(Boolean)
    .slice(0, 3);
  const translatedLead = sentences.map(translateCommonResearchSentence).filter(Boolean);
  const detailLines = buildFallbackDetails(article.title, article.text);
  const highlights = extractNumericHighlights(article.text);
  const lines = [
    "概要",
    `- ${buildFallbackTopic(article.title, article.text)}`,
  ];

  for (const line of [...detailLines, ...translatedLead]) {
    if (lines.length >= 5) break;
    pushUniqueSummaryLine(lines, line);
  }

  if (highlights.length > 0) {
    lines.push(`- 本文中の主な数値: ${highlights.slice(0, 4).join(" / ")}`);
  }

  return lines.join("\n");
}

function buildFallbackTopic(title, text) {
  const lowerTitle = title.toLowerCase();
  const lowerText = text.toLowerCase();

  if (lowerTitle.includes("ai discovery layer") || lowerTitle.includes("llms")) {
    return "LLMやAI検索が、暗号資産取引所の発見・比較・信頼形成に与える影響を扱っています。";
  }
  if (lowerTitle.includes("sentora prime") || lowerTitle.includes("vault curation")) {
    return "RWAボールトのキュレーション、リスク管理、機関投資家向け運用基盤の進展を扱っています。";
  }
  if (lowerTitle.includes("parallel universes")) {
    return "暗号資産が既存金融に組み込まれる流れと、独自インフラを作る流れの二極化を論じています。";
  }
  if (lowerTitle.includes("ekiden")) {
    return "Ekidenの創業者インタビューを通じて、オンチェーンデリバティブを機関投資家向けにする条件を掘り下げています。";
  }
  if (lowerTitle.includes("state of rwafi")) {
    return "RWAfiの市場動向、主要カテゴリ、オンチェーン化の進展を整理したレポートです。";
  }
  if (lowerTitle.includes("katana") && lowerTitle.includes("ve")) {
    return "Katanaのve(3,3)型インセンティブ設計を、チェーン全体の流動性配分として解説しています。";
  }
  if (lowerTitle.includes("startale")) {
    return "Startale Groupの統合型Web3インフラ戦略と、規制対応・ステーブルコイン活用を掘り下げたインタビューです。";
  }
  if (lowerTitle.includes("realfi")) {
    return "RealFi実現に必要なコンプライアンス、流動性、機関投資家向けインフラを議論しています。";
  }
  if (lowerTitle.includes("pharos")) {
    return "Pharosのメインネット立ち上げと、RWA市場での流動性・配布インフラの狙いを扱っています。";
  }
  if (lowerTitle.includes("launches") || lowerTitle.includes("mainnet")) {
    return "新しいメインネットやプロダクト立ち上げの狙い、資金調達、エコシステム展開を扱っています。";
  }
  if (lowerTitle.includes("ceo on") || lowerTitle.includes("founder on")) {
    return "プロジェクト関係者へのインタビューを通じて、事業戦略と市場課題を掘り下げています。";
  }
  if (lowerText.includes("tokenized") || lowerText.includes("tokenisation") || lowerText.includes("tokenization")) {
    return "資産のトークン化とオンチェーン金融インフラの進展を扱っています。";
  }
  if (lowerText.includes("stablecoin")) {
    return "ステーブルコインを中心に、DeFiと金融インフラへの影響を整理しています。";
  }
  if (lowerText.includes("liquidity")) {
    return "流動性の配分、インセンティブ、プロトコル設計の変化を解説しています。";
  }

  return `${title} に関するDefiLlama Researchの新着記事です。`;
}

function buildFallbackDetails(title, text) {
  const lowerTitle = title.toLowerCase();
  const lowerText = text.toLowerCase();

  if (lowerTitle.includes("ai discovery layer") || lowerTitle.includes("llms")) {
    return [
      "従来のSEOだけでなく、AI回答の中でどの取引所名が提示されるかが重要になりつつあります。",
      "手数料、流動性、規制対応、ブランド信頼などが、AIによる比較・推薦の材料になる点を整理しています。",
    ];
  }
  if (lowerTitle.includes("sentora prime") || lowerTitle.includes("vault curation")) {
    return [
      "RWAボールトでは利回りだけでなく、担保、流動性、リスク開示、運用者の選別が重要になります。",
      "Sentora PRIMEを例に、オンチェーン資産運用をより制度金融に近い形へ寄せる動きを見ています。",
    ];
  }
  if (lowerTitle.includes("parallel universes")) {
    return [
      "一方ではステーブルコインや決済網が既存金融の裏側に組み込まれ、実用性が前面に出ています。",
      "もう一方ではプライバシー、暗号計算、分散ストレージ、AIエージェントなど新しい基盤作りが進んでいます。",
    ];
  }
  if (lowerTitle.includes("ekiden")) {
    return [
      "オンチェーンデリバティブを機関投資家が使うには、清算、リスク管理、流動性、コンプライアンスの整備が鍵になります。",
      "プロダクトの使いやすさだけでなく、既存金融の運用基準に耐える市場構造が論点になっています。",
    ];
  }
  if (lowerText.includes("stablecoin")) {
    return [
      "ステーブルコインが決済、送金、金融機関のバックエンドでどう使われるかが中心テーマです。",
    ];
  }
  if (lowerText.includes("tokenized") || lowerText.includes("tokenisation") || lowerText.includes("tokenization")) {
    return [
      "伝統的な資産をオンチェーン化する際の流動性、コンプライアンス、投資家アクセスが主な論点です。",
    ];
  }
  if (lowerText.includes("privacy") || lowerText.includes("encrypted") || lowerText.includes("confidential")) {
    return [
      "透明性だけでは扱いづらい金融データや個人情報を、暗号技術でどう保護するかを扱っています。",
    ];
  }
  if (lowerText.includes("institutional")) {
    return [
      "機関投資家が利用するうえで必要な運用体制、規制対応、リスク管理の不足や改善点を整理しています。",
    ];
  }
  if (lowerText.includes("liquidity")) {
    return [
      "流動性をどこに集め、どのようなインセンティブで維持するかがプロトコル設計上の焦点です。",
    ];
  }

  return [];
}

function pushUniqueSummaryLine(lines, line) {
  if (!line) return;
  const bullet = `- ${line}`;
  if (lines.includes(bullet)) return;
  lines.push(bullet);
}

function translateCommonResearchSentence(sentence) {
  const normalized = sentence.replace(/\s+/g, " ").trim();
  const exactTranslations = [
    [
      /^Tokenisation is expanding rapidly across financial markets\.$/i,
      "金融市場ではトークン化が急速に広がっています。",
    ],
    [
      /^Tokenization is expanding rapidly across financial markets\.$/i,
      "金融市場ではトークン化が急速に広がっています。",
    ],
    [
      /^From stablecoins to commodities, equities and real estate, an increasing share of assets is moving onchain\.$/i,
      "ステーブルコイン、コモディティ、株式、不動産など、より多くの資産がオンチェーン化しています。",
    ],
    [
      /^Katana is a ve-native, chain-level system that coordinates liquidity and emissions across the network\.$/i,
      "Katanaは、ネットワーク全体の流動性とトークン排出を調整するチェーンレベルのveネイティブ設計です。",
    ],
    [
      /^We recently sat down with Sota Watanabe, CEO of Startale Group.*$/i,
      "Startale Groupの渡辺創太CEOが、グローバル金融向けの統合オンチェーン基盤について語っています。",
    ],
    [
      /^Interviewees: While the industry is eager to attract institutional capital, the underlying infrastructure must catch up first\.$/i,
      "機関投資家の資金を呼び込むには、まず基盤インフラの整備が必要だという議論です。",
    ],
    [
      /^Pharos has launched its Pacific Ocean Mainnet and \$PROS token.*$/i,
      "PharosはPacific Ocean Mainnetと$PROSトークンをローンチし、RWA市場の流動性・配布網の分断解消を狙っています。",
    ],
  ];

  for (const [pattern, translation] of exactTranslations) {
    if (pattern.test(normalized)) return translation;
  }

  return "";
}

function extractNumericHighlights(text) {
  const patterns = [
    /\$?\d+(?:\.\d+)?\s?(?:billion|million|trillion)/gi,
    /\d+(?:\.\d+)?%/g,
    /\$?\d+(?:\.\d+)?[BMKT]\b/g,
    /\d+(?:,\d{3})+(?:\.\d+)?/g,
  ];
  const matches = patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)]
      .filter((match) => isStandaloneNumericHighlight(text, match.index, match[0]))
      .map((match) => match[0]),
  );
  if (matches.length === 0) return [];

  return [...new Set(matches.map((match) => match.trim()))];
}

function isStandaloneNumericHighlight(text, index, value) {
  const previous = index > 0 ? text[index - 1] : "";
  const next = text[index + value.length] || "";
  return !/[A-Za-z0-9]/.test(previous) && !/[A-Za-z0-9]/.test(next);
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
      text: "Source: DefiLlama Research",
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

function sortArticles(articles) {
  return [...articles].sort((a, b) => {
    const aTime = Date.parse(a.publishedAt) || 0;
    const bTime = Date.parse(b.publishedAt) || 0;
    return bTime - aTime || (a.index || 0) - (b.index || 0);
  });
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
  return `${url.replace(/^http:\/\/defillama\.com/i, "https://defillama.com").replace(/\/+$/, "")}/`;
}

function extractSlug(url) {
  return (
    extractFirst(url, /\/research\/(?:report|spotlight|interview|opinion|roundtables)\/([^/?#]+)\/?$/) ||
    extractFirst(url, /\/research\/internal\/([^/]+)\/?$/)
  );
}

function readerUrl(url) {
  return url.startsWith(READER_PREFIX) ? url : `${READER_PREFIX}${url}`;
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
