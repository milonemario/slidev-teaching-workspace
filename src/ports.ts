import { createServer } from "node:net";

export async function findFreePort(startPort: number, reserved = new Set<number>()): Promise<number> {
  for (let port = startPort; port < startPort + 500; port += 1) {
    if (!reserved.has(port) && (await isPortFree(port))) {
      return port;
    }
  }

  throw new Error(`No free port found from ${startPort} to ${startPort + 499}`);
}

export async function findFreePortForHost(
  startPort: number,
  host: string,
  reserved = new Set<number>(),
): Promise<number> {
  for (let port = startPort; port < startPort + 500; port += 1) {
    if (!reserved.has(port) && (await isPortFreeForHost(port, host))) {
      return port;
    }
  }

  throw new Error(`No free port found from ${startPort} to ${startPort + 499}`);
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export function isPortFreeForHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}
