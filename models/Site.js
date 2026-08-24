const mongoose = require("mongoose");

module.exports = mongoose.model("Site", new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true },          // your own WordPress site
  username: { type: String, required: true },
  appPassword: { type: String, required: true },
  active: { type: Boolean, default: true },

  // Direct link to the category / listing page on the source site.
  // Works for any frontend (WordPress, plain HTML/PHP, React, Next.js, Vue, etc) -
  // the scraper renders the page and pulls out the latest post links itself.
  // Can also be a plain topic phrase ("founder stories") instead of a URL -
  // in that case it's turned into a Google News search feed using sourceRegion below.
  sourceCategoryUrl: { type: String, required: true },
  sourceRegion: { type: String, default: "IN" }, // used only when sourceCategoryUrl is a topic phrase, not a URL - see lib/regions.js
  keywordFilter: String, // optional - only pulls posts whose title contains this word (e.g. "startup")
  imageKeyword: String, // optional - biases the image search/fallback (e.g. "women", "businesswoman") so generic stock images match your site's theme
  dailyLimit: { type: Number, default: 0 }, // 0 = no limit, otherwise max this many posts/day on this site

  targetCategoryId: Number,                        // which category on your own site to publish into
  targetCategoryName: String,

  // Which SEO plugin (if any) is active on this WordPress site - lets publishPost()
  // send the meta description/focus keyword into the right custom REST fields.
  // "none" still works fine - the excerpt is used as a meta-description fallback either way.
  seoPlugin: { type: String, enum: ["none", "yoast", "rankmath"], default: "none" },

  createdAt: { type: Date, default: Date.now },
}));