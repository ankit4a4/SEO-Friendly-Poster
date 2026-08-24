const test = require("node:test");
const assert = require("node:assert/strict");
const { abs, sameOrigin } = require("../lib/urlUtils");

test("abs() resolves a relative path against a base URL", () => {
  assert.equal(abs("/post/1", "https://example.com/blog"), "https://example.com/post/1");
});

test("abs() leaves an already-absolute URL unchanged", () => {
  assert.equal(abs("https://other.com/x", "https://example.com/blog"), "https://other.com/x");
});

test("abs() resolves protocol-relative URLs", () => {
  assert.equal(abs("//cdn.example.com/img.jpg", "https://example.com"), "https://cdn.example.com/img.jpg");
});

test("abs() returns null for a malformed base URL instead of throwing", () => {
  assert.equal(abs("/post/1", "not-a-valid-base"), null);
});

test("sameOrigin() is true for two URLs on the same host+protocol", () => {
  assert.equal(sameOrigin("https://example.com/a", "https://example.com/b"), true);
});

test("sameOrigin() is false across different hosts", () => {
  assert.equal(sameOrigin("https://evil.com/a", "https://example.com/b"), false);
});

test("sameOrigin() is false across different protocols", () => {
  assert.equal(sameOrigin("http://example.com/a", "https://example.com/b"), false);
});

test("sameOrigin() returns false instead of throwing on malformed input", () => {
  assert.equal(sameOrigin("garbage", "also garbage"), false);
});
