import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceConfig, type WorkspaceConfig } from "./config.js";
import { deckCoverFilePath, deckStaticUrl, discoverDecks, isExternalCover, type Deck } from "./decks.js";

const uiDir = fileURLToPath(new URL("./ui", import.meta.url));

export function buildStaticCatalog(cwd = process.cwd()): string {
  const config = loadWorkspaceConfig(cwd);
  const decks = discoverDecks(config);
  const outDir = resolve(config.rootDir, config.outputDir);

  ensureBuiltUi();
  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, "assets"), { recursive: true, force: true });
  copyUi(uiDir, outDir);
  const coverUrls = copyDeckCovers(config, decks, outDir);

  const indexPath = join(outDir, "index.html");
  const index = readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, injectStaticData(index, config, decks, coverUrls));

  return outDir;
}

export function exportOgImages(cwd = process.cwd()): string {
  const config = loadWorkspaceConfig(cwd);
  const decks = discoverDecks(config);
  const outDir = resolve(config.rootDir, config.outputDir, "og");

  mkdirSync(outDir, { recursive: true });
  for (const deck of decks) {
    writeFileSync(join(outDir, `${deck.slug}.svg`), renderOgSvg(deck));
  }

  return outDir;
}

function ensureBuiltUi(): void {
  if (!existsSync(join(uiDir, "index.html"))) {
    throw new Error("Dashboard UI has not been built. Run `npm run build` in the package directory.");
  }
}

function copyUi(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);

    if (entry.isDirectory()) {
      copyUi(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    }
  }
}

function copyDeckCovers(config: WorkspaceConfig, decks: Deck[], outDir: string): Map<string, string> {
  const coverUrls = new Map<string, string>();
  const coversDir = join(outDir, "covers");
  rmSync(coversDir, { recursive: true, force: true });

  for (const deck of decks) {
    if (!deck.cover) {
      continue;
    }

    if (isExternalCover(deck.cover)) {
      coverUrls.set(deck.id, deck.cover);
      continue;
    }

    const coverPath = deckCoverFilePath(config, deck);
    if (!coverPath || !existsSync(coverPath) || !statSync(coverPath).isFile()) {
      continue;
    }

    const extension = extname(coverPath) || ".jpg";
    const fileName = `${safeAssetName(deck.id)}${extension}`;
    mkdirSync(coversDir, { recursive: true });
    copyFileSync(coverPath, join(coversDir, fileName));
    coverUrls.set(deck.id, `covers/${fileName}`);
  }

  return coverUrls;
}

function injectStaticData(index: string, config: WorkspaceConfig, decks: Deck[], coverUrls: Map<string, string>): string {
  const data = {
    staticMode: true,
    config: {
      baseUrl: config.baseUrl,
      outputDir: config.outputDir,
      interface: config.interface,
      hero: config.hero,
      sidebar: config.sidebar,
    },
    decks: decks.map((deck) => ({
      id: deck.id,
      relativePath: deck.relativePath,
      slug: deck.slug,
      label: deck.label,
      title: deck.title,
      theme: deck.theme,
      coverUrl: coverUrls.get(deck.id),
      workspaceOrder: deck.workspaceOrder,
      categoryId: deck.categoryId,
      subcategoryId: deck.subcategoryId,
      course: deck.course,
      section: deck.section,
      staticUrl: deckStaticUrl(config, deck),
      runtime: { status: "stopped" },
      job: { status: "idle" },
    })),
  };
  const script = `<script>window.__TEACHING_SLIDEV_STATIC_DATA__=${JSON.stringify(data).replace(/</g, "\\u003c")};</script>`;
  return index.replace("<!--STATIC_DATA-->", script);
}

function safeAssetName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function renderOgSvg(deck: Deck): string {
  const title = escapeXml(deck.label);
  const subtitle = escapeXml(deck.title && deck.title !== deck.label ? deck.title : `${deck.course} / ${deck.section}`);
  const course = escapeXml(`${deck.course} / ${deck.section}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f7f4ed"/>
  <rect x="0" y="0" width="1200" height="18" fill="#00629b"/>
  <rect x="0" y="18" width="1200" height="10" fill="#c69214"/>
  <text x="72" y="112" fill="#2b2f33" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700">${course}</text>
  <text x="72" y="286" fill="#111820" font-family="Arial, Helvetica, sans-serif" font-size="82" font-weight="800">${title}</text>
  <text x="76" y="372" fill="#4b5563" font-family="Arial, Helvetica, sans-serif" font-size="38">${subtitle}</text>
  <text x="72" y="548" fill="#00629b" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700">Teaching Slides</text>
</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
