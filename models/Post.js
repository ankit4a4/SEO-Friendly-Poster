const mongoose = require("mongoose");

module.exports = mongoose.model("Post", new mongoose.Schema({
  siteId: { type: mongoose.Schema.Types.ObjectId, ref: "Site", required: true, index: true }, // queried/sorted on constantly (dashboard, per-site view, daily-limit count) - was missing an index, causing a full collection scan every time
  sourcePostId: { type: String, required: true },  // prevents re-fetching the same post
  sourceTitle: String,
  sourceContent: String,
  sourceLink: String,
  sourceImage: String, // original article's image (more accurate than a stock photo for a real person/event)

  rewrittenTitle: String,
  rewrittenContent: String,

  // SEO metadata generated alongside the rewrite (see services/ai.js) - used
  // both when publishing to WordPress and to compute seoScore below.
  focusKeyword: String,
  seoTitle: String,
  metaDescription: String,
  slug: String,
  excerpt: String, // short WordPress excerpt (30-50 words), distinct from metaDescription
  tags: [String],
  imageAlt: String,
  articleCategory: String, // News / Short News / Business / Startup / Analysis - picked by the AI, drives the word-count target

  // On-page SEO checklist score (0-100, see lib/seoScorer.js), computed right
  // after generate (and again after the one auto-fix pass if the first score
  // missed the publishing threshold). seoChecks holds the individual pass/fail
  // breakdown so the dashboard can show exactly what's missing, not just the number.
  seoScore: { type: Number, default: null },
  seoStatus: String, // EXCELLENT / GOOD / NEEDS_IMPROVEMENT / POOR
  seoChecks: [{ id: String, label: String, points: Number, passed: Boolean }],
  seoIssues: [String],
  seoRecommendations: [String],
  wordCount: Number,
  keywordDensity: Number,

  status: { type: String, enum: ["pending", "generated", "posted", "failed", "seo_review_required"], default: "pending" },
  autoExcluded: { type: Boolean, default: false }, // true = daily limit reached, auto-cron will skip it, still publishable manually
  publishedUrl: String,
  errorMessage: String,

  createdAt: { type: Date, default: Date.now },
}, { timestamps: { createdAt: false, updatedAt: true } }));