const axios = require("axios");
const cheerio = require("cheerio");

// Each function returns null on failure so the chain can move on to the next source

// Pulls a person's name and their company name out of interview/profile-style
// titles, e.g. "Toloka: Interview With CEO Olga Megorskaya About The Training
// Data Platform" -> { companyName: "Toloka", personName: "Olga Megorskaya" }
// or "Meet Polymarket CEO Shayne Coplan, the college dropout..." -> { companyName:
// "Polymarket", personName: "Shayne Coplan" }. Returns nulls if the title doesn't
// match a recognizable pattern (e.g. no name/company mentioned at all).
function extractPersonAndCompany(title) {
  if (!title) return { personName: null, companyName: null };

  const STOPWORDS = new Set(["About", "On", "Of", "The", "With", "At", "For", "To", "And", "Discusses", "Talks", "Shares", "Says"]);
  const nameAfterRole = title.match(
    /(?:CEO|Founder|Co-Founder)[,\s&]*(?:CEO|Founder)?\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/
  );
  let personName = null;
  if (nameAfterRole) {
    const words = nameAfterRole[1].trim().split(/\s+/);
    const stopIdx = words.findIndex((w) => STOPWORDS.has(w));
    personName = (stopIdx === -1 ? words : words.slice(0, stopIdx)).join(" ") || null;
  }

  let companyName = null;
  const beforeColon = title.split(":")[0].trim();
  if (beforeColon.length < 40 && beforeColon.split(" ").length <= 4) {
    companyName = beforeColon;
  } else {
    const meetMatch = title.match(/Meet\s+([A-Z][A-Za-z0-9]+)\s+CEO/);
    if (meetMatch) companyName = meetMatch[1];
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

// Tries to find the actual named person's real photo from their own company's
// website. Only works when the title clearly names a person + company (profile/
// interview-style titles) - returns null otherwise so the caller falls back to
// findAnyImage()'s stock-photo chain.
async function findPersonPhoto(title) {
  const { personName, companyName } = extractPersonAndCompany(title);
  if (!personName || !companyName) return null;
  const domain = await findCompanyDomain(companyName);
  if (!domain) return null;
  return await findTeamPageImage(domain, personName);
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

module.exports = { findAnyImage, guaranteedFallbackImage, findPersonPhoto };