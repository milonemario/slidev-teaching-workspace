import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export const WORKSPACE_INTERFACE_THEMES = ["classic", "modern"] as const;
export const WORKSPACE_CONFIG_FILENAME = "slidev-teaching-workspace.yaml";

export type WorkspaceInterfaceTheme = (typeof WORKSPACE_INTERFACE_THEMES)[number];

export interface WorkspaceInterfaceThemeConfig {
  theme: WorkspaceInterfaceTheme;
}

export type WorkspaceInterfaceConfig = WorkspaceInterfaceThemeConfig;

export const DEFAULT_WORKSPACE_INTERFACE: WorkspaceInterfaceThemeConfig = {
  theme: "classic",
};

export interface WorkspaceSubcategory {
  id: string;
  label: string;
  slidesDir: string[];
}

export interface WorkspaceCategory {
  id: string;
  label: string;
  cover?: string;
  subcategories: WorkspaceSubcategory[];
}

export interface WorkspaceConfig {
  rootDir: string;
  configPath: string;
  slidesDir: string[];
  categories: WorkspaceCategory[];
  interface: WorkspaceInterfaceThemeConfig;
  outputDir: string;
  baseUrl: string;
  exclude: string[];
  hero: {
    title: string;
    description: string;
  };
  sidebar: {
    title: string;
    githubUrl: string;
  };
  raw: Record<string, unknown>;
}

export function loadWorkspaceConfig(cwd = process.cwd()): WorkspaceConfig {
  const rootDir = resolve(cwd);
  const configPath = resolve(rootDir, WORKSPACE_CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    throw new Error(`No ${WORKSPACE_CONFIG_FILENAME} found in ${rootDir}`);
  }

  const raw = parseYamlObject(readFileSync(configPath, "utf8"));
  const slidesDir = asStringArray(raw.slidesDir);

  return {
    rootDir,
    configPath,
    slidesDir,
    categories: normalizeCategories(raw.categories),
    interface: normalizeWorkspaceInterface(raw.interface),
    outputDir: asString(raw.outputDir, "./dist/slidev-workspace"),
    baseUrl: asString(raw.baseUrl, "/"),
    exclude: asStringArray(raw.exclude),
    hero: {
      title: asString(getNested(raw, "hero", "title"), ""),
      description: asString(getNested(raw, "hero", "description"), ""),
    },
    sidebar: {
      title: asString(getNested(raw, "sidebar", "title"), ""),
      githubUrl: asString(getNested(raw, "sidebar", "githubUrl"), ""),
    },
    raw,
  };
}

export function writeWorkspaceInterface(
  config: WorkspaceConfig,
  nextInterface: Partial<WorkspaceInterfaceThemeConfig>,
): WorkspaceConfig {
  const interfaceConfig = normalizeWorkspaceInterface(nextInterface);
  const source = readFileSync(config.configPath, "utf8");
  writeFileSync(config.configPath, replaceRootInterfaceBlock(source, interfaceConfig), "utf8");
  return loadWorkspaceConfig(config.rootDir);
}

export function parseYamlObject(source: string): Record<string, unknown> {
  const parsed = parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export function normalizeWorkspaceInterface(value: unknown): WorkspaceInterfaceThemeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_WORKSPACE_INTERFACE };
  }

  const raw = value as Record<string, unknown>;
  return {
    theme: isWorkspaceInterfaceTheme(raw.theme) ? raw.theme : DEFAULT_WORKSPACE_INTERFACE.theme,
  };
}

export function isWorkspaceInterfaceTheme(value: unknown): value is WorkspaceInterfaceTheme {
  return WORKSPACE_INTERFACE_THEMES.includes(value as WorkspaceInterfaceTheme);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function asSlidesDirList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return asStringArray(value);
}

function normalizeCategories(value: unknown): WorkspaceCategory[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((category, categoryIndex): WorkspaceCategory | undefined => {
      if (typeof category !== "object" || category === null || Array.isArray(category)) {
        return undefined;
      }

      const rawCategory = category as Record<string, unknown>;
      const label = asString(rawCategory.label);
      const id = asString(rawCategory.id, slugify(label || `category-${categoryIndex + 1}`));
      const cover = asOptionalString(rawCategory.cover);
      const subcategories = normalizeSubcategories(rawCategory.subcategories);

      if (!label || !subcategories.length) {
        return undefined;
      }

      return { id, label, cover, subcategories };
    })
    .filter((category): category is WorkspaceCategory => Boolean(category));
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeSubcategories(value: unknown): WorkspaceSubcategory[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((subcategory, subcategoryIndex): WorkspaceSubcategory | undefined => {
      if (typeof subcategory !== "object" || subcategory === null || Array.isArray(subcategory)) {
        return undefined;
      }

      const rawSubcategory = subcategory as Record<string, unknown>;
      const label = asString(rawSubcategory.label);
      const id = asString(rawSubcategory.id, slugify(label || `subcategory-${subcategoryIndex + 1}`));
      const slidesDir = asSlidesDirList(rawSubcategory.slidesDir);

      if (!label || !slidesDir.length) {
        return undefined;
      }

      return { id, label, slidesDir };
    })
    .filter((subcategory): subcategory is WorkspaceSubcategory => Boolean(subcategory));
}

function getNested(raw: Record<string, unknown>, key: string, nestedKey: string): unknown {
  const value = raw[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[nestedKey];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function replaceRootInterfaceBlock(source: string, interfaceConfig: WorkspaceInterfaceThemeConfig): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = source.endsWith("\n");
  const lines = source.split(/\r?\n/);
  if (hasTrailingNewline) {
    lines.pop();
  }

  const replacement = [
    "interface:",
    `  theme: "${interfaceConfig.theme}"`,
  ];
  const existingStart = lines.findIndex((line) => /^interface\s*:/.test(line));

  if (existingStart >= 0) {
    const existingEnd = rootBlockEnd(lines, existingStart);
    const updated = [...lines.slice(0, existingStart), ...replacement, ...lines.slice(existingEnd)];
    return `${updated.join(newline)}${hasTrailingNewline ? newline : ""}`;
  }

  const insertAfter = findRootBlock(lines, "baseUrl") ?? findRootBlock(lines, "outputDir");
  const insertIndex = insertAfter ? insertAfter.end : lines.length;
  const updated = [...lines.slice(0, insertIndex), ...replacement, ...lines.slice(insertIndex)];
  return `${updated.join(newline)}${hasTrailingNewline || source.length === 0 ? newline : ""}`;
}

function findRootBlock(lines: string[], key: string): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  return start >= 0 ? { start, end: rootBlockEnd(lines, start) } : undefined;
}

function rootBlockEnd(lines: string[], start: number): number {
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) {
    end += 1;
  }
  return end;
}
