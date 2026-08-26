const axios = require("axios");
const cheerio = require("cheerio");

// Each function returns null on failure so the chain can move on to the next source

// Pulls a person's name and their company name out of interview/profile-style
// titles. Handles two title shapes:
//   A) role before name  - "Toloka: Interview With CEO Olga Megorskaya..." or
//      "Meet Polymarket CEO Shayne Coplan..."
//   B) name before role  - "Mr. Pranav Trehan, Founder & CEO, Aufside
//      Hospitality LLP" or "Sundar Pichai, CEO of Google, discusses..."
// Shape B also gives us the company name directly (no colon/heuristic
// needed), so it's checked first and preferred when both would match.
// Returns nulls if the title doesn't match a recognizable pattern (e.g. no
// name/company mentioned at all).
const ROLE_PATTERN = "(?:Co-)?Founder(?:\\s*(?:&|and|,)\\s*CEO)?|CEO(?:\\s*(?:&|and|,)\\s*(?:Co-)?Founder)?";

function extractPersonAndCompany(title) {
  if (!title) return { personName: null, companyName: null };

  const STOPWORDS = new Set(["About", "On", "Of", "The", "With", "At", "For", "To", "And", "Discusses", "Talks", "Shares", "Says"]);

  // Shape A: "...CEO/Founder <Name>..."
  const nameAfterRole = title.match(
    new RegExp(`(?:${ROLE_PATTERN})[,\\s&]*\\s+([A-Z][a-z]+(?:\\s[A-Z][a-z]+){1,2})`)
  );

  // Shape B: "<Name>, Founder & CEO[, of] <Company>..."
  const nameBeforeRole = title.match(
    new RegExp(
      `(?:Mr\\.|Ms\\.|Mrs\\.|Dr\\.)?\\s*([A-Z][a-zA-Z'-]+(?:\\s[A-Z][a-zA-Z'-]+){1,2}),\\s*(?:${ROLE_PATTERN}),?\\s*(?:of\\s+)?([A-Z][A-Za-z0-9&.'\\s]{1,40}?)(?=[,.]|\\s+(?:says|on|about|discusses|talks|shares)\\b|$)`
    )
  );

  let personName = null;
  let companyName = null;

  if (nameBeforeRole) {
    const words = nameBeforeRole[1].trim().split(/\s+/);
    const stopIdx = words.findIndex((w) => STOPWORDS.has(w));
    personName = (stopIdx === -1 ? words : words.slice(0, stopIdx)).join(" ") || null;
    companyName = nameBeforeRole[2] ? nameBeforeRole[2].trim() : null;
  } else if (nameAfterRole) {
    const words = nameAfterRole[1].trim().split(/\s+/);
    const stopIdx = words.findIndex((w) => STOPWORDS.has(w));
    personName = (stopIdx === -1 ? words : words.slice(0, stopIdx)).join(" ") || null;
  }

  if (!companyName) {
    const beforeColon = title.split(":")[0].trim();
    if (beforeColon.length < 40 && beforeColon.split(" ").length <= 4) {
      companyName = beforeColon;
    } else {
      const meetMatch = title.match(/Meet\s+([A-Z][A-Za-z0-9]+)\s+CEO/);
      if (meetMatch) companyName = meetMatch[1];
    }
  }

  return { personName, companyName };
}

// Free, no API key. Turns a company name into its domain (logo field is dead
// since Sept 2025, but domain lookup still works).
async function findCompanyDomain(companyName) {
  try {
    const res = await axios.get("https://autocomplete.clearbit.com/v1/companies/suggest", {
      params: { query: companyName },
      timeout: 10000,
    });
    return res.data?.[0]?.domain || null;
  } catch { return null; }
}

// Scrapes a company's own About/Team/Leadership page for a photo next to the
// person's name. This is the company's own published photo of them - unlike
// a third-party news publisher's photo, they put it there themselves for
// public use, so it doesn't carry the same republishing risk.
const TEAM_PAGE_PATHS = ["/about", "/about-us", "/team", "/leadership", "/company/team", "/our-team", "/company"];

async function findTeamPageImage(domain, personName) {
  if (!domain || !personName) return null;
  for (const path of TEAM_PAGE_PATHS) {
    try {
      const url = `https://${domain}${path}`;
      const res = await axios.get(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
      const $ = cheerio.load(res.data);
      let found = null;
      $("*").each((_, el) => {
        if (found) return;
        const text = $(el).text().trim();
        if (text.includes(personName) && text.length < 200) {
          const img = $(el).find("img").first().attr("src") || $(el).closest("div,section,li,article").find("img").first().attr("src");
          if (img) found = img.startsWith("http") ? img : new URL(img, url).href;
        }
      });
      if (found) return found;
    } catch { /* this path doesn't exist / site blocked us - try the next one */ }
  }
  return null;
}

// Tries to find the actual named person's real photo. Only works when the
// title clearly names a person (profile/interview-style titles) - returns
// null otherwise so the caller falls back to findAnyImage()'s stock-photo chain.
// Order: 1) the person's own company team page (if a company name was also
// found) - most specific and current, e.g. a fresh headshot. 2) Wikidata -
// covers well-known founders/CEOs even when the company site scrape fails
// (JS-rendered team pages, no team page at all, blocked scraping, etc).
async function findPersonPhoto(title) {
  const { personName, companyName } = extractPersonAndCompany(title);
  if (!personName) return null;

  if (companyName) {
    const domain = await findCompanyDomain(companyName);
    if (domain) {
      const teamPageImage = await findTeamPageImage(domain, personName);
      if (teamPageImage) return teamPageImage;
    }
  }

  return await findWikidataPersonImage(personName);
}

async function findWikipediaImage(query) {
  try {
    const search = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", list: "search", srsearch: query, format: "json", srlimit: 1 },
      timeout: 10000,
    });
    const pageTitle = search.data.query?.search?.[0]?.title;
    if (!pageTitle) return null;
    const img = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", titles: pageTitle, prop: "pageimages", format: "json", pithumbsize: 800 },
      timeout: 10000,
    });
    const page = Object.values(img.data.query?.pages || {})[0];
    return page?.thumbnail?.source || null;
  } catch { return null; }
}

// Free, no API key. Looks the person up on Wikidata instead of plain Wikipedia
// search - Wikidata explicitly tags whether an entity "is a human" (P31 = Q5),
// so we can confirm the match is actually a person (not their company, a
// product named after them, etc.) before trusting the photo. If they have an
// entry and it's tagged human, P18 is their canonical Commons portrait -
// generally more reliable than Wikipedia's plain-search pageimages, which can
// grab the wrong page's thumbnail (e.g. the company logo) with no such check.
async function findWikidataPersonImage(personName) {
  if (!personName) return null;
  try {
    const search = await axios.get("https://www.wikidata.org/w/api.php", {
      params: {
        action: "wbsearchentities",
        search: personName,
        language: "en",
        type: "item",
        limit: 5,
        format: "json",
      },
      timeout: 10000,
    });
    const candidates = search.data?.search || [];
    if (!candidates.length) return null;

    const ids = candidates.map((c) => c.id).join("|");
    const entities = await axios.get("https://www.wikidata.org/w/api.php", {
      params: {
        action: "wbgetentities",
        ids,
        props: "claims",
        format: "json",
      },
      timeout: 10000,
    });

    for (const candidate of candidates) {
      const entity = entities.data?.entities?.[candidate.id];
      const instanceOf = entity?.claims?.P31 || [];
      const isHuman = instanceOf.some((c) => c.mainsnak?.datavalue?.value?.id === "Q5");
      if (!isHuman) continue; // skip companies, products, etc. matched by name

      const imageClaim = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (!imageClaim) continue; // human, but no photo on file - try next candidate

      const filename = imageClaim.replace(/ /g, "_");
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}`;
    }
    return null;
  } catch { return null; }
}

async function findPexelsImage(query) {
  try {
    const page = Math.floor(Math.random() * 3) + 1;
    const res = await axios.get("https://api.pexels.com/v1/search", {
      params: { query, per_page: 10, page, orientation: "landscape" },
      headers: { Authorization: process.env.PEXELS_API_KEY },
      timeout: 10000,
    });
    const photos = res.data.photos;
    return photos?.length ? photos[Math.floor(Math.random() * photos.length)].src.large : null;
  } catch { return null; }
}

async function findPixabayImage(query) {
  try {
    const res = await axios.get("https://pixabay.com/api/", {
      params: { key: process.env.PIXABAY_API_KEY, q: query, image_type: "photo", per_page: 10 },
      timeout: 10000,
    });
    const hits = res.data.hits;
    return hits?.length ? hits[Math.floor(Math.random() * hits.length)].largeImageURL : null;
  } catch { return null; }
}

async function findUnsplashImage(query) {
  try {
    const res = await axios.get("https://api.unsplash.com/search/photos", {
      params: { query, per_page: 10 },
      headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
      timeout: 10000,
    });
    const results = res.data.results;
    return results?.length ? results[Math.floor(Math.random() * results.length)].urls.regular : null;
  } catch { return null; }
}

async function findOpenverseImage(query) {
  try {
    const res = await axios.get("https://api.openverse.org/v1/images/", { params: { q: query, page_size: 10 }, timeout: 10000 });
    const results = res.data.results;
    return results?.length ? results[Math.floor(Math.random() * results.length)].url : null;
  } catch { return null; }
}

// Absolute last resort - a random stock photo service that doesn't depend on a
// search query matching anything, so it practically never fails. This guarantees
// every post gets SOME image rather than publishing with none.
function guaranteedFallbackImage() {
  const seed = Math.floor(Math.random() * 100000);
  return `https://picsum.photos/seed/${seed}/1200/800`;
}

// Tries every source in order - the first one that returns something wins.
// If every keyword-based source fails (e.g. a very specific/unusual title),
// falls back to a generic query, and finally to a guaranteed random image -
// this function should essentially never return null.
// `themeKeyword` (optional, from site.imageKeyword) biases the generic fallback
// search - e.g. "women"/"businesswoman" for a women-focused site - instead of
// always falling back to the gender-neutral "business" default.
async function findAnyImage(query, themeKeyword) {
  const sources = [findWikipediaImage, findPexelsImage, findPixabayImage, findUnsplashImage, findOpenverseImage];

  for (const fn of sources) {
    const url = await fn(query);
    if (url) return url;
  }

  // Specific titles (company/person names) often return nothing - retry once
  // with a broader query so a real stock photo still has a chance. Use the
  // site's theme keyword if it has one, so the fallback still matches the
  // site's audience/tone instead of being generic.
  // Wikipedia is skipped here on purpose: it returns the single deterministic
  // top result for a query, so if many posts fall through to this same broad
  // query, they'd all get the identical image. Pexels/Pixabay/Unsplash/Openverse
  // each pick randomly from several results, so different posts get different images.
  const fallbackQuery = themeKeyword ? `${themeKeyword} business` : "business";
  const randomizedSources = [findPexelsImage, findPixabayImage, findUnsplashImage, findOpenverseImage];
  for (const fn of randomizedSources) {
    const url = await fn(fallbackQuery);
    if (url) return url;
  }

  return guaranteedFallbackImage();
}

module.exports = { findAnyImage, guaranteedFallbackImage, findPersonPhoto, findWikidataPersonImage };