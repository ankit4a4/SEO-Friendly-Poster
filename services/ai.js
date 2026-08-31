const axios = require("axios");
const cheerio = require("cheerio");
const { scoreSeo, containsKeyword } = require("../lib/seoScorer");
const Post = require("../models/Post");

// Score an article must reach (post auto-fix) to be auto-published. Below this,
// the post is saved as "seo_review_required" instead (see routes/posts.js, server.js).
const SEO_PASS_SCORE = Number(process.env.SEO_PASS_SCORE) || 80;

// Category-based word-count targets used in the prompt itself (kept in sync with
// the same table in lib/seoScorer.js). The AI picks whichever category best fits
// the source article - this is not a new dashboard feature, just a prompt/scoring
// input, so it's stored on the post as a plain string (see models/Post.js: articleCategory).
const CATEGORY_GUIDE = `
- "News": 1200-1500 words
- "Short News": 1200-1400 words (use only for a brief update/announcement with little to expand on - still needs real depth, not a stub)
- "Business": 1200-1600 words
- "Startup": 1200-1600 words (founder stories, funding, company building)
- "Analysis": 1500-1800 words (deeper explainer/opinion pieces)
Every category has a 1200-word FLOOR - never go below that, even for a "Short News" item, by adding genuinely useful context/background rather than filler.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many times a single provider is retried on a transient error (429 / 5xx / network blip).
// Kept at 1 (no retry) by default - on a free-tier provider a 429/5xx rarely clears within
// seconds anyway, so retrying just burns time; failing straight to the NEXT provider is faster.
const RETRIES_PER_PROVIDER = Number(process.env.AI_RETRIES_PER_PROVIDER) || 1;
// Base wait before a retry (grows each retry). Only matters if RETRIES_PER_PROVIDER > 1.
const RETRY_BASE_DELAY_MS = Number(process.env.AI_RETRY_BASE_DELAY_MS) || 3 * 1000;
// If EVERY provider fails in a round, how many extra full rounds to try before finally giving up.
// Kept at 1 (no extra rounds) - if all 3 providers just failed, immediately looping back through
// the same 3 providers rarely helps and was the single biggest source of the 15-20+ minute waits.
const FULL_ROUNDS = Number(process.env.AI_FULL_ROUNDS) || 1;
// Wait between full rounds (only relevant if FULL_ROUNDS > 1).
const ROUND_DELAY_MS = Number(process.env.AI_ROUND_DELAY_MS) || 5 * 1000;
// Cap on how much source text we send in the prompt - very long articles can push a provider
// over its context/token limit, which comes back as a 400. Plenty of room for a full article.
const MAX_CONTENT_CHARS = Number(process.env.AI_MAX_CONTENT_CHARS) || 12000;
// If a provider takes longer than this to respond, give up on it and move to the NEXT
// AI immediately. With 3 providers (and Gemini trying up to 3 keys) this bounds the
// absolute worst case - keep it low so "Generate" finishes quickly, but not so low that
// normal network latency causes false failures.
const PROVIDER_TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS) || 25 * 1000;

function cleanContent(html) {
  let raw = html || "";
  // Strip leftover Markdown syntax the model sometimes mixes into HTML output
  // (bold/italic markers, heading hashes, code fences) before parsing as HTML.
  raw = raw.replace(/```[a-z]*\n?/gi, "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "");

  const $ = cheerio.load(raw, null, false);
  $("a").each((_, el) => $(el).replaceWith($(el).text())); // links hatao, text rakh lo
  $("img, figure, picture").remove(); // strip the source's images - we don't have the rights to them
  $("script, style").remove(); // never allow scripts/styles into WordPress content

  // Only one H1 allowed - the article's own title covers that slot in WordPress,
  // so any H1 inside the body is demoted to H2 rather than dropped (keeps the text).
  let seenH1 = false;
  $("h1").each((_, el) => {
    if (!seenH1) { seenH1 = true; return; }
    const $el = $(el);
    $el.replaceWith(`<h2>${$el.html()}</h2>`);
  });

  // Drop empty/whitespace-only headings and paragraphs - leftover formatting
  // artifacts, not real content.
  $("h1, h2, h3, p").each((_, el) => {
    if (!$(el).text().trim()) $(el).remove();
  });

  return $.html().replace(/https?:\/\/[^\s<"']+/g, "");
}

function countWords(html) {
  const text = cheerio.load(html || "", null, false).text();
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Keeps very long source articles from tipping a provider over its token limit (a common 400 cause).
// Cuts on a tag boundary where possible so we don't leave a dangling half-tag in the prompt.
function truncateContent(html) {
  if (!html || html.length <= MAX_CONTENT_CHARS) return html;
  const cut = html.slice(0, MAX_CONTENT_CHARS);
  const lastClose = cut.lastIndexOf(">");
  return (lastClose > MAX_CONTENT_CHARS * 0.8 ? cut.slice(0, lastClose + 1) : cut) + " …";
}

// Turns a title into a clean slug: lowercase, hyphenated, common stopwords
// dropped, capped at ~75 chars (safety net - the AI is asked to produce a
// good slug itself, this is only a fallback/sanitizer).
const SLUG_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "is", "are", "was", "were", "by", "as", "it", "this", "that",
]);
function slugify(str) {
  const words = (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w && !SLUG_STOPWORDS.has(w));
  return words.join("-").slice(0, 75).replace(/-+$/, "");
}

const SEO_JSON_SHAPE =
  '{"title": "...", "content": "...", "category": "...", "focusKeyword": "...", "seoTitle": "...", "metaDescription": "...", "slug": "...", "excerpt": "...", "tags": ["...", "..."], "imageAlt": "...", "keyFacts": {"people": ["..."], "organizations": ["..."], "products": ["..."], "numbers": ["..."], "dates": ["..."]}}';

// Source-fidelity rules: appended to the generation prompt so fact extraction and
// article generation happen in the SAME call (keeps this to one AI call, same as
// before - only the optional entity-correction pass below adds a second call, and
// only when something important was actually dropped).
const SOURCE_FIDELITY_RULES = `
Source fidelity (this is graded too - specific reporting beats generic paraphrase):
- Before writing, identify the specific people (founders, CEOs, executives, investors, other named individuals), organizations/companies, products/services, numbers (revenue, funding, valuation, prices, percentages, counts), and dates/timelines that the source article actually names. Put these in "keyFacts", grouped by category. Only include something that is actually present in the source text below - never invent a person, company, number, date, or event that isn't there. If a category has nothing in the source, return an empty array for it.
- Keep those specific names, companies, products, numbers, and dates in the rewritten article itself wherever they're central to the story. Do NOT replace "Branden Jenkins, CEO of Maxio" with "a tech executive," or "four founders shared lessons" with "several founders shared lessons" - name the founders/companies/figures the source names, don't dissolve them into vague summary.
- If the title claims a specific count (e.g. "4 Founders Share...", "5 Lessons..."), the article body must actually identify/discuss that many, when the source supports it. Never pad with an unsupported extra example to hit the number.
- Do not invent causes, motivations, or explanations the source doesn't state (e.g. don't turn "reported an unexpected cost increase" into a specific invented technical cause). General analysis/context you add is fine, but it must read as analysis, not as an additional reported fact - and never dressed up with unsupported phrases like "industry experts believe..." or "analysts say..." unless the source actually attributes that.
- If the source only gives one founder, don't imply there were several. If the source is incomplete or ambiguous on a point, leave it that way rather than filling the gap with an assumption.`;

const SEO_FIELD_RULES = `
Along with the article, also produce SEO metadata as part of the same JSON object. These are graded by an automated checklist afterwards, so hit every constraint exactly - not "roughly":
- "category": pick the ONE best-fitting category for this article from exactly these options: "News", "Short News", "Business", "Startup", "Analysis". This decides the target word count:${CATEGORY_GUIDE}
- "focusKeyword": the single main keyword/phrase a reader would actually type into Google to find this article (2-4 words, specific to THIS article - never a generic single word like "business", "startup", "India", or "company" unless truly nothing more specific fits).
- "seoTitle": a search-engine title, 50-60 characters (count them), with the focus keyword appearing at or near the start. Can differ from the on-page "title" if needed to hit the length. Avoid clickbait.
- "metaDescription": 140-160 characters (count them), MUST contain the focus keyword, accurately summarizes the article, written to make someone want to click it in Google results. Do NOT just copy the first paragraph.
- "slug": a SHORT, clean, keyword-focused URL slug - lowercase, hyphen-separated, no special characters, no duplicate words, no filler words. Do NOT just slugify the entire headline. E.g. title "Government Announces New Electric Vehicle Subsidy for 2026 Buyers" -> slug "electric-vehicle-subsidy-2026", not the whole title slugified.
- "excerpt": a short 30-50 word summary of the article for use as the WordPress excerpt - must NOT just be a copy of the first paragraph.
- "tags": an array of 3-5 relevant keywords/topics for this article (include the focus keyword and 2-4 closely related terms real readers search for).
- "imageAlt": a short, descriptive alt-text sentence (at least 5 words) for the featured image, MUST include the focus keyword. Do not keyword-stuff it.

Mandatory keyword placement (all of these are checked automatically - none are optional):
1. The focus keyword must appear in "seoTitle".
2. The focus keyword must appear in the article's very first paragraph (within the first 100-150 words).
3. The focus keyword must appear in at least one <h2>/<h3> subheading (not just the body text).
4. The focus keyword must appear in "metaDescription".
5. The focus keyword should also appear naturally in the conclusion where possible.
Work it in naturally each time - never as an awkward forced insertion - but every one of the first four placements is required, not a nice-to-have. Keep overall keyword usage natural (roughly 0.5-1.5% density) - do not repeat it so often it reads as stuffed.`;

const WRITING_QUALITY_RULES = `
Writing quality (this is what actually helps the article rank, not just checklist boxes):
- "title" MUST be a fresh, original headline - do NOT reuse the source's exact wording or copy it verbatim (this is a copyright requirement, not a style preference). Rephrase it in your own words while keeping the same meaning, the same key facts (people/companies/numbers), and roughly the same length/tone as a real news headline.
- Genuinely rewrite, don't paraphrase sentence-by-sentence: understand the source, reorganize the information into your own structure, and use fully original wording. Add relevant context, background, or a "why this matters" angle the source didn't spell out.
- Read like a professional business/news publication: no generic AI-sounding openers ("In today's fast-paced world...", "In this article, we will..."), no repetitive sentence patterns, no filler sentences that say nothing.
- Never invent facts, statistics, quotes, sources, or company information that are not in the source content. If the source doesn't give a number/quote, don't make one up - describe it in general terms instead.
- Naturally work in the focus keyword (per the mandatory placements above) and 2-3 of the related terms from "tags" across the rest of the article too - but only where it reads naturally. Never force or repeat it unnaturally or stuff it in.
- Structure: exactly ONE <h1> title, one solid introduction paragraph (states what this is about, contains the focus keyword), then relevant <h2> subheadings breaking the body into scannable sections based on what this specific topic actually needs (do not force the same generic headings on every article) - at least one subheading must contain the focus keyword. Use <h3> only where a section genuinely needs sub-points. End with a real closing/conclusion paragraph. Short paragraphs (2-4 lines), and a bullet list (<ul>) where it genuinely helps. No empty headings, no duplicate <h1> tags, no leftover Markdown syntax (no "**", "##", etc) in the HTML.
- Be specific: keep concrete facts, numbers, names, and dates from the source content rather than vague generalities.
- Word count depends on the "category" you choose for this article (see below) - hit that target. Do not pad with useless paragraphs just to reach a number; expand only with genuinely useful context/background/explanation.`;

function buildPrompt(title, htmlContent) {
  const wordCount = countWords(htmlContent);

  const noAttribution = "Do NOT mention or refer to the original publication's name, website, author byline (e.g. \"By XYZ Bureau\"), or any credit line anywhere in the title or content - write it as fully original, standalone content with no reference to where it came from.";

  // If the source content is too short (just a summary/headline), ask the AI to write a full article
  if (wordCount < 100) {
    return `The source content below is too short (just a summary). Write a complete, well-structured, original blog post based on this title and summary - expand it naturally with relevant details, context, and explanation. A 1200-word floor applies to every category, so treat that as an absolute minimum regardless of which category you pick.
Use proper HTML tags (<p>, <h2>, <ul> etc), but do NOT include any hyperlinks, anchor tags, images, or URLs anywhere. ${noAttribution}
${WRITING_QUALITY_RULES}
${SOURCE_FIDELITY_RULES}
${SEO_FIELD_RULES}
Return ONLY a valid JSON object, no markdown fences: ${SEO_JSON_SHAPE}

Title: ${title}
Summary: ${htmlContent}`;
  }

  return `Using the source article below as your factual base, write a fresh, more complete blog post on the same topic - not a sentence-by-sentence rewrite. Hit the word-count target for whichever category you choose, even if the source itself is shorter - expand with real context/background/explanation to get there naturally. A 1200-word floor applies regardless of category.
Keep the HTML tags intact, but do NOT include any hyperlinks, anchor tags, images, or URLs anywhere in the output. ${noAttribution}
${WRITING_QUALITY_RULES}
${SOURCE_FIDELITY_RULES}
${SEO_FIELD_RULES}
Return ONLY a valid JSON object, no markdown fences: ${SEO_JSON_SHAPE}

Title: ${title}
Content: ${htmlContent}`;
}

// Pads/trims a string to sit inside [min, max] chars without cutting a word in half.
function fitLength(str, min, max, fillers) {
  let s = (str || "").trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }
  const fillerList = (Array.isArray(fillers) ? fillers : [fillers]).filter(Boolean);
  for (const filler of fillerList) {
    if (s.length >= min) break;
    const next = s ? `${s} ${filler}` : filler;
    if (next.length <= max) s = next;
  }
  return s;
}

// Prepends (not appends) the keyword when missing, so a later max-length trim
// (which cuts from the end) trims the original text, never the keyword itself.
function ensureKeywordPresent(text, keyword) {
  if (!keyword) return text;
  const t = (text || "").trim();
  if (!t) return keyword;
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const already = words.every((w) => t.toLowerCase().includes(w));
  return already ? t : `${keyword}: ${t}`.trim();
}

// Reduces repeated occurrences of the focus keyword phrase in the body text
// when keyword-stuffing is detected - keeps the first N occurrences (still
// satisfies keyword-placement checks) and rewords the rest to a plain pronoun/
// synonym reference so it doesn't read as repetitive.
function reduceKeywordStuffing(html, keyword, keepFirst = 3) {
  const $ = cheerio.load(html || "", null, false);
  const phrase = keyword.trim();
  if (!phrase) return html;
  const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let count = 0;
  $("p").each((_, el) => {
    const $el = $(el);
    const text = $el.text();
    const updated = text.replace(re, (match) => {
      count++;
      return count <= keepFirst ? match : "it";
    });
    if (updated !== text) $el.text(updated);
  });
  return $.html();
}

// One deterministic, no-extra-AI-call correction pass: takes the checklist's
// failed checks (lib/seoScorer.js) and mechanically patches whichever of them
// can be fixed without regenerating the whole article. Only called once, and
// only when the initial score misses the publishing threshold (see rewrite()).
function enforceSeoCompliance(result, seoResult) {
  const kw = result.focusKeyword;
  const failed = new Set(seoResult.checks.filter((c) => !c.passed).map((c) => c.id));
  if (!kw || failed.size === 0) return result;

  if (failed.has("seoTitle")) {
    const title = ensureKeywordPresent(result.seoTitle, kw);
    result.seoTitle = fitLength(title, 50, 60, [result.title, kw]);
  }

  if (failed.has("metaDescription")) {
    const meta = ensureKeywordPresent(result.metaDescription, kw);
    result.metaDescription = fitLength(meta, 140, 160, [
      `Here's what you need to know about ${kw} and why it matters.`,
      `Read on for the full details and what happens next.`,
      `Find out more here.`,
    ]);
  }

  if (failed.has("slugQuality")) {
    result.slug = slugify(kw) || slugify(result.title);
  }

  if (failed.has("imageAlt")) {
    result.imageAlt = ensureKeywordPresent(result.imageAlt || result.title, kw);
  }

  if (failed.has("keywordPlacement")) {
    const $ = cheerio.load(result.content || "", null, false);
    const firstP = $("p").first();
    if (firstP.length) firstP.text(ensureKeywordPresent(firstP.text(), kw));
    const firstHeading = $("h2, h3").first();
    if (firstHeading.length && !containsKeywordLoose(firstHeading.text(), kw)) {
      firstHeading.text(ensureKeywordPresent(firstHeading.text(), kw));
    }
    result.content = $.html();
  }

  if (failed.has("keywordDensity")) {
    // Only the "too stuffed" direction is safely auto-fixable without an AI call -
    // too-sparse would need new sentences, which risks inventing content.
    if ((seoResult.keywordDensity || 0) > 2.0) {
      result.content = reduceKeywordStuffing(result.content, kw);
    }
  }

  if (failed.has("conclusion")) {
    const $ = cheerio.load(result.content || "", null, false);
    const paragraphs = $("p");
    if (paragraphs.length) {
      const last = $(paragraphs[paragraphs.length - 1]);
      const text = last.text();
      if (countWords(text) < 20) {
        last.text(`${text} Overall, this remains a story worth watching as it develops.`.trim());
      }
    }
    result.content = $.html();
  }

  return result;
}

function containsKeywordLoose(haystack, keyword) {
  const words = (keyword || "").toLowerCase().split(/\s+/).filter(Boolean);
  const h = (haystack || "").toLowerCase();
  return words.length > 0 && words.every((w) => h.includes(w));
}

// Some free/auto-routed models (e.g. OpenRouter's "openrouter/free") occasionally add
// stray text before/after the JSON object, or wrap it in prose - a plain JSON.parse()
// on the trimmed string then fails with "Unexpected non-whitespace character after JSON".
// Extract just the outermost {...} object (by brace-matching, so nested braces in the
// article HTML don't confuse it) before parsing.
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in AI response");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Unterminated JSON object in AI response");
}

const VALID_CATEGORIES = new Set(["news", "short news", "business", "startup", "analysis"]);

function parseResult(rawText, originalTitle) {
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const result = JSON.parse(extractJsonObject(cleaned));
  if (!result.title || !result.content) throw new Error("AI response missing title/content");
  result.content = cleanContent(result.content);
  result.title = (result.title || "").trim() || originalTitle;

  const category = (result.category || "").trim().toLowerCase();
  result.category = VALID_CATEGORIES.has(category) ? result.category.trim() : "News";

  result.focusKeyword = (result.focusKeyword || "").trim();
  result.seoTitle = (result.seoTitle || result.title || "").trim();
  result.metaDescription = (result.metaDescription || "").trim();
  // Prefer the AI's own short, keyword-focused slug; fall back to a slugified
  // focus keyword, then the full title, only if it didn't provide one.
  result.slug = slugify(result.slug) || slugify(result.focusKeyword) || slugify(result.title);
  result.excerpt = (result.excerpt || "").trim();
  result.tags = Array.isArray(result.tags) ? result.tags.filter(Boolean).slice(0, 6) : [];
  result.imageAlt = (result.imageAlt || result.focusKeyword || result.title || "").trim();
  result.keyFacts = sanitizeKeyFacts(result.keyFacts);

  return result;
}

// Cleans the AI's self-reported "keyFacts" block: strings only, trimmed, deduped,
// capped so a run-on list can't bloat the prompt/checks. Missing/malformed input
// (e.g. an older cached response without this field) just yields empty arrays -
// the entity-preservation check below then simply has nothing to flag.
const KEY_FACT_CATEGORIES = ["people", "organizations", "products", "numbers", "dates"];
function sanitizeKeyFacts(raw) {
  const facts = {};
  for (const category of KEY_FACT_CATEGORIES) {
    const list = Array.isArray(raw?.[category]) ? raw[category] : [];
    const cleaned = list
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    facts[category] = [...new Set(cleaned)].slice(0, 10);
  }
  return facts;
}

// Lightweight, non-AI check (section 6/12 of the fidelity requirement): does the
// generated article + title still contain every fact the model itself extracted
// from the source? Reuses the same loose word-match lib/seoScorer.js already uses
// for keyword placement, so a fact "counts" as present even if it's not an exact
// substring match (e.g. surrounding punctuation differs).
function findMissingFacts(result) {
  const facts = result.keyFacts;
  if (!facts) return [];
  const bodyText = cheerio.load(result.content || "", null, false).text();
  const haystack = `${result.title || ""} ${bodyText}`;
  const missing = [];
  for (const category of KEY_FACT_CATEGORIES) {
    for (const fact of facts[category] || []) {
      if (!containsKeyword(haystack, fact)) missing.push(fact);
    }
  }
  return missing;
}

// Runs the full generate -> score -> (one auto-fix if needed) -> final score
// pipeline described in the SEO publishing gate. This is the only place that
// decides pass/fail - callers (routes/posts.js, server.js) just read `.seo`.
function finalizeArticle(result) {
  let seo = scoreSeo({ ...result, category: result.category });

  if (seo.score < SEO_PASS_SCORE) {
    result = enforceSeoCompliance(result, seo);
    seo = scoreSeo({ ...result, category: result.category });
  }

  result.seo = seo;
  result.passed = seo.score >= SEO_PASS_SCORE;
  return result;
}

// Supports multiple Gemini API keys (comma-separated) so different Google accounts'
// free-tier quotas can be pooled - GEMINI_API_KEYS=key1,key2,key3. Falls back to the
// single GEMINI_API_KEY var for backward compatibility if GEMINI_API_KEYS isn't set.
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

// 1) Gemini - primary
// NOTE: gemini-2.5-flash was retired early (returns 404 ahead of its official
// Oct 16, 2026 shutdown) - using gemini-3.6-flash, the current recommended
// Flash model, instead. If Google ships a newer default later, swap it here.
//
// Tries each configured key in turn. A key that's invalid/revoked (401), blocked (403),
// or has hit its account's daily quota (429) just moves on to the next key immediately -
// no point retrying the SAME key on those errors, and this is exactly the scenario multiple
// keys are meant to cover (one account's quota running out shouldn't fail the whole provider).
async function tryGemini(prompt) {
  if (GEMINI_API_KEYS.length === 0) return null;

  let lastErr;
  for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
    const key = GEMINI_API_KEYS[i];
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          // Gemini 3.x models "think" (extended internal reasoning) by default, which was
          // adding enough latency to blow past PROVIDER_TIMEOUT_MS on every single key.
          // NOTE: Gemini 3.x replaced the old 2.5-series `thinkingBudget` param with
          // `thinkingLevel` ("minimal" | "low" | "medium" | "high"). Sending `thinkingBudget`
          // to a Gemini 3.x model is what was causing the
          // "400 Request contains an invalid argument" on every key - the request itself
          // was malformed, not a key/quota problem.
          generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
        },
        { timeout: PROVIDER_TIMEOUT_MS }
      );
      const candidate = res.data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (!text) {
        const reason = res.data?.promptFeedback?.blockReason || candidate?.finishReason || "empty response";
        throw new Error(`Gemini returned no usable content (${reason})`);
      }
      return text;
    } catch (err) {
      lastErr = err;
      const keyLabel = `key #${i + 1}/${GEMINI_API_KEYS.length} (…${key.slice(-4)})`;
      if (i < GEMINI_API_KEYS.length - 1) {
        console.warn(`⚠️  Gemini ${keyLabel} failed (${describeError(err)}) - trying next key`);
      } else {
        console.error(`❌ Gemini ${keyLabel} failed (${describeError(err)}) - no more keys left`);
      }
    }
  }
  throw lastErr;
}

// 2) Groq - fallback (free, no card, OpenAI-compatible)
// NOTE: openai/gpt-oss-120b is a reasoning model - by default it spends a chunk of its
// output budget on internal "thinking" tokens before writing the actual answer, and with
// a long article + JSON output that was eating enough of the budget to cut the JSON off
// mid-string (the "Unterminated string in JSON" error). reasoning_effort "low" cuts that
// down, and max_completion_tokens is raised explicitly so a 700-900 word article + SEO
// JSON always has room to finish.
//
// Supports multiple Groq API keys (comma-separated), same pooling as GEMINI_API_KEYS /
// OPENROUTER_API_KEYS above - GROQ_API_KEYS=key1,key2,key3. Falls back to the single
// GROQ_API_KEY var for backward compatibility if GROQ_API_KEYS isn't set.
const GROQ_API_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

async function tryGroq(prompt) {
  if (GROQ_API_KEYS.length === 0) return null;

  let lastErr;
  for (let i = 0; i < GROQ_API_KEYS.length; i++) {
    const key = GROQ_API_KEYS[i];
    try {
      const res = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "openai/gpt-oss-120b",
          messages: [{ role: "user", content: prompt }],
          reasoning_effort: "low",
          max_completion_tokens: 8000,
        },
        { headers: { Authorization: `Bearer ${key}` }, timeout: PROVIDER_TIMEOUT_MS }
      );
      const text = res.data?.choices?.[0]?.message?.content;
      if (!text) throw new Error("Groq returned no usable content");
      return text;
    } catch (err) {
      lastErr = err;
      const keyLabel = `key #${i + 1}/${GROQ_API_KEYS.length} (…${key.slice(-4)})`;
      if (i < GROQ_API_KEYS.length - 1) {
        console.warn(`⚠️  Groq ${keyLabel} failed (${describeError(err)}) - trying next key`);
      } else {
        console.error(`❌ Groq ${keyLabel} failed (${describeError(err)}) - no more keys left`);
      }
    }
  }
  throw lastErr;
}

// 3) OpenRouter - fallback (free models, OpenAI-compatible)
// NOTE: hardcoding one specific ":free" model (e.g. llama-3.3-70b-instruct:free) is fragile -
// OpenRouter's free model lineup rotates/gets delisted often (that's what caused the 404
// "unavailable for free" error). "openrouter/free" is OpenRouter's own auto-router - it
// picks whichever free model is currently live, so this stops breaking every time the
// lineup changes.
//
// Supports multiple OpenRouter API keys (comma-separated), same pooling idea as
// GEMINI_API_KEYS above - OPENROUTER_API_KEYS=key1,key2,key3. Falls back to the
// single OPENROUTER_API_KEY var for backward compatibility if OPENROUTER_API_KEYS
// isn't set. OpenRouter's free tier is rate-limited PER KEY/ACCOUNT ("Rate limit
// exceeded: free-models-per-day"), so one account hitting its daily cap doesn't
// have to fail the whole provider - just move on to the next key.
const OPENROUTER_API_KEYS = (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

async function tryOpenRouter(prompt) {
  if (OPENROUTER_API_KEYS.length === 0) return null;

  let lastErr;
  for (let i = 0; i < OPENROUTER_API_KEYS.length; i++) {
    const key = OPENROUTER_API_KEYS[i];
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        { model: "openrouter/free", messages: [{ role: "user", content: prompt }] },
        { headers: { Authorization: `Bearer ${key}` }, timeout: PROVIDER_TIMEOUT_MS }
      );
      const text = res.data?.choices?.[0]?.message?.content;
      if (!text) throw new Error("OpenRouter returned no usable content");
      return text;
    } catch (err) {
      lastErr = err;
      const keyLabel = `key #${i + 1}/${OPENROUTER_API_KEYS.length} (…${key.slice(-4)})`;
      if (i < OPENROUTER_API_KEYS.length - 1) {
        console.warn(`⚠️  OpenRouter ${keyLabel} failed (${describeError(err)}) - trying next key`);
      } else {
        console.error(`❌ OpenRouter ${keyLabel} failed (${describeError(err)}) - no more keys left`);
      }
    }
  }
  throw lastErr;
}

function describeError(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.error?.message || err.message;
  return status ? `${status} - ${msg}` : msg;
}

function isTimeout(err) {
  return err.code === "ECONNABORTED" || /timeout/i.test(err.message || "");
}

function isRetryable(err) {
  if (isTimeout(err)) return false;
  const status = err.response?.status;
  if (!status) return true;
  return status === 429 || (status >= 500 && status < 600);
}

async function callWithRetry(provider, prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES_PER_PROVIDER; attempt++) {
    try {
      return await provider(prompt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === RETRIES_PER_PROVIDER) throw err;

      const retryAfterHeader = err.response?.headers?.["retry-after"];
      const wait = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : RETRY_BASE_DELAY_MS * attempt;
      console.warn(
        `⚠️  ${provider.name} hit ${describeError(err)} - retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${RETRIES_PER_PROVIDER})`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

const PROVIDERS = [tryGemini, tryGroq, tryOpenRouter];

// Runs the existing provider fallback chain (Gemini -> Groq -> OpenRouter, with the
// existing per-provider retry and full-round-retry behavior) for a single prompt.
// Both the normal generation call and the one-shot fact-correction pass share this,
// so neither adds a new provider or a new fallback architecture.
async function generateWithProviders(prompt) {
  let lastError;
  for (let round = 1; round <= FULL_ROUNDS; round++) {
    for (const provider of PROVIDERS) {
      try {
        const raw = await callWithRetry(provider, prompt);
        if (raw) return raw;
      } catch (err) {
        console.error(`❌ AI provider "${provider.name}" failed (round ${round}/${FULL_ROUNDS}): ${describeError(err)}`);
        lastError = new Error(`${provider.name}: ${describeError(err)}`);
      }
    }
    if (round < FULL_ROUNDS) {
      console.warn(`⚠️  All AI providers failed this round - waiting ${ROUND_DELAY_MS / 1000}s before trying the full chain again...`);
      await sleep(ROUND_DELAY_MS);
    }
  }
  throw lastError || new Error("All AI providers failed");
}

// Builds the single, targeted correction prompt used when the entity-preservation
// check finds that facts the model itself extracted from the source didn't make it
// into the generated article. Asks for a revision, not a rewrite from scratch, and
// returns the same JSON shape so it can go through the normal parse/finalize path.
function buildFactCorrectionPrompt(title, sourceHtml, result, missingFacts) {
  return `You previously rewrote the source article below into the JSON object shown as "Previous output". On review, the following facts from the source were dropped and need to be worked back in naturally: ${missingFacts.join(", ")}.

Revise "content" so it includes these facts wherever they're relevant to the story, without inventing details beyond what the source states. Keep the rest of the article's wording, structure, and length target as close to the previous output as reasonably possible - this is a targeted fix, not a full rewrite. Keep "title" as it was in "Previous output" below (already a rewritten, original headline) - do not revert it to the source's original wording. Update "keyFacts" to reflect the revised article.
${SOURCE_FIDELITY_RULES}
${SEO_FIELD_RULES}
Return ONLY a valid JSON object, no markdown fences: ${SEO_JSON_SHAPE}

Original source title (context only - your rewritten title is in "Previous output", not this): ${title}
Source: ${truncateContent(sourceHtml)}
Previous output: ${JSON.stringify({ title: result.title, content: result.content, category: result.category, focusKeyword: result.focusKeyword, seoTitle: result.seoTitle, metaDescription: result.metaDescription, slug: result.slug, excerpt: result.excerpt, tags: result.tags, imageAlt: result.imageAlt })}`;
}

// Real internal linking to the SAME site's own already-published posts - not the
// source article's links (cleanContent() strips those, we don't have rights to
// them). Uses the "keyFacts" people/organizations the model itself extracted
// (see SOURCE_FIDELITY_RULES) to find other posted articles on this site that
// cover the same person/company, and links the first mention of that name to
// the existing post. Capped, and skipped entirely (never throws) if there's no
// siteId, no named entities, no DB match, or the DB lookup itself fails - this
// must never be the thing that breaks a generate.
const MAX_INTERNAL_LINKS = 3;
const MIN_ENTITY_NAME_LEN = 4; // skip trivial fragments like "AI" or "EV"

async function findRelatedPosts(siteId) {
  try {
    return await Post.find({ siteId, status: "posted", publishedUrl: { $exists: true, $ne: null } })
      .select("focusKeyword tags rewrittenTitle publishedUrl")
      .lean();
  } catch (err) {
    console.warn(`⚠️  Internal-link lookup skipped (${err.message})`);
    return [];
  }
}

// Loose match, same idea as containsKeyword() in lib/seoScorer.js - does this
// OTHER post's own title/keyword/tags mention the entity we're looking for?
function matchEntityToPost(entity, posts, usedUrls) {
  const e = entity.toLowerCase();
  return posts.find((p) => {
    if (!p.publishedUrl || usedUrls.has(p.publishedUrl)) return false;
    const haystack = `${p.focusKeyword || ""} ${p.rewrittenTitle || ""} ${(p.tags || []).join(" ")}`.toLowerCase();
    return haystack.includes(e);
  });
}

async function attachInternalLinks(result, siteId) {
  const entities = [...(result.keyFacts?.people || []), ...(result.keyFacts?.organizations || [])]
    .filter((e) => e && e.length >= MIN_ENTITY_NAME_LEN);

  if (!siteId || entities.length === 0) return { ...result, hasInternalLinkCandidates: false };

  const candidates = await findRelatedPosts(siteId);
  if (candidates.length === 0) return { ...result, hasInternalLinkCandidates: false };

  const $ = cheerio.load(result.content || "", null, false);
  const usedUrls = new Set();
  let linksAdded = 0;

  for (const entity of entities) {
    if (linksAdded >= MAX_INTERNAL_LINKS) break;
    const match = matchEntityToPost(entity, candidates, usedUrls);
    if (!match) continue;

    const re = new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    let linked = false;
    $("p").each((_, el) => {
      if (linked) return;
      const $el = $(el);
      if ($el.find("a").length > 0) return; // don't double-link inside an already-linked paragraph
      const html = $el.html() || "";
      if (re.test($el.text())) {
        $el.html(html.replace(re, (m) => `<a href="${match.publishedUrl}">${m}</a>`));
        linked = true;
      }
    });

    if (linked) {
      usedUrls.add(match.publishedUrl);
      linksAdded++;
    }
  }

  // hasInternalLinkCandidates: true because we DID find at least one other post
  // to potentially link to - this is what lets lib/seoScorer.js fairly require
  // an actual <a> tag now, rather than just recording that we tried.
  return { ...result, content: $.html(), hasInternalLinkCandidates: true };
}

async function rewrite(title, htmlContent, siteId) {
  const truncated = truncateContent(htmlContent);
  const prompt = buildPrompt(title, truncated);
  const raw = await generateWithProviders(prompt);
  let result = finalizeArticle(parseResult(raw, title));

  // Entity-preservation check (max ONE extra AI call, per the fidelity requirement) -
  // only fires when the model's own extracted facts didn't make it into the article.
  const missing = findMissingFacts(result);
  if (missing.length > 0) {
    try {
      const correctionPrompt = buildFactCorrectionPrompt(title, truncated, result, missing);
      const correctedRaw = await generateWithProviders(correctionPrompt);
      result = finalizeArticle(parseResult(correctedRaw, title));
    } catch (err) {
      console.error(`⚠️  Fact-preservation correction pass failed (${describeError(err)}) - keeping original result`);
    }
  }

  // Link named people/companies to this site's other posts about them, then
  // rescore once more so the "internalLinks" check (and the publish gate)
  // reflect the linked version rather than the pre-link one.
  result = await attachInternalLinks(result, siteId);
  result.seo = scoreSeo({ ...result, category: result.category, hasInternalLinkCandidates: result.hasInternalLinkCandidates });
  result.passed = result.seo.score >= SEO_PASS_SCORE;

  return result;
}

module.exports = { rewrite, SEO_PASS_SCORE };