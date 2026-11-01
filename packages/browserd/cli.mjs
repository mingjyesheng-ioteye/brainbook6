#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONTROL_URL = (process.env.AIONUI_BROWSER_CONTROL_URL || 'http://127.0.0.1:25900').replace(/\/$/, '');
const TOKEN_FILE =
  process.env.AIONUI_BROWSER_CONTROL_TOKEN_FILE || path.join(os.homedir(), '.aionui-web', 'browser', 'control-token');
const USER_ID = process.env.AIONUI_USER_ID || '';

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    throw new Error(`browser control token not found at ${TOKEN_FILE}`);
  }
}

async function call(pathname, body) {
  const response = await fetch(CONTROL_URL + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-browserd-token': readToken(),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `request failed (${response.status})`);
  }
  return data;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional.shift() || '';

function requireUser() {
  if (!USER_ID) throw new Error('AIONUI_USER_ID is not set; run this from an AionUi agent session');
}

async function getSession() {
  requireUser();
  if (typeof flags.session === 'string' && flags.session) return flags.session;
  if (process.env.AIONUI_BROWSER_SESSION) return process.env.AIONUI_BROWSER_SESSION;
  const surfaceId =
    (typeof flags.surface === 'string' && flags.surface) || process.env.AIONUI_BROWSER_SURFACE || 'agent';
  const data = await call('/agent/session', { user_id: USER_ID, surface_id: surfaceId, owner: 'agent' });
  return data.sessionId;
}

async function callTool(tool, args = {}, sessionId) {
  requireUser();
  const id = sessionId || (await getSession());
  const data = await call('/agent/tool', { user_id: USER_ID, session_id: id, tool, args });
  return data.result;
}

function printSnapshot(result) {
  console.log(`URL: ${result.url}`);
  console.log(`Title: ${result.title}`);
  if (Array.isArray(result.nodes) && result.nodes.length) {
    console.log('Interactive elements:');
    for (const node of result.nodes) {
      const detail = [node.tag, node.type].filter(Boolean).join('/');
      console.log(`  ${node.ref} [${detail}] ${node.label}${node.href ? ` -> ${node.href}` : ''}`);
    }
  } else if (result.snapshot) {
    console.log(result.snapshot);
  } else {
    console.log('No interactive elements found.');
  }
  if (result.text) {
    console.log('Page text:');
    console.log(result.text);
  }
}

function usage() {
  console.error(`Usage: browser-live <command> [args] [--session <id>] [--surface <id>]

Commands:
  navigate <url>
  snapshot [--aria]
  find <query>
  click <ref>
  type <ref> <text...>
  press <key>
  scroll <deltaY>
  screenshot [file]
  state
  console [limit]
  network [limit]
  tabs
  tab-new [url]
  tab-select <sessionId>
  tab-close <sessionId>
  upload <ref> <path>
  download <ref>
  pdf [filename]
  back | forward | reload | close
`);
}

async function main() {
  if (!command) {
    usage();
    process.exit(1);
  }
  if (command === 'navigate') {
    const url = positional.join(' ').trim();
    if (!url) throw new Error('navigate requires a URL');
    console.log(JSON.stringify(await callTool('navigate', { url }), null, 2));
    return;
  }
  if (command === 'snapshot') {
    printSnapshot(await callTool('snapshot', { mode: flags.aria ? 'aria' : 'dom' }));
    return;
  }
  if (command === 'find') {
    const query = positional.join(' ').trim();
    if (!query) throw new Error('find requires a query');
    console.log(JSON.stringify(await callTool('find', { query }), null, 2));
    return;
  }
  if (command === 'click') {
    const ref = positional[0];
    if (!ref) throw new Error('click requires a ref');
    console.log(JSON.stringify(await callTool('click', { ref }), null, 2));
    return;
  }
  if (command === 'type') {
    const [ref, ...textParts] = positional;
    if (!ref) throw new Error('type requires a ref and text');
    console.log(JSON.stringify(await callTool('type', { ref, text: textParts.join(' ') }), null, 2));
    return;
  }
  if (command === 'press') {
    const key = positional[0];
    if (!key) throw new Error('press requires a key');
    console.log(JSON.stringify(await callTool('press', { key }), null, 2));
    return;
  }
  if (command === 'scroll') {
    console.log(JSON.stringify(await callTool('scroll', { deltaY: Number(positional[0] || 600) }), null, 2));
    return;
  }
  if (command === 'screenshot') {
    const data = await callTool('screenshot', {});
    const target = positional[0] || path.join(process.cwd(), 'browser-screenshot.png');
    fs.writeFileSync(target, Buffer.from(data.base64, 'base64'));
    console.log(target);
    return;
  }
  if (command === 'state') {
    console.log(JSON.stringify(await callTool('state', {}), null, 2));
    return;
  }
  if (command === 'console' || command === 'network') {
    console.log(JSON.stringify(await callTool(command, { limit: Number(positional[0] || 50) }), null, 2));
    return;
  }
  if (command === 'tabs') {
    requireUser();
    const data = await call('/agent/tool', { user_id: USER_ID, tool: 'tab_list', args: {} });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (command === 'tab-new') {
    requireUser();
    const url = positional.join(' ').trim();
    const data = await call('/agent/tool', { user_id: USER_ID, tool: 'tab_new', args: { url } });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (command === 'tab-select') {
    const sessionId = positional[0] || (typeof flags.session === 'string' ? flags.session : '');
    if (!sessionId) throw new Error('tab-select requires a session id');
    console.log(JSON.stringify(await callTool('tab_select', {}, sessionId), null, 2));
    console.log(`Use --session ${sessionId} for subsequent commands.`);
    return;
  }
  if (command === 'tab-close') {
    const sessionId = positional[0] || (typeof flags.session === 'string' ? flags.session : '');
    if (!sessionId) throw new Error('tab-close requires a session id');
    console.log(JSON.stringify(await callTool('tab_close', {}, sessionId), null, 2));
    return;
  }
  if (command === 'upload') {
    const [ref, filePath] = positional;
    if (!ref || !filePath) throw new Error('upload requires a ref and a file path');
    console.log(JSON.stringify(await callTool('upload_file', { ref, path: filePath }), null, 2));
    return;
  }
  if (command === 'download') {
    const ref = positional[0];
    if (!ref) throw new Error('download requires a ref');
    console.log(JSON.stringify(await callTool('download_file', { ref }), null, 2));
    return;
  }
  if (command === 'pdf') {
    console.log(JSON.stringify(await callTool('print_pdf', { filename: positional[0] }), null, 2));
    return;
  }
  if (['back', 'forward', 'reload', 'close'].includes(command)) {
    console.log(JSON.stringify(await callTool(command, {}), null, 2));
    return;
  }
  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
