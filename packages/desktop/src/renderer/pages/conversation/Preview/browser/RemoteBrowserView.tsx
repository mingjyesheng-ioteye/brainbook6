/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Left, Right, Refresh, Loading, History, Close } from '@icon-park/react';
import { usePreviewContext } from '../context/PreviewContext';
import { BROWSER_BLANK_URL, browserTabLabelFromUrl, resolveAddressBarInput } from './constants';

export interface RemoteBrowserViewProps {
  url: string;
  tabId: string;
  surfaceId?: string;
  onUrlChange: (tabId: string, url: string) => void;
  onTitleChange: (tabId: string, title: string) => void;
  onFaviconChange: (tabId: string, favicon: string) => void;
}

type Approval = { id: string; tool: string; args?: Record<string, unknown>; createdAt?: number };
type ReplayEntry = {
  ts: number;
  source: string;
  action: string;
  url?: string;
  title?: string;
  screenshot?: string;
};
type BrowserFile = { name: string; size: number; mtime: number };

type BrowserMessage =
  | { type: 'frame'; data: string; metadata?: { deviceWidth?: number; deviceHeight?: number } }
  | { type: 'state'; url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean }
  | { type: 'error'; message?: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval_resolved'; approvalId: string; decision: string }
  | { type: 'replay'; entry: ReplayEntry }
  | { type: 'popup'; session: { sessionId: string; surfaceId: string; url?: string; title?: string } }
  | { type: 'pong' };

const keyCodeFor = (event: React.KeyboardEvent<HTMLCanvasElement>): number => {
  const map: Record<string, number> = {
    Enter: 13,
    Backspace: 8,
    Tab: 9,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
  };
  return event.keyCode || map[event.key] || 0;
};

const modifiersFor = (event: React.KeyboardEvent<HTMLCanvasElement>): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

const textFor = (event: React.KeyboardEvent<HTMLCanvasElement>): string => {
  if (event.key === 'Enter') return '\r';
  if (event.key === 'Tab') return '\t';
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return event.key;
  return '';
};

const RemoteBrowserView: React.FC<RemoteBrowserViewProps> = ({
  url,
  tabId,
  surfaceId,
  onUrlChange,
  onTitleChange,
}) => {
  const { t } = useTranslation();
  const { openBrowserTab } = usePreviewContext();
  const effectiveSurfaceId = surfaceId || tabId;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const callbacksRef = useRef({ onUrlChange, onTitleChange });
  const lastMoveRef = useRef(0);
  const initialUrlRef = useRef(url);
  const [address, setAddress] = useState(url === BROWSER_BLANK_URL ? '' : url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [sessionId, setSessionId] = useState('');
  const [approval, setApproval] = useState<Approval | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [timeline, setTimeline] = useState<ReplayEntry[]>([]);
  const [files, setFiles] = useState<BrowserFile[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  callbacksRef.current = { onUrlChange, onTitleChange };

  const send = useCallback((message: unknown) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const drawFrame = useCallback((data: string) => {
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== image.width) canvas.width = image.width;
      if (canvas.height !== image.height) canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setLoading(false);
    };
    image.src = `data:image/jpeg;base64,${data}`;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;

    const connect = async () => {
      setError(null);
      setLoading(true);
      try {
        const response = await fetch('/api/browser/session', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ surfaceId: effectiveSurfaceId }),
        });
        if (!response.ok) {
          throw new Error(`Browser service unavailable (${response.status})`);
        }
        const data = (await response.json()) as { wsPath?: string; sessionId?: string };
        if (!data.wsPath) throw new Error('Browser service returned no session');
        setSessionId(data.sessionId || '');
        if (cancelled) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${protocol}//${window.location.host}${data.wsPath}`);
        socketRef.current = socket;
        socket.onopen = () => {
          setConnected(true);
          setError(null);
          if (initialUrlRef.current && initialUrlRef.current !== BROWSER_BLANK_URL) {
            socket?.send(JSON.stringify({ type: 'navigate', url: initialUrlRef.current }));
          }
        };
        socket.onmessage = (event: MessageEvent) => {
          let message: BrowserMessage;
          try {
            message = JSON.parse(String(event.data)) as BrowserMessage;
          } catch {
            return;
          }
          if (message.type === 'frame') {
            drawFrame(message.data);
            return;
          }
          if (message.type === 'state') {
            const nextUrl = message.url || BROWSER_BLANK_URL;
            setAddress(nextUrl === BROWSER_BLANK_URL ? '' : nextUrl);
            setCanGoBack(Boolean(message.canGoBack));
            setCanGoForward(Boolean(message.canGoForward));
            callbacksRef.current.onUrlChange(tabId, nextUrl);
            const title = message.title || browserTabLabelFromUrl(nextUrl);
            callbacksRef.current.onTitleChange(tabId, title);
            return;
          }
          if (message.type === 'error' && message.message) {
            setError(message.message);
            return;
          }
          if (message.type === 'approval') {
            setApproval(message.approval);
            return;
          }
          if (message.type === 'approval_resolved') {
            setApproval((current) => (current?.id === message.approvalId ? null : current));
            return;
          }
          if (message.type === 'replay') {
            setTimeline((current) => [...current, message.entry].slice(-200));
            return;
          }
          if (message.type === 'popup' && message.session) {
            openBrowserTab(message.session.url || BROWSER_BLANK_URL, message.session.surfaceId);
          }
        };
        socket.onclose = () => {
          setConnected(false);
          setLoading(false);
        };
        socket.onerror = () => {
          setError('Browser connection failed');
        };
      } catch (connectionError) {
        if (cancelled) return;
        setError(connectionError instanceof Error ? connectionError.message : String(connectionError));
        setLoading(false);
      }
    };

    void connect();
    return () => {
      cancelled = true;
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [drawFrame, effectiveSurfaceId, openBrowserTab, reconnectKey, tabId]);

  const navigate = useCallback(
    (raw: string) => {
      const target = resolveAddressBarInput(raw);
      if (!target) return;
      setLoading(true);
      send({ type: 'navigate', url: target });
    },
    [send]
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      navigate(address);
    },
    [address, navigate]
  );

  const ratios = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      xRatio: rect.width ? (event.clientX - rect.left) / rect.width : 0,
      yRatio: rect.height ? (event.clientY - rect.top) / rect.height : 0,
    };
  }, []);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      event.currentTarget.focus();
      send({ type: 'mouse', event: 'mousePressed', ...ratios(event), button: 'left', clickCount: 1 });
    },
    [ratios, send]
  );

  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      send({ type: 'mouse', event: 'mouseReleased', ...ratios(event), button: 'left', clickCount: 1 });
    },
    [ratios, send]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const now = Date.now();
      if (now - lastMoveRef.current < 16) return;
      lastMoveRef.current = now;
      send({
        type: 'mouse',
        event: 'mouseMoved',
        ...ratios(event),
        button: 'none',
        buttons: event.buttons ? 1 : 0,
      });
    },
    [ratios, send]
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      send({
        type: 'mouse',
        event: 'mouseWheel',
        ...ratios(event as unknown as React.MouseEvent<HTMLCanvasElement>),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    },
    [ratios, send]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      send({
        type: 'key',
        event: 'keyDown',
        key: event.key,
        code: event.code,
        keyCode: keyCodeFor(event),
        text: textFor(event),
        modifiers: modifiersFor(event),
      });
    },
    [send]
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      send({
        type: 'key',
        event: 'keyUp',
        key: event.key,
        code: event.code,
        keyCode: keyCodeFor(event),
        text: '',
        modifiers: modifiersFor(event),
      });
    },
    [send]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text');
      if (text) send({ type: 'insertText', text });
    },
    [send]
  );

  const decideApproval = useCallback(
    async (decision: 'approve' | 'deny') => {
      if (!approval || !sessionId) return;
      setApproval(null);
      await fetch('/api/browser/approval', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, approvalId: approval.id, decision }),
      });
    },
    [approval, sessionId]
  );

  const loadActivity = useCallback(async () => {
    if (!sessionId) return;
    setActivityLoading(true);
    try {
      const [replayResponse, filesResponse] = await Promise.all([
        fetch(`/api/browser/replay?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' }),
        fetch(`/api/browser/files?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' }),
      ]);
      const replay = (await replayResponse.json().catch(() => ({ entries: [] as ReplayEntry[] }))) as {
        entries?: ReplayEntry[];
      };
      const fileList = (await filesResponse.json().catch(() => ({ files: [] as BrowserFile[] }))) as {
        files?: BrowserFile[];
      };
      setTimeline(Array.isArray(replay.entries) ? replay.entries : []);
      setFiles(Array.isArray(fileList.files) ? fileList.files : []);
    } finally {
      setActivityLoading(false);
    }
  }, [sessionId]);

  const toggleActivity = useCallback(() => {
    setActivityOpen((open) => {
      const next = !open;
      if (next) void loadActivity();
      return next;
    });
  }, [loadActivity]);

  const stopBrowser = useCallback(async () => {
    if (!sessionId) return;
    await fetch('/api/browser/close', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    setConnected(false);
    setError('Browser stopped');
  }, [sessionId]);

  return (
    <div className='flex flex-col h-full min-h-0'>
      <div className='aion-url-viewer-toolbar flex items-center gap-6px h-40px px-10px bg-bg-2 border-b border-border-1 flex-shrink-0'>
        <button
          type='button'
          onClick={() => send({ type: 'back' })}
          disabled={!canGoBack}
          className='toolbar-btn icon-btn'
          title={t('common.historyBack')}
        >
          <Left theme='outline' size={16} />
        </button>
        <button
          type='button'
          onClick={() => send({ type: 'forward' })}
          disabled={!canGoForward}
          className='toolbar-btn icon-btn'
          title={t('common.forward')}
        >
          <Right theme='outline' size={16} />
        </button>
        <button
          type='button'
          onClick={() => send({ type: 'reload' })}
          className='toolbar-btn icon-btn'
          title={t('common.refresh')}
        >
          {loading ? <Loading theme='outline' size={16} className='animate-spin' /> : <Refresh theme='outline' size={16} />}
        </button>
        <button type='button' onClick={toggleActivity} className='toolbar-btn icon-btn' title='Activity'>
          <History theme='outline' size={16} />
        </button>
        <button type='button' onClick={() => void stopBrowser()} className='toolbar-btn icon-btn' title='Stop browser'>
          <Close theme='outline' size={16} />
        </button>
        <form onSubmit={handleSubmit} className='flex-1 ms-2px'>
          <input
            type='text'
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.target.select()}
            className='toolbar-input'
            placeholder={t('preview.browser.addressPlaceholder')}
          />
        </form>
      </div>

      {approval && (
        <div className='flex items-center justify-between gap-8px px-10px py-6px bg-bg-2 border-b border-border-1 text-12px flex-shrink-0'>
          <span className='min-w-0 truncate'>
            Agent wants to <b>{approval.tool}</b>
            {approval.args?.ref ? ` ${String(approval.args.ref)}` : ''}
            {approval.args?.key ? ` ${String(approval.args.key)}` : ''}
          </span>
          <span className='flex items-center gap-6px flex-shrink-0'>
            <button type='button' className='toolbar-btn' onClick={() => void decideApproval('approve')}>
              Approve
            </button>
            <button type='button' className='toolbar-btn' onClick={() => void decideApproval('deny')}>
              Deny
            </button>
          </span>
        </div>
      )}

      <div className='flex-1 relative overflow-hidden bg-black' style={{ minHeight: 0 }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className='w-full h-full block outline-none'
          style={{ cursor: 'default' }}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPaste={handlePaste}
          onContextMenu={(event) => event.preventDefault()}
        />
        {loading && !error && (
          <div className='absolute inset-0 flex items-center justify-center text-white/70 text-14px pointer-events-none'>
            {t('preview.loading')}
          </div>
        )}
        {error && (
          <div className='absolute inset-x-0 top-0 flex items-center justify-between gap-8px px-10px py-6px bg-red-6 text-white text-12px'>
            <span>{error}</span>
            <button
              type='button'
              className='toolbar-btn text-white'
              onClick={() => setReconnectKey((value) => value + 1)}
            >
              {t('common.refresh')}
            </button>
          </div>
        )}
        {!connected && !error && !loading && (
          <div className='absolute inset-0 flex items-center justify-center text-white/70 text-14px pointer-events-none'>
            Browser disconnected
          </div>
        )}
        {activityOpen && (
          <div className='absolute inset-y-0 end-0 w-360px max-w-full bg-bg-1 border-s border-border-1 flex flex-col z-20'>
            <div className='flex items-center justify-between h-36px px-10px border-b border-border-1 flex-shrink-0'>
              <span className='text-12px font-600'>Activity</span>
              <button
                type='button'
                className='toolbar-btn icon-btn'
                onClick={() => setActivityOpen(false)}
                title='Close'
              >
                <Close theme='outline' size={14} />
              </button>
            </div>
            <div className='flex-1 overflow-auto p-10px text-12px'>
              {activityLoading && <div className='text-t-secondary'>Loading...</div>}
              <div className='font-600 mb-6px'>Timeline</div>
              {timeline.length === 0 && <div className='text-t-secondary'>No activity yet.</div>}
              {timeline
                .slice()
                .reverse()
                .map((entry, index) => (
                  <div key={`${entry.ts}-${index}`} className='mb-8px pb-8px border-b border-border-1'>
                    <div className='text-t-secondary'>
                      {new Date(entry.ts).toLocaleTimeString()} · {entry.source} · {entry.action}
                    </div>
                    {entry.url && <div className='truncate text-t-primary'>{entry.url}</div>}
                    {entry.screenshot && (
                      <img
                        src={`/api/browser/replay/file?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(entry.screenshot)}`}
                        alt=''
                        className='w-full mt-4px rd-4px border border-border-1'
                      />
                    )}
                  </div>
                ))}
              <div className='font-600 mt-12px mb-6px'>Files</div>
              {files.length === 0 && <div className='text-t-secondary'>No files yet.</div>}
              {files.map((file) => (
                <a
                  key={file.name}
                  href={`/api/browser/file?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`}
                  target='_blank'
                  rel='noreferrer'
                  className='block truncate text-primary hover:underline'
                >
                  {file.name}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RemoteBrowserView;
