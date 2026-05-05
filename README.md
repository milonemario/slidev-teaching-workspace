# slidev-teaching-workspace

A Slidev workspace dashboard and CLI for managing many decks from one repository. It discovers configured decks, starts individual Slidev dev servers on demand, runs build/export jobs, previews generated artifacts, and can build a static catalog for browsing published decks.

This package was inspired by the original [`slidev-workspace`](https://www.npmjs.com/package/slidev-workspace) package ([GitHub](https://github.com/leochiu-a/slidev-workspace)).

The npm package ships a compiled CLI for running a workspace dashboard around many Slidev decks. The command exposed by the package is:

```bash
slidev-teaching-workspace
```

## Features

- Organize decks by category and subcategory from a repository-level YAML file.
- Browse deck metadata, covers, build status, export status, and runtime status from one dashboard.
- Start and stop individual Slidev dev servers from the interface.
- Build individual decks, selected groups of decks, or the full workspace catalog.
- Export decks from the interface and preview generated files when available.
- Serve built deck previews and exported PDFs from the workspace dashboard.
- Generate a static workspace catalog for publishing or archiving.
- Choose between built-in dashboard themes.
- Use Slidev-compatible remote mode for presenting decks on the local network.
- Password protect the workspace dashboard when serving it on a shared network.

## Requirements

- Node.js `>=20.12.0`
- Slidev `>=52.0.0`
- A repository-level `slidev-teaching-workspace.yaml`

Decks can use either local dependencies or a globally available `slidev` binary. The workspace CLI starts deck servers only when requested from the dashboard.

## Installation

For a global install:

```bash
npm install -g slidev-teaching-workspace
slidev-teaching-workspace
```

Run the command from the repository root that contains `slidev-teaching-workspace.yaml`. This keeps the workspace manager available as a global CLI instead of requiring a `node_modules` folder in the workspace repository.

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
  - id: course-a
    label: "Course A"
    cover: "./courses/course-a/cover.jpg"
    subcategories:
      - id: lectures
        label: "Lectures"
        slidesDir: "./courses/course-a/lectures"
      - id: cases
        label: "Cases"
        slidesDir: "./courses/course-a/cases"

outputDir: "./dist/slidev-workspace"
baseUrl: "/"
exclude:
  - "_template"

interface:
  theme: "classic"

hero:
  title: "Slidev Workspace"
  description: "Decks, previews, exports, and static builds"

sidebar:
  title: "Slidev Workspace"
  githubUrl: "https://github.com/owner/repository"
```

Each deck directory should contain `slides.md` and `package.json`.

## Commands

```bash
slidev-teaching-workspace [--port 3000]
slidev-teaching-workspace dev [--port 3000] [--remote] [--bind 0.0.0.0] [--password secret] [--username slidev]
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
| `--password` | Protect the workspace dashboard |
| `--username` | Dashboard login username; defaults to `SLIDEV_WORKSPACE_USERNAME` or `slidev` |
| `--force`, `-f` | Pass `--force` to deck dev servers |
| `--log` | Pass a Slidev log level: `error`, `warn`, `info`, or `silent` |

### Remote Mode

Remote mode intentionally follows Slidev's behavior. The workspace server binds publicly, and decks started from the dashboard are launched with Slidev's `--remote` and `--bind` options.

When you provide `--password`, the workspace dashboard uses HTTP Basic Auth before serving any dashboard page, API response, deck cover, built preview, or exported file. Sign in with the configured username, defaulting to `slidev`, and the password you configured.

```bash
slidev-teaching-workspace --remote --password my-secret
```

To use a custom dashboard username:

```bash
slidev-teaching-workspace --remote --username mario --password my-secret
```

That command protects only the workspace dashboard. Decks started from the dashboard use Slidev's plain remote mode, with no Slidev presenter password.

To use Slidev's built-in presenter password for deck remote mode, pass the deck secret to `--remote`:

```bash
slidev-teaching-workspace --remote deck-secret
```

That command protects Slidev presenter/remote routes with `deck-secret`, but it does not protect the workspace dashboard unless you also pass `--password`. When a deck secret is configured, live deck links opened from the workspace include Slidev's `?password=...` query so presenter mode is available without typing the secret manually.

To protect both independently, pass both values:

```bash
slidev-teaching-workspace --remote deck-secret --password dashboard-secret
```

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

## License

MIT
