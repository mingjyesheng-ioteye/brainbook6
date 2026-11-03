#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CONTROL_URL = (process.env.AIONUI_BROWSER_CONTROL_URL || 'http://127.0.0.1:25900').replace(/\/$/, '');
const TOKEN_FILE =
  process.env.AIONUI_BROWSER_CONTROL_TOKEN_FILE || path.join(os.homedir(), '.aionui-web', 'browser', 'control-token');
const USER_ID = process.env.AIONUI_USER_ID || '';
const SURFACE = process.env.AIONUI_BROWSER_SURFACE || 'agent';
const CONVERSATION_ID = process.env.AIONUI_CONVERSATION_ID || '';

function log(message) {
  process.stderr.write(`[aionui-browser-mcp] ${message}\n`);
}

function readToken() {
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
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

let currentSessionId = process.env.AIONUI_BROWSER_SESSION || '';

async function ensureSession() {
  if (currentSessionId) return currentSessionId;
  if (!USER_ID) throw new Error('AIONUI_USER_ID is not set');
  const body = { user_id: USER_ID, surface_id: SURFACE, owner: 'agent' };
  if (CONVERSATION_ID) body.conversation_id = CONVERSATION_ID;
  const data = await call('/agent/session', body);
  currentSessionId = data.sessionId;
  return currentSessionId;
}

async function callTool(tool, args = {}, sessionId) {
  if (!USER_ID) throw new Error('AIONUI_USER_ID is not set');
  const id = sessionId || (await ensureSession());
  const body = { user_id: USER_ID, session_id: id, tool, args };
  if (CONVERSATION_ID) body.conversation_id = CONVERSATION_ID;
  return call('/agent/tool', body);
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

async function main() {
  const server = new McpServer({ name: 'aionui-browser', version: '1.0.0' });

  server.tool(
    'browser_navigate',
    'Navigate the live sbpro browser session to an http(s) URL.',
    { url: z.string().describe('Absolute http(s) URL') },
    async ({ url }) => {
      try {
        return textResult(await callTool('navigate', { url }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_snapshot',
    'Return a compact snapshot of the current page. Use DOM mode for eN element refs, aria mode for an accessibility tree.',
    {
      mode: z.enum(['dom', 'aria']).optional().describe('dom (default) or aria'),
      maxText: z.number().optional().describe('Maximum page text characters'),
      maxNodes: z.number().optional().describe('Maximum interactive nodes in DOM mode'),
    },
    async ({ mode, maxText, maxNodes }) => {
      try {
        return textResult(await callTool('snapshot', { mode, maxText, maxNodes }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_find',
    'Find interactive elements whose text contains the query and return their eN refs.',
    { query: z.string() },
    async ({ query }) => {
      try {
        return textResult(await callTool('find', { query }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_click',
    'Click an element by its eN ref from browser_snapshot or browser_find. Requires user approval in the live browser tab.',
    { ref: z.string() },
    async ({ ref }) => {
      try {
        return textResult(await callTool('click', { ref }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_type',
    'Fill an input/textarea/contenteditable by eN ref. Requires user approval in the live browser tab.',
    { ref: z.string(), text: z.string() },
    async ({ ref, text }) => {
      try {
        return textResult(await callTool('type', { ref, text }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_press',
    'Press a keyboard key in the live page. Enter requires user approval.',
    { key: z.string() },
    async ({ key }) => {
      try {
        return textResult(await callTool('press', { key }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_scroll',
    'Scroll the live page by deltaY pixels.',
    { deltaY: z.number() },
    async ({ deltaY }) => {
      try {
        return textResult(await callTool('scroll', { deltaY }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_screenshot',
    'Capture a PNG screenshot of the live page into the current workspace.',
    { filename: z.string().optional() },
    async ({ filename }) => {
      try {
        const data = await callTool('screenshot', {});
        const target = path.resolve(process.cwd(), filename || `browser-screenshot-${Date.now()}.png`);
        fs.writeFileSync(target, Buffer.from(data.base64, 'base64'));
        return textResult({ path: target });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool('browser_state', 'Return the current URL, title, and navigation state.', {}, async () => {
    try {
      return textResult(await callTool('state', {}));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.tool(
    'browser_console',
    'Return recent browser console messages and page errors.',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        return textResult(await callTool('console', { limit }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_network',
    'Return recent network requests from the live page.',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        return textResult(await callTool('network', { limit }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool('browser_tabs', 'List all browser sessions/tabs for the current user.', {}, async () => {
    try {
      const body = { user_id: USER_ID, tool: 'tab_list', args: {} };
      if (CONVERSATION_ID) body.conversation_id = CONVERSATION_ID;
      const data = await call('/agent/tool', body);
      return textResult(data.result);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.tool(
    'browser_tab_new',
    'Open a new parallel browser session/tab and make it the current session.',
    { url: z.string().optional(), surfaceId: z.string().optional() },
    async ({ url, surfaceId }) => {
      try {
        const body = { user_id: USER_ID, tool: 'tab_new', args: { url, surfaceId } };
        if (CONVERSATION_ID) body.conversation_id = CONVERSATION_ID;
        const data = await call('/agent/tool', body);
        currentSessionId = data.result.sessionId;
        return textResult(data.result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_tab_select',
    'Select an existing browser session/tab by sessionId and make it current.',
    { sessionId: z.string() },
    async ({ sessionId }) => {
      try {
        const data = await callTool('tab_select', {}, sessionId);
        currentSessionId = sessionId;
        return textResult(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_tab_close',
    'Close a browser session/tab by sessionId (defaults to the current session).',
    { sessionId: z.string().optional() },
    async ({ sessionId }) => {
      try {
        const target = sessionId || (await ensureSession());
        const data = await callTool('tab_close', {}, target);
        if (currentSessionId === target) currentSessionId = '';
        return textResult(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_upload_file',
    'Upload a file to a file input by eN ref. The path must be inside the browserd upload directory. Requires approval.',
    { ref: z.string(), path: z.string() },
    async ({ ref, path: filePath }) => {
      try {
        return textResult(await callTool('upload_file', { ref, path: filePath }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_download_file',
    'Click an element by eN ref and save the resulting download on the server. Requires approval.',
    { ref: z.string() },
    async ({ ref }) => {
      try {
        return textResult(await callTool('download_file', { ref }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    'browser_print_pdf',
    'Print the current page to PDF on the server. Requires approval.',
    { filename: z.string().optional() },
    async ({ filename }) => {
      try {
        return textResult(await callTool('print_pdf', { filename }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool('browser_close', 'Close the current browser session.', {}, async () => {
    try {
      const data = await callTool('close', {});
      currentSessionId = '';
      return textResult(data);
    } catch (error) {
      return errorResult(error);
    }
  });

  log(`starting (control=${CONTROL_URL}, surface=${SURFACE})`);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
