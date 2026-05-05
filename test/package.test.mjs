import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadWorkspaceConfig, parseYamlObject, writeWorkspaceInterface } from "../dist/config.js";
import { commandFor } from "../dist/commands.js";
import { categorizeDeck, deckCoverUrl, discoverDecks, humanizeDeckName } from "../dist/decks.js";
import { isValidBasicAuthHeader, isValidBasicAuthHeaderForUsername } from "../dist/server.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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

test("validates workspace basic auth headers", () => {
  const header = `Basic ${Buffer.from("slidev:secret").toString("base64")}`;

  assert.equal(isValidBasicAuthHeader(header, "secret"), true);
  assert.equal(isValidBasicAuthHeader(`basic ${Buffer.from("slidev:secret").toString("base64")}`, "secret"), true);
  assert.equal(isValidBasicAuthHeaderForUsername(`Basic ${Buffer.from("mario:secret").toString("base64")}`, "mario", "secret"), true);
  assert.equal(isValidBasicAuthHeader(`Basic ${Buffer.from("mario:secret").toString("base64")}`, "secret"), false);
  assert.equal(isValidBasicAuthHeader(`Basic ${Buffer.from("slidev:wrong").toString("base64")}`, "secret"), false);
  assert.equal(isValidBasicAuthHeader(undefined, "secret"), false);
});

test("protects dashboard routes with environment username and password", async () => {
  const fixture = createWorkspaceFixture("slidev-teaching-auth-");
  const server = await startWorkspaceServer(fixture.root, [], {
    SLIDEV_WORKSPACE_USERNAME: "mario",
    SLIDEV_WORKSPACE_PASSWORD: "dash-secret",
  });

  try {
    for (const path of ["/", "/api/decks", "/api/events"]) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /Basic realm=/);
    }

    const wrongUser = await fetch(`${server.url}/api/decks`, {
      headers: { Authorization: basicAuth("slidev", "dash-secret") },
    });
    assert.equal(wrongUser.status, 401);

    const response = await fetch(`${server.url}/api/decks`, {
      headers: { Authorization: basicAuth("mario", "dash-secret") },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.decks.length, 1);
    assert.equal(body.decks[0].id, fixture.deckId);
  } finally {
    await server.stop();
  }
});

test("returns bad request for invalid dashboard JSON", async () => {
  const fixture = createWorkspaceFixture("slidev-teaching-json-");
  const server = await startWorkspaceServer(fixture.root, ["--username", "mario", "--password", "dash-secret"]);

  try {
    const response = await fetch(`${server.url}/api/interface`, {
      method: "POST",
      headers: {
        Authorization: basicAuth("mario", "dash-secret"),
        "Content-Type": "application/json",
      },
      body: "{",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid JSON body." });
  } finally {
    await server.stop();
  }
});

test("keeps dashboard password separate from deck remote secret in runtime URLs", async () => {
  const fixture = createWorkspaceFixture("slidev-teaching-remote-");
  const fakeSlidev = writeFakeSlidevBin(fixture.root);
  const server = await startWorkspaceServer(
    fixture.root,
    ["--remote", "deck secret", "--bind", "127.0.0.1", "--username", "mario", "--password", "dash secret"],
    { SLIDEV_WORKSPACE_SLIDEV_BIN: fakeSlidev },
  );

  try {
    const response = await fetch(`${server.url}/api/decks/${encodeURIComponent(fixture.deckId)}/start`, {
      method: "POST",
      headers: { Authorization: basicAuth("mario", "dash secret") },
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.deck.runtime.status, "running");
    assert.match(body.deck.runtime.url, /^http:\/\/127\.0\.0\.1:\d+\/\?password=deck%20secret#\/1\?password=deck%20secret$/);
    assert.doesNotMatch(body.deck.runtime.url, /dash/);
  } finally {
    await server.stop();
  }
});

function createWorkspaceFixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const deckId = "Decks/Lecture01";
  const deckDir = join(root, deckId);
  mkdirSync(deckDir, { recursive: true });
  writeFileSync(
    join(root, "slidev-teaching-workspace.yaml"),
    `
slidesDir:
  - "./Decks"
outputDir: "./dist/slidev-workspace"
`,
  );
  writeFileSync(join(deckDir, "package.json"), "{}");
  writeFileSync(
    join(deckDir, "slides.md"),
    `---
title: Lecture 01
---
`,
  );

  return { root, deckId };
}

async function startWorkspaceServer(cwd, args = [], env = {}) {
  const port = await freeEphemeralPort();
  const child = spawn(process.execPath, [cliPath, "dev", "--port", String(port), ...args], {
    cwd,
    env: {
      ...process.env,
      SLIDEV_WORKSPACE_OPEN: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  await waitForServerOutput(child, output, port);

  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await stopChild(child);
    },
  };
}

async function freeEphemeralPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return address.port;
}

async function waitForServerOutput(child, output, port) {
  const expected = `Teaching Slidev Workspace running at http://localhost:${port}/`;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for workspace server.\n${output.join("")}`));
    }, 8000);

    const onData = () => {
      if (output.join("").includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Workspace server exited with code ${code} signal ${signal}.\n${output.join("")}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    onData();
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function writeFakeSlidevBin(root) {
  const scriptPath = join(root, "fake-slidev.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { createServer } from "node:http";

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});

server.listen(port, "127.0.0.1", () => {
  console.log(\`Fake Slidev ready at http://127.0.0.1:\${port}/\`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}
