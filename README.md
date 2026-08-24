# SEO Friendly Poster - Backend

Flow: **Latest posts from a source website's category → AI rewrites them → published into your own site's category**

## Setup

### Option A - Docker (recommended, handles the browser dependency for you)
1. `.env` banao (`.env.example` se copy karke) and fill in the values, including `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `SESSION_SECRET` for the login page.
2. `docker compose up --build`
3. Open **http://localhost:5000**, sign in, and you're in.

### Option B - Running directly with Node
1. `npm install` (this also downloads the Chromium browser Playwright needs - it's a few hundred MB, only happens once)
2. `.env` banao (`.env.example` se copy karke)
3. `npm start`
4. Browser mein kholo: **http://localhost:5000**

## Login
The dashboard is behind a simple username/password login (`login.html`), checked against `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`. Sessions are cookie-based and last 7 days. Failed logins are rate-limited (5 attempts per IP, then a 15-minute lockout).

## Use kaise karna hai
1. Dashboard pe **"+ Add website"** dabao
2. Apni WordPress site ki details + target category bharo
3. **Source category page URL** field mein directly wo link daalo jahan se latest posts uthane hain (e.g. `https://othersite.com/category/tech`). Ye kisi bhi tarah ki site ke saath kaam karta hai - WordPress, plain HTML/PHP, React, Next.js, Vue - koi extra step nahi, koi separate "load categories" step nahi. Ek RSS feed URL bhi chalega, wo automatically detect ho jata hai.
4. Site add hote hi uska apna page ban jayega (left sidebar mein dikhega)
5. Us page pe **"Check for new posts"** dabao - source category ke latest posts mil jayenge
6. Har post pe **"Generate"** (rewrite) → **"Publish"** (apni site pe daalo)
7. Kuch galat add ho gaya ya baad mein change karna ho (URL, target category, daily limit, etc.) to website ke page pe **"Edit website"** button se update kar sakte ho. Application password field khaali chhod do agar wo change nahi karni - purani hi save rahegi.

Background mein ek worker khud-ba-khud chalta rehta hai aur naye posts automatically rewrite + publish kar deta hai - dashboard khula rakhna zaroori nahi.

### Auto-posting kaise chalti hai (one at a time)
Chahe kitni bhi websites add ki hon (jaise 24), worker **strictly ek-ek karke** kaam karta hai - kabhi bhi ek se zyada post ek sath generate/publish nahi hoti:
1. Ek website ki baari aati hai (dashboard sidebar mein wo website highlight ho jaati hai jab tak uski baari chal rahi hai).
2. Uska ek pending post **generate** hota hai, fir turant **publish**.
3. Publish hone ke baad **30 second** ka wait (`SUCCESS_GAP_MS`, `.env` mein change kar sakte ho) - taaki AI/WordPress API pe load na aaye.
4. Same website ka agla post (agar `dailyLimit` abhi bhi allow karta hai) - step 2 se repeat.
5. Website ke saare due posts ho jaane ke baad (ya `dailyLimit` reach hone ke baad), **turant** agli website ki baari aati hai - koi extra wait nahi.

Dashboard pe **"Check for new posts"** button se turant manually bhi check kar sakte ho, wait karne ki zarurat nahi.

### Start/Stop - sab logon ke liye shared, sirf midnight pe auto-stop
Start/Stop button ka state MongoDB mein store hota hai (session/cookie ke bharose nahi) - to jitne bhi log (3-4 admin) same dashboard login use karte hain, sabko exactly same live state dikhta hai: kisi ne bhi Start/Stop dabaya ho, baaki sabke dashboard pe turant reflect hoga.

Ek baar Start dabane ke baad, worker chalta rehta hai - dashboard tab band karna, reload karna, ya browser band karna, kuch bhi isse rukta nahi. Ye sirf do tarike se rukta hai: (1) koi bhi Stop button dabaye, ya (2) har raat **midnight IST (India time)** pe apne aap ek baar stop ho jaata hai - taaki har naye din ke liye Start dobara dabana pade. Beech mein agar Stop nahi dabaya to poora din chalta rahega.

## How source scraping works
For any given category URL, the scraper:
1. Checks if it's an RSS/Atom feed (by content, not by URL) - if so, uses that directly, since feeds are the cleanest source.
2. Otherwise, fetches the page with a plain HTTP request (fast) and tries to find post links / article content in the HTML.
3. If that comes back empty or too thin (common with React/Next.js/Vue sites that render content client-side), it falls back to a real headless browser (Playwright) that loads the page like a normal visitor would, then extracts the same way.

This means the same "source category page URL" field works regardless of what the source site is built with.

## Env keys
- `MONGODB_URI` - mongodb.com/cloud/atlas (free)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` - dashboard login credentials
- `SESSION_SECRET` - random string used to sign login sessions (see `.env.example` for how to generate one)
- `GEMINI_API_KEY` - aistudio.google.com/apikey (free, content rewrite - primary)
- `GROQ_API_KEY` - console.groq.com/keys (free, content rewrite fallback) - optional but recommended at scale
- `OPENROUTER_API_KEY` - openrouter.ai/keys (free, content rewrite fallback) - optional but recommended at scale
- `PEXELS_API_KEY` - pexels.com/api (free, feature image)
- `PIXABAY_API_KEY` - pixabay.com/api/docs (free, image fallback) - optional but recommended at scale
- `UNSPLASH_ACCESS_KEY` - unsplash.com/developers (free, image fallback) - optional. Note: Unsplash's API terms restrict "non-automated" use, so review their terms before relying on this fallback in an automated pipeline.
- `SUCCESS_GAP_MS` - gap (ms) between two posts of the *same* website (default: `30000` = 30s) - optional
- `FAILURE_BACKOFF_MS` - gap (ms) after a failed generate/publish before trying the next post (default: `120000` = 2min) - optional
- `POST_RETENTION_DAYS` - how many days of fetched posts to keep before auto-deleting (default: `5`) - optional
- `CLEANUP_INTERVAL_MS` - how often to sweep for old posts once running (default: `86400000` = 24h) - optional

## Content rewriting
3 providers try hote hain order mein: **Gemini → Groq → OpenRouter**. Agar Gemini busy/rate-limited ho ya quota khatam ho jaye, automatically Groq pe switch ho jata hai, fir OpenRouter pe. Groq/OpenRouter keys na ho to bhi system Gemini pe hi chalega - bas keys add karne se scale pe reliability badh jati hai aur kaam rukta nahi.

### Retries aur rate-limit handling
Content generate karte waqt 400/429 jaise errors seedhe post ko "failed" nahi bana dete - pehle system khud retry karta hai:
1. **429 (rate limited) ya 5xx / network error** - wahi provider 3 baar tak retry hota hai, har baar zyada wait ke saath (agar provider `Retry-After` header bhejta hai to wahi respect hota hai).
2. Ek provider bilkul fail ho jaye (retries ke baad bhi) to turant **agle provider** pe switch ho jata hai (Gemini → Groq → OpenRouter).
3. Agar **teeno providers** ek pass mein fail ho jayein, to system 20 second wait karke **poora chain phir se try karta hai** - total 3 rounds tak.
4. Sirf tab post `"failed"` mark hota hai jab in sab retries/rounds ke baad bhi koi provider kaam na kare (yeh sign hai ki sab providers ki free quota us waqt khatam ho chuki hai).
5. Bahut lambi source content ko automatically trim kar diya jata hai (~12000 characters) taaki "content too large" jaisa 400 error na aaye.

In sab ko `.env` se tune kiya ja sakta hai (defaults theek hain, generally change karne ki zaroorat nahi):
- `AI_RETRIES_PER_PROVIDER` (default 3)
- `AI_RETRY_BASE_DELAY_MS` (default 8000)
- `AI_FULL_ROUNDS` (default 3)
- `AI_ROUND_DELAY_MS` (default 20000)
- `AI_MAX_CONTENT_CHARS` (default 12000)

## SEO
Every time an article is generated, the AI also produces a full SEO bundle alongside the rewrite: a focus keyword, an SEO-optimized title (50-60 chars), a meta description (150-160 chars), a clean URL slug, 3-5 tags, and descriptive image alt-text. The writing itself is also prompted to go beyond a plain reword - adding context/depth the source didn't cover, using proper H2 subheadings, and naturally working in the focus keyword + related terms - since that's what actually helps a page rank, not just the metadata being technically correct.

Right after generation, a rule-based checklist scorer (`lib/seoScorer.js`, same idea as Yoast/RankMath's checklist - no extra API call, runs instantly) checks things like: keyword in title/intro/a subheading, title & meta-description length, slug quality, content length (600+ words), heading structure, and image alt-text. This produces a **0-100% score** shown as a badge next to every post on the dashboard (green 80%+, amber 50-79%, red under 50%) - hover it to see exactly which checks failed. The dashboard's overview page also shows the average SEO score across all posts, and each post shows a tag for which category (on your own site) it's going into.

On publish, the slug and meta description (as the WordPress excerpt) are always sent - these work on any WordPress site with no plugin needed. If you also set **SEO plugin: Yoast / Rank Math** when adding a website, the meta description and focus keyword are additionally sent to that plugin's own fields, which is what actually shows up in its metabox/snippet preview in wp-admin (this only takes effect if that plugin is installed and has those fields registered for REST access - if not, WordPress just ignores the extra fields, so it's safe either way).

**Important:** this score measures on-page technical SEO signals - it does not guarantee a Google ranking. Actual ranking also depends on content uniqueness/quality (which the improved prompt targets), how fast the page gets crawled, and your domain's overall authority/backlinks, none of which a 100% checklist score can force on its own.

## Feature images
5 free sources try hote hain order mein: **Wikipedia → Pexels → Pixabay → Unsplash → Openverse** (Wikipedia/Openverse ko key nahi chahiye). Jo pehla mil jaye wahi use hota hai.

## Data cleanup
- **Old posts auto-delete**: Posts are only kept for **5 days** from when they were fetched (`POST_RETENTION_DAYS` in `.env` to change). This runs once at startup and then once a day automatically, so the dashboard/database doesn't keep piling up with old entries. Already-published posts stay live on your site regardless - this only clears the internal record.
- **Stale error messages**: If a post failed once but later succeeded on a retry, its old error text is automatically cleared so the dashboard doesn't keep showing an error next to a post that's actually fine now.

## Testing
See `tests/` for a small dependency-free test suite covering the pure logic (URL resolution, RSS content sniffing, prompt building, auth comparison). Run it with:
```
node --test tests/*.test.js
```
This doesn't require `npm install` since it avoids importing axios/cheerio/playwright/mongoose directly. Once you've run `npm install`, you can exercise the scraper/AI/image modules for real against live URLs and keys.

## Note
There's no `package-lock.json` committed - `npm install` will generate one the first time you run it (it wasn't possible to generate it here without network access). Commit the generated lockfile so builds are reproducible.# SEO-Friendly-Poster
