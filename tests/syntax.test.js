const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "tests"]);

function findJsFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(findJsFiles(full));
    else if (entry.name.endsWith(".js")) results.push(full);
  }
  return results;
}

for (const file of findJsFiles(ROOT)) {
  test(`valid JS syntax: ${path.relative(ROOT, file)}`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }));
  });
}
