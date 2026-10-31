/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Left, Right, Refresh, Loading } from '@icon-park/react';
import { BROWSER_BLANK_URL, browserTabLabelFromUrl, resolveAddressBarInput } from './constants';

export interface RemoteBrowserViewProps {
  url: string;
  tabId: string;
  onUrlChange: (tabId: string, url: string) => void;
  onTitleChange: (tabId: string, title: string) => void;
  onFaviconChange: (tabId: string, favicon: string) => void;
}

type BrowserMessage =
  | { type: 'frame'; data: string; metadata?: { deviceWidth?: number; deviceHeight?: number } }
  | { type: 'state'; url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean }
  | { type: 'error'; message?: string }
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

const RemoteBrowserView: React.FC<RemoteBrowserViewProps> = ({ url, tabId, onUrlChange, onTitleChange }) => {
  const { t } = useTranslation();
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
        const response = await fetch('/api/browser/session', { method: 'POST', credentials: 'include' });
        if (!response.ok) {
          throw new Error(`Browser service unavailable (${response.status})`);
        }
        const data = (await response.json()) as { wsPath?: string };
        if (!data.wsPath) throw new Error('Browser service returned no session');
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
  }, [drawFrame, reconnectKey, tabId]);

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
      </div>
    </div>
  );
};

export default RemoteBrowserView;
