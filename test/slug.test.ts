import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("slugify basic title", () => {
  assert.equal(slugify("Fix login bug"), "fix-login-bug");
});

test("slugify collapses punctuation and repeated separators", () => {
  assert.equal(slugify("Add   dark_mode!! (v2)"), "add-dark-mode-v2");
});

test("slugify trims leading/trailing separators", () => {
  assert.equal(slugify("  --Hello World--  "), "hello-world");
});

test("slugify lowercases mixed case", () => {
  assert.equal(slugify("Refactor API Layer"), "refactor-api-layer");
});
