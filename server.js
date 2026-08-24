require("dotenv").config();
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const Site = require("./models/Site");
const Post = require("./models/Post");
const WorkerState = require("./models/WorkerState");
const cron = require("node-cron");
const { uploadImage, publishPost } = require("./services/wordpress");
const { fetchSourcePosts, closeBrowser } = require("./services/scraper");
const { rewrite } = require("./services/ai");
const { findAnyImage, guaranteedFallbackImage, findPersonPhoto } = require("./services/image");
const { requireAuth, requirePage } = require("./middleware/auth");

const app = express();
app.set("trust proxy", 1); // needed so req.ip / secure cookies work correctly behind a reverse proxy (Render, Docker, etc)

// Gap between finishing one full pass over all sites and starting the next (default: 1 minute)
const CYCLE_GAP_MS = Number(process.env.CYCLE_GAP_MS) || 60 * 1000;
// Pause after a failed publish before moving on to the next post (default: 2 minutes)
const FAILURE_BACKOFF_MS = Number(process.env.FAILURE_BACKOFF_MS) || 2 * 60 * 1000;
// Gap between two posts of the SAME site (generate -> publish -> wait -> next post), so the AI/WP APIs don't get hammered (default: 30 seconds)
const SUCCESS_GAP_MS = Number(process.env.SUCCESS_GAP_MS) || 30 * 1000;

if (!process.env.SESSION_SECRET) {
  console.warn("⚠️  SESSION_SECRET is not set in .env - using a random one-off value (sessions won't survive a restart).");
}

app.use(cors());
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production", // requires HTTPS in production
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Login/logout endpoints are public; everything else below requires a session.
// API responses are dynamic/private data - never let the browser cache them
// (this was causing stale/empty 304 responses to hide real data on the dashboard).
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/api/auth", require("./routes/auth"));

app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/", requirePage, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use("/api/sites", requireAuth, require("./routes/sites"));
app.use("/api/posts", requireAuth, require("./routes/posts"));

let nextCycleAt = null;

// `paused` is kept in memory purely as a fast read-through cache -
// models/WorkerState.js in MongoDB is the real source of truth, so all 3-4 people
// logged into the same dashboard see the exact same live start/stop state, and it
// survives a server restart. Every write to `paused` below is mirrored to the DB.
// NOTE: closing/reloading the dashboard tab does NOT stop it anymore - once
// Start is pressed it keeps running regardless of tabs, until either Stop is
// pressed, or midnight (see the cron job below) resets it for the new day.
let paused = false; // by default the worker runs; Stop pauses it, Start resumes it

// Which site is actively being generated/published right now (null = none) -
// lets the dashboard highlight that site in the sidebar in real time.
let currentSiteId = null;
let currentSiteName = null;

async function setPaused(value, { startedBy } = {}) {
  paused = value;
  const update = { paused: value };
  if (startedBy !== undefined) update.startedBy = startedBy;
  await WorkerState.updateOne({ _id: "worker" }, { $set: update }, { upsert: true });
}

// GET /api/status - tells the dashboard when the next auto-check pass will start,
// and which site (if any) is currently being posted to.
app.get("/api/status", requireAuth, (req, res) => {
  res.json({
    nextRunAt: nextCycleAt ? nextCycleAt.toISOString() : null,
    paused,
    currentSiteId,
    currentSiteName,
  });
});

// POST /api/worker/start - resumes auto-posting (reacts within a few seconds).
// Stays running even if every dashboard tab is closed/reloaded - only Stop,
// or the midnight reset below, will pause it again.
app.post("/api/worker/start", requireAuth, async (req, res) => {
  await setPaused(false, { startedBy: req.session.username || null });
  if (!isRunning) {
    clearTimeout(cycleTimer);
    runCycle();
  }
  res.json({ paused });
});

// POST /api/worker/stop - pauses auto-posting. A post already in progress finishes,
// but no new post will be started until Start is pressed again.
app.post("/api/worker/stop", requireAuth, async (req, res) => {
  await setPaused(true);
  res.json({ paused });
});

// Every day at midnight IST (India time - not the server's own timezone, since
// Render runs in UTC), auto-posting is stopped so a fresh "Start" press is
// required for the new day - this is the ONLY automatic stop; tab
// close/reload/reboot of the browser has no effect on it anymore.
cron.schedule(
  "0 0 * * *",
  async () => {
    console.log("🌙 New day (midnight IST) - auto-posting stopped automatically. Press Start to resume today.");
    await setPaused(true);
  },
  { timezone: "Asia/Kolkata" }
);

// ---------------------------------------------------------------------------
// One-time migration: sites created before the "direct category URL" update
// still have the old sourceUrl/sourceType/sourceCategoryId fields instead of
// sourceCategoryUrl. This finds them and fills in sourceCategoryUrl so they
// keep working without needing to be re-added by hand.
// ---------------------------------------------------------------------------
async function migrateLegacySites() {
  const legacy = await mongoose.connection.db
    .collection("sites")
    .find({ sourceCategoryUrl: { $exists: false }, sourceUrl: { $exists: true } })
    .toArray();

  if (legacy.length === 0) return;
  console.log(`🔧 Migrating ${legacy.length} site(s) added before the "source category URL" update...`);

  for (const doc of legacy) {
    let sourceCategoryUrl = null;
    try {
      if (doc.sourceType === "wordpress" && doc.sourceCategoryId && /^\d+$/.test(doc.sourceCategoryId)) {
        // Old WordPress flow stored a numeric category ID - resolve it to the real category page URL
        const res = await axios.get(`${doc.sourceUrl}/wp-json/wp/v2/categories/${doc.sourceCategoryId}`);
        sourceCategoryUrl = res.data.link;
      } else if (doc.sourceCategoryId) {
        // Old "generic"/"rss" flow already stored the category page URL directly
        sourceCategoryUrl = doc.sourceCategoryId;
      } else {
        // No category had been selected - fall back to the site's homepage
        sourceCategoryUrl = doc.sourceUrl;
      }
    } catch (err) {
      console.error(`   ⚠️  Could not auto-migrate "${doc.name}": ${err.message}. Delete and re-add it from the dashboard with the new URL field.`);
      continue;
    }

    await mongoose.connection.db.collection("sites").updateOne(
      { _id: doc._id },
      {
        $set: { sourceCategoryUrl },
        $unset: { sourceUrl: "", sourceType: "", sourceCategoryId: "", sourceCategoryName: "" },
      }
    );
    console.log(`   ✅ "${doc.name}" -> ${sourceCategoryUrl}`);
  }
}

// ---------------------------------------------------------------------------
// One-time cleanup: before this version, a post's errorMessage was never
// cleared after it went on to succeed (generate/publish worked on a later
// try) - so the old error text kept showing next to a "Ready to publish" /
// "Published" post, even though nothing was actually wrong anymore. This
// clears that leftover text for any post that isn't currently "failed".
// ---------------------------------------------------------------------------
async function migrateStaleErrors() {
  const result = await Post.updateMany(
    { status: { $ne: "failed" }, errorMessage: { $exists: true, $ne: null } },
    { $unset: { errorMessage: "" } }
  );
  if (result.modifiedCount > 0) {
    console.log(`🔧 Cleared stale error messages on ${result.modifiedCount} post(s) that had already succeeded.`);
  }
}

// How many days of fetched posts to keep before they're deleted (default: 5 days)
const POST_RETENTION_DAYS = Number(process.env.POST_RETENTION_DAYS) || 5;
// How often to sweep for old posts once the server is running (default: once a day)
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deletes posts older than POST_RETENTION_DAYS (based on when they were first
// fetched from the source). Keeps the dashboard/DB from filling up with old
// entries - the site already has any published post live regardless, this is
// just the internal queue/log. Runs once at startup, then on a daily timer.
// ---------------------------------------------------------------------------
async function cleanupOldPosts() {
  const cutoff = new Date(Date.now() - POST_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await Post.deleteMany({ createdAt: { $lt: cutoff } });
  if (result.deletedCount > 0) {
    console.log(`🧹 Removed ${result.deletedCount} post(s) older than ${POST_RETENTION_DAYS} day(s).`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Processes a single site: fetch its source posts, then generate + publish
// them one at a time up to its daily limit. A failed post gets a 2-minute
// backoff before the next one is attempted, so we don't hammer a provider
// that's rate-limiting or down.
// ---------------------------------------------------------------------------
async function processSite(site) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  if (site.dailyLimit > 0) {
    // Posts left over from previous days shouldn't count toward today's auto work.
    // Status stays "pending" - they can still be generated/published manually from the dashboard.
    await Post.updateMany(
      { siteId: site._id, status: "pending", createdAt: { $lt: todayStart } },
      { $set: { autoExcluded: true } }
    );
  }

  let postedToday = site.dailyLimit > 0
    ? await Post.countDocuments({ siteId: site._id, status: "posted", updatedAt: { $gte: todayStart } })
    : 0;

  const doneIds = new Set(
    (await Post.find({ siteId: site._id }).select("sourcePostId")).map((p) => p.sourcePostId)
  );

  // Only fetch full content for as many NEW articles as this site could actually still
  // post today (plus a small buffer in case a couple turn out to be duplicates/unusable) -
  // not every new link on the page. See fetchSourcePosts' comment in scraper.js for why:
  // without this cap, a big backlog of new links would all get scraped (slowly) before
  // even the first post of the day gets generated.
  const remainingToday = site.dailyLimit > 0 ? Math.max(site.dailyLimit - postedToday, 0) : 20;
  const maxToFetch = remainingToday === 0 ? 0 : remainingToday + 3;
  const sourcePosts = maxToFetch > 0 ? await fetchSourcePosts(site, doneIds, maxToFetch) : [];

  // Did this site actually generate/publish anything this pass? Returned for
  // logging/future use - there's no inter-site gap anymore, so runCycle moves
  // on to the next site immediately regardless of this value.
  let didWork = false;

  try {
    for (const sp of sourcePosts) {
      if (paused) break; // Stop was pressed - leave the rest for when Start is pressed again
      const limitReached = site.dailyLimit > 0 && postedToday >= site.dailyLimit;

      let post = await Post.findOne({ siteId: site._id, sourcePostId: String(sp.id) });
      if (!post) {
        post = await Post.create({
          siteId: site._id,
          sourcePostId: String(sp.id),
          sourceTitle: sp.title,
          sourceContent: sp.content,
          sourceLink: sp.link,
          sourceImage: sp.image || null,
          autoExcluded: limitReached, // today's limit is already reached - only publishable manually
        });
      }
      if (post.status !== "pending" || post.autoExcluded) continue;

      // Mark this site as "active" only once we actually start working on a post -
      // this is what the dashboard highlights, and only ONE post (of ONE site) is
      // ever generated/published at a time across the whole app.
      currentSiteId = site._id.toString();
      currentSiteName = site.name;
      didWork = true;

      try {
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

        if (!result.passed) {
          // Publishing gate: still below the SEO threshold after the one auto-fix
          // attempt - hold for manual review instead of auto-publishing (main goal
          // of this pipeline). Don't count it against today's post limit.
          post.status = "seo_review_required";
          post.errorMessage = undefined;
          await post.save();
          console.log(`📝 "${result.title}" held for SEO review (score ${result.seo.score}/100) - ${site.name}`);
          await sleep(SUCCESS_GAP_MS);
          continue;
        }

        post.status = "generated";
        post.errorMessage = undefined; // clear any error left over from a previous failed attempt
        await post.save(); // saved so the dashboard can show "Ready to publish" mid-flight on refresh

        // Always use royalty-free stock-photo search (Wikipedia/Pexels/Pixabay/Unsplash/Openverse) -
        // NEVER the source article's own image. The source's image belongs to that publisher
        // (Forbes/TechCrunch/etc) and republishing it directly is a copyright risk - that's
        // exactly why the stock-photo APIs were added. findAnyImage() always returns something
        // (it has its own guaranteed fallback), so imageUrl is never null here.
        const imageUrl = (await findPersonPhoto(post.sourceTitle)) || (await findAnyImage(post.sourceTitle, site.imageKeyword));
        let mediaId = null;
        try {
          mediaId = await uploadImage(site, imageUrl, result.imageAlt, post.slug);
        } catch (e) {
          // The source's image URL might be broken/unreachable/blocked - don't let that
          // fail the whole post. Retry once with a fresh guaranteed fallback image so the
          // post still gets published with SOME image rather than none.
          try {
            mediaId = await uploadImage(site, guaranteedFallbackImage(), result.imageAlt, post.slug);
          } catch (e2) {
            // Both attempts failed (likely a WordPress/network issue, not an image issue) -
            // proceed without a featured image rather than failing the whole post.
            mediaId = null;
          }
        }
        post.publishedUrl = await publishPost(site, result.title, result.content, mediaId, {
          slug: post.slug,
          excerpt: post.excerpt,
          metaDescription: post.metaDescription,
          focusKeyword: post.focusKeyword,
          seoTitle: post.seoTitle,
          tags: post.tags,
        });
        post.status = "posted";
        postedToday++;
        await post.save();
        console.log(`✅ Posted "${result.title}" -> ${site.name}`);
        // Wait before the NEXT post of this same site so we don't hammer the AI/WordPress APIs
        await sleep(SUCCESS_GAP_MS);
      } catch (err) {
        post.status = "failed";
        post.errorMessage = err.message;
        await post.save();
        console.error(`❌ Failed for ${site.name}: ${err.message} - waiting ${FAILURE_BACKOFF_MS / 60000} min before continuing`);
        await sleep(FAILURE_BACKOFF_MS);
      }
    }
  } finally {
    // Site's turn is over (or it errored out) - clear the highlight either way.
    if (currentSiteId === site._id.toString()) {
      currentSiteId = null;
      currentSiteName = null;
    }
  }

  return didWork;
}

// Prevents overlapping cycles - if one is still going (e.g. a slow site), a new one won't start
let isRunning = false;
let stopping = false;
let cycleTimer = null;

async function runCycle() {
  if (isRunning || stopping) return;

  if (paused) {
    // Do no work while paused, but keep polling every few seconds so Start reacts fast.
    nextCycleAt = null;
    cycleTimer = setTimeout(runCycle, 3000);
    return;
  }

  isRunning = true;
  try {
    const sites = await Site.find({ active: true });
    for (const site of sites) {
      if (paused) break; // Stop was pressed mid-pass
      // Each site runs in its own try/catch - one broken/slow/unreachable source
      // must not stop the other sites in this pass from being checked. As soon
      // as this site's batch/limit is done we move straight to the next one -
      // no artificial gap in between.
      try {
        await processSite(site);
      } catch (err) {
        console.error(`❌ Skipping "${site.name}" this pass:`, err.message);
      }
    }
  } catch (err) {
    console.error("Cycle error:", err.message);
  } finally {
    isRunning = false;
  }

  if (!stopping) {
    nextCycleAt = paused ? null : new Date(Date.now() + CYCLE_GAP_MS);
    cycleTimer = setTimeout(runCycle, paused ? 3000 : CYCLE_GAP_MS);
  }
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("✅ Connected to MongoDB");
    await migrateLegacySites();
    await migrateStaleErrors();
    await cleanupOldPosts();
    setInterval(cleanupOldPosts, CLEANUP_INTERVAL_MS); // keep sweeping old posts daily while the server runs

    // Restore the shared start/stop state from the DB (survives a restart) -
    // stays exactly as it was left; a server restart alone never stops it.
    const saved = await WorkerState.findOneAndUpdate(
      { _id: "worker" },
      { $setOnInsert: { paused: false } },
      { upsert: true, new: true }
    );
    paused = saved.paused;

    runCycle(); // start the continuous worker once we're connected
  })
  .catch((err) => console.error("❌ MongoDB error:", err.message));

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));

// Closes the shared Playwright browser cleanly so the process can exit
// (important in Docker, otherwise the container can hang on stop).
async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  stopping = true;
  if (cycleTimer) clearTimeout(cycleTimer);
  server.close();
  await closeBrowser();
  await mongoose.connection.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));