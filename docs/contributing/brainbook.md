# Brainbook Development

This document combines the repository-specific development notes with the general production deployment guidance for a Brainbook web service. The deployment sections describe the standard hosted web-service pattern; they do not describe the local WSL/PM2 workflow used for in-editor or personal development.

## Build Windows with a Local AionCore

By default, `bun run build-win` downloads the configured AionCore release. To package local backend changes and their embedded assets, install AionCore and explicitly select that binary for the build:

```powershell
# Run from the AionCore repository.
cargo install --path crates/aionui-app --locked --force

# Run from the AionUi repository in the same PowerShell session.
$env:AIONUI_BACKEND_LOCAL_BINARY = "$HOME\.cargo\bin\aioncore.exe"
bun run build-win
```

The AionCore repository `.env` may define the public
`BRAINBOOK_SUPABASE_URL` and `BRAINBOOK_SUPABASE_ANON_KEY` values. The
`aionui-brainbook` build script embeds those two values during `cargo install`;
explicit PowerShell environment variables take precedence. Cargo does not load
`.env` by itself, so use an AionCore revision containing that build script.

For desktop development, close the running desktop/backend process before
reinstalling, then restart it so PATH resolution loads the replaced
`$HOME\.cargo\bin\aioncore.exe`. A running process continues using the old
binary even after the file is replaced. Packaged desktop builds prefer their
bundled backend and must be rebuilt with `AIONUI_BACKEND_LOCAL_BINARY` as shown
above.

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

---

## Production Deployment Guide

> **Scope**: general production deployment guidance for a hosted Brainbook web service
> **Domain**: `brainbook.ioteyeinc.com`
> **Host**: cloud VPS / dedicated server / managed hosting
> **Goal**: deploy the Brainbook web UI as a dedicated service behind HTTPS, using a standard reverse proxy and a persistent backend runtime.
>
> This section describes the standard hosted deployment model. It is intentionally separate from local or personal developer runs and does not describe any WSL-specific or PM2-managed local deployment workflow.

---

### Architecture Overview

This is the baseline architecture for a production Brainbook web service. It is a general pattern for a secure, publicly reachable deployment and is not intended to describe a developer laptop or WSL startup flow.

```
  Client Browser
       │
       ▼
  ┌─────────────────────────────┐
  │  cloudflare / CDN (optional) │
  │  brainbook.ioteyeinc.com     │
  └────────────────┬────────────┘
                   ▼
        ┌──────────────────┐
        │  Nginx / Caddy    │  ← reverse proxy, TLS termination
        │  (port 443/80)    │
        └────────┬─────────┘
                 ▼
        ┌──────────────────┐
        │  AionCore         │  ← AI agent backend (port 25808)
        │  backend process  │
        └────────┬─────────┘
                 ▲
        ┌──────────────────────┐
        │  @aionui/web-host    │  ← static server + reverse proxy
        │  (port 25808)        │     to AionCore
        └──────────────────────┘
                 ▲
        ┌──────────────────────┐
        │  SQLite / workspace   │  ← persistent data
        │  (mounted volume)     │
        └──────────────────────┘
```

---

### Phase 1 — Pre-deployment Setup

### 1.1 Domain & DNS

| Item | Action |
|------|--------|
| DNS | Create an `A` record `brainbook.ioteyeinc.com` → server public IP |
| DNS | Optionally add CNAME for `www.brainbook.ioteyeinc.com` |
| TLS | Provision Let's Encrypt cert for `brainbook.ioteyeinc.com` (ACME via certbot or Caddy) |
| Web | Ensure ports 80 and 443 are open on the server |

### 1.2 Server Prerequisites

| Item | Value |
|------|-------|
| OS | Ubuntu 22.04+ / Debian 12+ |
| RAM | ≥ 2 GB (4 GB recommended) |
| Disk | ≥ 10 GB (data volume for persistent SQLite) |
| Runtime | **Bun** installed (`curl -fsSL https://bun.sh/install \| bash`) |
| Docker | Optional, for containerized deployment |
| Reverse proxy | Nginx or Caddy |

---

### Phase 2 — Application Deployment

The examples below show how to deploy the web service on a standard host. For a local development setup, use the repository-specific instructions earlier in this document instead of the production-host steps below.

### Option A: Bun Direct (simpler, recommended for single-server)

#### 2A.1 Install AionUi WebUI

```bash
# One-click installer (no Electron binary needed)
curl -fsSL https://raw.githubusercontent.com/iOfficeAI/AionUi/main/scripts/install-web.sh | bash

# Or install to a fixed path
curl -fsSL https://raw.githubusercontent.com/iOfficeAI/AionUi/main/scripts/install-web.sh | \
    INSTALL_DIR=/opt/aionui INSTALL_DIR_BIN=/usr/local/bin bash
```

After install, the binary is at:
```
/opt/aionui/aionui    (or $HOME/.local/share/aionui-web/aionui)
```

#### 2A.2 Create a systemd Service

Create `/etc/systemd/system/aionui-brainbook.service`:

```ini
[Unit]
Description=Brainbook WebUI (AionUi WebHost)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aionui        # dedicated service user
Group=aionui
ExecStart=/opt/aionui/aionui --webui --remote --port 25808
Restart=always
RestartSec=10
Environment=AIONUI_ALLOW_REMOTE=true
Environment=AIONUI_HOST=0.0.0.0
Environment=AIONUI_DATA_DIR=/var/lib/aionui
Environment=PORT=25808
WorkingDirectory=/opt/aionui
StandardOutput=journal
StandardError=journal
SyslogIdentifier=aionui-brainbook

# Security hardening
ReadOnlyPaths=/opt/aionui
ReadWritePaths=/var/lib/aionui
PrivateTmp=true
ProtectSystem=strict
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
# Create dedicated user and directories
sudo useradd -r -s /usr/sbin/nologin -d /opt/aionui -m aionui
sudo mkdir -p /var/lib/aionui /var/log/aionui
sudo chown aionui:aionui /var/lib/aionui /var/log/aionui /opt/aionui

# Enable service
sudo systemctl daemon-reload
sudo systemctl enable aionui-brainbook.service
sudo systemctl start aionui-brainbook.service

# Verify
sudo systemctl status aionui-brainbook.service
journalctl -u aionui-brainbook.service -f
```

### Option B: Docker Deployment (containerized)

```bash
# Build from source directory or pull pre-built image
docker build -t aionui-brainbook .

docker run -d \
  --name aionui-brainbook \
  --restart=always \
  -p 25808:3000 \
  -v $(pwd)/data:/data \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e ALLOW_REMOTE=true \
  -e DATA_DIR=/data \
  aionui-brainbook
```

---

### Phase 3 — Reverse Proxy (Nginx)

### 3.1 Nginx Configuration

Create `/etc/nginx/sites-available/brainbook.ioteyeinc.com`:

```nginx
server {
    listen 80;
    server_name brainbook.ioteyeinc.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name brainbook.ioteyeinc.com;

    # Let's Encrypt cert (auto-provisioned by certbot or Caddy)
    ssl_certificate /etc/letsencrypt/live/brainbook.ioteyeinc.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/brainbook.ioteyeinc.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # Static content served directly by Nginx (optional offload)
    # The upstream serves the SPA via AionUi web-host

    # Route all traffic to AionUi backend
    location / {
        proxy_pass http://127.0.0.1:25808;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket + SSE streaming (needed for AI streaming & STT)
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
}
```

Or, **simpler with Caddy** (auto-HTTPS):

```nginx
# Caddy v2 – let Caddy manage SSL entirely
brainbook.ioteyeinc.com {
    reverse_proxy 127.0.0.1:25808
}
```

### 3.2 Enable Site

```bash
# For Nginx
sudo ln -s /etc/nginx/sites-available/brainbook.ioteyeinc.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# For Caddy
sudo systemctl enable --now caddy
```

---

### Phase 4 — Data Persistence & Backups

### 4.1 Data Directory

| Component | Path |
|-----------|------|
| AionCore SQLite DB | `/var/lib/aionui/users.sqlite` (or wherever AionCore stores it) |
| Workspace files | `/var/lib/aionui/workspace/` |
| Logs | `/var/log/aionui/` |

### 4.2 Backup Strategy

```bash
# Daily cron backup
0 3 * * * tar czf /backups/aionui-$(date +\%Y\%m\%d).tar.gz -C /var/lib/aionui .

# Or use AionCore's built-in export if available
```

---

### Phase 5 — Security Hardening

| Measure | Implementation |
|---------|---------------|
| HTTPS | Let's Encrypt via certbot or Caddy (already includes HSTS) |
| Auth | Set admin password on first run: `sudo -u aionui aionui --resetpass admin` |
| Firewall | Only allow 80/443 externally: `ufw allow 80,443/tcp` (block 25808) |
| HTTPS redirect | Nginx: force 301 redirect from HTTP → HTTPS |
| Rate limiting | Nginx `limit_req_zone` for login path: `/login` |
| Admin IP whitelist | Nginx `allow`/`deny` directives for `Location /admin` (if any) |
| Fail2ban | `fail2ban-regex` + jail for `/login` 401 responses |
| TLS hardening | `ssl_protocols TLSv1.2 TLSv1.3` + modern cipher list |
| X-Frame-Options | Set to `SAMEORIGIN` to prevent clickjacking |

---

### Phase 6 — Monitoring & Maintenance

### 6.1 Health Checks

```bash
# systemd status
systemctl status aionui-brainbook

# Backend health API
curl -s http://127.0.0.1:25808/health

# HTTP-level health (through proxy)
curl -sI https://brainbook.ioteyeinc.com/ -o /dev/null -w '%'{http_code}'\n'
```

### 6.2 Log Management

```bash
# View live logs
journalctl -u aionui-brainbook.service -f

# Rotate logs (systemd-journald handles by default, configure max-size in /etc/systemd/journald.conf)
sudo systemctl restart systemd-journald
```

### 6.3 Update Procedure

```bash
# Re-run installer with new version
curl -fsSL https://raw.githubusercontent.com/iOfficeAI/AionUi/main/scripts/install-web.sh | \
    VERSION=new_version bash
sudo systemctl restart aionui-brainbook.service
```

---

### Quick Start Checklist

> This checklist is for a hosted production deployment and does not cover local developer setups or WSL-managed runtime startup.

- [ ] Provision server (VPS or existing host)
- [ ] Point `brainbook.ioteyeinc.com` DNS A-record to server IP
- [ ] Open ports 80 and 443 on firewall/cloud security group
- [ ] Install runtime (Bun or Docker)
- [ ] Deploy AionUi WebUI via installer or Docker
- [ ] Create systemd service (Bun path) or Docker container
- [ ] Install and configure reverse proxy (Nginx/Caddy) with SSL
- [ ] Set admin password
- [ ] Configure backup cron
- [ ] Set up monitoring (logwatch, fail2ban, uptime check)
- [ ] Test: `https://brainbook.ioteyeinc.com` loads the AI chat UI
- [ ] Confirm HTTPS cert is valid (check cert expiry: `certbot certificates`)

---

### Related Documentation

| Doc | Path | Purpose |
|-----|------|---------|
| WebUI Startup Guide | `docs/guides/webui.md` | WebUI mode usage across all platforms |
| Headless Server Deploy | `docs/guides/deploy-server.md` | Xvfb + systemd + SSH tunnel + PAC proxy for server deployments |
| Service Startup Guide | `docs/guides/service-startup-guide.md` | systemd-style service management |
| Windows WebUI Guide | `docs/guides/webui-windows.md` | Desktop shortcuts / batch files for Windows |
| macOS WebUI Guide | `docs/guides/webui-macos.md` | Automator / Dock setup for macOS |
| Android WebUI Guide | `docs/guides/webui-android.md` | Termux + proot deployment |
| Nginx Setup Guide | `docs/guides/nginx-setup-guide.md` | Production reverse proxy configuration |
| Angular Development | `docs/guides/frontend/angular--angular.md` | Frontend framework reference |

---

### Notes

1. **Why not run on port 80/443 directly?** Running AionCore on 25808 behind a reverse proxy gives us TLS termination, caching, rate limiting, and security headers — all managed by Nginx/Caddy without touching AionCore's core.
2. **Web-Host static server vs full Electron app**: The `@aionui/web-host` package (installed via `install-web.sh`) is a **headless Node/Bun process** — no Electron binary, no Xvfb needed (unlike the Electron `.deb` approach in `deploy-server.md`). It spawns the `aioncore` backend and reverse-proxies the SPA + API.
3. **The Dockerfile already builds a production image**: `bun dist-server/server.mjs` runs the same backend, on port 3000. This can be used as an alternative to the Bun direct path.
