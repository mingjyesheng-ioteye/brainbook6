import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const HOST = process.env.BROWSERD_HOST || '127.0.0.1';
const PORT = Number(process.env.BROWSERD_PORT || 25900);
const DATA_DIR = process.env.BROWSERD_DATA_DIR || path.join(os.homedir(), '.aionui-web', 'browser');
const AUTH_URL = process.env.BROWSERD_AUTH_URL || 'http://127.0.0.1:25809/api/auth/user';
const TOKEN_FILE =
  process.env.BROWSERD_CONTROL_TOKEN_FILE || path.join(DATA_DIR, 'control-token');
const IDLE_MS = Number(process.env.BROWSERD_IDLE_MS || 30 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.BROWSERD_MAX_SESSIONS || 8);
const APPROVAL_MODE = process.env.BROWSERD_APPROVAL_MODE || 'writes';
const APPROVAL_TIMEOUT_MS = Number(process.env.BROWSERD_APPROVAL_TIMEOUT_MS || 60_000);
const ALLOW_PRIVATE = process.env.BROWSERD_ALLOW_PRIVATE_NETWORK === '1';
const UPLOAD_DIR = process.env.BROWSERD_UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const DOWNLOAD_DIR = process.env.BROWSERD_DOWNLOAD_DIR || path.join(DATA_DIR, 'downloads');
const REPLAY_DIR = process.env.BROWSERD_REPLAY_DIR || path.join(DATA_DIR, 'replays');
const VIEWPORT = { width: 1280, height: 800 };

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(REPLAY_DIR, { recursive: true, mode: 0o700 });

function readOrCreateToken() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // create below
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

const CONTROL_TOKEN = readOrCreateToken();
const sessions = new Map();
const userBrowsers = new Map();
const wss = new WebSocketServer({ noServer: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Replay lookup tables. Live sessions are keyed by id; closed sessions are
// recovered from the `session.json` manifest written into each replay dir, so
// replay keeps working after the browser page (and the session object) is gone.
const replayIndex = new Map();
const conversationIndex = new Map();

function indexManifest(manifest) {
  if (!manifest || !manifest.sessionId) return;
  replayIndex.set(manifest.sessionId, manifest);
  const conversationId = manifest.conversationId;
  if (conversationId) {
    if (!conversationIndex.has(conversationId)) conversationIndex.set(conversationId, new Set());
    conversationIndex.get(conversationId).add(manifest.sessionId);
  }
}

function manifestPathFor(session) {
  return path.join(session.replayDir, 'session.json');
}

function writeSessionManifest(session, extra = {}) {
  let url = '';
  try {
    url = session.page && !session.page.isClosed() ? session.page.url() : '';
  } catch {
    url = '';
  }
  const manifest = {
    sessionId: session.id,
    userId: session.userId,
    surfaceId: session.surfaceId,
    owner: session.owner,
    conversationId: session.conversationId || null,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    closedAt: session.closed ? Date.now() : null,
    url,
    title: session.title || '',
    replayDir: session.replayDir,
    ...extra,
  };
  try {
    fs.writeFileSync(manifestPathFor(session), JSON.stringify(manifest) + '\n', { mode: 0o600 });
    indexManifest(manifest);
  } catch (error) {
    log('session manifest write failed', error?.message || error);
  }
  return manifest;
}

function loadReplayIndex() {
  try {
    for (const userDir of fs.readdirSync(REPLAY_DIR, { withFileTypes: true })) {
      if (!userDir.isDirectory()) continue;
      const userPath = path.join(REPLAY_DIR, userDir.name);
      for (const sessionDir of fs.readdirSync(userPath, { withFileTypes: true })) {
        if (!sessionDir.isDirectory()) continue;
        const manifestFile = path.join(userPath, sessionDir.name, 'session.json');
        if (!fs.existsSync(manifestFile)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
          manifest.replayDir = manifest.replayDir || path.join(userPath, sessionDir.name);
          indexManifest(manifest);
        } catch {
          // ignore malformed manifests
        }
      }
    }
  } catch (error) {
    log('replay index load failed', error?.message || error);
  }
}

function readTimelineEntries(dir, conversationId = null) {
  const file = path.join(dir, 'timeline.jsonl');
  if (!fs.existsSync(file)) return [];
  // The replay directory is named after the session id, so stamp every entry
  // with it. A conversation can span several sessions (a MAP link opens a popup
  // with its own session) and the UI builds screenshot URLs per session, because
  // the replay-file endpoint resolves paths per session.
  const owningSessionId = path.basename(dir);
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (conversationId && entry.conversationId && entry.conversationId !== conversationId) continue;
      if (!entry.sessionId) entry.sessionId = owningSessionId;
      entries.push(entry);
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

function resolveReplayDirs(userId, sessionId, conversationId) {
  const dirs = new Set();
  const manifests = [];
  if (sessionId) {
    const live = findSession(userId, sessionId);
    if (live) {
      dirs.add(live.replayDir);
      manifests.push(meta(live));
    }
    const manifest = replayIndex.get(sessionId);
    if (manifest && manifest.userId === userId) {
      dirs.add(manifest.replayDir);
      if (!live) manifests.push(manifest);
    }
  }
  if (conversationId) {
    for (const id of conversationIndex.get(conversationId) || []) {
      const manifest = replayIndex.get(id);
      if (!manifest || manifest.userId !== userId) continue;
      dirs.add(manifest.replayDir);
      const live = findSession(userId, id);
      manifests.push(live ? { ...manifest, ...meta(live), closedAt: null } : manifest);
    }
  }
  return { dirs: [...dirs], manifests };
}

function audit(entry) {
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'audit.jsonl'), JSON.stringify({ ts: Date.now(), ...entry }) + '\n', {
      mode: 0o600,
    });
  } catch (error) {
    log('audit write failed', error?.message || error);
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function hasControlToken(req) {
  return req.headers['x-browserd-token'] === CONTROL_TOKEN;
}

// Authentication cache. Every browser API request and WebSocket upgrade used to
// call AUTH_URL afresh, and AionCore rate-limits that endpoint (20/min per user).
// Rapid conversation switching remounts each browser tab, so a handful of tabs
// produced dozens of auth checks a minute and the endpoint answered 429. This
// code treated any non-ok status as "not logged in" and returned 401, which the
// UI surfaced as "Browser service unavailable (401)" even though the session was
// perfectly valid. Cache the resolved user per cookie for a short TTL instead, so
// a burst of requests shares one upstream check, and degrade gracefully when the
// upstream throttles us rather than reporting a session failure.
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX_ENTRIES = 200;
const authCache = new Map(); // cookie -> { user, expiresAt }

function readAuthCache(cookie) {
  const entry = authCache.get(cookie);
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.user;
  return null;
}

function rememberAuth(cookie, user) {
  if (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    // Evict the entry closest to expiry; cookies are opaque so there is no LRU
    // signal beyond the TTL we stamped.
    let oldestKey = null;
    let oldestExpiry = Infinity;
    for (const [key, entry] of authCache) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) authCache.delete(oldestKey);
  }
  authCache.set(cookie, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}

async function authenticate(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const cached = readAuthCache(cookie);
  if (cached) return cached;
  try {
    const response = await fetch(AUTH_URL, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 429) {
      // Rate limited: the session itself is not in question — AionCore is only
      // refusing to answer. Serve a recently cached user if we have one so a
      // burst of tab remounts does not turn into a 401 storm. Without a cached
      // user we cannot vouch for the cookie, so report unauthenticated.
      const stale = authCache.get(cookie);
      if (stale) {
        rememberAuth(cookie, stale.user);
        return stale.user;
      }
      return null;
    }
    if (!response.ok) {
      authCache.delete(cookie);
      return null;
    }
    const data = await response.json();
    if (!data?.success || !data?.user?.id) {
      authCache.delete(cookie);
      return null;
    }
    rememberAuth(cookie, data.user);
    return data.user;
  } catch {
    return null;
  }
}

function isPrivateAddress(host) {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (value === '::1' || value === '0.0.0.0' || value === '::') return true;
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) URLs are allowed');
  }
  if (!ALLOW_PRIVATE && isPrivateAddress(url.hostname)) {
    throw new Error('private and loopback addresses are blocked');
  }
  return url.toString();
}

function safeUserId(userId) {
  return String(userId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'file';
}

function sessionKey(userId, surfaceId) {
  return `${userId}::${surfaceId || 'default'}`;
}

function meta(session) {
  return {
    sessionId: session.id,
    surfaceId: session.surfaceId,
    owner: session.owner,
    conversationId: session.conversationId || null,
    url: session.page.url(),
    title: session.title || '',
    lastActive: session.lastActive,
  };
}

function listSessions(userId, conversationId = null) {
  const active = [...sessions.values()]
    .filter((session) => session.userId === userId && !session.closed)
    .filter((session) => !conversationId || session.conversationId === conversationId)
    .map((session) => ({ ...meta(session), replayable: true }));

  // Merge in archived sessions recovered from replay manifests. Active sessions
  // shadow their manifest, so a session never shows up twice.
  const archived = [];
  for (const manifest of replayIndex.values()) {
    if (manifest.userId !== userId) continue;
    if (conversationId && manifest.conversationId !== conversationId) continue;
    if (sessions.has(`${manifest.userId}::${manifest.surfaceId}`) && findSession(userId, manifest.sessionId)) continue;
    const activeEntry = active.find((entry) => entry.sessionId === manifest.sessionId);
    if (activeEntry) continue;
    archived.push({
      sessionId: manifest.sessionId,
      surfaceId: manifest.surfaceId,
      owner: manifest.owner,
      conversationId: manifest.conversationId || null,
      url: manifest.url || '',
      title: manifest.title || '',
      lastActive: manifest.updatedAt,
      closedAt: manifest.closedAt,
      replayable: true,
      archived: true,
    });
  }
  return [...active, ...archived];
}

function findSession(userId, sessionId) {
  for (const session of sessions.values()) {
    if (session.userId === userId && session.id === sessionId && !session.closed) return session;
  }
  return null;
}

/**
 * Resolve replay data for a session id, whether the browser session is still
 * live or was closed and only its on-disk replay manifest remains. Returns
 * `{ replayDir, manifest }` or null when the id is unknown / belongs to
 * another user. Live sessions take precedence over the indexed manifest.
 */
function resolveReplaySession(userId, sessionId) {
  const live = findSession(userId, sessionId);
  if (live) {
    return {
      replayDir: live.replayDir,
      manifest: {
        sessionId: live.id,
        userId: live.userId,
        surfaceId: live.surfaceId,
        owner: live.owner,
        conversationId: live.conversationId || null,
        createdAt: live.createdAt,
        updatedAt: Date.now(),
        closedAt: null,
        title: live.title || '',
        replayDir: live.replayDir,
      },
    };
  }
  const manifest = replayIndex.get(sessionId);
  if (!manifest || manifest.userId !== userId) return null;
  return { replayDir: manifest.replayDir, manifest };
}



async function ensureUserBrowser(userId) {
  const existing = userBrowsers.get(userId);
  if (existing && !existing.closed) return existing;
  const userDataDir = path.join(DATA_DIR, 'profiles', safeUserId(userId));
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: VIEWPORT,
    locale: 'en-US',
    chromiumSandbox: true,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
    ],
  });
  const initialPage = context.pages()[0] || (await context.newPage());
  const entry = {
    context,
    initialPage,
    initialPageUsed: false,
    creatingPage: false,
    managedPages: new Set(),
    sessions: new Set(),
    closed: false,
  };
  context.on('close', () => {
    entry.closed = true;
    userBrowsers.delete(userId);
  });
  context.on('page', (page) => {
    if (entry.closed || entry.creatingPage || entry.managedPages.has(page)) return;
    void attachPopup(userId, entry, page);
  });
  userBrowsers.set(userId, entry);
  return entry;
}

function broadcastUser(userId, message) {
  for (const session of sessions.values()) {
    if (session.userId === userId && !session.closed) broadcast(session, message);
  }
}

async function attachPopup(userId, userBrowser, page) {
  if (sessions.size >= MAX_SESSIONS) {
    await page.close().catch(() => {});
    return;
  }
  userBrowser.managedPages.add(page);
  const opener = await page.opener().catch(() => null);
  const openerSession = opener
    ? [...sessions.values()].find((session) => session.userId === userId && session.page === opener)
    : [...sessions.values()]
        .filter((session) => session.userId === userId && !session.closed)
        .sort((a, b) => b.lastActive - a.lastActive)[0];
  const surfaceId = `popup-${crypto.randomBytes(4).toString('hex')}`;
  const session = await setupSession(userId, surfaceId, 'user', userBrowser, page, openerSession?.conversationId || null);
  const message = { type: 'popup', session: meta(session) };
  if (openerSession && !openerSession.closed) {
    broadcast(openerSession, message);
  } else {
    broadcastUser(userId, message);
  }
  log('popup session created', session.id, 'user', userId, 'surface', session.surfaceId);
}

/**
 * Pick a session that can safely be closed to make room for a new one.
 *
 * UI preview tabs each get a session, and a closed tab only releases its
 * session after the idle sweep. When the cap is reached, reclaim the
 * least-recently-active session that has no connected client and does not
 * belong to an agent (agent sessions may be mid-task between tool calls).
 */
function pickEvictableSession(userId) {
  let victim = null;
  for (const session of sessions.values()) {
    if (session.closed || session.userId !== userId) continue;
    if (session.owner === 'agent') continue;
    if (session.clients.size > 0) continue;
    if (!victim || session.lastActive < victim.lastActive) victim = session;
  }
  return victim;
}

async function createSession(userId, surfaceId, owner, conversationId = null) {
  const key = sessionKey(userId, surfaceId);
  const existing = sessions.get(key);
  if (existing && !existing.closed) {
    existing.lastActive = Date.now();
    if (!existing.conversationId && conversationId) {
      existing.conversationId = conversationId;
      writeSessionManifest(existing);
    }
    return existing;
  }
  if (sessions.size >= MAX_SESSIONS) {
    const victim = pickEvictableSession(userId);
    if (!victim) {
      throw new Error('browser session limit reached');
    }
    log('session limit reached; evicting idle session', victim.id, 'surface', victim.surfaceId);
    await closeSession(victim);
  }
  const userBrowser = await ensureUserBrowser(userId);
  let page;
  if (!userBrowser.initialPageUsed && !userBrowser.initialPage.isClosed()) {
    page = userBrowser.initialPage;
  } else {
    userBrowser.creatingPage = true;
    try {
      page = await userBrowser.context.newPage();
    } finally {
      userBrowser.creatingPage = false;
    }
  }
  userBrowser.initialPageUsed = true;
  userBrowser.managedPages.add(page);
  return setupSession(userId, surfaceId, owner, userBrowser, page, conversationId);
}

async function setupSession(userId, surfaceId, owner, userBrowser, page, conversationId = null) {
  const key = sessionKey(userId, surfaceId);
  const cdp = await userBrowser.context.newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const session = {
    id: crypto.randomUUID(),
    userId,
    surfaceId: surfaceId || 'default',
    owner: owner || 'user',
    conversationId: conversationId || null,
    createdAt: Date.now(),
    context: userBrowser.context,
    userBrowser,
    page,
    cdp,
    clients: new Set(),
    lastActive: Date.now(),
    screencasting: false,
    closed: false,
    title: '',
    replayDir: path.join(REPLAY_DIR, safeUserId(userId), 'pending'),
    replayTimer: null,
    replayBusy: false,
    approvals: new Map(),
    consoleBuffer: [],
    networkBuffer: [],
  };
  session.replayDir = path.join(REPLAY_DIR, safeUserId(userId), session.id);
  fs.mkdirSync(session.replayDir, { recursive: true, mode: 0o700 });
  writeSessionManifest(session);

  const sendStateSoon = () => {
    void sendState(session);
    scheduleReplay(session, 'ui', 'navigation');
  };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) sendStateSoon();
  });
  page.on('domcontentloaded', sendStateSoon);
  page.on('load', sendStateSoon);
  page.on('close', () => {
    if (!session.closed) void closeSession(session);
  });
  page.on('pageerror', (error) => {
    session.consoleBuffer.push({ ts: Date.now(), type: 'pageerror', text: String(error?.message || error).slice(0, 2000) });
    broadcast(session, { type: 'error', message: String(error?.message || error) });
  });
  page.on('console', (message) => {
    session.consoleBuffer.push({ ts: Date.now(), type: message.type(), text: message.text().slice(0, 2000) });
    if (session.consoleBuffer.length > 200) session.consoleBuffer.shift();
  });
  page.on('request', (request) => {
    session.networkBuffer.push({
      ts: Date.now(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    });
    if (session.networkBuffer.length > 200) session.networkBuffer.shift();
  });
  cdp.on('Page.screencastFrame', async (event) => {
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    } catch {
      // page may have navigated or closed
    }
    broadcast(session, { type: 'frame', data: event.data, metadata: event.metadata });
  });
  sessions.set(key, session);
  userBrowser.sessions.add(session.id);
  audit({
    userId,
    source: 'system',
    action: 'session.create',
    surfaceId: session.surfaceId,
    owner: session.owner,
    conversationId: session.conversationId || null,
  });
  log('session created', session.id, 'user', userId, 'surface', session.surfaceId, 'owner', session.owner);
  return session;
}

async function ensureSession(userId, surfaceId, owner, conversationId = null) {
  return createSession(userId, surfaceId || 'default', owner || 'user', conversationId);
}

function broadcast(session, message) {
  const payload = JSON.stringify(message);
  for (const client of session.clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        // ignore per-client failures
      }
    }
  }
}

async function sendState(session) {
  if (session.closed) return;
  let canGoBack = false;
  let canGoForward = false;
  try {
    const history = await session.cdp.send('Page.getNavigationHistory');
    canGoBack = history.currentIndex > 0;
    canGoForward = history.currentIndex < history.entries.length - 1;
  } catch {
    // ignore
  }
  let title = '';
  try {
    title = await session.page.title();
  } catch {
    // ignore
  }
  session.title = title;
  broadcast(session, {
    type: 'state',
    url: session.page.url(),
    title,
    canGoBack,
    canGoForward,
  });
}

async function startScreencast(session) {
  if (session.closed || session.screencasting) return;
  session.screencasting = true;
  try {
    await session.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });
  } catch (error) {
    session.screencasting = false;
    log('startScreencast failed', error?.message || error);
  }
}

async function stopScreencast(session) {
  if (!session.screencasting) return;
  session.screencasting = false;
  try {
    await session.cdp.send('Page.stopScreencast');
  } catch {
    // ignore
  }
}

function scheduleReplay(session, source, action, extra) {
  if (session.replayTimer) return;
  session.replayTimer = setTimeout(() => {
    session.replayTimer = null;
    void captureReplay(session, source, action, extra);
  }, 800);
}

async function captureReplay(session, source, action, extra = {}) {
  if (session.closed || session.replayBusy) return;
  session.replayBusy = true;
  try {
    const ts = Date.now();
    const filename = `frame-${ts}.jpg`;
    await session.page.screenshot({
      type: 'jpeg',
      quality: 60,
      path: path.join(session.replayDir, filename),
    });
    const entry = {
      ts,
      source,
      action,
      conversationId: session.conversationId || null,
      url: session.page.url(),
      title: session.title || '',
      screenshot: filename,
      ...extra,
    };
    fs.appendFileSync(path.join(session.replayDir, 'timeline.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    writeSessionManifest(session);
    broadcast(session, { type: 'replay', entry });
  } catch {
    // replay capture is best-effort
  } finally {
    session.replayBusy = false;
  }
}

async function closeSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
  writeSessionManifest(session);
  sessions.delete(sessionKey(session.userId, session.surfaceId));
  if (session.replayTimer) clearTimeout(session.replayTimer);
  for (const entry of session.approvals.values()) {
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
  session.approvals.clear();
  for (const client of session.clients) {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
  session.clients.clear();
  try {
    await session.page.close();
  } catch {
    // ignore
  }
  const userBrowser = session.userBrowser;
  if (userBrowser) {
    userBrowser.sessions.delete(session.id);
    if (userBrowser.sessions.size === 0) {
      try {
        await userBrowser.context.close();
      } catch {
        // ignore
      }
      userBrowsers.delete(session.userId);
    }
  }
  audit({
    userId: session.userId,
    source: 'system',
    action: 'session.close',
    surfaceId: session.surfaceId,
    conversationId: session.conversationId || null,
  });
  log('session closed', session.id, 'user', session.userId, 'surface', session.surfaceId);
}

async function navigate(session, rawUrl, source) {
  const url = validateUrl(rawUrl);
  audit({
    userId: session.userId,
    source,
    action: 'navigate',
    url,
    surfaceId: session.surfaceId,
    conversationId: session.conversationId || null,
  });
  await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  session.lastActive = Date.now();
  await sendState(session);
  void captureReplay(session, source, 'navigate', { url: session.page.url() });
  return { url: session.page.url(), title: await session.page.title() };
}

function refSelector(ref) {
  return `[data-aionui-ref="${String(ref).replace(/"/g, '')}"]`;
}

async function snapshot(session, args = {}) {
  const mode = args.mode || 'dom';
  if (mode === 'aria') {
    const text = await session.page.locator('body').ariaSnapshot({ timeout: 5000 });
    return {
      mode: 'aria',
      url: session.page.url(),
      title: session.title,
      snapshot: text.slice(0, Number(args.maxText) || 8000),
    };
  }
  const maxText = Number(args.maxText) || 3000;
  const maxNodes = Number(args.maxNodes) || 80;
  return session.page.evaluate(
    ({ maxText: textLimit, maxNodes: nodeLimit }) => {
      const selector =
        'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]';
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.bottom >= 0 &&
          rect.top <= innerHeight
        );
      };
      let counter = 0;
      const nodes = [];
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const ref = 'e' + ++counter;
        el.setAttribute('data-aionui-ref', ref);
        const label = (
          el.innerText ||
          el.value ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.getAttribute('name') ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 120);
        nodes.push({
          ref,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          label,
          href: el.href || undefined,
        });
        if (nodes.length >= nodeLimit) break;
      }
      return {
        mode: 'dom',
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, textLimit),
        nodes,
      };
    },
    { maxText, maxNodes }
  );
}

async function find(session, query) {
  return session.page.evaluate((needle) => {
    const selector =
      'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]';
    const out = [];
    let counter = 0;
    const value = String(needle || '').toLowerCase();
    for (const el of document.querySelectorAll(selector)) {
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!text || !text.toLowerCase().includes(value)) continue;
      const ref = 'e' + ++counter;
      el.setAttribute('data-aionui-ref', ref);
      out.push({ ref, tag: el.tagName.toLowerCase(), label: text.replace(/\s+/g, ' ').slice(0, 120) });
    }
    return out;
  }, query);
}

async function clickRef(session, ref) {
  await session.page.locator(refSelector(ref)).first().click({ timeout: 10000 });
  await sendState(session);
  void captureReplay(session, 'agent', 'click', { ref });
  return { clicked: ref };
}

async function typeRef(session, ref, text) {
  await session.page.locator(refSelector(ref)).first().fill(String(text), { timeout: 10000 });
  await sendState(session);
  void captureReplay(session, 'agent', 'type', { ref, length: String(text).length });
  return { typed: ref, length: String(text).length };
}

async function pressKey(session, key) {
  await session.page.keyboard.press(String(key));
  await sendState(session);
  void captureReplay(session, 'agent', 'press', { key });
  return { pressed: key };
}

async function scrollPage(session, deltaY) {
  await session.page.mouse.wheel(0, Number(deltaY) || 0);
  void captureReplay(session, 'agent', 'scroll', { deltaY: Number(deltaY) || 0 });
  return { scrolled: Number(deltaY) || 0 };
}

async function screenshot(session) {
  const buffer = await session.page.screenshot({ type: 'png' });
  return { format: 'png', base64: buffer.toString('base64') };
}

async function uploadFile(session, args) {
  const selector = refSelector(args.ref);
  let filePath;
  if (args.base64) {
    const filename = safeName(args.filename || 'upload.bin');
    filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(String(args.base64), 'base64'), { mode: 0o600 });
  } else if (args.path) {
    filePath = path.resolve(UPLOAD_DIR, String(args.path));
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) throw new Error('upload path is outside the upload directory');
  } else {
    throw new Error('upload_file requires path or base64');
  }
  await session.page.locator(selector).first().setInputFiles(filePath, { timeout: 15000 });
  void captureReplay(session, 'agent', 'upload', { file: path.basename(filePath) });
  return { uploaded: path.basename(filePath) };
}

async function downloadFile(session, args) {
  const dir = path.join(DOWNLOAD_DIR, session.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const [download] = await Promise.all([
    session.page.waitForEvent('download', { timeout: 30000 }),
    session.page.locator(refSelector(args.ref)).first().click(),
  ]);
  const filename = safeName(download.suggestedFilename() || `download-${Date.now()}`);
  const target = path.join(dir, filename);
  await download.saveAs(target);
  void captureReplay(session, 'agent', 'download', { file: filename });
  return { path: target, filename };
}

async function printPdf(session, args) {
  const dir = path.join(DOWNLOAD_DIR, session.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = safeName(args.filename || `page-${Date.now()}.pdf`);
  const target = path.join(dir, filename);
  await session.page.pdf({ path: target, format: 'A4', printBackground: true });
  void captureReplay(session, 'agent', 'print_pdf', { file: filename });
  return { path: target, filename };
}

function needsApproval(tool, args) {
  if (APPROVAL_MODE === 'off') return false;
  if (tool === 'click' || tool === 'type' || tool === 'upload_file' || tool === 'download_file' || tool === 'print_pdf') {
    return true;
  }
  if (tool === 'press' && String(args.key || '').toLowerCase() === 'enter') return true;
  return false;
}

function summarizeArgs(tool, args) {
  if (tool === 'type') return { ref: args.ref, length: String(args.text || '').length };
  if (tool === 'click') return { ref: args.ref };
  if (tool === 'press') return { key: args.key };
  if (tool === 'upload_file') return { ref: args.ref, filename: args.filename || args.path };
  if (tool === 'download_file') return { ref: args.ref };
  if (tool === 'print_pdf') return { filename: args.filename };
  return {};
}

function requestApproval(session, tool, args) {
  if (!needsApproval(tool, args)) return Promise.resolve(true);
  const approval = {
    id: crypto.randomUUID(),
    tool,
    args: summarizeArgs(tool, args),
    createdAt: Date.now(),
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.approvals.delete(approval.id);
      broadcast(session, { type: 'approval_resolved', approvalId: approval.id, decision: 'timeout' });
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    session.approvals.set(approval.id, { approval, resolve, timer });
    broadcast(session, { type: 'approval', approval });
    audit({
      userId: session.userId,
      source: 'system',
      action: 'approval.request',
      approval,
      conversationId: session.conversationId || null,
    });
    void captureReplay(session, 'system', `approval:${tool}`, { approvalId: approval.id });
  });
}

function resolveApproval(session, approvalId, decision) {
  const entry = session.approvals.get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  session.approvals.delete(approvalId);
  entry.resolve(decision === 'approve');
  broadcast(session, { type: 'approval_resolved', approvalId, decision });
  audit({
    userId: session.userId,
    source: 'ui',
    action: 'approval.resolve',
    approvalId,
    decision,
    conversationId: session.conversationId || null,
  });
  return true;
}

async function runTool(session, tool, args, source) {
  if (source !== 'ui' && needsApproval(tool, args)) {
    const approved = await requestApproval(session, tool, args);
    if (!approved) throw new Error('action denied by user');
  }
  session.lastActive = Date.now();
  switch (tool) {
    case 'navigate':
      return navigate(session, args.url, source);
    case 'snapshot':
      return snapshot(session, args);
    case 'find':
      return find(session, args.query);
    case 'click':
      return clickRef(session, args.ref);
    case 'type':
      return typeRef(session, args.ref, args.text ?? '');
    case 'press':
      return pressKey(session, args.key);
    case 'scroll':
      return scrollPage(session, args.deltaY);
    case 'screenshot':
      return screenshot(session);
    case 'state':
      return { url: session.page.url(), title: session.title, canGoBack: false };
    case 'console':
      return session.consoleBuffer.slice(-(Number(args.limit) || 50));
    case 'network':
      return session.networkBuffer.slice(-(Number(args.limit) || 50));
    case 'upload_file':
      return uploadFile(session, args);
    case 'download_file':
      return downloadFile(session, args);
    case 'print_pdf':
      return printPdf(session, args);
    case 'back':
      await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sendState(session);
      return { ok: true };
    case 'forward':
      await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sendState(session);
      return { ok: true };
    case 'reload':
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sendState(session);
      return { ok: true };
    case 'close':
      await closeSession(session);
      return { closed: true };
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

async function handleWsMessage(session, ws, raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  session.lastActive = Date.now();
  try {
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (message.type === 'navigate') {
      await navigate(session, message.url, 'ui');
      return;
    }
    if (message.type === 'back') {
      await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sendState(session);
      return;
    }
    if (message.type === 'forward') {
      await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sendState(session);
      return;
    }
    if (message.type === 'reload') {
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sendState(session);
      return;
    }
    if (message.type === 'mouse') {
      const x = Math.round((Number(message.xRatio) || 0) * VIEWPORT.width);
      const y = Math.round((Number(message.yRatio) || 0) * VIEWPORT.height);
      if (message.event === 'mouseWheel') {
        await session.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX: Number(message.deltaX) || 0,
          deltaY: Number(message.deltaY) || 0,
        });
        return;
      }
      const pressed = message.event === 'mousePressed';
      await session.cdp.send('Input.dispatchMouseEvent', {
        type: message.event,
        x,
        y,
        button: message.button || 'left',
        buttons: pressed ? 1 : 0,
        clickCount: message.clickCount || 1,
        modifiers: Number(message.modifiers) || 0,
      });
      return;
    }
    if (message.type === 'key') {
      const params = {
        type: message.event,
        key: message.key || '',
        code: message.code || '',
        windowsVirtualKeyCode: Number(message.keyCode) || 0,
        nativeVirtualKeyCode: Number(message.keyCode) || 0,
        modifiers: Number(message.modifiers) || 0,
      };
      if (message.event === 'keyDown' && typeof message.text === 'string' && message.text) {
        params.text = message.text;
        params.unmodifiedText = message.text;
      }
      await session.cdp.send('Input.dispatchKeyEvent', params);
      return;
    }
    if (message.type === 'insertText') {
      await session.cdp.send('Input.insertText', { text: String(message.text || '') });
      return;
    }
  } catch (error) {
    broadcast(session, { type: 'error', message: String(error?.message || error) });
  }
}

async function handleUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/api/browser/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const user = await authenticate(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const session = findSession(user.id, url.searchParams.get('session'));
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    session.clients.add(ws);
    session.lastActive = Date.now();
    ws.on('message', (data) => void handleWsMessage(session, ws, data));
    ws.on('close', () => {
      session.clients.delete(ws);
      if (session.clients.size === 0) void stopScreencast(session);
    });
    ws.on('error', () => {});
    void startScreencast(session);
    void sendState(session);
    for (const entry of session.approvals.values()) {
      ws.send(JSON.stringify({ type: 'approval', approval: entry.approval }));
    }
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      json(res, 404, { error: 'file not found' });
      return;
    }
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(data);
  });
}

// Load replay manifests written by previous daemon runs so closed sessions can
// be listed and replayed without a live browser page. Must run before the
// server starts accepting requests.
loadReplayIndex();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/browser/status') {
      return json(res, 200, { available: true, approvalMode: APPROVAL_MODE });
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/session') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const body = await readJson(req);
      const surfaceId = String(body.surfaceId || 'default');
      const conversationId = body.conversationId ? String(body.conversationId) : null;
      const session = await ensureSession(user.id, surfaceId, 'user', conversationId);
      return json(res, 200, {
        sessionId: session.id,
        surfaceId: session.surfaceId,
        conversationId: session.conversationId,
        wsPath: `/api/browser/ws?session=${encodeURIComponent(session.id)}`,
        tabs: listSessions(user.id, conversationId),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/browser/sessions') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const conversationId = url.searchParams.get('conversationId');
      return json(res, 200, { tabs: listSessions(user.id, conversationId) });
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/close') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const body = await readJson(req);
      const session = findSession(user.id, String(body.sessionId || ''));
      if (session) await closeSession(session);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/approval') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const body = await readJson(req);
      const session = findSession(user.id, String(body.sessionId || ''));
      if (!session) return json(res, 404, { error: 'session not found' });
      const ok = resolveApproval(session, String(body.approvalId || ''), String(body.decision || 'deny'));
      return json(res, ok ? 200 : 404, { ok });
    }
    if (req.method === 'GET' && url.pathname === '/api/browser/replay') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const sessionId = url.searchParams.get('sessionId');
      const conversationId = url.searchParams.get('conversationId');
      if (!sessionId && !conversationId) {
        return json(res, 400, { error: 'sessionId or conversationId is required' });
      }
      const { dirs, manifests } = resolveReplayDirs(user.id, sessionId, conversationId);
      if (dirs.length === 0) return json(res, 404, { error: 'session not found' });
      const entries = dirs
        .flatMap((dir) => readTimelineEntries(dir, conversationId))
        // Heartbeat snapshots exist only to show liveness. They outnumber real
        // actions by orders of magnitude and would push the interesting steps
        // (a click that opens a MAP popup, for instance) out of the 200-entry
        // window, so trim them before applying the cap.
        .filter((entry) => entry.action !== 'heartbeat')
        .sort((a, b) => a.ts - b.ts);
      const trimmed = entries.length > 200 ? entries.slice(-200) : entries;
      return json(res, 200, { entries: trimmed, sessions: manifests });
    }
    if (req.method === 'GET' && url.pathname === '/api/browser/files') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const sessionId = url.searchParams.get('sessionId');
      const conversationId = url.searchParams.get('conversationId');
      if (!sessionId && !conversationId) {
        return json(res, 400, { error: 'sessionId or conversationId is required' });
      }
      const { dirs } = resolveReplayDirs(user.id, sessionId, conversationId);
      if (dirs.length === 0) return json(res, 404, { error: 'session not found' });
      const files = [];
      for (const dir of dirs) {
        const downloadDir = path.join(DOWNLOAD_DIR, path.basename(dir));
        if (!fs.existsSync(downloadDir)) continue;
        for (const name of fs.readdirSync(downloadDir)) {
          const stat = fs.statSync(path.join(downloadDir, name));
          files.push({ name, size: stat.size, mtime: stat.mtimeMs });
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { files });
    }
    if (req.method === 'GET' && (url.pathname === '/api/browser/replay/file' || url.pathname === '/api/browser/file')) {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const sessionId = String(url.searchParams.get('sessionId') || '');
      const name = safeName(url.searchParams.get('name'));
      let base;
      if (url.pathname === '/api/browser/file') {
        const session = findSession(user.id, sessionId);
        if (!session) return json(res, 404, { error: 'session not found' });
        base = path.join(DOWNLOAD_DIR, session.id);
      } else {
        const resolved = resolveReplaySession(user.id, sessionId);
        if (!resolved) return json(res, 404, { error: 'session not found' });
        base = resolved.replayDir;
      }
      const filePath = path.join(base, name);
      if (!filePath.startsWith(base + path.sep)) return json(res, 400, { error: 'invalid file' });
      const contentType = name.endsWith('.png') ? 'image/png' : name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
      return serveFile(res, filePath, contentType);
    }
    if (req.method === 'POST' && url.pathname === '/agent/session') {
      if (!hasControlToken(req)) return json(res, 403, { error: 'invalid control token' });
      const body = await readJson(req);
      const userId = String(body.user_id || '').trim();
      if (!userId) return json(res, 400, { error: 'user_id is required' });
      const conversationId = body.conversation_id ? String(body.conversation_id) : null;
      const session = await ensureSession(userId, String(body.surface_id || 'agent'), String(body.owner || 'agent'), conversationId);
      return json(res, 200, {
        sessionId: session.id,
        surfaceId: session.surfaceId,
        conversationId: session.conversationId,
        tabs: listSessions(userId, conversationId),
      });
    }
    if (req.method === 'POST' && url.pathname === '/agent/tool') {
      if (!hasControlToken(req)) return json(res, 403, { error: 'invalid control token' });
      const body = await readJson(req);
      const userId = String(body.user_id || '').trim();
      if (!userId) return json(res, 400, { error: 'user_id is required' });
      const tool = String(body.tool || '');
      const args = body.args || {};
      const conversationId = body.conversation_id ? String(body.conversation_id) : null;
      if (tool === 'tab_list') {
        return json(res, 200, { ok: true, result: listSessions(userId, conversationId) });
      }
      if (tool === 'tab_new') {
        const surfaceId = String(args.surfaceId || `agent-${crypto.randomBytes(4).toString('hex')}`);
        const session = await ensureSession(userId, surfaceId, 'agent', conversationId);
        if (args.url) await navigate(session, args.url, 'agent');
        return json(res, 200, { ok: true, result: meta(session) });
      }
      const session = findSession(userId, String(body.session_id || ''));
      if (!session) return json(res, 404, { error: 'session not found' });
      if (tool === 'tab_close') {
        await closeSession(session);
        return json(res, 200, { ok: true, result: { closed: true } });
      }
      if (tool === 'tab_select') {
        return json(res, 200, { ok: true, result: meta(session) });
      }
      const result = await runTool(session, tool, args, 'agent');
      return json(res, 200, { ok: true, result });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    log('request failed', req.method, req.url, error?.stack || error);
    return json(res, 500, { error: String(error?.message || error) });
  }
});

server.on('upgrade', (req, socket, head) => {
  void handleUpgrade(req, socket, head);
});

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.clients.size === 0 && now - session.lastActive > IDLE_MS) {
      void closeSession(session);
    } else if (session.clients.size > 0) {
      void captureReplay(session, 'ui', 'heartbeat');
    }
  }
}, 5000).unref();

async function shutdown(signal) {
  log('shutting down', signal);
  for (const session of [...sessions.values()]) {
    await closeSession(session);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  log(`browserd listening on http://${HOST}:${PORT}`);
  log(`data dir: ${DATA_DIR}`);
  log(`approval mode: ${APPROVAL_MODE}`);
});
