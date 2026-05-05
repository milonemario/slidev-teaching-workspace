#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildStaticCatalog, exportOgImages } from "./staticBuild.js";
import { startServer } from "./server.js";

interface ParsedArgs {
  command: string;
  port: number;
  remote?: string;
  bind: string;
  open?: boolean;
  force: boolean;
  log?: string;
  password?: string;
  username?: string;
  help: boolean;
  version: boolean;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    printVersion();
    return;
  }

  if (args.help || args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "dev") {
    await startServer({
      port: args.port,
      remote: args.remote,
      bind: args.bind,
      open: args.open,
      force: args.force,
      log: args.log,
      password: args.password,
      username: args.username,
    });
    return;
  }

  if (args.command === "build") {
    const outDir = buildStaticCatalog();
    console.log(`Built teaching workspace catalog at ${outDir}`);
    return;
  }

  if (args.command === "export-og") {
    const outDir = exportOgImages();
    console.log(`Exported Open Graph SVGs at ${outDir}`);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const knownCommands = new Set(["dev", "build", "export-og", "help"]);
  let command = "dev";
  let index = 0;

  if (argv[0] && !argv[0].startsWith("-")) {
    if (!knownCommands.has(argv[0])) {
      throw new Error(`Unknown command: ${argv[0]}`);
    }
    command = argv[0];
    index = 1;
  }

  let port = Number(process.env.SLIDEV_WORKSPACE_PORT || 3000);
  let remote: string | undefined;
  let bind = "0.0.0.0";
  let open: boolean | undefined;
  let force = false;
  let log: string | undefined;
  let password: string | undefined;
  let username: string | undefined;
  let help = false;
  let version = false;

  for (; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--port") {
      port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "-p") {
      port = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--remote") {
      const value = argv[index + 1];
      if (value && !value.startsWith("-")) {
        remote = value;
        index += 1;
      } else {
        remote = "";
      }
    } else if (arg.startsWith("--remote=")) {
      remote = arg.slice("--remote=".length);
    } else if (arg === "--bind" || arg === "--host") {
      bind = String(argv[index + 1] ?? "");
      remote ??= "";
      index += 1;
    } else if (arg.startsWith("--bind=")) {
      bind = arg.slice("--bind=".length);
      remote ??= "";
    } else if (arg.startsWith("--host=")) {
      bind = arg.slice("--host=".length);
      remote ??= "";
    } else if (arg === "--open" || arg === "-o") {
      open = true;
    } else if (arg.startsWith("--open=")) {
      open = parseBoolean(arg.slice("--open=".length));
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--log") {
      log = String(argv[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--log=")) {
      log = arg.slice("--log=".length);
    } else if (arg === "--password") {
      password = String(argv[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--password=")) {
      password = arg.slice("--password=".length);
    } else if (arg === "--username") {
      username = String(argv[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--username=")) {
      username = arg.slice("--username=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (!bind) {
    throw new Error("Invalid bind address");
  }
  if (log && !["error", "warn", "info", "silent"].includes(log)) {
    throw new Error(`Invalid log level: ${log}`);
  }
  if (password !== undefined && !password.trim()) {
    throw new Error("Invalid password");
  }
  if (username !== undefined && !username.trim()) {
    throw new Error("Invalid username");
  }

  return { command, port, remote, bind, open, force, log, password, username, help, version };
}

function printHelp(): void {
  console.log(`Teaching Slidev Workspace

Usage:
  slidev-teaching-workspace [--port 3000] [--remote] [--bind 0.0.0.0] [--password secret] [--username slidev]
  slidev-teaching-workspace dev [--port 3000] [--remote] [--bind 0.0.0.0] [--password secret] [--username slidev]
  slidev-teaching-workspace build
  slidev-teaching-workspace export-og

Options:
  -p, --port     first workspace server port to try             [default: 3000]
  -o, --open     open workspace in browser                      [default: false]
      --remote   listen on public host, matching Slidev remote mode; accepts an optional password
      --bind     address to bind in remote mode                 [default: 0.0.0.0]
      --host     alias for --bind
      --password protect the workspace dashboard
      --username dashboard login username                       [default: slidev]
  -f, --force    pass --force to deck dev servers
      --log      pass log level to deck dev servers             [error|warn|info|silent]
  -h, --help     show help
  -v, --version  show version

Run commands from the teaching repository root. The CLI reads ./slidev-teaching-workspace.yaml.
`);
}

function parseBoolean(value: string): boolean {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function printVersion(): void {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  console.log(pkg.version ?? "0.0.0");
}
