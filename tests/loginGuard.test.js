const test = require("node:test");
const assert = require("node:assert/strict");
const { safeCompare, createLoginGuard } = require("../lib/loginGuard");

test("safeCompare() is true only for an exact match", () => {
  assert.equal(safeCompare("hunter2", "hunter2"), true);
  assert.equal(safeCompare("hunter2", "hunter3"), false);
});

test("safeCompare() does not throw on different-length inputs", () => {
  assert.equal(safeCompare("short", "a-much-longer-password"), false);
});

test("safeCompare() treats empty strings as a valid (but only self-matching) input", () => {
  assert.equal(safeCompare("", ""), true);
  assert.equal(safeCompare("", "something"), false);
});

test("loginGuard allows attempts under the limit", () => {
  const guard = createLoginGuard({ maxAttempts: 3, windowMs: 60000 });
  guard.recordFailure("1.2.3.4");
  guard.recordFailure("1.2.3.4");
  assert.equal(guard.isLockedOut("1.2.3.4"), false);
});

test("loginGuard locks out after maxAttempts failures", () => {
  const guard = createLoginGuard({ maxAttempts: 3, windowMs: 60000 });
  guard.recordFailure("1.2.3.4");
  guard.recordFailure("1.2.3.4");
  guard.recordFailure("1.2.3.4");
  assert.equal(guard.isLockedOut("1.2.3.4"), true);
});

test("loginGuard tracks each key independently", () => {
  const guard = createLoginGuard({ maxAttempts: 1, windowMs: 60000 });
  guard.recordFailure("attacker-ip");
  assert.equal(guard.isLockedOut("attacker-ip"), true);
  assert.equal(guard.isLockedOut("innocent-ip"), false);
});

test("loginGuard.clearFailures() resets the lockout (e.g. after a successful login)", () => {
  const guard = createLoginGuard({ maxAttempts: 1, windowMs: 60000 });
  guard.recordFailure("1.2.3.4");
  assert.equal(guard.isLockedOut("1.2.3.4"), true);
  guard.clearFailures("1.2.3.4");
  assert.equal(guard.isLockedOut("1.2.3.4"), false);
});

test("loginGuard lockout expires after the time window passes", () => {
  const guard = createLoginGuard({ maxAttempts: 1, windowMs: 10 });
  guard.recordFailure("1.2.3.4");
  assert.equal(guard.isLockedOut("1.2.3.4"), true);
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(guard.isLockedOut("1.2.3.4"), false);
      resolve();
    }, 20);
  });
});
