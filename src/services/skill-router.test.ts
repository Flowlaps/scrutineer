import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDynamicSkillInstructions } from "./skill-router.js";

test("returns empty instructions and no triggered categories when nothing matches", () => {
  const result = buildDynamicSkillInstructions(["src/services/ast-parser.ts"]);

  assert.equal(result.codeReviewerAdditions, "");
  assert.equal(result.securityAuditorAdditions, "");
  assert.deepEqual(result.triggeredCategories, []);
});

test("detects frontend files by page.tsx, layout.tsx, and a components/ path segment", () => {
  for (const file of ["src/app/page.tsx", "src/app/dashboard/layout.tsx", "src/components/Button.tsx"]) {
    const result = buildDynamicSkillInstructions([file]);
    assert.deepEqual(result.triggeredCategories, ["frontend"], `expected "${file}" to trigger frontend`);
    assert.match(result.codeReviewerAdditions, /React Architecture & Performance Auditor/);
    assert.equal(result.securityAuditorAdditions, "");
  }
});

test("detects backend/data files by route.ts, schema.ts, a prisma/ path segment, and .sql", () => {
  for (const file of ["src/app/api/users/route.ts", "src/db/schema.ts", "prisma/migrations/init.sql", "seed.sql"]) {
    const result = buildDynamicSkillInstructions([file]);
    assert.deepEqual(result.triggeredCategories, ["backend"], `expected "${file}" to trigger backend`);
    assert.match(result.codeReviewerAdditions, /Type Wizard/);
    assert.match(result.securityAuditorAdditions, /Backend Security Auditor/);
  }
});

test("detects config files by package.json and next.config.ts/js/mjs", () => {
  for (const file of ["package.json", "next.config.ts", "next.config.js", "next.config.mjs"]) {
    const result = buildDynamicSkillInstructions([file]);
    assert.deepEqual(result.triggeredCategories, ["config"], `expected "${file}" to trigger config`);
    assert.equal(result.codeReviewerAdditions, "");
    assert.match(result.securityAuditorAdditions, /Dependency & Environment Auditor/);
  }
});

test("detects lockfiles (pnpm-lock.yaml, package-lock.json, yarn.lock) as config", () => {
  for (const file of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const result = buildDynamicSkillInstructions([file]);
    assert.deepEqual(result.triggeredCategories, ["config"], `expected "${file}" to trigger config`);
    assert.equal(result.codeReviewerAdditions, "");
    assert.match(result.securityAuditorAdditions, /Dependency & Environment Auditor/);
  }
});

test("combines instructions across categories when a batch touches multiple file types", () => {
  const result = buildDynamicSkillInstructions([
    "src/app/page.tsx",
    "src/app/api/route.ts",
    "package.json",
    "pnpm-lock.yaml",
  ]);

  assert.deepEqual(result.triggeredCategories, ["frontend", "backend", "config"]);
  assert.match(result.codeReviewerAdditions, /React Architecture/);
  assert.match(result.codeReviewerAdditions, /Type Wizard/);
  assert.match(result.securityAuditorAdditions, /Backend Security Auditor/);
  assert.match(result.securityAuditorAdditions, /Dependency & Environment Auditor/);
});

test("does not match unrelated files with similar substrings", () => {
  const result = buildDynamicSkillInstructions(["src/services/prismatic.ts", "src/routes-config.ts"]);

  assert.deepEqual(result.triggeredCategories, []);
});
