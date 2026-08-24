const express = require("express");
const { safeCompare, createLoginGuard } = require("../lib/loginGuard");
const router = express.Router();

const guard = createLoginGuard({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });

router.post("/login", (req, res) => {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Admin credentials are not configured on the server (.env)" });
  }

  const ip = req.ip;
  if (guard.isLockedOut(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in a few minutes." });
  }

  const { username, password } = req.body || {};
  const validUser = safeCompare(username || "", process.env.ADMIN_USERNAME);
  const validPass = safeCompare(password || "", process.env.ADMIN_PASSWORD);

  if (!validUser || !validPass) {
    guard.recordFailure(ip);
    return res.status(401).json({ error: "Invalid username or password" });
  }

  guard.clearFailures(ip);
  req.session.loggedIn = true;
  req.session.username = username;
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/status", (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.loggedIn),
    username: req.session?.username || null,
  });
});

module.exports = router;
