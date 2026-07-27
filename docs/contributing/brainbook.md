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

The `@aionui/web-cli` package runs the full app without Electron — spawns AionCore backend + serves SPA assets via a Node.js web server.

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