import { useCallback, useEffect, useState } from 'react';
import {
  backfillBrainbook,
  getBrainbookStatus,
  setBrainbookSync,
  signInBrainbook,
  signOutBrainbook,
} from '@/renderer/services/brainbook/brainbookApi';
import type { BrainbookStatus } from '@/renderer/services/brainbook/types';

export function useBrainbookAccount() {
  const [status, setStatus] = useState<BrainbookStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getBrainbookStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setBusy(true);
      try {
        const next = await signInBrainbook({ email, password });
        setStatus(next);
        setError(null);
        return next;
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await signOutBrainbook();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const setSyncEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await setBrainbookSync(enabled);
      setStatus(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const syncNow = useCallback(async () => {
    setBusy(true);
    try {
      await backfillBrainbook();
      await refresh();
      setError(null);
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return {
    status,
    error,
    loading,
    busy,
    refresh,
    signIn,
    signOut,
    setSyncEnabled,
    syncNow,
  };
}
