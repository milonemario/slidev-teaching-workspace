import { readFileSync } from "node:fs";
import { parseYamlObject } from "./config.js";

export interface SlideFrontmatter {
  title?: string;
  theme?: string;
  cover?: string;
  exportFilename?: string;
  workspace?: {
    order?: number;
  };
}

export function readSlideFrontmatter(slidesPath: string): SlideFrontmatter {
  const text = readFileSync(slidesPath, "utf8");
  const normalized = text.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return {};
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return {};
  }

  const raw = parseYamlObject(normalized.slice(4, end));
  const workspaceOrder = readWorkspaceOrder(raw.workspace);
  return {
    title: typeof raw.title === "string" ? raw.title : undefined,
    theme: typeof raw.theme === "string" ? raw.theme : undefined,
    cover: typeof raw.cover === "string" ? raw.cover : undefined,
    exportFilename: typeof raw.exportFilename === "string" ? raw.exportFilename : undefined,
    workspace: workspaceOrder === undefined ? undefined : { order: workspaceOrder },
  };
}

function readWorkspaceOrder(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const order = (value as Record<string, unknown>).order;
  if (typeof order === "number" && Number.isFinite(order)) {
    return order;
  }

  if (typeof order === "string") {
    const trimmed = order.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}
