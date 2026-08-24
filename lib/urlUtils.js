// Resolves a possibly-relative href against a base URL. Returns null instead
// of throwing on malformed input, since scraped HTML is never fully trustworthy.
function abs(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// True if `url` is on the same origin as `base` - used to only follow internal links.
function sameOrigin(url, base) {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

// True if `str` is an actual http(s) URL rather than a plain topic phrase
// (e.g. "founder stories", "Middle East news") typed into the source field.
function isUrl(str) {
  try {
    const u = new URL((str || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

module.exports = { abs, sameOrigin, isUrl };