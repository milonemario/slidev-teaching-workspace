import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceConfig } from "./config.js";
import { readSlideFrontmatter } from "./frontmatter.js";

export interface Deck {
  id: string;
  dir: string;
  relativePath: string;
  slug: string;
  label: string;
  title?: string;
  theme?: string;
  cover?: string;
  coverBaseDir?: string;
  exportFilename?: string;
  workspaceOrder?: number;
  categoryId: string;
  subcategoryId: string;
  course: string;
  section: string;
  categoryOrder: number;
  subcategoryOrder: number;
}

interface DeckSource {
  slidesRoot: string;
  categoryId?: string;
  subcategoryId?: string;
  course?: string;
  section?: string;
  cover?: string;
  categoryOrder: number;
  subcategoryOrder: number;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function discoverDecks(config: WorkspaceConfig): Deck[] {
  const excluded = new Set(config.exclude);
  const decks: Deck[] = [];

  for (const source of deckSources(config)) {
    const root = resolve(config.rootDir, source.slidesRoot);
    if (!existsSync(root)) {
      continue;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || excluded.has(entry.name)) {
        continue;
      }

      const dir = join(root, entry.name);
      const slidesPath = join(dir, "slides.md");
      const packagePath = join(dir, "package.json");

      if (!existsSync(slidesPath) || !existsSync(packagePath)) {
        continue;
      }

      const relativePath = toPosix(relative(config.rootDir, dir));
      const frontmatter = readSlideFrontmatter(slidesPath);
      const category =
        source.course && source.section
          ? {
              course: source.course,
              section: source.section,
              categoryId: source.categoryId ?? slugify(source.course),
              subcategoryId: source.subcategoryId ?? slugify(source.section),
            }
          : categorizeDeck(relativePath);
      const frontmatterCover = frontmatter.cover?.trim() ? frontmatter.cover : undefined;

      decks.push({
        id: relativePath,
        dir,
        relativePath,
        slug: entry.name,
        label: humanizeDeckName(entry.name),
        title: frontmatter.title,
        theme: frontmatter.theme,
        cover: frontmatterCover ?? source.cover,
        coverBaseDir: frontmatterCover ? dir : config.rootDir,
        exportFilename: frontmatter.exportFilename,
        workspaceOrder: frontmatter.workspace?.order,
        categoryId: category.categoryId,
        subcategoryId: category.subcategoryId,
        course: category.course,
        section: category.section,
        categoryOrder: source.categoryOrder,
        subcategoryOrder: source.subcategoryOrder,
      });
    }
  }

  return decks.sort((left, right) => {
    return (
      left.categoryOrder - right.categoryOrder ||
      left.subcategoryOrder - right.subcategoryOrder ||
      compareWorkspaceOrder(left, right) ||
      collator.compare(left.course, right.course) ||
      collator.compare(left.section, right.section) ||
      collator.compare(left.label, right.label)
    );
  });
}

export function categorizeDeck(
  relativePath: string,
): Pick<Deck, "categoryId" | "subcategoryId" | "course" | "section"> {
  const parts = relativePath.split("/");

  if (relativePath.startsWith("Strategic_Cost_Management/Current/Lectures/Slidev/")) {
    return {
      categoryId: "strategic-cost-management",
      subcategoryId: "lectures",
      course: "Strategic Cost Management",
      section: "Lectures",
    };
  }

  if (relativePath.startsWith("Strategic_Cost_Management/Current/Cases/Slidev/")) {
    return {
      categoryId: "strategic-cost-management",
      subcategoryId: "cases",
      course: "Strategic Cost Management",
      section: "Cases",
    };
  }

  if (relativePath.startsWith("Data_Analytics/Current/Lectures/Slidev/")) {
    return {
      categoryId: "data-analytics",
      subcategoryId: "lectures",
      course: "Data Analytics",
      section: "Lectures",
    };
  }

  const course = humanizeDeckName(parts[0] ?? "Decks");
  const section = parts.includes("Cases") ? "Cases" : parts.includes("Lectures") ? "Lectures" : "Decks";
  return {
    categoryId: slugify(course),
    subcategoryId: slugify(section),
    course,
    section,
  };
}

export function humanizeDeckName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\bLecture(\d+)/gi, "Lecture $1")
    .replace(/\bpart\s*([IVX]+)\b/gi, "Part $1")
    .replace(/\s+/g, " ")
    .trim();
}

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function deckStaticUrl(config: WorkspaceConfig, deck: Deck): string {
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  return `${base}${basename(deck.slug)}/`;
}

export function deckCoverUrl(deck: Deck): string | undefined {
  const cover = deck.cover?.trim();
  if (!cover) {
    return undefined;
  }

  return isExternalCover(cover) ? cover : `/api/deck-cover?id=${encodeURIComponent(deck.id)}`;
}

export function deckCoverFilePath(config: WorkspaceConfig, deck: Deck): string | undefined {
  const cover = deck.cover?.trim();
  if (!cover || isExternalCover(cover)) {
    return undefined;
  }

  const rootDir = resolve(config.rootDir);
  const baseDir = cover.startsWith("/") ? rootDir : deck.coverBaseDir ?? deck.dir;
  const localPath = cover.startsWith("/") ? cover.slice(1) : cover;
  const resolved = resolve(baseDir, localPath);

  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${sep}`)) {
    return undefined;
  }

  return resolved;
}

export function deckExportFilePath(deck: Deck): string | undefined {
  const requestedFile = deck.exportFilename?.trim() || "slides-export";
  const localPath = extname(requestedFile) ? requestedFile : `${requestedFile}.pdf`;
  const resolved = resolve(deck.dir, localPath);
  const root = resolve(deck.dir);

  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return undefined;
  }

  return resolved;
}

export function isExternalCover(value: string): boolean {
  return /^(https?:)?\/\//.test(value) || value.startsWith("data:");
}

function deckSources(config: WorkspaceConfig): DeckSource[] {
  if (config.categories.length) {
    return config.categories.flatMap((category, categoryOrder) =>
      category.subcategories.flatMap((subcategory, subcategoryOrder) =>
        subcategory.slidesDir.map((slidesRoot) => ({
          slidesRoot,
          categoryId: category.id,
          subcategoryId: subcategory.id,
          course: category.label,
          section: subcategory.label,
          cover: category.cover,
          categoryOrder,
          subcategoryOrder,
        })),
      ),
    );
  }

  return config.slidesDir.map((slidesRoot, index) => ({
    slidesRoot,
    categoryOrder: index,
    subcategoryOrder: 0,
  }));
}

function compareWorkspaceOrder(left: Deck, right: Deck): number {
  if (left.workspaceOrder !== undefined && right.workspaceOrder !== undefined) {
    return left.workspaceOrder - right.workspaceOrder;
  }

  if (left.workspaceOrder !== undefined) {
    return -1;
  }

  if (right.workspaceOrder !== undefined) {
    return 1;
  }

  return 0;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
