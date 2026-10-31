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

async function getSession() {
  if (!USER_ID) {
    throw new Error('AIONUI_USER_ID is not set; run this from an AionUi agent session');
  }
  const data = await call('/agent/session', { user_id: USER_ID });
  return data.sessionId;
}

function usage() {
  console.error(`Usage: browser-live <command> [args]

Commands:
  navigate <url>
  snapshot
  click <ref>
  type <ref> <text...>
  press <key>
  scroll <deltaY>
  screenshot [file]
  state
  back | forward | reload | close
`);
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
  } else {
    console.log('No interactive elements found.');
  }
  if (result.text) {
    console.log('Page text:');
    console.log(result.text);
  }
}

async function main() {
  const [command = '', ...rest] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exit(1);
  }
  const sessionId = await getSession();
  const base = { user_id: USER_ID, session_id: sessionId };

  if (command === 'navigate') {
    const url = rest.join(' ').trim();
    if (!url) throw new Error('navigate requires a URL');
    const data = await call('/agent/tool', { ...base, tool: 'navigate', args: { url } });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (command === 'snapshot') {
    const data = await call('/agent/tool', { ...base, tool: 'snapshot', args: {} });
    printSnapshot(data.result);
    return;
  }
  if (command === 'click') {
    const ref = rest[0];
    if (!ref) throw new Error('click requires a ref');
    const data = await call('/agent/tool', { ...base, tool: 'click', args: { ref } });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (command === 'type') {
    const [ref, ...textParts] = rest;
    if (!ref) throw new Error('type requires a ref and text');
    const text = textParts.join(' ');
    const data = await call('/agent/tool', { ...base, tool: 'type', args: { ref, text } });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (command === 'press') {
    const key = rest[0];
    if (!key) throw new Error('press requires a key');
    const data = await call('/agent/tool', { ...base, tool: 'press', args: { key } });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (command === 'scroll') {
    const deltaY = Number(rest[0] || 600);
    const data = await call('/agent/tool', { ...base, tool: 'scroll', args: { deltaY } });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (command === 'screenshot') {
    const data = await call('/agent/tool', { ...base, tool: 'screenshot', args: {} });
    const target = rest[0] || path.join(process.cwd(), 'browser-screenshot.png');
    fs.writeFileSync(target, Buffer.from(data.result.base64, 'base64'));
    console.log(target);
    return;
  }
  if (command === 'state') {
    const data = await call('/agent/tool', { ...base, tool: 'state', args: {} });
    console.log(JSON.stringify(data.result, null, 2));
    return;
  }
  if (['back', 'forward', 'reload', 'close'].includes(command)) {
    const data = await call('/agent/tool', { ...base, tool: command, args: {} });
    console.log(JSON.stringify(data.result ?? { ok: true }, null, 2));
    return;
  }
  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
