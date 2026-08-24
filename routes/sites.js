const express = require("express");
const router = express.Router();
const Site = require("../models/Site");
const { getCategories } = require("../services/wordpress");

router.get("/", async (req, res) => {
  res.json(await Site.find().select("-appPassword"));
});

router.post("/", async (req, res) => {
  try {
    res.json(await Site.create(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sites/:id - edit an existing website's details.
// appPassword is optional here: if left blank on the edit form, we don't touch
// the one already saved, so the user isn't forced to re-enter it every time.
router.put("/:id", async (req, res) => {
  try {
    const update = { ...req.body };
    if (!update.appPassword) delete update.appPassword;
    const site = await Site.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });
    if (!site) return res.status(404).json({ error: "Site not found" });
    res.json(site);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  await Site.findByIdAndDelete(req.params.id);
  res.json({ message: "deleted" });
});

// GET /api/sites/categories?url=https://example.com
// Used only for YOUR OWN WordPress site, to pick which category new posts go into.
// (The source site no longer needs this - you paste its category page URL directly.)
router.get("/categories", async (req, res) => {
  try {
    const cats = await getCategories(req.query.url);
    res.json({ categories: cats });
  } catch (err) {
    res.status(500).json({ error: "Could not load categories: " + err.message });
  }
});

module.exports = router;