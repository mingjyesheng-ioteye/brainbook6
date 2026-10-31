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
const MAX_SESSIONS = Number(process.env.BROWSERD_MAX_SESSIONS || 4);
const ALLOW_PRIVATE = process.env.BROWSERD_ALLOW_PRIVATE_NETWORK === '1';
const VIEWPORT = { width: 1280, height: 800 };

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

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
const wss = new WebSocketServer({ noServer: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
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
      if (size > 1024 * 1024) {
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
      } catch (error) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function hasControlToken(req) {
  return req.headers['x-browserd-token'] === CONTROL_TOKEN;
}

async function authenticate(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  try {
    const response = await fetch(AUTH_URL, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.success || !data?.user?.id) return null;
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

async function createSession(userId) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error('browser session limit reached');
  }
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
  const page = context.pages()[0] || (await context.newPage());
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const session = {
    id: crypto.randomUUID(),
    userId,
    context,
    page,
    cdp,
    clients: new Set(),
    lastActive: Date.now(),
    screencasting: false,
    closed: false,
  };
  const sendStateSoon = () => {
    void sendState(session);
  };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) sendStateSoon();
  });
  page.on('domcontentloaded', sendStateSoon);
  page.on('load', sendStateSoon);
  page.on('pageerror', (error) => {
    broadcast(session, { type: 'error', message: String(error?.message || error) });
  });
  cdp.on('Page.screencastFrame', async (event) => {
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    } catch {
      // page may have navigated or closed
    }
    broadcast(session, { type: 'frame', data: event.data, metadata: event.metadata });
  });
  sessions.set(userId, session);
  audit({ userId, source: 'system', action: 'session.create' });
  log('session created', session.id, 'user', userId);
  return session;
}

async function ensureSession(userId) {
  const existing = sessions.get(userId);
  if (existing && !existing.closed) {
    existing.lastActive = Date.now();
    return existing;
  }
  return createSession(userId);
}

function sessionById(userId, sessionId) {
  const session = sessions.get(userId);
  if (!session || session.closed) return null;
  if (sessionId && session.id !== sessionId) return null;
  return session;
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

async function closeSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
  sessions.delete(session.userId);
  for (const client of session.clients) {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
  session.clients.clear();
  try {
    await session.context.close();
  } catch {
    // ignore
  }
  audit({ userId: session.userId, source: 'system', action: 'session.close' });
  log('session closed', session.id, 'user', session.userId);
}

async function navigate(session, rawUrl, source) {
  const url = validateUrl(rawUrl);
  audit({ userId: session.userId, source, action: 'navigate', url });
  await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  session.lastActive = Date.now();
  await sendState(session);
  return { url: session.page.url(), title: await session.page.title() };
}

async function snapshot(session) {
  const result = await session.page.evaluate(() => {
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
    }
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 6000),
      nodes,
    };
  });
  return result;
}

async function clickRef(session, ref) {
  const selector = `[data-aionui-ref="${String(ref).replace(/"/g, '')}"]`;
  await session.page.locator(selector).first().click({ timeout: 10000 });
  await sendState(session);
  return { clicked: ref };
}

async function typeRef(session, ref, text) {
  const selector = `[data-aionui-ref="${String(ref).replace(/"/g, '')}"]`;
  const locator = session.page.locator(selector).first();
  await locator.fill(String(text), { timeout: 10000 });
  await sendState(session);
  return { typed: ref, length: String(text).length };
}

async function pressKey(session, key) {
  await session.page.keyboard.press(String(key));
  await sendState(session);
  return { pressed: key };
}

async function scrollPage(session, deltaY) {
  await session.page.mouse.wheel(0, Number(deltaY) || 0);
  return { scrolled: Number(deltaY) || 0 };
}

async function screenshot(session) {
  const buffer = await session.page.screenshot({ type: 'png' });
  return { format: 'png', base64: buffer.toString('base64') };
}

async function runTool(session, tool, args, source) {
  const auditBase = { userId: session.userId, source, action: tool };
  switch (tool) {
    case 'navigate':
      return navigate(session, args.url, source);
    case 'snapshot':
      return snapshot(session);
    case 'click':
      audit({ ...auditBase, ref: args.ref });
      return clickRef(session, args.ref);
    case 'type':
      audit({ ...auditBase, ref: args.ref, length: String(args.text ?? '').length });
      return typeRef(session, args.ref, args.text ?? '');
    case 'press':
      audit({ ...auditBase, key: args.key });
      return pressKey(session, args.key);
    case 'scroll':
      audit({ ...auditBase, deltaY: Number(args.deltaY) || 0 });
      return scrollPage(session, args.deltaY);
    case 'screenshot':
      audit(auditBase);
      return screenshot(session);
    case 'state':
      return {
        url: session.page.url(),
        title: await session.page.title(),
        canGoBack: (await session.cdp.send('Page.getNavigationHistory')).currentIndex > 0,
      };
    case 'back':
      await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return sendState(session).then(() => ({ ok: true }));
    case 'forward':
      await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return sendState(session).then(() => ({ ok: true }));
    case 'reload':
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return sendState(session).then(() => ({ ok: true }));
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
  const session = sessionById(user.id, url.searchParams.get('session'));
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
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/browser/status') {
      return json(res, 200, { available: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/session') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const session = await ensureSession(user.id);
      return json(res, 200, {
        sessionId: session.id,
        wsPath: `/api/browser/ws?session=${encodeURIComponent(session.id)}`,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/close') {
      const user = await authenticate(req);
      if (!user) return json(res, 401, { error: 'authentication required' });
      const session = sessions.get(user.id);
      if (session) await closeSession(session);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/agent/session') {
      if (!hasControlToken(req)) return json(res, 403, { error: 'invalid control token' });
      const body = await readJson(req);
      const userId = String(body.user_id || '').trim();
      if (!userId) return json(res, 400, { error: 'user_id is required' });
      const session = await ensureSession(userId);
      return json(res, 200, { sessionId: session.id });
    }
    if (req.method === 'POST' && url.pathname === '/agent/tool') {
      if (!hasControlToken(req)) return json(res, 403, { error: 'invalid control token' });
      const body = await readJson(req);
      const userId = String(body.user_id || '').trim();
      const session = sessionById(userId, body.session_id);
      if (!session) return json(res, 404, { error: 'session not found' });
      const result = await runTool(session, String(body.tool || ''), body.args || {}, 'agent');
      return json(res, 200, { ok: true, result });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
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
    }
  }
}, 60_000).unref();

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
});
