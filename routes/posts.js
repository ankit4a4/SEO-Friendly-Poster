const express = require("express");
const router = express.Router();
const Post = require("../models/Post");
const Site = require("../models/Site");
const { uploadImage, publishPost } = require("../services/wordpress");
const { fetchSourcePosts } = require("../services/scraper");
const { rewrite } = require("../services/ai");
const { findAnyImage } = require("../services/image");

router.get("/", async (req, res) => {
  const filter = req.query.siteId ? { siteId: req.query.siteId } : {};
  // The list view (dashboard + per-site page) never shows the full article body -
  // only title/status/link/error. sourceContent and rewrittenContent can each be
  // tens of KB of HTML per post, and with no siteId (dashboard) this was pulling
  // that for EVERY post across ALL sites in one go - that's what was taking ~15
  // minutes to load. Generate/Publish fetch the full post by ID separately, so
  // excluding these here doesn't break anything.
  res.json(
    await Post.find(filter)
      .select("-sourceContent -rewrittenContent")
      .sort({ createdAt: -1 })
  );
});

// POST /api/posts/fetch/:siteId - check the source category for new posts (duplicates are skipped)
router.post("/fetch/:siteId", async (req, res) => {
  try {
    const site = await Site.findById(req.params.siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const doneIds = new Set(
      (await Post.find({ siteId: site._id, status: "posted" }).select("sourcePostId")).map((p) => p.sourcePostId)
    );
    const sourcePosts = await fetchSourcePosts(site, doneIds);
    const created = [];

    for (const sp of sourcePosts) {
      const exists = await Post.findOne({ siteId: site._id, sourcePostId: String(sp.id) });
      if (exists) continue;
      created.push(
        await Post.create({
          siteId: site._id,
          sourcePostId: String(sp.id),
          sourceTitle: sp.title,
          sourceContent: sp.content,
          sourceLink: sp.link,
          sourceImage: sp.image || null,
        })
      );
    }
    res.json({ newPosts: created.length, posts: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/generate", async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });

    const result = await rewrite(post.sourceTitle, post.sourceContent);
    post.rewrittenTitle = result.title;
    post.rewrittenContent = result.content;
    post.focusKeyword = result.focusKeyword;
    post.seoTitle = result.seoTitle;
    post.metaDescription = result.metaDescription;
    post.slug = result.slug;
    post.excerpt = result.excerpt;
    post.tags = result.tags;
    post.imageAlt = result.imageAlt;
    post.articleCategory = result.category;

    // result.seo / result.passed come from the publishing gate (generate -> score
    // -> one auto-fix if needed -> final score) run inside services/ai.js.
    post.seoScore = result.seo.score;
    post.seoStatus = result.seo.status;
    post.seoChecks = result.seo.checks;
    post.seoIssues = result.seo.issues;
    post.seoRecommendations = result.seo.recommendations;
    post.wordCount = result.seo.wordCount;
    post.keywordDensity = result.seo.keywordDensity;

    // Publishing gate: score >= 80 -> ready to publish. Below that (even after
    // the one auto-fix attempt) -> held for manual review, never auto-published.
    post.status = result.passed ? "generated" : "seo_review_required";
    post.errorMessage = undefined; // clear any error left over from a previous failed attempt
    await post.save();
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/publish", async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });
    const site = await Site.findById(post.siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    if (post.status !== "generated") return res.status(400).json({ error: "Generate the content first" });

    try {
      // 5 free sources are tried in order - whichever one returns something is used
      const imageUrl = await findAnyImage(post.sourceTitle);
      const mediaId = imageUrl ? await uploadImage(site, imageUrl, post.imageAlt, post.slug) : null;
      post.publishedUrl = await publishPost(site, post.rewrittenTitle, post.rewrittenContent, mediaId, {
        slug: post.slug,
        excerpt: post.excerpt,
        metaDescription: post.metaDescription,
        focusKeyword: post.focusKeyword,
        seoTitle: post.seoTitle,
        tags: post.tags,
      });
      post.status = "posted";
      post.errorMessage = undefined; // clear any error left over from a previous failed attempt
    } catch (err) {
      post.status = "failed";
      post.errorMessage = err.message;
    }
    await post.save();
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;