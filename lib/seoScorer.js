const cheerio = require("cheerio");

// Rule-based on-page SEO scorer (same idea as Yoast/RankMath's checklist) -
// no external API/AI call, pure logic, runs instantly on every generate.
// 12 checks, weighted to add up to 100 (see README "SEO" section for the
// recommended breakdown this mirrors).

const CHECKS = [
  { id: "focusKeyword", label: "Focus keyword is set and specific (not too generic)", points: 10,
    recommendation: "Pick a more specific 2-4 word focus keyword instead of a generic term." },
  { id: "seoTitle", label: "SEO title is present and search-friendly (~50-60 characters)", points: 10,
    recommendation: "Rewrite the SEO title to be 50-60 characters and include the focus keyword." },
  { id: "metaDescription", label: "Meta description is present and a good length (~140-160 characters)", points: 10,
    recommendation: "Rewrite the meta description to be 140-160 characters." },
  { id: "slugQuality", label: "URL slug is clean, short, and keyword-focused", points: 10,
    recommendation: "Shorten the slug to a clean, hyphenated, keyword-focused URL." },
  { id: "keywordPlacement", label: "Focus keyword appears naturally in the intro and a subheading", points: 10,
    recommendation: "Work the focus keyword naturally into the first 100-150 words and at least one subheading." },
  { id: "contentLength", label: "Content length matches the article's category target", points: 10,
    recommendation: "Expand the article with genuinely useful context to reach the target word count." },
  { id: "headingStructure", label: "Clean heading structure (one H1, 2+ subheadings, no empty headings)", points: 10,
    recommendation: "Fix the heading structure - exactly one H1, meaningful H2/H3 subheadings, nothing empty." },
  { id: "keywordDensity", label: "Keyword density is in a natural range (~0.5-1.5%)", points: 10,
    recommendation: "Adjust keyword usage - reduce repetition if stuffed, add a mention or two if too sparse." },
  { id: "introduction", label: "Introduction paragraph exists and is substantial", points: 5,
    recommendation: "Add a proper introduction paragraph that frames what the article covers." },
  { id: "conclusion", label: "Conclusion paragraph exists", points: 5,
    recommendation: "Add a closing paragraph that wraps up the article." },
  { id: "imageAlt", label: "Featured image has descriptive alt text", points: 5,
    recommendation: "Write descriptive alt text for the featured image (include the focus keyword)." },
  { id: "readability", label: "Readable sentence/paragraph length", points: 5,
    recommendation: "Break up long sentences/paragraphs for easier reading." },
];

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "is", "are", "was", "were", "by", "as", "it", "this", "that",
]);

// Keywords the AI shouldn't land on - too broad to help any single article rank.
const GENERIC_KEYWORDS = new Set([
  "business", "company", "india", "startup", "news", "market", "industry", "technology",
]);

// Category-based word-count targets (see README/task spec). Falls back to a
// generic 600+ minimum when no category is supplied or it's unrecognized.
const CATEGORY_WORD_TARGETS = {
  news: [700, 900],
  "short news": [600, 800],
  shortnews: [600, 800],
  business: [900, 1200],
  company: [900, 1200],
  startup: [900, 1200],
  founder: [900, 1200],
  analysis: [1200, 1500],
};

function wordTargetForCategory(category) {
  const key = (category || "").toLowerCase().trim();
  return CATEGORY_WORD_TARGETS[key] || [600, null];
}

function countWords(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

function normalize(str) {
  return (str || "").toLowerCase().trim();
}

// Keyword "appears" = every significant word of the keyword phrase shows up
// (handles multi-word keywords without needing an exact-substring match).
function containsKeyword(haystack, keyword) {
  const words = normalize(keyword).split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  if (words.length === 0) return false;
  const h = normalize(haystack);
  return words.every((w) => h.includes(w));
}

function keywordDensity(bodyText, keyword) {
  const words = normalize(keyword).split(/\s+/).filter(Boolean);
  if (words.length === 0 || !bodyText) return 0;
  const text = normalize(bodyText);
  const totalWords = countWords(text) || 1;
  const phrase = words.join(" ");
  const occurrences = text.split(phrase).length - 1;
  return (occurrences / totalWords) * 100;
}

function isGenericKeyword(keyword) {
  const words = normalize(keyword).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length === 1 && GENERIC_KEYWORDS.has(words[0])) return true;
  return false;
}

function statusForScore(score) {
  if (score >= 90) return "EXCELLENT";
  if (score >= 80) return "GOOD";
  if (score >= 60) return "NEEDS_IMPROVEMENT";
  return "POOR";
}

/**
 * @param {Object} article
 * @param {string} article.seoTitle
 * @param {string} article.content - HTML
 * @param {string} article.focusKeyword
 * @param {string} article.metaDescription
 * @param {string} article.slug
 * @param {string} article.imageAlt
 * @param {string} [article.category] - one of the category keys above (optional)
 * @returns {{ score:number, status:string, checks:Array, issues:string[], recommendations:string[], wordCount:number, keywordDensity:number|null }}
 */
function scoreSeo({ seoTitle, content, focusKeyword, metaDescription, slug, imageAlt, category }) {
  const $ = cheerio.load(content || "", null, false);
  const bodyText = $.text();
  const paragraphs = $("p").map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const firstParagraph = paragraphs[0] || bodyText.slice(0, 300);
  const lastParagraph = paragraphs[paragraphs.length - 1] || "";
  const first150 = bodyText.trim().split(/\s+/).slice(0, 150).join(" ");
  const headings = $("h2, h3").map((_, el) => $(el).text().trim()).get();
  const h1Count = $("h1").length;
  const emptyHeadings = $("h1, h2, h3").filter((_, el) => !$(el).text().trim()).length;
  const wordCount = countWords(bodyText);
  const kw = focusKeyword || "";
  const [minWords, maxWords] = wordTargetForCategory(category);

  const sentences = bodyText.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const avgSentenceLen = sentences.length ? wordCount / sentences.length : 0;
  const longParagraphs = paragraphs.filter((p) => countWords(p) > 150).length;

  const density = kw ? Number(keywordDensity(bodyText, kw).toFixed(2)) : null;

  const results = {
    focusKeyword: !!kw && !isGenericKeyword(kw),
    seoTitle: !!seoTitle && seoTitle.length >= 45 && seoTitle.length <= 65 && (!kw || containsKeyword(seoTitle, kw)),
    metaDescription: !!metaDescription && metaDescription.length >= 130 && metaDescription.length <= 165 && (!kw || containsKeyword(metaDescription, kw)),
    slugQuality: !!slug && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 60,
    keywordPlacement: !!kw && containsKeyword(first150, kw) && headings.some((h) => containsKeyword(h, kw)),
    contentLength: wordCount >= minWords && (maxWords ? wordCount <= maxWords + 200 : true),
    headingStructure: h1Count <= 1 && headings.length >= 2 && emptyHeadings === 0,
    keywordDensity: !kw ? false : (density >= 0.3 && density <= 2.0),
    introduction: !!firstParagraph && countWords(firstParagraph) >= 30,
    conclusion: paragraphs.length >= 2 && !!lastParagraph && countWords(lastParagraph) >= 20,
    imageAlt: !!imageAlt && imageAlt.trim().split(/\s+/).filter(Boolean).length >= 4,
    readability: avgSentenceLen <= 28 && longParagraphs === 0,
  };

  const checks = CHECKS.map((c) => ({ ...c, passed: !!results[c.id] }));
  const score = checks.reduce((sum, c) => sum + (c.passed ? c.points : 0), 0);
  const failed = checks.filter((c) => !c.passed);

  return {
    score,
    status: statusForScore(score),
    checks,
    issues: failed.map((c) => c.label),
    recommendations: failed.map((c) => c.recommendation),
    wordCount,
    keywordDensity: density,
  };
}

module.exports = { scoreSeo, statusForScore, wordTargetForCategory, containsKeyword, keywordDensity };
