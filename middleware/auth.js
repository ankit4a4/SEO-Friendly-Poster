// Blocks API requests that don't have a logged-in session. Returns JSON so the
// frontend's api() helper can detect it and redirect to the login page.
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

// Blocks full-page requests (the dashboard itself) and redirects to /login.html
// instead of returning JSON, since a browser navigating here expects a page.
function requirePage(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect("/login.html");
}

module.exports = { requireAuth, requirePage };
