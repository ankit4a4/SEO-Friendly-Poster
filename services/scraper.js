const axios = require("axios");
const cheerio = require("cheerio");
const { abs, isUrl } = require("../lib/urlUtils");
const { getRegion } = require("../lib/regions");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const headers = { "User-Agent": USER_AGENT };

// If the static HTML has fewer words than this, the page is probably rendered
// client-side (React/Next.js/Vue/etc) and we need a real browser to see the content.
const MIN_WORDS_FOR_STATIC_CONTENT = 40;

function textWordCount(html) {
  const text = cheerio.load(html || "", null, false).text();
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Headless browser (Playwright) - used as a fallback for JS-rendered sites.
// The browser instance is reused across calls instead of relaunching it every
// time, since launching Chromium is the expensive part.
// ---------------------------------------------------------------------------

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require("playwright");
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    // If Chromium crashes/gets OOM-killed, browserPromise would otherwise stay
    // pointed at a dead browser forever - reset it so the next call launches fresh.
    browserPromise.then((browser) => {
      browser.on("disconnected", () => {
        browserPromise = null;
      });
    });
  }
  return browserPromise;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

async function getRenderedHtml(url) {
  return withPage(async (page) => {
    // "domcontentloaded" is fast and reliable. "networkidle" was used here
    // before, but modern sites (with ads/analytics/chat-widgets/websockets
    // running continuously in the background - e.g. asia.nikkei.com) NEVER
    // go network-"idle", so it would time out completely even though the
    // page had actually finished loading.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Best-effort: wait a bit more for lazy-loaded/JS-rendered content to
    // settle. If the site truly never goes idle, proceed anyway -
    // domcontentloaded has already been achieved, and that's good enough.
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // Ignore - there's persistent background network activity, that's fine
    }

    await page.waitForTimeout(1000);
    return page.content();
  });
}

// Call this on server shutdown so the Chromium process doesn't linger.
async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    browserPromise = null;
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Fast path - plain HTTP request, no browser. Works for any server-rendered
// page (WordPress, plain HTML/PHP, static-generated Next.js pages, etc).
// ---------------------------------------------------------------------------

async function getStaticHtml(url) {
  const { data } = await axios.get(url, { headers, timeout: 15000 });
  return typeof data === "string" ? data : String(data);
}

// Pulls post links out of a listing/category page. Tries the common article-link
// patterns first, then falls back to any long-text link if nothing matched.
function extractPostLinks($, pageUrl, limit) {
  const origin = new URL(pageUrl).origin;
  const seen = new Map();

  const collect = (selector, getTitle) => {
    $(selector).each((_, el) => {
      const href = $(el).attr("href");
      const u = href ? abs(href, pageUrl) : null;
      if (!u || !u.startsWith(origin) || seen.has(u)) return;
      const title = getTitle($, el);
      if (title && title.length > 12) seen.set(u, title);
    });
  };

  // Tier 1: common article-link patterns
  collect("article a, h1 a, h2 a, h3 a, a:has(h1), a:has(h2), a:has(h3)", ($, el) =>
    $(el).find("h1,h2,h3").first().text().trim() || $(el).text().trim()
  );

  // Tier 2: fallback - any link with reasonably long text (news/blog listing style)
  if (seen.size === 0) {
    collect("main a, body a", ($, el) => $(el).text().trim());
  }

  return Array.from(seen, ([link, title]) => ({ link, title })).slice(0, limit);
}

// Pulls title/content/image out of an article page.
function extractArticle($, pageUrl) {
  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("h1").first().text().trim() ||
    $("title").text().trim();
  const image = $('meta[property="og:image"]').attr("content") || null;

  let content;
  if ($("article").length) {
    content = $("article").html();
  } else {
    let best = null,
      max = 0;
    $("div, section, main").each((_, el) => {
      const n = $(el).find("> p").length;
      if (n > max) {
        max = n;
        best = el;
      }
    });
    content = best ? $(best).html() : $("body").html();
  }
  return { title, content, image };
}

// ---------------------------------------------------------------------------
// Universal scraper: static fetch first (fast, cheap), falls back to a
// headless browser only when the static HTML doesn't have what we need.
// This is what lets a single "category page URL" field work regardless of
// whether the source site is WordPress, plain PHP, React, Next.js, or Vue.
// ---------------------------------------------------------------------------

async function getUniversalPosts(categoryUrl, limit = 6) {
  let html = await getStaticHtml(categoryUrl);
  let $ = cheerio.load(html);
  let links = extractPostLinks($, categoryUrl, limit);

  if (links.length === 0) {
    html = await getRenderedHtml(categoryUrl);
    $ = cheerio.load(html);
    links = extractPostLinks($, categoryUrl, limit);
  }
  return links;
}

async function getUniversalArticle(link) {
  let html = await getStaticHtml(link);
  let $ = cheerio.load(html);
  let article = extractArticle($, link);

  if (textWordCount(article.content) < MIN_WORDS_FOR_STATIC_CONTENT) {
    html = await getRenderedHtml(link);
    $ = cheerio.load(html);
    article = extractArticle($, link);
  }
  return article;
}

// ---------------------------------------------------------------------------
// RSS/Atom feeds - detected by content, not URL pattern, and used when
// available since they're the most reliable source of clean content.
// ---------------------------------------------------------------------------

async function isLikelyRss(url) {
  try {
    const html = await getStaticHtml(url);
    return /<rss|<feed|<\?xml/i.test(html.slice(0, 500));
  } catch {
    return false;
  }
}

// Google News (and similar aggregator) feeds append " - Publisher Name" to every
// title, using the exact text they also put in a separate <source> tag. Strip it
// using that tag rather than a generic "trailing dash" regex - some publisher
// names contain their own dash (e.g. "Prestige Online - Singapore"), so guessing
// where the headline ends and the publisher name begins from the title alone
// would cut real headlines short.
function stripFeedSourceSuffix(title, source) {
  if (!source || !title.endsWith(source)) return title;
  return title.slice(0, title.length - source.length).replace(/[\s\-–—]+$/, "").trim();
}

async function getRssPosts(feedUrl, limit = 6) {
  const xml = await getStaticHtml(feedUrl);
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];

  $("item, entry").each((_, el) => {
    if (items.length >= limit) return;
    const $el = $(el);
    const source = $el.find("source").first().text().trim();
    const title = stripFeedSourceSuffix($el.find("title").first().text().trim(), source);
    const link = $el.find("link").first().attr("href") || $el.find("link").first().text().trim();
    let content =
      $el.find("content\\:encoded").first().text() ||
      $el.find("content").first().text() ||
      $el.find("description").first().text() ||
      $el.find("summary").first().text();

    // Aggregator feeds (Google News etc.) don't put the actual article in
    // <description> - it's just a link back to the aggregator wrapped around the
    // headline, plus the publisher name. That's not real content, and letting it
    // through means the "publisher name" text can leak into what gets sent to
    // the AI. If the description is basically just the title again, drop it so
    // the rewrite prompt falls back to writing a full article from the headline
    // alone (see the wordCount < 100 branch in services/ai.js) instead of
    // treating this junk blurb as "real" source content.
    if (textWordCount(content) <= textWordCount(title) + 5) content = "";

    if (title && link) items.push({ id: link, title, content: content || `<p>${title}</p>`, link });
  });

  return items;
}

// ---------------------------------------------------------------------------
// Topic phrases (instead of a URL) - "founder stories", "AI articles",
// "Middle East news", "cover story of a brand" etc. Lets the source field
// just describe what's wanted instead of requiring a hand-picked feed URL;
// this is converted into a Google News search feed for that topic.
// ---------------------------------------------------------------------------

// "Cover story"/"exclusive"/"interview" style topics only make sense if that
// label is genuinely in the headline - a plain keyword search would also
// match ordinary articles that merely mention the phrase in passing. Forcing
// it into the headline via intitle: is what keeps results to genuine
// cover-story pieces (see the earlier manual query this replaces).
const SECTION_LABEL_RE = /\bcover stor(?:y|ies)\b|\bexclusive\b|\binterview\b/i;

function topicToGoogleNewsUrl(topic, regionCode) {
  const t = topic.trim();
  const label = t.match(SECTION_LABEL_RE);
  const rest = label ? t.replace(SECTION_LABEL_RE, "").trim() : "";
  const q = label ? `intitle:"${toTitleCase(label[0])}" ${rest}`.trim() : t;

  const { hl, gl, ceid } = getRegion(regionCode);
  const params = new URLSearchParams({ q });
  if (hl) params.set("hl", hl);
  if (gl) params.set("gl", gl);
  if (ceid) params.set("ceid", ceid);
  return `https://news.google.com/rss/search?${params.toString()}`;
}

function toTitleCase(s) {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// Resolves whatever's in a site's source field to an actual fetchable URL -
// passes real URLs through untouched, converts a plain topic phrase into a
// Google News search feed for that topic, using the region picked in the UI.
function resolveSourceUrl(site) {
  return isUrl(site.sourceCategoryUrl)
    ? site.sourceCategoryUrl
    : topicToGoogleNewsUrl(site.sourceCategoryUrl, site.sourceRegion);
}

// How many links/items to pull from one listing page or feed per check. Category/listing
// pages and RSS feeds only expose a limited number of items on a single load anyway (no
// pagination here), so this is really "grab everything visible", not "just the newest few" -
// set high enough that a normal listing page/feed won't ever get truncated by this number.
const SOURCE_FETCH_LIMIT = 50;

// ---------------------------------------------------------------------------
// Entry point used by server.js and routes/posts.js
// ---------------------------------------------------------------------------

// Fetches posts for a site's source category URL (or topic phrase - see resolveSourceUrl
// above). Auto-detects RSS feeds; otherwise scrapes the listing page using the universal
// scraper, which works no matter what framework the source site is built with.
//
// This pulls in every post currently visible on that listing page/feed - not just the
// newest ones - and then relies entirely on `doneIds` to filter out what's already in our
// DB. So on the first check, older posts already sitting on the source's listing page come
// in right alongside the latest ones; from then on, each new check picks up whatever's new
// on the page while skipping everything already fetched.
//
// `doneIds` (optional Set of sourcePostId/link strings already saved in our DB)
// lets the listing links we already know about skip the expensive per-article
// fetch entirely (which can trigger the headless-browser fallback) - this
// matters because "Check for new posts" re-scrapes the whole listing page
// every time, and without this, already-fetched posts got re-downloaded for
// nothing on every single check.
// `maxToFetch` (optional) caps how many of the NEW links actually get their full
// article content fetched this call. Without this, a site with e.g. 40 new links
// but a daily limit of 4 would still fetch all 40 full articles before generating
// even one post - each one potentially taking 30-50s if it needs the headless-
// browser fallback, so the auto-poster could sit "checking" for 20-30+ minutes
// with nothing published and no error shown. Callers pass roughly "how many do I
// actually need this pass" here (see server.js) instead of always fetching everything.
async function fetchSourcePosts(site, doneIds, maxToFetch = SOURCE_FETCH_LIMIT) {
  const sourceUrl = resolveSourceUrl(site);

  if (await isLikelyRss(sourceUrl)) {
    const items = await getRssPosts(sourceUrl, SOURCE_FETCH_LIMIT);
    const filtered = doneIds ? items.filter((i) => !doneIds.has(i.id)) : items;
    return filtered.slice(0, maxToFetch);
  }

  const links = await getUniversalPosts(sourceUrl, SOURCE_FETCH_LIMIT);
  const newLinks = (doneIds ? links.filter((l) => !doneIds.has(l.link)) : links).slice(0, maxToFetch);
  const posts = [];
  for (const l of newLinks) {
    const a = await getUniversalArticle(l.link);
    posts.push({ id: l.link, title: a.title || l.title, content: a.content, link: l.link, image: a.image });
  }
  return posts;
}

module.exports = { fetchSourcePosts, isLikelyRss, closeBrowser, topicToGoogleNewsUrl };