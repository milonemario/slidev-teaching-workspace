import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkspaceConfig, parseYamlObject, writeWorkspaceInterface } from "../dist/config.js";
import { commandFor } from "../dist/commands.js";
import { categorizeDeck, deckCoverUrl, discoverDecks, humanizeDeckName } from "../dist/decks.js";

test("parses the workspace yaml shape used by the teaching repo", () => {
  const parsed = parseYamlObject(`
categories:
  - id: data-analytics
    label: "Data Analytics"
    cover: "./Data_Analytics/Current/Canvas-Image.jpg"
    subcategories:
      - id: lectures
        label: "Lectures"
        slidesDir: "./A"
outputDir: "./dist/slidev-workspace"
baseUrl: "/teaching/"
interface:
  theme: "modern"
`);

  assert.equal(parsed.categories[0].label, "Data Analytics");
  assert.equal(parsed.categories[0].cover, "./Data_Analytics/Current/Canvas-Image.jpg");
  assert.equal(parsed.categories[0].subcategories[0].slidesDir, "./A");
  assert.equal(parsed.outputDir, "./dist/slidev-workspace");
  assert.deepEqual(parsed.interface, {
    theme: "modern",
  });
});

test("loads interface defaults and writes interface selection to yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "slidev-teaching-interface-"));
  writeFileSync(join(root, "slidev-teaching-workspace.yaml"), `
slidesDir:
  - "./Decks"
outputDir: "./dist/slidev-workspace"
`);

  const config = loadWorkspaceConfig(root);
  assert.deepEqual(config.interface, {
    theme: "classic",
  });

  const updated = writeWorkspaceInterface(config, {
    theme: "modern",
  });
  assert.deepEqual(updated.interface, {
    theme: "modern",
  });

  const written = readFileSync(join(root, "slidev-teaching-workspace.yaml"), "utf8");
  assert.match(written, /outputDir: "\.\/dist\/slidev-workspace"/);
  const parsed = parseYamlObject(written);
  assert.deepEqual(parsed.slidesDir, ["./Decks"]);
  assert.deepEqual(parsed.interface, {
    theme: "modern",
  });
});

test("discovers decks and derives teaching categories", () => {
  const root = mkdtempSync(join(tmpdir(), "slidev-teaching-workspace-"));
  const deckDir = join(root, "Strategic_Cost_Management/Current/Lectures/Slidev/Lecture01_partI");
  mkdirSync(deckDir, { recursive: true });
  writeFileSync(join(root, "slidev-teaching-workspace.yaml"), `
categories:
  - id: strategic-cost-management
    label: "Strategic Cost Management"
    cover: "./Strategic_Cost_Management/Current/Canvas-Image.jpg"
    subcategories:
      - id: lectures
        label: "Lectures"
        slidesDir: "./Strategic_Cost_Management/Current/Lectures/Slidev"
outputDir: "./dist/slidev-workspace"
baseUrl: "/teaching/"
`);
  writeFileSync(join(deckDir, "package.json"), "{}");
  writeFileSync(join(deckDir, "slides.md"), `---
theme: ucsd
title: Strategic Cost Management & New Technologies
cover: ./cover.jpg
workspace:
  order: 10
---
`);

  const config = loadWorkspaceConfig(root);
  const decks = discoverDecks(config);

  assert.equal(decks.length, 1);
  assert.equal(decks[0].id, "Strategic_Cost_Management/Current/Lectures/Slidev/Lecture01_partI");
  assert.equal(decks[0].label, "Lecture 01 Part I");
  assert.equal(decks[0].categoryId, "strategic-cost-management");
  assert.equal(decks[0].subcategoryId, "lectures");
  assert.equal(decks[0].course, "Strategic Cost Management");
  assert.equal(decks[0].section, "Lectures");
  assert.equal(decks[0].theme, "ucsd");
  assert.equal(decks[0].cover, "./cover.jpg");
  assert.equal(decks[0].coverBaseDir, deckDir);
  assert.equal(decks[0].workspaceOrder, 10);
  assert.equal(
    deckCoverUrl(decks[0]),
    "/api/deck-cover?id=Strategic_Cost_Management%2FCurrent%2FLectures%2FSlidev%2FLecture01_partI",
  );
});

test("sorts decks by workspace frontmatter order before natural fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "slidev-teaching-workspace-order-"));
  const slidesRoot = join(root, "Decks");
  mkdirSync(slidesRoot, { recursive: true });
  writeFileSync(join(root, "slidev-teaching-workspace.yaml"), `
categories:
  - id: strategic-cost-management
    label: "Strategic Cost Management"
    subcategories:
      - id: lectures
        label: "Lectures"
        slidesDir: "./Decks"
`);

  for (const [slug, workspace] of [
    ["Lecture01", ""],
    ["Lecture02", 'workspace:\n  order: "2"\n'],
    ["Lecture10", "workspace:\n  order: 1\n"],
  ]) {
    const deckDir = join(slidesRoot, slug);
    mkdirSync(deckDir, { recursive: true });
    writeFileSync(join(deckDir, "package.json"), "{}");
    writeFileSync(join(deckDir, "slides.md"), `---\n${workspace}---\n`);
  }

  const decks = discoverDecks(loadWorkspaceConfig(root));

  assert.deepEqual(
    decks.map((deck) => deck.slug),
    ["Lecture10", "Lecture02", "Lecture01"],
  );
  assert.deepEqual(
    decks.map((deck) => deck.workspaceOrder),
    [1, 2, undefined],
  );
});

test("uses category cover when deck frontmatter has no cover", () => {
  const root = mkdtempSync(join(tmpdir(), "slidev-teaching-workspace-cover-"));
  const deckDir = join(root, "Decks/Lecture01_partI");
  mkdirSync(deckDir, { recursive: true });
  writeFileSync(join(root, "slidev-teaching-workspace.yaml"), `
categories:
  - id: strategic-cost-management
    label: "Strategic Cost Management"
    cover: "./Strategic_Cost_Management/Current/Canvas-Image.jpg"
    subcategories:
      - id: lectures
        label: "Lectures"
        slidesDir: "./Decks"
`);
  writeFileSync(join(deckDir, "package.json"), "{}");
  writeFileSync(join(deckDir, "slides.md"), `---
title: Strategic Cost Management & New Technologies
---
`);

  const config = loadWorkspaceConfig(root);
  const decks = discoverDecks(config);

  assert.equal(decks.length, 1);
  assert.equal(decks[0].cover, "./Strategic_Cost_Management/Current/Canvas-Image.jpg");
  assert.equal(decks[0].coverBaseDir, root);
});

test("categorizes known deck roots", () => {
  assert.deepEqual(categorizeDeck("Strategic_Cost_Management/Current/Cases/Slidev/Wilkerson"), {
    categoryId: "strategic-cost-management",
    subcategoryId: "cases",
    course: "Strategic Cost Management",
    section: "Cases",
  });
  assert.deepEqual(categorizeDeck("Data_Analytics/Current/Lectures/Slidev/Lecture_OLS"), {
    categoryId: "data-analytics",
    subcategoryId: "lectures",
    course: "Data Analytics",
    section: "Lectures",
  });
});

test("builds command specs for global and local modes", () => {
  const deck = {
    id: "Data_Analytics/Current/Lectures/Slidev/Lecture_OLS",
    dir: tmpdir(),
    relativePath: "Data_Analytics/Current/Lectures/Slidev/Lecture_OLS",
    slug: "Lecture_OLS",
    label: "Lecture OLS",
    categoryId: "data-analytics",
    subcategoryId: "lectures",
    course: "Data Analytics",
    section: "Lectures",
    categoryOrder: 0,
    subcategoryOrder: 0,
  };

  const previous = process.env.SLIDEV_WORKSPACE_SLIDEV_BIN;
  process.env.SLIDEV_WORKSPACE_SLIDEV_BIN = "slidev";
  assert.deepEqual(commandFor("dev", deck, { port: 3031, remote: "", bind: "0.0.0.0" }).args, [
    "slides.md",
    "--port",
    "3031",
    "--open",
    "false",
    "--remote",
    "--bind",
    "0.0.0.0",
  ]);
  assert.deepEqual(commandFor("dev", deck, { port: 3031, remote: "secret", bind: "0.0.0.0" }).args, [
    "slides.md",
    "--port",
    "3031",
    "--open",
    "false",
    "--remote",
    "secret",
    "--bind",
    "0.0.0.0",
  ]);
  assert.deepEqual(commandFor("dev", deck, { port: 3031 }).args, [
    "slides.md",
    "--port",
    "3031",
    "--open",
    "false",
  ]);

  if (previous === undefined) {
    delete process.env.SLIDEV_WORKSPACE_SLIDEV_BIN;
  } else {
    process.env.SLIDEV_WORKSPACE_SLIDEV_BIN = previous;
  }
});

test("humanizes deck folder names", () => {
  assert.equal(humanizeDeckName("Lecture01_partII"), "Lecture 01 Part II");
  assert.equal(humanizeDeckName("BirchPaper"), "Birch Paper");
});
