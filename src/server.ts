import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_INTERFACE_THEMES,
  isWorkspaceInterfaceTheme,
  loadWorkspaceConfig,
  writeWorkspaceInterface,
  type WorkspaceConfig,
} from "./config.js";
import {
  deckCoverFilePath,
  deckCoverUrl,
  deckExportFilePath,
  deckStaticUrl,
  discoverDecks,
  type Deck,
} from "./decks.js";
import { ProcessManager, type DeckSnapshot, type JobType } from "./processManager.js";
import { findFreePortForHost } from "./ports.js";

export interface StartServerOptions {
  cwd?: string;
  port: number;
  remote?: string;
  bind?: string;
  open?: boolean;
  force?: boolean;
  log?: string;
}

interface DeckView {
  id: string;
  relativePath: string;
  slug: string;
  label: string;
  title?: string;
  theme?: string;
  coverUrl?: string;
  workspaceOrder?: number;
  categoryId: string;
  subcategoryId: string;
  course: string;
  section: string;
  staticUrl: string;
  builtPreviewUrl?: string;
  exportPreviewUrl?: string;
  artifacts: {
    build: ArtifactStatus;
    export: ArtifactStatus;
  };
  runtime: DeckSnapshot["runtime"] & { url?: string };
  job: DeckSnapshot["job"];
}

interface ArtifactStatus {
  state: "missing" | "fresh" | "stale";
  outputTime?: string;
  sourceTime?: string;
}

interface ServerState {
  config: WorkspaceConfig;
  decks: Deck[];
}

type WorkspaceView = ReturnType<typeof workspaceView>;

interface EventClient {
  id: number;
  req: IncomingMessage;
  res: ServerResponse;
}

const uiDir = fileURLToPath(new URL("./ui", import.meta.url));

export async function startServer(options: StartServerOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const state: ServerState = {
    config: loadWorkspaceConfig(cwd),
    decks: [],
  };
  state.decks = discoverDecks(state.config);
  const remote = options.remote;
  const remoteEnabled = remote !== undefined;
  const bind = options.bind || process.env.SLIDEV_WORKSPACE_BIND || "0.0.0.0";
  const host = remoteEnabled ? bind : process.env.SLIDEV_WORKSPACE_HOST || "127.0.0.1";
  const port = await findFreePortForHost(options.port, host);
  const manager = new ProcessManager(port, {
    remote,
    bind,
    force: options.force,
    log: options.log,
  });
  const events = new EventStream((req) => workspaceView(state.config, state.decks, manager, req));
  manager.onChange(() => events.broadcast("decks"));

  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, state, manager, events);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const shutdown = async (): Promise<void> => {
    events.close();
    await manager.shutdown();
    server.close();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const displayHost = host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host;
  const url = `http://${displayHost}:${port}/`;
  console.log(`Teaching Slidev Workspace running at ${url}`);
  if (port !== options.port) {
    console.log(`  Port ${options.port} was unavailable, using ${port}.`);
  }
  if (remoteEnabled) {
    for (const remoteUrl of networkUrls(port)) {
      console.log(`  Network: ${remoteUrl}`);
    }
  }

  if (options.open ?? process.env.SLIDEV_WORKSPACE_OPEN === "true") {
    openBrowser(url);
  }
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  manager: ProcessManager,
  events: EventStream,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const deckById = new Map(state.decks.map((deck) => [deck.id, deck]));

  if (req.method === "GET" && url.pathname === "/api/decks") {
    sendJson(res, 200, workspaceView(state.config, state.decks, manager, req));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    events.connect(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/interface") {
    sendJson(res, 200, {
      interface: state.config.interface,
      themes: WORKSPACE_INTERFACE_THEMES,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/interface") {
    const body = await readJsonBody(req);
    const theme = body.theme;

    if (!isWorkspaceInterfaceTheme(theme)) {
      sendJson(res, 400, {
        error: "Invalid interface theme.",
        themes: WORKSPACE_INTERFACE_THEMES,
      });
      return;
    }

    state.config = writeWorkspaceInterface(state.config, { theme });
    state.decks = discoverDecks(state.config);
    events.broadcast("decks");
    sendJson(res, 200, {
      interface: state.config.interface,
      config: publicConfig(state.config),
    });
    return;
  }

  const deckCoverId = deckCoverRequestId(url);
  if ((req.method === "GET" || req.method === "HEAD") && deckCoverId !== undefined) {
    const deckId = deckCoverId;
    const deck = deckById.get(deckId);
    if (!deck) {
      sendJson(res, 404, { error: `Unknown deck: ${deckId}` });
      return;
    }

    await serveDeckCover(state.config, deck, res, req.method === "HEAD");
    return;
  }

  const builtPreview = /^\/built\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if ((req.method === "GET" || req.method === "HEAD") && builtPreview) {
    const deckId = decodeURIComponent(builtPreview[1]);
    const deck = deckById.get(deckId);
    if (!deck) {
      sendJson(res, 404, { error: `Unknown deck: ${deckId}` });
      return;
    }

    const assetPath = builtPreview[2] ?? "";
    if (!assetPath && !url.pathname.endsWith("/")) {
      res.writeHead(302, { Location: `${url.pathname}/${url.search}` });
      res.end();
      return;
    }

    await serveBuiltDeck(deck, assetPath, res, req.method === "HEAD");
    return;
  }

  const exportPreview = /^\/exported\/([^/]+)\/?$/.exec(url.pathname);
  if ((req.method === "GET" || req.method === "HEAD") && exportPreview) {
    const deckId = decodeURIComponent(exportPreview[1]);
    const deck = deckById.get(deckId);
    if (!deck) {
      sendJson(res, 404, { error: `Unknown deck: ${deckId}` });
      return;
    }

    await serveExportedDeck(deck, res, req.method === "HEAD");
    return;
  }

  const deckAction = /^\/api\/decks\/([^/]+)\/(start|stop|build|export)$/.exec(url.pathname);
  if (req.method === "POST" && deckAction) {
    const deckId = decodeURIComponent(deckAction[1]);
    const action = deckAction[2] as "start" | "stop" | "build" | "export";
    const deck = deckById.get(deckId);

    if (!deck) {
      sendJson(res, 404, { error: `Unknown deck: ${deckId}` });
      return;
    }

    if (action === "start") {
      await manager.start(deck);
    } else if (action === "stop") {
      await manager.stop(deck.id);
    } else {
      manager.enqueueJob(deck, action);
    }

    sendJson(res, 200, {
      deck: deckView(state.config, deck, manager.snapshot(deck.id), req),
    });
    return;
  }

  const deckLogs = /^\/api\/decks\/([^/]+)\/logs$/.exec(url.pathname);
  if (req.method === "GET" && deckLogs) {
    const deckId = decodeURIComponent(deckLogs[1]);
    if (!deckById.has(deckId)) {
      sendJson(res, 404, { error: `Unknown deck: ${deckId}` });
      return;
    }
    sendJson(res, 200, { logs: manager.snapshot(deckId).logs });
    return;
  }

  const batchAction = /^\/api\/batch\/(build|export)$/.exec(url.pathname);
  if (req.method === "POST" && batchAction) {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    const selectedDecks = ids.length
      ? ids.map((id) => deckById.get(id)).filter((deck): deck is Deck => Boolean(deck))
      : state.decks;
    const type = batchAction[1] as JobType;
    const queued = manager.enqueueBatch(selectedDecks, type);
    sendJson(res, 200, { queued: queued.length });
    return;
  }

  await serveStatic(req, res);
}

function deckCoverRequestId(url: URL): string | undefined {
  if (url.pathname === "/api/deck-cover") {
    return url.searchParams.get("id") ?? "";
  }

  const deckCover = /^\/api\/decks\/([^/]+)\/cover$/.exec(url.pathname);
  return deckCover ? decodeURIComponent(deckCover[1]) : undefined;
}

function workspaceView(
  config: WorkspaceConfig,
  decks: Deck[],
  manager: ProcessManager,
  req: IncomingMessage,
): {
  config: Record<string, unknown>;
  decks: DeckView[];
} {
  return {
    config: publicConfig(config),
    decks: decks.map((deck) => deckView(config, deck, manager.snapshot(deck.id), req)),
  };
}

function deckView(config: WorkspaceConfig, deck: Deck, snapshot: DeckSnapshot, req: IncomingMessage): DeckView {
  const runtime: DeckView["runtime"] = { ...snapshot.runtime };
  if (runtime.port && (runtime.status === "running" || runtime.status === "starting")) {
    runtime.url = `http://${requestHostname(req)}:${runtime.port}/`;
  }
  const sourceTime = newestDeckSourceTime(deck);
  const buildPath = join(deck.dir, "dist", "index.html");
  const exportPath = deckExportFilePath(deck);

  return {
    id: deck.id,
    relativePath: deck.relativePath,
    slug: deck.slug,
    label: deck.label,
    title: deck.title,
    theme: deck.theme,
    coverUrl: deckCoverUrl(deck),
    workspaceOrder: deck.workspaceOrder,
    categoryId: deck.categoryId,
    subcategoryId: deck.subcategoryId,
    course: deck.course,
    section: deck.section,
    staticUrl: deckStaticUrl(config, deck),
    builtPreviewUrl: deckBuiltPreviewUrl(deck),
    exportPreviewUrl: deckExportPreviewUrl(deck),
    artifacts: {
      build: artifactStatus(buildPath, sourceTime),
      export: artifactStatus(exportPath, sourceTime),
    },
    runtime,
    job: snapshot.job,
  };
}

async function serveBuiltDeck(
  deck: Deck,
  assetPath: string,
  res: ServerResponse,
  headOnly = false,
): Promise<void> {
  const distDir = resolve(deck.dir, "dist");
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    sendText(res, 404, "Built deck not found. Build this deck first.");
    return;
  }

  const root = resolve(distDir);
  const decodedPath = decodeURIComponent(assetPath);
  const safePath = normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
  const requestedPath = safePath && safePath !== "." ? resolve(join(root, safePath)) : indexPath;

  if (requestedPath !== root && !requestedPath.startsWith(`${root}${sep}`)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const target =
    existsSync(requestedPath) && statSync(requestedPath).isFile()
      ? requestedPath
      : extname(decodedPath)
        ? undefined
        : indexPath;

  if (!target) {
    sendText(res, 404, "Built deck asset not found.");
    return;
  }

  res.writeHead(200, { "Content-Type": mimeType(target) });
  res.end(headOnly ? undefined : readFileSync(target));
}

function deckBuiltPreviewUrl(deck: Deck): string | undefined {
  const indexPath = join(deck.dir, "dist", "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    return undefined;
  }

  return `/built/${encodeURIComponent(deck.id)}/`;
}

async function serveExportedDeck(deck: Deck, res: ServerResponse, headOnly = false): Promise<void> {
  const exportPath = deckExportFilePath(deck);
  if (!exportPath || !existsSync(exportPath) || !statSync(exportPath).isFile()) {
    sendText(res, 404, "Export not found. Export this deck first.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": mimeType(exportPath),
    "Content-Disposition": `inline; filename="${basename(exportPath).replace(/"/g, "")}"`,
  });
  res.end(headOnly ? undefined : readFileSync(exportPath));
}

function deckExportPreviewUrl(deck: Deck): string | undefined {
  const exportPath = deckExportFilePath(deck);
  if (!exportPath || !existsSync(exportPath) || !statSync(exportPath).isFile()) {
    return undefined;
  }

  return `/exported/${encodeURIComponent(deck.id)}/`;
}

function artifactStatus(outputPath: string | undefined, sourceTime: number): ArtifactStatus {
  if (!outputPath || !existsSync(outputPath) || !statSync(outputPath).isFile()) {
    return { state: "missing", sourceTime: isoTime(sourceTime) };
  }

  const outputTime = statSync(outputPath).mtimeMs;
  return {
    state: outputTime >= sourceTime ? "fresh" : "stale",
    outputTime: isoTime(outputTime),
    sourceTime: isoTime(sourceTime),
  };
}

function newestDeckSourceTime(deck: Deck): number {
  const root = resolve(deck.dir);
  const generatedExport = deckExportFilePath(deck);
  let newest = 0;

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipSourceDirectory(entry.name)) {
          continue;
        }
        visit(filePath);
      } else if (entry.isFile() && !isGeneratedDeckArtifact(filePath, root, generatedExport)) {
        newest = Math.max(newest, statSync(filePath).mtimeMs);
      }
    }
  };

  visit(root);
  return newest;
}

function shouldSkipSourceDirectory(name: string): boolean {
  return name === "dist" || name === "node_modules" || name === ".git" || name === ".slidev";
}

function isGeneratedDeckArtifact(filePath: string, root: string, generatedExport: string | undefined): boolean {
  if (generatedExport && resolve(filePath) === resolve(generatedExport)) {
    return true;
  }

  const relativePath = normalize(filePath.slice(root.length + 1));
  return /^slides-export\.(pdf|png|pptx|md)$/i.test(relativePath);
}

function isoTime(value: number): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

async function serveDeckCover(config: WorkspaceConfig, deck: Deck, res: ServerResponse, headOnly = false): Promise<void> {
  const coverPath = deckCoverFilePath(config, deck);
  if (!coverPath || !existsSync(coverPath) || !statSync(coverPath).isFile()) {
    sendJson(res, 404, { error: "Deck cover not found." });
    return;
  }

  res.writeHead(200, { "Content-Type": mimeType(coverPath) });
  res.end(headOnly ? undefined : readFileSync(coverPath));
}

function publicConfig(config: WorkspaceConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    outputDir: config.outputDir,
    interface: config.interface,
    hero: config.hero,
    sidebar: config.sidebar,
  };
}

class EventStream {
  private clients = new Map<number, EventClient>();
  private nextClientId = 1;
  private keepAlive: NodeJS.Timeout;

  constructor(private readonly dataFactory: (req: IncomingMessage) => WorkspaceView) {
    this.keepAlive = setInterval(() => {
      for (const client of this.clients.values()) {
        client.res.write(": keep-alive\n\n");
      }
    }, 25000);
  }

  connect(req: IncomingMessage, res: ServerResponse): void {
    const id = this.nextClientId++;
    const client = { id, req, res };
    this.clients.set(id, client);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 2000\n\n");
    this.send(client, "decks", this.dataFactory(req));

    req.on("close", () => {
      this.clients.delete(id);
    });
    res.on("error", () => {
      this.clients.delete(id);
    });
  }

  broadcast(eventName: "decks"): void {
    for (const client of this.clients.values()) {
      this.send(client, eventName, this.dataFactory(client.req));
    }
  }

  close(): void {
    clearInterval(this.keepAlive);
    for (const client of this.clients.values()) {
      client.res.end();
    }
    this.clients.clear();
  }

  private send(client: EventClient, eventName: string, data: unknown): void {
    try {
      client.res.write(`event: ${eventName}\n`);
      client.res.write(`data: ${JSON.stringify(data).replace(/\n/g, "\\n")}\n\n`);
    } catch {
      this.clients.delete(client.id);
    }
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!existsSync(join(uiDir, "index.html"))) {
    sendText(res, 500, "Dashboard UI has not been built. Run `npm run build` in the package directory.");
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = resolve(join(uiDir, safePath));

  if (!filePath.startsWith(resolve(uiDir))) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const target = existsSync(filePath) && statSync(filePath).isFile() ? filePath : join(uiDir, "index.html");
  res.writeHead(200, { "Content-Type": mimeType(target) });
  res.end(readFileSync(target));
}

function requestHostname(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }

  const hostname = host.split(":")[0] || "localhost";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function mimeType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".wasm":
      return "application/wasm";
    default:
      return "text/html; charset=utf-8";
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", () => undefined);
}

function networkUrls(port: number): string[] {
  const urls: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}/`);
      }
    }
  }
  return urls;
}
