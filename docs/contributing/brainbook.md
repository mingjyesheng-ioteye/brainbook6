# Brainbook Development

## Build Windows with a Local AionCore

By default, `bun run build-win` downloads the configured AionCore release. To package local backend changes and their embedded assets, install AionCore and explicitly select that binary for the build:

```powershell
# Run from the AionCore repository.
cargo install --path crates/aionui-app --locked --force

# Run from the AionUi repository in the same PowerShell session.
$env:AIONUI_BACKEND_LOCAL_BINARY = "$HOME\.cargo\bin\aioncore.exe"
bun run build-win
```

After preparation, `resources/bundled-aioncore/win32-x64/manifest.json` should contain `"sourceType": "local-binary"`. If the variable is not set, the build continues to use the configured release binary.

## Sync with the Parent Repository

The expected remotes are:

- `origin`: the Brainbook fork
- `upstream`: `https://github.com/iOfficeAI/AionUi.git`

Confirm them before syncing:

```powershell
git remote -v
```

If `upstream` is missing, add it once:

```powershell
git remote add upstream https://github.com/iOfficeAI/AionUi.git
```

Commit local changes before rebasing, then replay the Brainbook commits on the latest parent branch:

```powershell
git status
git add <changed-files>
git commit -m "<type>: <description>"

git fetch upstream --prune
git rebase upstream/main
```

If the rebase reports conflicts, resolve each file and continue:

```powershell
git status
git add <resolved-files>
git rebase --continue
```

To cancel an incomplete rebase and return to the previous state:

```powershell
git rebase --abort
```

After a successful rebase, update the Brainbook fork:

```powershell
git push --force-with-lease origin main
```

Use `--force-with-lease`, not `--force`, because rebasing changes commit IDs while the lease protects unexpected remote changes.

## Build aionui-web (Standalone Web CLI)

`@aionui/web-cli` is the CLI entry point that produces `aionui-web.exe`. It depends on `@aionui/web-host` (the library) for backend spawning and static serving.

### Prerequisites

- Bun installed
- AionCore backend binary (download from [Releases](https://github.com/iOfficeAI/brainbook/releases))

### Build Steps

```powershell
# 1. Install dependencies
bun install

# 2. Build renderer assets (SPA static files)
bun run build

# 3. Build web-cli package
bun run --filter @aionui/web-cli build

# 4. Download AionCore backend binary
#    Place it at packages/web-cli/bundled-aioncore/<plat-arch>/aioncore.exe
#    Example: packages/web-cli/bundled-aioncore/win-x64/aioncore.exe

# 5. Copy renderer static assets
Copy-Item -Recurse -Force packages/desktop/out/renderer/* packages/web-cli/static/
```

### Run (Dev Mode)

```powershell
# Start with backend
bun run --filter @aionui/web-cli start

# Or with explicit paths
bun run --filter @aionui/web-cli start --backend-bin ./bundled-aioncore/win-x64/aioncore.exe --static-dir ./static --remote
```

### Run (Packaged / Bun Compiled)

```powershell
# Compile to standalone binary
bun build --compile --target=bun-windows-x64 packages/web-cli/src/index.ts --outfile=aionui-web.exe

# Run
.\aionui-web.exe start --remote
```

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `--port <n>` | 25808 | Listen port |
| `--remote` | false | Bind 0.0.0.0 for network access |
| `--data-dir <path>` | `~/.aionui-web` | SQLite + logs directory |
| `--static-dir <path>` | `<cli-root>/static` | SPA static assets |
| `--backend-bin <path>` | `<cli-root>/bundled-aioncore/<plat-arch>/aioncore` | Backend binary |
| `--open` | true | Auto-open browser on start |
| `--no-open` | false | Disable auto-open |

### Environment Variables

```powershell
$env:AIONUI_PORT = "8080"
$env:AIONUI_ALLOW_REMOTE = "true"
$env:AIONUI_DATA_DIR = "C:\data\brainbook"
$env:AIONUI_BACKEND_BIN = "C:\tools\aioncore.exe"
```

### Login

On first launch, the terminal prints the generated credentials:

```
[WebUI] Generated initial admin password: RandomPassword123
[WebUI] Log in with username "admin"
```

Username is always `admin` (unless overridden via `webui.config.json` legacy migration).

### Reset Admin Password

```powershell
# Reset and print new credentials
.\aionui-web.exe resetpass

# Or specify data dir and backend
.\aionui-web.exe resetpass --data-dir C:\data\brainbook --backend-bin C:\tools\aioncore.exe
```

The new password is printed to terminal. All existing JWT sessions are invalidated.

### Headless Linux Deployment

For server/container deployment, wrap with `xvfb-run` (Electron requires a display):

```bash
sudo apt-get install -y xvfb
xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
    aionui-web start --remote --no-sandbox
```

Or use the desktop app with `--webui --remote --no-sandbox` for the same effect.

## Build aionui-web-host (Library Package)

`@aionui/web-host` is the underlying library that `web-cli` depends on. It has **no `bin` field** and does not produce a standalone executable. It builds to `dist/index.js` and is consumed by `web-cli`.

**Package relationship:**
```
@aionui/web-cli (has bin → produces aionui-web.exe)
  └── depends on @aionui/web-host (library, no bin)
```

Use `web-host` directly only when building custom orchestration (Docker entrypoint, Kubernetes init container, or integrating with another Node.js service).

### Build

```powershell
# Build the web-host package
bun run --filter @aionui/web-host build

# Build the renderer assets (required at runtime)
bun run build
```

### Run via Node/Bun

```powershell
# Example: standalone Node.js script
node start-webhost.js

# start-webhost.js contents:
# import { startWebHost } from '@aionui/web-host';
# const handle = await startWebHost({
#   app: { version: '2.1.41', isPackaged: true, resourcesPath: '.', userDataPath: 'C:\\data\\brainbook' },
#   staticDir: 'C:\\src\\brainbook\\out\\renderer',
#   port: 25808,
#   allowRemote: true,
#   dataDir: 'C:\\data\\brainbook',
#   logDir: 'C:\\data\\brainbook\\logs',
#   dirs: { cacheDir: 'C:\\data\\brainbook', workDir: 'C:\\data\\brainbook', logDir: 'C:\\data\\brainbook\\logs' },
#   backend: { kind: 'ownBackend', resolveBackend: () => 'C:\\tools\\aioncore.exe' }
# });
# console.log('WebUI ready:', handle.url);
# await new Promise(() => {}); // keep alive
```

### Node.js API

```typescript
import { startWebHost, startStaticServer, startBackend, stopBackend } from '@aionui/web-host';

// Option A: Full web host (backend + static server)
const handle = await startWebHost({
  app: { version: '2.1.41', isPackaged: false, resourcesPath: '.', userDataPath: '.' },
  staticDir: './out/renderer',
  port: 25808,
  allowRemote: false,
  dataDir: './data',
  logDir: './logs',
  dirs: { cacheDir: './data', workDir: './data', logDir: './logs' },
  backend: {
    kind: 'ownBackend',
    resolveBackend: () => './aioncore.exe',
  },
});

// Option B: Static server only (no backend — API calls will 502)
const staticHandle = await startStaticServer({
  staticDir: './out/renderer',
  backendPort: 0, // invalid port
  port: 3000,
  allowRemote: true,
});

// Stop
await handle.stop();
await staticHandle.stop();
```

### Key Behaviors

- **Static server** serves SPA assets and reverse-proxies `/api/*`, `/login`, `/logout` to backend
- **WebSocket** and **STT streaming** connections are TCP-spliced to backend at the raw socket level
- **Backend** auto-starts, waits for `/health` to return 200, then the web host becomes ready
- **Data dir** stores SQLite DB, logs, and agent session state
- **Remote binding** uses `0.0.0.0` when `allowRemote: true`, `127.0.0.1` otherwise

### Configuration

Same as web-cli — flags accepted by `startWebHost` or via constructor options:

| Option | Default | Description |
|--------|---------|-------------|
| `port` | 25808 | Static server listen port |
| `allowRemote` | false | Bind 0.0.0.0 |
| `dataDir` | required | SQLite + logs |
| `logDir` | dataDir/logs | Log directory |
| `dirs` | required | `cacheDir`, `workDir`, `logDir` for backend env |
| `backend.kind` | `'ownBackend'` | `'ownBackend'` or `'useExistingBackend'` |
| `backend.resolveBackend` | required for own | Returns path to aioncore binary |
| `backend.port` | required for useExisting | Port where external backend listens |

### Dockerfile Example

```dockerfile
FROM oven/bun:1-alpine
RUN apk add --no-cache xvfb
# web-cli has the bin; web-host is its transitive dependency
COPY --from=builder /app/node_modules/@aionui/web-host/dist ./node_modules/@aionui/web-host/dist
COPY --from=builder /app/packages/web-cli/dist ./packages/web-cli/dist
COPY --from=builder /app/packages/web-cli/bin ./packages/web-cli/bin
COPY --from=builder /app/packages/desktop/out/renderer ./static
COPY --from=builder /app/external/aioncore ./aioncore
WORKDIR /app
EXPOSE 25808
ENTRYPOINT ["bun", "run", "packages/web-cli/dist/index.js"]
CMD ["start", "--remote"]
```

## Quick Reference: aionui-web.exe Commands

### Start Web Server

```powershell
.\aionui-web.exe start --remote --static-dir ./out/renderer --backend-bin ./out/aioncore.exe
```

### Reset Admin Password

```powershell
.\aionui-web.exe resetpass --static-dir ./out/renderer --backend-bin ./out/aioncore.exe
```