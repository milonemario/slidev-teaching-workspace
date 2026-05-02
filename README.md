# slidev-teaching-workspace

A Slidev workspace dashboard and CLI for managing many decks from one course or teaching repository. It discovers configured decks, starts individual Slidev dev servers on demand, runs build/export jobs, previews generated artifacts, and can build a static catalog for browsing published decks.

The npm package ships a compiled CLI for running a workspace dashboard around many Slidev decks. The command exposed by the package is:

```bash
slidev-teaching-workspace
```

## Requirements

- Node.js `>=20.12.0`
- Slidev `>=52.0.0`
- A repository-level `slidev-teaching-workspace.yaml`

Decks can use either local dependencies or a globally available `slidev` binary. The workspace CLI starts deck servers only when requested from the dashboard.

## Installation

For the global workflow used by a teaching repository:

```bash
npm install -g slidev-teaching-workspace
slidev-teaching-workspace
```

Run the command from the repository root that contains `slidev-teaching-workspace.yaml`. This keeps the workspace manager available as a global CLI instead of requiring a `node_modules` folder inside every teaching repository.

For a project-local install:

```bash
npm install -D slidev-teaching-workspace
```

Run the workspace from the repository root:

```bash
npx slidev-teaching-workspace
```

## Configuration

Create `slidev-teaching-workspace.yaml` in the repository root:

```yaml
categories:
  - id: data-analytics
    label: "Data Analytics"
    cover: "./Data_Analytics/Current/Canvas-Image.jpg"
    subcategories:
      - id: lectures
        label: "Lectures"
        slidesDir: "./Data_Analytics/Current/Lectures/Slidev"

outputDir: "./dist/slidev-workspace"
baseUrl: "/"
exclude:
  - "_template"

interface:
  theme: "classic"

hero:
  title: "Teaching Slides"
  description: "Course decks and exports"

sidebar:
  title: "Slidev Workspace"
  githubUrl: "https://github.com/example/repo"
```

Each deck directory should contain `slides.md` and `package.json`.

## Commands

```bash
slidev-teaching-workspace [--port 3000]
slidev-teaching-workspace dev [--port 3000] [--remote] [--bind 0.0.0.0]
slidev-teaching-workspace build
slidev-teaching-workspace export-og
```

Useful options:

| Option | Purpose |
| --- | --- |
| `--port`, `-p` | First workspace server port to try |
| `--open`, `-o` | Open the workspace in a browser |
| `--remote` | Listen on a public host, matching Slidev remote mode; accepts an optional remote-control password |
| `--bind`, `--host` | Address to bind in remote mode |
| `--force`, `-f` | Pass `--force` to deck dev servers |
| `--log` | Pass a Slidev log level: `error`, `warn`, `info`, or `silent` |

### Remote Mode

Remote mode intentionally follows Slidev's behavior. The workspace server binds publicly, and decks started from the dashboard are launched with Slidev's `--remote` and `--bind` options.

Plain Slidev remote access works without a deck `vite.config.ts` when using localhost or IP-address hosts. If you serve decks through a custom DNS name, Vite requires that host to be listed in `server.allowedHosts`; configure that in the deck's Vite config just as you would when running Slidev directly.

## Deck Ordering

Decks are grouped by the configured categories and subcategories. Within a group, add `workspace.order` to a deck frontmatter block for explicit ordering:

```yaml
---
title: "Lecture 01"
workspace:
  order: 1
---
```

When no order is provided, decks fall back to natural sorting by course, section, and folder label.

## Publishing

This package ships compiled JavaScript, declarations, and the built dashboard UI from `dist`. Run these checks before publishing:

```bash
npm test
npm run check:pack
```

`npm pack` and `npm publish` run `prepack`, which rebuilds `dist` before packaging.

Publish from this directory:

```bash
npm publish
```

For CI releases on npm, prefer trusted publishing or `npm publish --provenance` when your npm account and workflow support it.

## License

MIT
