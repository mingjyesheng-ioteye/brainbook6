# AionUi Architecture

A cross-platform Electron desktop AI assistant application, built as a Bun monorepo with a strict multi-process architecture.

**Stack**: Electron 37 + React 19 + UnoCSS + Arco Design + Vitest 4 + TypeScript (strict) + SQLite

---

## Monorepo Layout

```
brainbook6/
├── packages/
│   ├── desktop/          # @aionui/desktop — Main Electron app (core)
│   ├── web-cli/          # @aionui/web-cli — Browser-based CLI access
│   ├── web-host/         # @aionui/web-host — Web server + agent process registry
│   └── shared-scripts/   # @aionui/shared-scripts — Build/install scripts
├── tests/                # Shared test suites (unit, integration, E2E)
├── docs/                 # Documentation (guides, PRDs, translations)
├── scripts/              # Build/deploy/test scripts
├── resources/            # App resources (icons, bundled AionCore binary)
├── public/               # Vite public assets
├── patches/              # Dependency patches
├── homebrew/             # Homebrew formula
├── out/                  # Build output (gitignored)
├── package.json          # Workspace root
├── tsconfig.json         # Shared TS config
├── vitest.config.ts      # Shared test config
├── electron.vite.config.ts
├── uno.config.ts         # UnoCSS semantic tokens
├── AGENTS.md             # Contributor guide
└── ...                   # Tooling config (.oxlint, .oxfmt, husky, etc.)
```

---

## Three-Layer Process Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Renderer Process                     │
│  packages/desktop/src/renderer/                          │
│  - React 19 UI, DOM/browser APIs only                    │
│  - NO Node.js, NO Electron main APIs                     │
└──────────────────────────┬──────────────────────────────┘
                           │  IPC via contextBridge
┌──────────────────────────▼──────────────────────────────┐
│                     Preload Layer                        │
│  packages/desktop/src/preload/                           │
│  - contextBridge + ipcRenderer                           │
│  - Curated API surface exposed to renderer               │
│  - 4 entries: main + 3 pet windows                       │
└──────────────────────────┬──────────────────────────────┘
                           │  Node.js / Electron APIs only
┌──────────────────────────▼──────────────────────────────┐
│                    Main Process                          │
│  packages/desktop/src/process/                           │
│  - Node.js + Electron APIs only                          │
│  - NO DOM, NO React                                      │
│                                                          │
│  ├── bridge/        IPC handlers (renderer ↔ main)       │
│  ├── services/      Business logic (DB, updates, etc.)   │
│  ├── backend/       AionCore binary lifecycle            │
│  ├── startup/       App initialization & single-instance │
│  ├── pet/           Desktop pet companion system         │
│  ├── agent/         AI platform connections              │
│  ├── worker/        Background worker threads            │
│  ├── channels/      Multi-channel messaging              │
│  ├── extensions/    Plugin system                        │
│  ├── webserver/     Express + WebSocket for WebUI        │
│  ├── feedback/      Log collection                       │
│  └── utils/         Tray, GPU, zoom, deep links, etc.   │
└─────────────────────────────────────────────────────────┘
```

### Cross-Process Communication Rules

| Direction         | Mechanism                                          |
| ----------------- | -------------------------------------------------- |
| Renderer ↔ Main   | IPC via preload → `bridge/*.ts`                    |
| Main ↔ Worker     | Fork protocol via `WorkerProtocol.ts`              |
| WebUI             | Express HTTP + WebSocket (in `webserver/`)         |

**Hard rules** — violations cause runtime crashes:
- Renderer cannot import from `@process/*`
- Main process cannot use DOM APIs (`document`, `window`, React)

---

## Core: `packages/desktop/src/`

```
packages/desktop/src/
├── renderer/     # React UI (browser-only)
├── process/      # Electron main process (Node.js-only)
├── common/       # Shared cross-process code
├── preload/      # IPC bridge (contextBridge)
├── index.ts      # Main process entry
├── sentry.ts     # Sentry error tracking init
├── types.d.ts    # Ambient declarations
└── preload.ts    # Re-export of preload/main.ts
```

---

## Renderer Layer (`renderer/`)

```
renderer/
├── index.html              # Vite HTML entry (MPA: 4 pages)
├── main.tsx                # React 19 mount + bootstrap
├── pages/                  # Page-level modules (business code)
│   ├── conversation/       # Main chat/conversation page
│   │   ├── components/     # Page-private components
│   │   ├── GroupedHistory/ # Feature module (PascalCase)
│   │   ├── Workspace/      # Feature module
│   │   ├── Preview/        # Feature module
│   │   ├── platforms/      # Agent platforms (acp/, aionrs/, gemini/, legacy/)
│   │   ├── runtime/        # Runtime execution
│   │   └── utils/          # Page-private utilities
│   ├── settings/           # Settings page
│   │   ├── AgentSettings/, AssistantSettings/, AppearanceSettings/
│   │   ├── SkillsSettings/, ToolsSettings/, SystemSettings/
│   │   └── PetSettings.tsx, ExtensionSettingsPage.tsx, etc.
│   ├── cron/               # Scheduled tasks page
│   ├── team/               # Team management page
│   ├── login/              # Login page
│   └── guid/               # GUID page
├── components/             # Shared UI components (layered)
│   ├── base/               # UI primitives (Modal, Select, ScrollArea)
│   ├── chat/               # Chat/conversation domain
│   ├── agent/              # Agent/model selection
│   ├── layout/             # Window frame, router, sider, titlebar
│   ├── settings/           # Settings modals
│   ├── media/              # File preview, image viewer
│   ├── Markdown/           # Markdown rendering (code, mermaid, etc.)
│   └── workspace/          # Workspace selection
├── hooks/                  # Shared React hooks (grouped by domain)
│   ├── agent/, assistant/, chat/, config/, file/, mcp/
│   ├── system/ (useDeepLink, useTheme, usePwaMode)
│   └── ui/ (useAutoScroll, useDebounce, useResizableSplit)
├── services/               # Client-side services
│   ├── i18n/               # Internationalization (13 locales, 20 modules)
│   ├── speech/             # Speech services
│   ├── FileService.ts
│   ├── PasteService.ts
│   ├── SpeechToTextService.ts
│   ├── registerPwa.ts
│   ├── bootstrapRenderer.ts
│   └── clientBusinessSettings.ts
├── api/                    # HTTP client + WebSocket client
├── styles/                 # Global styles (UnoCSS tokens, Arco overrides, themes)
├── theme/                  # Built-in themes (builtinThemes.ts)
├── assets/                 # Static assets (logos, icons)
├── pet/                    # Pet renderer (3 separate HTML windows)
└── utils/                  # Renderer utilities (chat, file, model, workspace, theme)
```

### UI Standards
- **Components**: `@arco-design/web-react` (no raw `<button>`, `<input>`, etc.)
- **Icons**: `@icon-park/react`
- **CSS**: UnoCSS utilities → CSS Modules for complex/reusable styles
- **Colors**: Semantic tokens only (from `uno.config.ts` / CSS variables)

### Component Layering
```
components/
├── base/           # Fixed: UI primitives, no business logic
├── chat/           # Business: conversation domain
├── agent/          # Business: agent selection
├── layout/         # Business: window frame
├── media/          # Business: file preview
└── ...             # New domains as needed (lowercase)
```

### Page Module Structure
```
PageName/                     # PascalCase
├── index.tsx                 # Entry point (required)
├── components/               # Page-private (lowercase)
├── hooks/                    # Page-private
├── contexts/                 # Page-private
├── utils/                    # Page-private
├── types.ts
└── constants.ts
```

**Promotion rule**: Start page-private in `pages/<PageName>/`. Promote to `components/` or `hooks/` only when a second consumer appears.

---

## Main Process Layer (`process/`)

### IPC Bridges (`bridge/`)
One file per domain, registered in `bridge/index.ts`:

| Bridge                  | Purpose                          |
| ----------------------- | -------------------------------- |
| `applicationBridge.ts`  | App-level operations             |
| `dialogBridge.ts`       | Native dialogs                   |
| `feedbackBridge.ts`     | Log feedback                     |
| `notificationBridge.ts` | System notifications             |
| `restartApplication.ts` | App restart                      |
| `systemSettingsBridge.ts` | System settings access         |
| `themeBridge.ts`        | Theme changes                    |
| `updateBridge.ts`       | Auto-update management           |
| `webuiBridge.ts`        | WebUI configuration              |
| `windowControlsBridge.ts` | Window minimize/close/maximize |

### Services (`services/`)
```
services/
├── database/             # SQLite layer (better-sqlite3)
│   ├── drivers/          # Driver implementations (better-sqlite3, BunSqlite)
│   ├── schema.ts         # Database schema
│   ├── migrations.ts     # Schema migrations
│   └── IConversationRepository.ts
├── i18n/                 # Main-process i18n
├── autoUpdaterService.ts # Auto-update logic
├── autoUpdateDiagnostics.ts
├── cdnGenericProvider.ts # CDN content provider
├── updateFeed.ts         # Update feed management
└── installerLastFailure.ts
```

### Backend (`backend/`)
- `binaryResolver.ts` — Resolves AionCore (Rust binary) location
- Handles AionCore startup/shutdown lifecycle

### Startup (`startup/`)
- `backendStartup.ts` / `backendStartupFailure.ts` — Backend lifecycle
- `singleInstanceGating.ts` — Prevents multiple app instances
- `recoverCorruptedDatabase.ts` — DB repair
- `architectureCompatibility.ts` — Version compatibility checks
- `quitCleanup.ts` — Graceful shutdown
- `windowsPath.ts` — Windows-specific path handling

### Agent Platform Connections (`agent/`)
One directory per AI platform (lowercase): `acp/`, `codex/`, `gemini/`, `nanobot/`, `openclaw/`

### Worker (`worker/`)
Background worker threads for long-running tasks:
```
worker/
├── fork/               # Fork management
├── <platform>.ts       # Per-platform worker files
├── WorkerProtocol.ts   # Main ↔ Worker protocol (PascalCase class)
└── index.ts
```

### Other Modules
| Module       | Location                              | Purpose                              |
| ------------ | ------------------------------------- | ------------------------------------ |
| Channels     | `channels/`                           | Multi-channel messaging (Lark, DingTalk, Telegram) |
| Extensions   | `extensions/`                         | Plugin loading, resolvers, sandbox   |
| WebServer    | `webserver/`                          | Express + WebSocket for WebUI        |
| Resources    | `resources/builtinMcp/`               | Built-in MCP server resources        |

### Utilities (`utils/`)
Tray icon, GPU recovery, window bounds, zoom control, deep links, app menu, analytics ID, persist-on-quit, admin user management, CLI password reset.

---

## Shared Layer (`common/`)

Code imported by **both** main and renderer processes.

```
common/
├── adapter/           # API model mappers, HTTP/IPC bridges, registry
├── api/               # Rotating API clients (Anthropic, OpenAI, Gemini), protocol converters
├── chat/              # Chat library, slash commands, tool calls, image generation
├── config/            # App settings, config migration, i18n config, storage
├── electronSafe.ts    # Electron-safe utilities
├── platform/          # Platform abstraction (Electron vs Node services)
├── theme/             # Theme constants, migration, resolution
├── types/             # Shared types (agent, channel, provider, team, office)
├── update/            # Update models and types
└── utils/             # App config, model capabilities, protocol detection, shims
```

**Belongs here**: shared types, API adapters, protocol converters, storage keys.
**Does NOT belong**: React components → `renderer/`, Node.js-specific → `process/`.

---

## Preload Layer (`preload/`)

4 entry points using `contextBridge`:

| Entry                  | Window                    |
| ---------------------- | ------------------------- |
| `main.ts`              | Main application window   |
| `petPreload.ts`        | Pet companion window      |
| `petHitPreload.ts`     | Pet interaction popup     |
| `petConfirmPreload.ts` | Pet confirmation dialog   |

Only `contextBridge` and `ipcRenderer` APIs allowed. No DOM, no Node.js `fs`.

---

## External Dependencies

| Category          | Technologies                                              |
| ----------------- | --------------------------------------------------------- |
| **AI Providers**  | OpenAI, Anthropic, Google Gemini, AWS Bedrock             |
| **Chat UI**       | React Markdown, CodeMirror, Monaco Editor, Mermaid, KaTeX |
| **DB**            | better-sqlite3 (SQLite)                                   |
| **Protocol**      | MCP SDK (@modelcontextprotocol/sdk)                       |
| **Messaging**     | grammy (Telegram), dingtalk-stream, Lark                  |
| **Monitoring**    | Sentry (@sentry/electron, @sentry/vite-plugin)            |
| **Data Fetching** | SWR                                                       |
| **Validation**    | Zod                                                       |
| **i18n**          | i18next (13 locales, 20 modules)                          |
| **Virtual List**  | react-virtuoso                                            |
| **Diff**          | Diff2Html                                                 |

---

## Build & Tooling

| Tool             | Purpose                         |
| ---------------- | ------------------------------- |
| `electron-vite`  | Bundle (main + preload + renderer) |
| `electron-builder` | App packaging (Windows/macOS/Linux) |
| `electron.vite.config.ts` | MPA: 4 HTML entries (main + 3 pet) |
| `vitest.config.ts` | 2 test projects: `node` + `dom` (jsdom) |
| `playwright.config.ts` | E2E tests |
| `uno.config.ts`  | UnoCSS with semantic tokens + Arco Design color rules |
| `.oxlint` / `.oxfmt` | Linting + formatting (Prettier-compatible) |

---

## Routing (4 HTML Entries — MPA)

1. **`index`** — Main app (`renderer/index.html` → `main.tsx`)
2. **`pet`** — Pet companion (`renderer/pet/pet.html` → `petRenderer.ts`)
3. **`pet-hit`** — Pet interaction popup (`renderer/pet/pet-hit.html` → `petHitRenderer.ts`)
4. **`pet-confirm`** — Pet confirmation dialog (`renderer/pet/pet-confirm.html` → `petConfirmRenderer.ts`)

---

## Key Architectural Constraints

1. **Process boundary**: Renderer (`@renderer/*`) and Main (`@process/*`) never mix APIs
2. **Directory size limit**: Max 10 direct children per directory
3. **No single-file directories**: Merge into parent
4. **Page-private first**: Start in `pages/<Page>/`, promote to shared only on second consumer
5. **Naming**: Components PascalCase, utilities camelCase, renderer dirs PascalCase (component names), everything else lowercase
6. **Path aliases**: `@/*`, `@process/*`, `@renderer/*`, `@worker/*`
7. **No hardcoded strings**: All user-facing text uses i18n keys
8. **No raw interactive HTML**: Must use Arco Design components
