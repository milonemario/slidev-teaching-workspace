import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Deck } from "./decks.js";

export type CommandKind = "dev" | "build" | "export";

export interface CommandOptions {
  port?: number;
  remote?: string;
  bind?: string;
  force?: boolean;
  log?: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  runner: "global" | "pnpm";
  display: string;
}

export function commandFor(kind: CommandKind, deck: Deck, options: CommandOptions = {}): CommandSpec {
  const slidevBin = process.env.SLIDEV_WORKSPACE_SLIDEV_BIN?.trim();

  if (slidevBin) {
    return directSlidevCommand(slidevBin, kind, options);
  }

  if (existsSync(join(deck.dir, "node_modules"))) {
    return pnpmCommand(kind, options);
  }

  return directSlidevCommand("slidev", kind, options);
}

function directSlidevCommand(slidevBin: string, kind: CommandKind, options: CommandOptions): CommandSpec {
  if (kind === "dev") {
    if (!options.port) {
      throw new Error("A port is required to start a deck");
    }
    return makeSpec(slidevBin, devArgs(options), "global");
  }

  if (kind === "build") {
    return makeSpec(slidevBin, ["build", "slides.md", "--out", "dist", "--base", "./", "--without-notes"], "global");
  }

  return makeSpec(slidevBin, ["export", "slides.md"], "global");
}

function pnpmCommand(kind: CommandKind, options: CommandOptions): CommandSpec {
  if (kind === "dev") {
    if (!options.port) {
      throw new Error("A port is required to start a deck");
    }
    return makeSpec("pnpm", ["exec", "slidev", ...devArgs(options)], "pnpm");
  }

  if (kind === "build") {
    return makeSpec("pnpm", ["exec", "slidev", "build", "slides.md", "--out", "dist", "--base", "./", "--without-notes"], "pnpm");
  }

  return makeSpec("pnpm", ["exec", "slidev", "export", "slides.md"], "pnpm");
}

function makeSpec(command: string, args: string[], runner: CommandSpec["runner"]): CommandSpec {
  return {
    command,
    args,
    runner,
    display: [command, ...args].join(" "),
  };
}

function devArgs(options: CommandOptions): string[] {
  const args = ["slides.md", "--port", String(options.port), "--open", "false"];

  if (options.remote !== undefined) {
    args.push("--remote");
    if (options.remote) {
      args.push(options.remote);
    }
    args.push("--bind", options.bind || "0.0.0.0");
  }

  if (options.force) {
    args.push("--force");
  }

  if (options.log) {
    args.push("--log", options.log);
  }

  return args;
}
