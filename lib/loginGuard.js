const crypto = require("crypto");

// Hashes both sides before comparing so crypto.timingSafeEqual always gets
// equal-length buffers (it throws otherwise) and the comparison time doesn't
// leak how much of the input matched.
function safeCompare(a, b) {
  const bufA = crypto.createHash("sha256").update(String(a)).digest();
  const bufB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

// Tracks failed login attempts per key (usually an IP) and locks out after
// too many failures within a time window. Returned as a factory so each
// caller (and each test) gets its own isolated state instead of a shared module map.
function createLoginGuard({ maxAttempts = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map(); // key -> { count, resetAt }

  function isLockedOut(key) {
    const entry = attempts.get(key);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      attempts.delete(key);
      return false;
    }
    return entry.count >= maxAttempts;
  }

  function recordFailure(key) {
    const entry = attempts.get(key) || { count: 0, resetAt: Date.now() + windowMs };
    entry.count++;
    attempts.set(key, entry);
  }

  function clearFailures(key) {
    attempts.delete(key);
  }

  return { isLockedOut, recordFailure, clearFailures };
}

module.exports = { safeCompare, createLoginGuard };
