# Brainbook Web Service — Implementation Plan

> **Domain**: `brainbook.ioteyeinc.com`
> **Host**: to be assigned (cloud VPS / existing server)
> **Goal**: deploy AionUi WebUI as a dedicated web service reachable at the domain above, secured with HTTPS via Let's Encrypt.

---

## Architecture Overview

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

## Phase 1 — Pre-deployment Setup

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

## Phase 2 — Application Deployment

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

## Phase 3 — Reverse Proxy (Nginx)

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

## Phase 4 — Data Persistence & Backups

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

## Phase 5 — Security Hardening

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

## Phase 6 — Monitoring & Maintenance

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

## Quick Start Checklist

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

## Related Documentation

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

## Notes

1. **Why not run on port 80/443 directly?** Running AionCore on 25808 behind a reverse proxy gives us TLS termination, caching, rate limiting, and security headers — all managed by Nginx/Caddy without touching AionCore's core.
2. **Web-Host static server vs full Electron app**: The `@aionui/web-host` package (installed via `install-web.sh`) is a **headless Node/Bun process** — no Electron binary, no Xvfb needed (unlike the Electron `.deb` approach in `deploy-server.md`). It spawns the `aioncore` backend and reverse-proxies the SPA + API.
3. **The Dockerfile already builds a production image**: `bun dist-server/server.mjs` runs the same backend, on port 3000. This can be used as an alternative to the Bun direct path.
