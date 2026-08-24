const axios = require("axios");

// If the user pastes the site URL with a trailing slash (e.g. "https://example.com/"),
// naively appending "/wp-json/..." produces a double slash ("...com//wp-json/...")
// which many servers 404 on. Every WP REST call below goes through this first.
function baseUrl(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

// Fetches categories for any WordPress site - public endpoint, no auth needed.
// Used only for your own (target) site, so you can pick which category to publish into.
async function getCategories(siteUrl) {
  const res = await axios.get(`${baseUrl(siteUrl)}/wp-json/wp/v2/categories`, { params: { per_page: 100 }, timeout: 15000 });
  return res.data.map((c) => ({ id: c.id, name: c.name }));
}

// Uploads an image to your site's media library, returns its ID.
// altText (optional) is set in a follow-up PATCH - the initial POST's body is
// the raw image bytes (Content-Type is the image mime type), so text fields
// like alt_text can't ride along in that same request; WordPress's media
// endpoint accepts them on a normal JSON update afterward.
async function uploadImage(site, imageUrl, altText, slugHint) {
  const auth = Buffer.from(`${site.username}:${site.appPassword}`).toString("base64");
  const img = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 20000 });

  // Use the image's real content-type (jpeg/webp/png/etc) instead of assuming
  // jpeg - several sources (e.g. arabtimesonline) serve .webp, and uploading
  // those with a hardcoded "image/jpeg" header can cause WordPress to reject
  // or mis-store the file, silently losing the featured image.
  const contentType = img.headers["content-type"] || "image/jpeg";
  const ext = contentType.split("/")[1]?.split(";")[0] || "jpg";

  // SEO-friendly filename (falls back to the old "img-<timestamp>" scheme when
  // no slug is available) instead of a meaningless "image123.jpg".
  const namePart = (slugHint || "").trim() || `img-${Date.now()}`;

  const res = await axios.post(`${baseUrl(site.url)}/wp-json/wp/v2/media`, img.data, {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${namePart}.${ext}"`,
    },
    timeout: 30000,
  });

  if (altText) {
    // Best-effort only - a missing alt text shouldn't fail the whole publish,
    // it just costs a bit of the on-page SEO score for this post.
    try {
      await axios.post(
        `${baseUrl(site.url)}/wp-json/wp/v2/media/${res.data.id}`,
        { alt_text: altText },
        { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }, timeout: 15000 }
      );
    } catch (e) {
      console.warn(`⚠️  Could not set alt text on uploaded image: ${e.message}`);
    }
  }

  return res.data.id;
}

// Publishes a post to your own site.
// `seo` (optional) = { slug, metaDescription, focusKeyword, seoTitle, tags }. Slug/excerpt
// are plain WordPress core fields, so those always work. metaDescription/
// focusKeyword/seoTitle additionally get sent as the relevant SEO plugin's custom meta
// fields based on site.seoPlugin - this only actually takes effect if that
// plugin is installed AND has registered those fields for REST access; if not,
// WordPress just silently ignores unknown meta keys, so it's always safe to send.
async function publishPost(site, title, content, featuredMediaId, seo = {}) {
  const auth = Buffer.from(`${site.username}:${site.appPassword}`).toString("base64");
  const payload = { title, content, status: "publish" };
  if (site.targetCategoryId) payload.categories = [site.targetCategoryId];
  if (featuredMediaId) payload.featured_media = featuredMediaId;
  if (seo.slug) payload.slug = seo.slug;
  // WordPress excerpt: prefer the AI's own short 30-50 word excerpt; fall back
  // to the meta description (old behavior) if it's missing for any reason.
  if (seo.excerpt) payload.excerpt = seo.excerpt;
  else if (seo.metaDescription) payload.excerpt = seo.metaDescription;
  if (Array.isArray(seo.tags) && seo.tags.length) payload.tags_input = seo.tags; // some setups accept names directly

  if (site.seoPlugin === "yoast") {
    payload.meta = {
      ...(seo.metaDescription ? { _yoast_wpseo_metadesc: seo.metaDescription } : {}),
      ...(seo.focusKeyword ? { _yoast_wpseo_focuskw: seo.focusKeyword } : {}),
      ...(seo.seoTitle ? { _yoast_wpseo_title: seo.seoTitle } : {}),
    };
  } else if (site.seoPlugin === "rankmath") {
    payload.meta = {
      ...(seo.metaDescription ? { rank_math_description: seo.metaDescription } : {}),
      ...(seo.focusKeyword ? { rank_math_focus_keyword: seo.focusKeyword } : {}),
      ...(seo.seoTitle ? { rank_math_title: seo.seoTitle } : {}),
    };
  }

  const res = await axios.post(`${baseUrl(site.url)}/wp-json/wp/v2/posts`, payload, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    timeout: 30000,
  });
  return res.data.link;
}

module.exports = { getCategories, uploadImage, publishPost };