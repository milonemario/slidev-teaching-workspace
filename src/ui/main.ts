import "./styles/index.css";

type RuntimeStatus = "stopped" | "starting" | "running" | "stopping" | "failed";
type JobStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
type ArtifactState = "missing" | "fresh" | "stale";
type InterfaceTheme = "classic" | "modern";
type InterfaceLayout = "control-room" | "command-center";

interface PersistedInterfaceConfig {
  theme: InterfaceTheme;
}

interface ResolvedInterfaceConfig extends PersistedInterfaceConfig {
  layout: InterfaceLayout;
}

interface Deck {
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
  artifacts?: {
    build: ArtifactStatus;
    export: ArtifactStatus;
  };
  runtime: {
    status: RuntimeStatus;
    port?: number;
    pid?: number;
    url?: string;
    error?: string;
  };
  job: {
    status: JobStatus;
    type?: "build" | "export";
    error?: string;
  };
}

interface ArtifactStatus {
  state: ArtifactState;
  outputTime?: string;
  sourceTime?: string;
}

interface AppData {
  staticMode?: boolean;
  config: {
    hero: {
      title: string;
      description: string;
    };
    sidebar: {
      title: string;
      githubUrl: string;
    };
    interface: Partial<PersistedInterfaceConfig>;
  };
  decks: Deck[];
}

interface LogEntry {
  time: string;
  source: "dev" | "job" | "system";
  stream: "stdout" | "stderr" | "status";
  message: string;
}

interface DeckGroup {
  key: string;
  label: string;
  count: number;
  running: number;
  jobs: number;
  subgroups: Array<{
    key: string;
    label: string;
    count: number;
    running: number;
    jobs: number;
  }>;
}

interface RenderContext {
  activeInterface: ResolvedInterfaceConfig;
  groups: DeckGroup[];
  filtered: Deck[];
  focusedDeck?: Deck;
}

declare global {
  interface Window {
    __TEACHING_SLIDEV_STATIC_DATA__?: AppData;
  }
}

const interfaceThemes = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const;

const themeLayouts: Record<InterfaceTheme, InterfaceLayout> = {
  classic: "control-room",
  modern: "command-center",
};

const defaultInterface: PersistedInterfaceConfig = {
  theme: "classic",
};

const app = document.querySelector<HTMLDivElement>("#app");
let data: AppData | null = window.__TEACHING_SLIDEV_STATIC_DATA__ ?? null;
let apiAvailable = !window.__TEACHING_SLIDEV_STATIC_DATA__;
let search = "";
let selectedGroup = "all";
let focusedDeckId: string | null = null;
let logsDeckId: string | null = null;
let logs: LogEntry[] = [];
let busyActions = new Set<string>();
let busyInterface = false;
let interfaceError: string | null = null;
let eventSource: EventSource | null = null;
let fallbackPollTimer: number | undefined;

if (!app) {
  throw new Error("Missing app element");
}

void refresh().then(() => {
  render();
  if (apiAvailable) {
    startLiveUpdates();
  }
});

async function refresh(): Promise<void> {
  if (!apiAvailable && data) {
    return;
  }

  try {
    const response = await fetch("/api/decks");
    if (!response.ok) {
      throw new Error(await response.text());
    }
    data = (await response.json()) as AppData;
    apiAvailable = true;
  } catch {
    apiAvailable = false;
    data ??= {
      config: {
        hero: {
          title: "",
          description: "",
        },
        sidebar: {
          title: "",
          githubUrl: "",
        },
        interface: { ...defaultInterface },
      },
      decks: [],
    };
  }

  if (logsDeckId && apiAvailable) {
    await refreshLogs(logsDeckId);
  }
}

function startLiveUpdates(): void {
  if (data?.staticMode || eventSource) {
    return;
  }

  if (!("EventSource" in window)) {
    scheduleFallbackPoll();
    return;
  }

  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("decks", (event) => {
    window.clearTimeout(fallbackPollTimer);
    applyWorkspaceData(JSON.parse((event as MessageEvent<string>).data) as AppData);
  });
  eventSource.onerror = () => {
    scheduleFallbackPoll();
  };
}

function scheduleFallbackPoll(): void {
  window.clearTimeout(fallbackPollTimer);
  fallbackPollTimer = window.setTimeout(() => {
    void refresh().then(() => {
      if (!isUserEditing()) {
        render();
      }
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        scheduleFallbackPoll();
      }
    });
  }, 30000);
}

function applyWorkspaceData(nextData: AppData): void {
  data = nextData;
  apiAvailable = true;

  if (logsDeckId) {
    void refreshLogs(logsDeckId).then(() => {
      if (!isUserEditing()) {
        render();
      }
    });
    return;
  }

  if (!isUserEditing()) {
    render();
  }
}

function render(): void {
  if (!data) {
    app.innerHTML = `<main class="shell"><p>Loading...</p></main>`;
    return;
  }

  const groups = groupDecks(data.decks);
  const filtered = filterDecks(data.decks);
  const activeInterface = resolveInterface(data.config.interface);
  const focusedDeck = deckByFocus(filtered);
  const context = {
    activeInterface,
    groups,
    filtered,
    focusedDeck,
  };

  app.innerHTML = `
    <div class="app-shell" data-theme="${escapeAttribute(activeInterface.theme)}">
      ${renderActiveLayout(context)}
      ${renderLogDock(context.focusedDeck)}
      ${renderInterfaceDock(activeInterface)}
      <aside class="logs ${logsDeckId ? "open" : ""}">
        ${renderLogs()}
      </aside>
    </div>
  `;

  bindEvents(filtered);
}

function renderActiveLayout(context: RenderContext): string {
  if (context.activeInterface.layout === "command-center") {
    return renderCommandCenter(context);
  }

  return renderControlRoom(context);
}

function renderControlRoom(context: RenderContext): string {
  return `
    ${renderSidebar(context.groups)}
    <main class="workspace control-room">
      ${renderTopbar()}
      <section class="control-room-grid">
        <section class="operation-panel">
          ${renderBatchbar(context.filtered)}
          <div class="deck-table">
            ${context.filtered.map((deck) => renderDeckRow(deck)).join("") || renderEmptyState()}
          </div>
        </section>
        <aside class="deck-inspector">
          ${context.focusedDeck ? renderDeckInspector(context.focusedDeck) : renderEmptyInspector()}
        </aside>
      </section>
    </main>
  `;
}

function renderCommandCenter(context: RenderContext): string {
  return `
    <main class="workspace command-center">
      <aside class="modern-sidebar">
        <div class="modern-sidebar-inner">
          <div class="modern-brand">
            <span class="brand-mark"></span>
            <div>
              <span>${data!.decks.length} decks</span>
            </div>
          </div>
          <label class="modern-search">
            <span>Search</span>
            <input id="search" type="search" value="${escapeAttribute(search)}" placeholder="Search decks" />
          </label>
          ${renderModernFilters(context.groups)}
        </div>
      </aside>
      <section class="modern-main">
        <header class="modern-header">
          <div class="modern-actions">
            <button class="secondary" data-action="refresh" ${!apiAvailable ? "disabled" : ""}>Refresh</button>
          </div>
        </header>
        <section class="modern-overview">
          <p>
            <strong>${context.filtered.length}</strong> of ${data!.decks.length} decks
            ${search.trim() ? ` matching <strong>${escapeHtml(search.trim())}</strong>` : ""}
          </p>
        </section>
        <section class="modern-batchbar">
          <span>${context.filtered.length} selected by filter</span>
          <div>
            <button data-action="batch-build" ${disableRuntimeButton()}>Build matches</button>
            <button data-action="batch-export" ${disableRuntimeButton()}>Export matches</button>
          </div>
        </section>
        <section class="modern-card-grid" aria-label="Decks">
          ${context.filtered.map((deck) => renderModernDeckCard(deck)).join("") || renderEmptyState()}
        </section>
      </section>
    </main>
  `;
}

function renderModernFilters(groups: DeckGroup[]): string {
  return `
    <nav class="modern-filters" aria-label="Deck filters">
      <p>Courses</p>
      <button class="modern-filter ${selectedGroup === "all" ? "active" : ""}" data-group="all">
        <span class="filter-label">All decks</span>${renderFilterCount(data!.decks.length)}
      </button>
      ${groups
        .map(
          (group) => `
            <div class="modern-filter-group">
              <button class="modern-filter ${selectedGroup === group.key ? "active" : ""}" data-group="${escapeAttribute(group.key)}">
                <span class="filter-label">${escapeHtml(group.label)}</span>${renderFilterCount(group.count)}
              </button>
              <div class="modern-subfilters">
                ${group.subgroups
                  .map(
                    (subgroup) => `
                      <button class="modern-filter modern-subfilter ${selectedGroup === subgroup.key ? "active" : ""}" data-group="${escapeAttribute(subgroup.key)}">
                        <span class="filter-label">${escapeHtml(subgroup.label)}</span>${renderFilterMeta(subgroup)}
                      </button>
                    `,
                  )
                  .join("")}
              </div>
            </div>
          `,
        )
        .join("")}
    </nav>
  `;
}

function renderModernDeckCard(deck: Deck): string {
  return `
    <article class="modern-deck-card ${focusedDeckId === deck.id ? "focused" : ""}" data-status="${escapeAttribute(deck.runtime.status)}" data-job="${escapeAttribute(deck.job.status)}">
      ${renderModernCardCover(deck)}
      <button class="modern-card-main" data-action="focus" data-id="${escapeAttribute(deck.id)}">
        <span class="modern-card-topline">
          <span>${escapeHtml(deck.section)}</span>
        </span>
        <strong>${escapeHtml(deck.label)}</strong>
        <small>${escapeHtml(deck.course)}</small>
      </button>
      <div class="modern-card-meta">
        ${renderJob(deck)}
        ${deck.runtime.port ? `<span>Port ${deck.runtime.port}</span>` : ""}
      </div>
      ${renderDeckMessages(deck)}
      <div class="modern-card-actions">
        ${renderDeckActions(deck, "modern-card")}
      </div>
    </article>
  `;
}

function renderModernCardCover(deck: Deck): string {
  if (deck.coverUrl) {
    return `
      <div class="modern-card-cover">
        <img src="${escapeAttribute(deck.coverUrl)}" alt="" loading="lazy" />
        ${renderStatus(deck)}
        <div class="modern-card-live-actions">
          ${renderLiveActionGroup(deck)}
        </div>
      </div>
    `;
  }

  return `
    <div class="modern-card-cover empty">
      ${renderStatus(deck)}
      <div class="modern-card-live-actions">
        ${renderLiveActionGroup(deck)}
      </div>
    </div>
  `;
}

function renderTopbar(): string {
  return `
    <header class="topbar">
      <div class="toolbar">
        <input id="search" type="search" value="${escapeAttribute(search)}" placeholder="Search decks" />
        <button class="secondary" data-action="refresh" ${!apiAvailable ? "disabled" : ""}>Refresh</button>
      </div>
    </header>
  `;
}

function renderSidebar(groups: DeckGroup[]): string {
  return `
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark"></span>
        <div>
          <p>${data!.decks.length} decks</p>
        </div>
      </div>
      <button class="group-button ${selectedGroup === "all" ? "active" : ""}" data-group="all">
        <span class="filter-label">All decks</span>${renderFilterCount(data!.decks.length)}
      </button>
      ${groups.map(renderGroup).join("")}
    </aside>
  `;
}

function renderBatchbar(filtered: Deck[]): string {
  return `
    <section class="batchbar">
      <span>${filtered.length} visible</span>
      <button data-action="batch-build" ${disableRuntimeButton()}>Build visible</button>
      <button data-action="batch-export" ${disableRuntimeButton()}>Export visible</button>
    </section>
  `;
}

function renderDeckRow(deck: Deck): string {
  return `
    <article class="deck-row ${focusedDeckId === deck.id ? "focused" : ""}" data-status="${escapeAttribute(deck.runtime.status)}" data-job="${escapeAttribute(deck.job.status)}" data-category="${escapeAttribute(deck.categoryId)}" data-subcategory="${escapeAttribute(deck.subcategoryId)}">
      <button class="deck-select" data-action="focus" data-id="${escapeAttribute(deck.id)}">
        <span class="deck-heading">
          ${renderStatus(deck)}
          <span class="section">${escapeHtml(deck.course)} / ${escapeHtml(deck.section)}</span>
        </span>
        <strong>${escapeHtml(deck.label)}</strong>
        <span>${escapeHtml(deck.title || deck.relativePath)}</span>
      </button>
      <div class="deck-meta">
        ${renderJob(deck)}
        ${deck.runtime.port ? `<span>Port ${deck.runtime.port}</span>` : ""}
      </div>
      <div class="deck-actions">
        ${renderDeckActions(deck)}
      </div>
    </article>
  `;
}

function renderDeckInspector(deck: Deck): string {
  return `
    <div class="inspector-header">
      <p class="eyebrow">Selected deck</p>
      <h2>${escapeHtml(deck.label)}</h2>
      <p>${escapeHtml(deck.title || deck.relativePath)}</p>
    </div>
    <dl class="deck-facts">
      <div><dt>Course</dt><dd>${escapeHtml(deck.course)}</dd></div>
      <div><dt>Section</dt><dd>${escapeHtml(deck.section)}</dd></div>
      <div><dt>Runtime</dt><dd>${renderStatus(deck)}</dd></div>
      <div><dt>Job</dt><dd>${renderJob(deck)}</dd></div>
      ${deck.runtime.port ? `<div><dt>Port</dt><dd>${deck.runtime.port}</dd></div>` : ""}
    </dl>
    ${renderDeckMessages(deck)}
    <div class="inspector-actions">
      ${renderDeckActions(deck)}
    </div>
    <p class="path-label">${escapeHtml(deck.relativePath)}</p>
  `;
}

function renderDeckActions(deck: Deck, mode: "full" | "modern-card" = "full"): string {
  return `
    <div class="deck-action-groups" data-action-mode="${escapeAttribute(mode)}">
      ${mode === "modern-card" ? "" : renderLiveActionGroup(deck)}
      ${renderArtifactActionGroups(deck)}
    </div>
  `;
}

function renderLiveActionGroup(deck: Deck): string {
  const status = deck.runtime.status;
  const liveAction = status === "running" || status === "starting" ? "stop" : "start";
  const liveLabel = liveAction === "stop" ? "Stop" : "Start";
  const canToggleLive =
    apiAvailable &&
    !isBusyAction(liveAction, deck.id) &&
    ((liveAction === "start" && (status === "stopped" || status === "failed")) ||
      (liveAction === "stop" && (status === "running" || status === "starting")));
  const canOpen = status === "running" && Boolean(deck.runtime.url);

  return `
    <div class="action-group live-action-group" aria-label="Live deck">
      <button class="primary" data-action="${liveAction}" data-id="${escapeAttribute(deck.id)}" ${canToggleLive ? "" : "disabled"}>${liveLabel}</button>
      ${renderPreviewControl(canOpen, deck.runtime.url, "Open live deck")}
    </div>
  `;
}

function renderArtifactActionGroups(deck: Deck): string {
  const job = deck.job.status;
  const canRunJob = apiAvailable && job !== "running" && job !== "queued";
  const canOpenBuilt = apiAvailable && Boolean(deck.builtPreviewUrl);
  const canOpenExport = apiAvailable && Boolean(deck.exportPreviewUrl);
  const buildArtifact = artifactStatus(deck, "build");
  const exportArtifact = artifactStatus(deck, "export");

  return `
    <div class="action-group build-action-group" data-freshness="${escapeAttribute(buildArtifact.state)}" title="${escapeAttribute(artifactTitle("Build", buildArtifact))}" aria-label="Built deck">
      <button data-action="build" data-id="${escapeAttribute(deck.id)}" ${canRunJob ? "" : "disabled"}>Build</button>
      ${renderPreviewControl(canOpenBuilt, deck.builtPreviewUrl, "View built deck")}
    </div>
    <div class="action-group export-action-group" data-freshness="${escapeAttribute(exportArtifact.state)}" title="${escapeAttribute(artifactTitle("Export", exportArtifact))}" aria-label="Exported deck">
      <button data-action="export" data-id="${escapeAttribute(deck.id)}" ${canRunJob ? "" : "disabled"}>Export</button>
      ${renderPreviewControl(canOpenExport, deck.exportPreviewUrl, "View exported deck")}
    </div>
  `;
}

function renderPreviewControl(enabled: boolean, url: string | undefined, label: string): string {
  const attributes = `class="button icon-button" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}"`;
  if (enabled && url) {
    return `<a ${attributes} href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${renderEyeIcon()}</a>`;
  }

  return `<button ${attributes} disabled>${renderEyeIcon()}</button>`;
}

function renderEyeIcon(): string {
  return `
    <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
}

function artifactStatus(deck: Deck, kind: "build" | "export"): ArtifactStatus {
  const fallback: ArtifactStatus = {
    state: kind === "build" ? (deck.builtPreviewUrl ? "fresh" : "missing") : deck.exportPreviewUrl ? "fresh" : "missing",
  };
  return deck.artifacts?.[kind] ?? fallback;
}

function artifactTitle(label: string, artifact: ArtifactStatus): string {
  if (artifact.state === "missing") {
    return `${label} output is missing.`;
  }
  if (artifact.state === "stale") {
    return `${label} output is stale; the deck changed after it was created.`;
  }
  return `${label} output is up to date.`;
}

function renderStatus(deck: Deck): string {
  const status = deck.runtime.status;
  return `<span class="status ${status}" data-status="${escapeAttribute(status)}">${status}</span>`;
}

function renderJob(deck: Deck): string {
  const job = deck.job.status;
  if (job === "idle") {
    return "";
  }
  return `<span class="job ${job}" data-job="${escapeAttribute(job)}">${job}${deck.job.type ? ` ${deck.job.type}` : ""}</span>`;
}

function renderDeckMessages(deck: Deck): string {
  return `
    ${deck.runtime.error ? `<p class="error">${escapeHtml(deck.runtime.error)}</p>` : ""}
    ${deck.job.error ? `<p class="error">${escapeHtml(deck.job.error)}</p>` : ""}
  `;
}

function renderLogDock(deck?: Deck): string {
  const openForSelectedDeck = Boolean(deck && logsDeckId === deck.id);
  const action = openForSelectedDeck ? "close-logs" : "logs";
  const disabled = !apiAvailable || !deck ? "disabled" : "";
  const idAttribute = deck ? ` data-id="${escapeAttribute(deck.id)}"` : "";
  const title = deck
    ? `${openForSelectedDeck ? "Hide" : "Show"} logs for ${deck.label}`
    : "Choose a deck to show logs";

  return `
    <div class="log-dock">
      <button class="secondary log-dock-button ${openForSelectedDeck ? "active" : ""}" data-action="${action}"${idAttribute} ${disabled} title="${escapeAttribute(title)}">Logs</button>
    </div>
  `;
}

function renderInterfaceDock(activeInterface: ResolvedInterfaceConfig): string {
  const open = busyInterface || interfaceError ? " open" : "";
  return `
    <details class="interface-dock"${open}>
      <summary aria-label="Interface settings">View</summary>
      <div class="interface-dock-panel">
        ${renderInterfaceControls(activeInterface)}
        ${renderInterfaceError()}
      </div>
    </details>
  `;
}

function renderInterfaceControls(activeInterface: ResolvedInterfaceConfig): string {
  const disabled = !apiAvailable || busyInterface ? "disabled" : "";
  return `
    <div class="interface-controls" aria-label="Interface settings">
      <label>
        <span>Theme</span>
        <select id="theme-select" ${disabled}>
          ${interfaceThemes
            .map(
              (theme) =>
                `<option value="${theme.value}" ${theme.value === activeInterface.theme ? "selected" : ""}>${theme.label}</option>`,
            )
            .join("")}
        </select>
      </label>
      ${busyInterface ? `<span class="interface-saving">Saving</span>` : ""}
    </div>
  `;
}

function renderLogs(): string {
  if (!logsDeckId) {
    return "";
  }

  const deck = data?.decks.find((candidate) => candidate.id === logsDeckId);
  return `
    <div class="logs-header">
      <div>
        <p class="eyebrow">Logs</p>
        <h2>${escapeHtml(deck?.label ?? "Deck")}</h2>
      </div>
      <button class="secondary" data-action="close-logs">Close</button>
    </div>
    <pre>${logs.map((entry) => `[${entry.time.slice(11, 19)}] ${entry.source}/${entry.stream}: ${entry.message}`).map(escapeHtml).join("\n") || "No logs yet."}</pre>
  `;
}

function renderGroup(group: DeckGroup): string {
  return `
    <div class="category-group">
      <button class="group-button category-button ${selectedGroup === group.key ? "active" : ""}" data-group="${escapeAttribute(group.key)}">
        <span class="filter-label">${escapeHtml(group.label)}</span>${renderFilterCount(group.count)}
      </button>
      <div class="subcategory-list">
        ${group.subgroups
          .map(
            (subgroup) => `
              <button class="subgroup-button ${selectedGroup === subgroup.key ? "active" : ""}" data-group="${escapeAttribute(subgroup.key)}">
                <span class="filter-label">${escapeHtml(subgroup.label)}</span>${renderFilterMeta(subgroup)}
              </button>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderFilterCount(count: number): string {
  return `
    <span class="filter-meta">
      <span class="filter-count">${count}</span>
    </span>
  `;
}

function renderFilterMeta(summary: Pick<DeckGroup, "count" | "running" | "jobs">): string {
  return `
    <span class="filter-meta">
      <span class="filter-count">${summary.count}</span>
      ${summary.running ? `<span class="filter-badge running">${summary.running} running</span>` : ""}
      ${summary.jobs ? `<span class="filter-badge jobs">${summary.jobs} jobs</span>` : ""}
    </span>
  `;
}

function renderEmptyState(): string {
  return `<div class="empty">No decks match the current filter.</div>`;
}

function renderEmptyInspector(): string {
  return `
    <div class="empty inspector-empty">
      <h2>No deck selected</h2>
      <p>Choose a deck from the current view.</p>
    </div>
  `;
}

function renderInterfaceError(): string {
  return interfaceError ? `<p class="interface-error" role="alert">${escapeHtml(interfaceError)}</p>` : "";
}

function bindEvents(filtered: Deck[]): void {
  app.querySelector<HTMLInputElement>("#search")?.addEventListener("input", (event) => {
    search = (event.target as HTMLInputElement).value;
    render();
  });

  app.querySelector<HTMLSelectElement>("#theme-select")?.addEventListener("change", () => {
    void saveSelectedInterface();
  });

  app.querySelectorAll<HTMLButtonElement>("[data-group]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedGroup = button.dataset.group || "all";
      render();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const id = button.dataset.id;
      if (!action) {
        return;
      }

      if (action === "refresh") {
        void refresh().then(render);
      } else if (action === "close-logs") {
        logsDeckId = null;
        logs = [];
        render();
      } else if (action === "batch-build" || action === "batch-export") {
        const kind = action === "batch-build" ? "build" : "export";
        void post(`/api/batch/${kind}`, { ids: filtered.map((deck) => deck.id) }).then(refresh).then(render);
      } else if (action === "focus" && id) {
        focusedDeckId = id;
        if (logsDeckId) {
          logsDeckId = id;
          logs = [];
          void refreshLogs(id).then(render);
        } else {
          render();
        }
      } else if (action === "logs" && id) {
        focusedDeckId = id;
        logsDeckId = id;
        void refreshLogs(id).then(render);
      } else if (id) {
        void runDeckAction(id, action);
      }
    });
  });
}

async function saveSelectedInterface(): Promise<void> {
  const theme = app.querySelector<HTMLSelectElement>("#theme-select")?.value;
  if (!isInterfaceTheme(theme)) {
    return;
  }
  await saveInterface({ theme });
}

async function saveInterface(nextInterface: PersistedInterfaceConfig): Promise<void> {
  if (!data || !apiAvailable || busyInterface) {
    return;
  }

  const previousInterface = { ...data.config.interface };
  data.config.interface = nextInterface;
  busyInterface = true;
  interfaceError = null;
  render();

  try {
    const response = await postJson<{ interface: Partial<PersistedInterfaceConfig> }>("/api/interface", {
      theme: nextInterface.theme,
    });
    data.config.interface = normalizePersistedInterface(response.interface);
  } catch (error) {
    data.config.interface = previousInterface;
    interfaceError = error instanceof Error ? error.message : String(error);
  } finally {
    busyInterface = false;
    render();
  }
}

async function runDeckAction(id: string, action: string): Promise<void> {
  const busyKey = actionKey(action, id);
  busyActions = new Set(busyActions).add(busyKey);
  focusedDeckId = id;
  render();
  try {
    await post(`/api/decks/${encodeURIComponent(id)}/${action}`);
    if (logsDeckId === id) {
      await refreshLogs(id);
    }
    await refresh();
  } finally {
    const nextBusyActions = new Set(busyActions);
    nextBusyActions.delete(busyKey);
    busyActions = nextBusyActions;
    render();
  }
}

async function refreshLogs(id: string): Promise<void> {
  const response = await fetch(`/api/decks/${encodeURIComponent(id)}/logs`);
  if (response.ok) {
    logs = ((await response.json()) as { logs: LogEntry[] }).logs;
  }
}

async function post(url: string, body?: unknown): Promise<void> {
  await postJson<unknown>(url, body);
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(errorMessage(await response.text()));
  }

  return (await response.json()) as T;
}

function deckByFocus(filtered: Deck[]): Deck | undefined {
  if (focusedDeckId) {
    const focused = filtered.find((deck) => deck.id === focusedDeckId);
    if (focused) {
      return focused;
    }
  }

  return filtered[0];
}

function groupDecks(decks: Deck[]): DeckGroup[] {
  const groups = new Map<string, DeckGroup>();
  for (const deck of decks) {
    const deckStatus = statusSummaryForDeck(deck);
    const key = `category:${deck.categoryId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.running += deckStatus.running;
      existing.jobs += deckStatus.jobs;
    } else {
      groups.set(key, {
        key,
        label: deck.course,
        count: 1,
        running: deckStatus.running,
        jobs: deckStatus.jobs,
        subgroups: [],
      });
    }

    const group = groups.get(key)!;
    const subgroupKey = `subcategory:${deck.categoryId}::${deck.subcategoryId}`;
    const subgroup = group.subgroups.find((candidate) => candidate.key === subgroupKey);
    if (subgroup) {
      subgroup.count += 1;
      subgroup.running += deckStatus.running;
      subgroup.jobs += deckStatus.jobs;
    } else {
      group.subgroups.push({
        key: subgroupKey,
        label: deck.section,
        count: 1,
        running: deckStatus.running,
        jobs: deckStatus.jobs,
      });
    }
  }
  return [...groups.values()];
}

function statusSummaryForDeck(deck: Deck): Pick<DeckGroup, "running" | "jobs"> {
  return {
    running: deck.runtime.status === "running" ? 1 : 0,
    jobs: deck.job.status === "queued" || deck.job.status === "running" ? 1 : 0,
  };
}

function filterDecks(decks: Deck[]): Deck[] {
  const query = search.trim().toLowerCase();
  return decks.filter((deck) => {
    const groupMatches =
      selectedGroup === "all" ||
      selectedGroup === `category:${deck.categoryId}` ||
      selectedGroup === `subcategory:${deck.categoryId}::${deck.subcategoryId}`;
    const queryMatches =
      !query ||
      [deck.label, deck.title, deck.course, deck.section, deck.relativePath]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query));
    return groupMatches && queryMatches;
  });
}

function disableRuntimeButton(): string {
  return apiAvailable ? "" : "disabled";
}

function isUserEditing(): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLTextAreaElement ||
    busyInterface
  );
}

function isBusyAction(action: string, id: string): boolean {
  return busyActions.has(actionKey(action, id));
}

function actionKey(action: string, id: string): string {
  return `${action}:${id}`;
}

function resolveInterface(value: Partial<PersistedInterfaceConfig> | undefined): ResolvedInterfaceConfig {
  return interfaceForTheme(normalizePersistedInterface(value).theme);
}

function normalizePersistedInterface(value: Partial<PersistedInterfaceConfig> | undefined): PersistedInterfaceConfig {
  return {
    theme: isInterfaceTheme(value?.theme) ? value.theme : defaultInterface.theme,
  };
}

function isInterfaceTheme(value: unknown): value is InterfaceTheme {
  return interfaceThemes.some((theme) => theme.value === value);
}

function interfaceForTheme(theme: InterfaceTheme): ResolvedInterfaceConfig {
  return {
    theme,
    layout: themeLayouts[theme],
  };
}

function errorMessage(responseText: string): string {
  try {
    const parsed = JSON.parse(responseText) as { error?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Keep the original response text below.
  }
  return responseText || "Request failed.";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
