import { useCallback, useEffect, useState } from 'react';
import {
  backfillBrainbook,
  BRAINBOOK_ACCESS_CHANGED_EVENT,
  getBrainbookStatus,
  setBrainbookSync,
  signInBrainbook,
  signOutBrainbook,
} from '@/renderer/services/brainbook/brainbookApi';
import type { BrainbookStatus } from '@/renderer/services/brainbook/types';
import { mutate as swrMutate } from 'swr';

const refreshProtectedCatalogs = async () => {
  await Promise.all([swrMutate('assistants.list'), swrMutate('skills.list')]);
  window.dispatchEvent(new CustomEvent(BRAINBOOK_ACCESS_CHANGED_EVENT));
};

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

  const signIn = useCallback(async (email: string, password: string) => {
    setBusy(true);
    try {
      const next = await signInBrainbook({ email, password });
      setStatus(next);
      await refreshProtectedCatalogs();
      setError(null);
      return next;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await signOutBrainbook();
      await refresh();
      await refreshProtectedCatalogs();
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

  const syncNow = useCallback(
    async (confirmAccountSwitch = false) => {
      setBusy(true);
      try {
        await backfillBrainbook(confirmAccountSwitch);
        await refresh();
        setError(null);
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

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
