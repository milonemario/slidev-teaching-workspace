import { spawn, type ChildProcessByStdio } from "node:child_process";
import { request } from "node:http";
import type { Readable } from "node:stream";
import type { Deck } from "./decks.js";
import { commandFor, type CommandKind, type CommandOptions } from "./commands.js";
import { findFreePort } from "./ports.js";

export type RuntimeStatus = "stopped" | "starting" | "running" | "stopping" | "failed";
export type JobStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
export type JobType = "build" | "export";

export interface LogEntry {
  time: string;
  source: "dev" | "job" | "system";
  stream: "stdout" | "stderr" | "status";
  message: string;
}

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  port?: number;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
}

export interface JobSnapshot {
  status: JobStatus;
  type?: JobType;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  error?: string;
}

export interface DeckSnapshot {
  runtime: RuntimeSnapshot;
  job: JobSnapshot;
  logs: LogEntry[];
}

interface InternalDeckState extends DeckSnapshot {
  child?: ManagedChildProcess;
  jobChild?: ManagedChildProcess;
}

interface QueuedJob {
  deck: Deck;
  type: JobType;
}

const MAX_LOGS = 400;
type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type ChangeListener = (deckId: string) => void;

export class ProcessManager {
  private states = new Map<string, InternalDeckState>();
  private queue: QueuedJob[] = [];
  private queueRunning = false;
  private listeners = new Set<ChangeListener>();

  constructor(
    private readonly workspacePort: number,
    private readonly deckStartOptions: Omit<CommandOptions, "port"> = {},
  ) {}

  snapshot(deckId: string): DeckSnapshot {
    const state = this.ensureState(deckId);
    return {
      runtime: { ...state.runtime },
      job: { ...state.job },
      logs: [...state.logs],
    };
  }

  snapshots(decks: Deck[]): Map<string, DeckSnapshot> {
    return new Map(decks.map((deck) => [deck.id, this.snapshot(deck.id)]));
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(deck: Deck): Promise<DeckSnapshot> {
    const state = this.ensureState(deck.id);
    if (state.runtime.status === "running" || state.runtime.status === "starting") {
      return this.snapshot(deck.id);
    }

    const reserved = new Set(
      [...this.states.values()]
        .map((candidate) => candidate.runtime.port)
        .filter((port): port is number => typeof port === "number"),
    );
    const port = await findFreePort(this.workspacePort + 1, reserved);
    const command = commandFor("dev", deck, { ...this.deckStartOptions, port });

    this.pushLog(deck.id, "system", "status", `Starting: ${command.display}`);
    state.runtime = {
      status: "starting",
      port,
      startedAt: new Date().toISOString(),
    };
    this.emitChange(deck.id);

    const child = spawn(command.command, command.args, {
      cwd: deck.dir,
      env: childEnv(command.runner),
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    state.child = child;
    state.runtime.pid = child.pid;
    this.emitChange(deck.id);

    child.stdout.on("data", (chunk) => {
      const message = chunk.toString();
      this.pushLog(deck.id, "dev", "stdout", message);
      this.markReadyFromOutput(deck.id, port, message);
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString();
      this.pushLog(deck.id, "dev", "stderr", message);
      this.markReadyFromOutput(deck.id, port, message);
    });
    child.once("error", (error) => {
      state.runtime = { ...state.runtime, status: "failed", error: error.message };
      this.pushLog(deck.id, "system", "status", `Start failed: ${error.message}`);
      this.emitChange(deck.id);
    });
    child.once("exit", (code, signal) => {
      const wasStopping = state.runtime.status === "stopping";
      const message = `Deck process exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
      this.pushLog(deck.id, "system", "status", message);
      state.child = undefined;
      state.runtime = {
        ...state.runtime,
        status: wasStopping ? "stopped" : "failed",
        stoppedAt: new Date().toISOString(),
        error: wasStopping ? undefined : message,
      };
      this.emitChange(deck.id);
    });

    try {
      await waitForHttp(port, () => state.runtime.status !== "starting");
      if (state.runtime.status === "starting") {
        state.runtime = { ...state.runtime, status: "running" };
        this.pushLog(deck.id, "system", "status", `Ready on port ${port}`);
        this.emitChange(deck.id);
      }
    } catch (error) {
      if (state.runtime.status === "starting") {
        state.runtime = {
          ...state.runtime,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        this.pushLog(deck.id, "system", "status", `Start timed out on port ${port}`);
        this.killChild(child, "SIGTERM");
        this.emitChange(deck.id);
      }
    }

    return this.snapshot(deck.id);
  }

  async stop(deckId: string): Promise<DeckSnapshot> {
    const state = this.ensureState(deckId);
    const child = state.child;

    if (!child || state.runtime.status === "stopped") {
      state.runtime = { status: "stopped", stoppedAt: new Date().toISOString() };
      this.emitChange(deckId);
      return this.snapshot(deckId);
    }

    state.runtime = { ...state.runtime, status: "stopping" };
    this.pushLog(deckId, "system", "status", "Stopping deck process");
    this.emitChange(deckId);
    const exitPromise = waitForExit(child, 4000);
    this.killChild(child, "SIGTERM");

    await exitPromise.catch(() => {
      this.pushLog(deckId, "system", "status", "Force stopping deck process");
      this.killChild(child, "SIGKILL");
    });

    state.child = undefined;
    state.runtime = { status: "stopped", stoppedAt: new Date().toISOString() };
    this.emitChange(deckId);
    return this.snapshot(deckId);
  }

  enqueueJob(deck: Deck, type: JobType): DeckSnapshot {
    const state = this.ensureState(deck.id);

    if (state.job.status === "queued" || state.job.status === "running") {
      throw new Error(`${deck.label} already has a ${state.job.status} job`);
    }

    state.job = {
      status: "queued",
      type,
      queuedAt: new Date().toISOString(),
    };
    this.queue.push({ deck, type });
    this.pushLog(deck.id, "system", "status", `Queued ${type} job`);
    this.emitChange(deck.id);
    void this.runQueue();

    return this.snapshot(deck.id);
  }

  enqueueBatch(decks: Deck[], type: JobType): DeckSnapshot[] {
    return decks.map((deck) => this.enqueueJob(deck, type));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.states.keys()].map((deckId) => this.stop(deckId)));
  }

  private async runQueue(): Promise<void> {
    if (this.queueRunning) {
      return;
    }

    this.queueRunning = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift();
        if (!next) {
          continue;
        }
        await this.runJob(next.deck, next.type);
      }
    } finally {
      this.queueRunning = false;
    }
  }

  private async runJob(deck: Deck, type: JobType): Promise<void> {
    const state = this.ensureState(deck.id);
    const commandKind: CommandKind = type;
    const command = commandFor(commandKind, deck);

    state.job = {
      ...state.job,
      status: "running",
      type,
      startedAt: new Date().toISOString(),
    };
    this.pushLog(deck.id, "system", "status", `Running ${type}: ${command.display}`);
    this.emitChange(deck.id);

    const child = spawn(command.command, command.args, {
      cwd: deck.dir,
      env: childEnv(command.runner),
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    state.jobChild = child;
    child.stdout.on("data", (chunk) => this.pushLog(deck.id, "job", "stdout", chunk.toString()));
    child.stderr.on("data", (chunk) => this.pushLog(deck.id, "job", "stderr", chunk.toString()));

    const result = await waitForJob(child).catch((error: Error) => ({
      code: 1,
      error: error.message,
    }));

    state.jobChild = undefined;
    state.job = {
      ...state.job,
      status: result.code === 0 ? "succeeded" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      error: result.error,
    };
    this.pushLog(deck.id, "system", "status", `${type} ${result.code === 0 ? "succeeded" : "failed"}`);
    this.emitChange(deck.id);
  }

  private ensureState(deckId: string): InternalDeckState {
    const existing = this.states.get(deckId);
    if (existing) {
      return existing;
    }

    const state: InternalDeckState = {
      runtime: { status: "stopped" },
      job: { status: "idle" },
      logs: [],
    };
    this.states.set(deckId, state);
    return state;
  }

  private pushLog(deckId: string, source: LogEntry["source"], stream: LogEntry["stream"], message: string): void {
    const state = this.ensureState(deckId);
    const entries = message
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (const line of entries) {
      state.logs.push({
        time: new Date().toISOString(),
        source,
        stream,
        message: line,
      });
    }

    if (state.logs.length > MAX_LOGS) {
      state.logs.splice(0, state.logs.length - MAX_LOGS);
    }
    this.emitChange(deckId);
  }

  private killChild(child: ManagedChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) {
      return;
    }

    try {
      if (process.platform === "win32") {
        child.kill(signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      child.kill(signal);
    }
  }

  private emitChange(deckId: string): void {
    for (const listener of this.listeners) {
      listener(deckId);
    }
  }

  private markReadyFromOutput(deckId: string, port: number, message: string): void {
    const state = this.ensureState(deckId);
    if (state.runtime.status !== "starting" || !isSlidevReadyOutput(message, port)) {
      return;
    }

    state.runtime = { ...state.runtime, status: "running" };
    this.pushLog(deckId, "system", "status", `Ready on port ${port}`);
  }
}

function childEnv(runner: "global" | "pnpm"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
  if (runner === "global" && !env.SLIDEV_GLOBAL_MODE) {
    env.SLIDEV_GLOBAL_MODE = "1";
  }
  return env;
}

function waitForHttp(port: number, shouldCancel: () => boolean): Promise<void> {
  const started = Date.now();
  const timeoutMs = 60000;

  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (shouldCancel()) {
        reject(new Error("Deck startup was cancelled"));
        return;
      }

      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for Slidev on port ${port}`));
        return;
      }

      const req = request({ hostname: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.once("error", () => setTimeout(check, 500));
      req.once("timeout", () => {
        req.destroy();
        setTimeout(check, 500);
      });
      req.end();
    };

    check();
  });
}

function waitForExit(child: ManagedChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for process exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function waitForJob(child: ManagedChildProcess): Promise<{ code: number | null; error?: string }> {
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      resolve({
        code,
        error: code === 0 ? undefined : `Process exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
      });
    });
  });
}

function isSlidevReadyOutput(message: string, port: number): boolean {
  const cleanMessage = stripAnsi(message);
  return new RegExp(`https?://[^\\s]+:${port}(?:/|\\b)`).test(cleanMessage);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
