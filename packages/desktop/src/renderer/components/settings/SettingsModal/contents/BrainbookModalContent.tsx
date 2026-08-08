/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { useBrainbookAccount } from '@/renderer/hooks/brainbook/useBrainbookAccount';
import { Button, Input, Message, Modal, Spin, Switch, Typography } from '@arco-design/web-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import { useSettingsViewMode } from '../settingsViewContext';

const BrainbookModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';

  const { status, error, loading, busy, refresh, signIn, signOut, setSyncEnabled, syncNow } = useBrainbookAccount();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const lastSync = useMemo(() => {
    if (!status?.last_sync_at) return t('settings.brainbookNever');
    return new Date(status.last_sync_at).toLocaleString();
  }, [status?.last_sync_at, t]);

  const getErrorMessage = (error: unknown) => {
    if (isBackendHttpError(error) && error.backendMessage) return error.backendMessage;
    if (error instanceof Error && error.message) return error.message;
    return t('settings.brainbookRequestFailed');
  };

  const handleSignIn = async () => {
    if (!email.trim() || !password) {
      Message.warning(t('settings.brainbookMissingCredentials'));
      return;
    }

    try {
      await signIn(email.trim(), password);
      setPassword('');
      Message.success(t('settings.brainbookSignedIn'));
    } catch (error) {
      Message.error(getErrorMessage(error));
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      Message.success(t('settings.brainbookSignedOut'));
    } catch (error) {
      Message.error(getErrorMessage(error));
    }
  };

  const handleToggleSync = async (enabled: boolean) => {
    try {
      await setSyncEnabled(enabled);
      Message.success(enabled ? t('settings.brainbookSyncEnabled') : t('settings.brainbookSyncDisabled'));
    } catch (error) {
      Message.error(getErrorMessage(error));
    }
  };

  const handleSyncNow = async () => {
    try {
      await syncNow();
      Message.success(t('settings.brainbookBackfillQueued'));
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes('BRAINBOOK_ACCOUNT_SWITCH_CONFIRMATION_REQUIRED')) {
        Modal.confirm({
          title: t('settings.brainbookConfirmAccountSwitchTitle', { defaultValue: 'Confirm account switch' }),
          content: t('settings.brainbookConfirmAccountSwitch', {
            defaultValue:
              'Previously synced conversations remain with their original account. Continue and sync only unowned conversations?',
          }),
          onOk: async () => {
            await syncNow(true);
            Message.success(t('settings.brainbookBackfillQueued'));
          },
        });
        return;
      }
      Message.error(getErrorMessage(error));
    }
  };

  return (
    <div className={classNames('flex flex-col gap-16px max-w-560px', isPageMode ? 'px-0' : 'px-12px')}>
      <Typography.Paragraph className='m-0 text-t-secondary'>{t('settings.brainbookDescription')}</Typography.Paragraph>

      {loading && !status ? (
        <div className='py-24px flex justify-center'>
          <Spin />
        </div>
      ) : null}

      {!loading && error ? (
        <div className='flex flex-col gap-8px'>
          <Typography.Paragraph className='m-0 text-red-500'>{getErrorMessage(error)}</Typography.Paragraph>
          <Button size='small' disabled={busy} onClick={() => void refresh()}>
            {t('common.retry', { defaultValue: 'Retry' })}
          </Button>
        </div>
      ) : null}

      {!loading && status && !status.configured ? (
        <Typography.Paragraph className='m-0 text-orange-500'>
          {t('settings.brainbookNotConfigured')}
        </Typography.Paragraph>
      ) : null}

      {!loading && status?.configured && !status.signed_in ? (
        <div className='flex flex-col gap-10px'>
          <Typography.Text className='text-t-primary'>{t('settings.brainbookSignInTitle')}</Typography.Text>
          <Input
            placeholder={t('settings.brainbookEmail')}
            value={email}
            onChange={setEmail}
            autoComplete='email'
            disabled={busy}
          />
          <Input.Password
            placeholder={t('settings.brainbookPassword')}
            value={password}
            onChange={setPassword}
            autoComplete='current-password'
            disabled={busy}
            onPressEnter={() => {
              void handleSignIn();
            }}
          />
          <Button type='primary' loading={busy} onClick={() => void handleSignIn()}>
            {t('settings.brainbookSignIn')}
          </Button>
        </div>
      ) : null}

      {!loading && status?.configured && status.signed_in ? (
        <div className='flex flex-col gap-10px'>
          <Typography.Text className='text-t-primary'>
            {t('settings.brainbookSignedInAs', { email: status.email ?? '-' })}
          </Typography.Text>

          <div className='flex items-center justify-between gap-10px'>
            <Typography.Text className='text-t-secondary'>{t('settings.brainbookSyncAll')}</Typography.Text>
            <Switch checked={status.sync_enabled} disabled={busy} onChange={(v) => void handleToggleSync(v)} />
          </div>

          <Typography.Paragraph className='m-0 text-t-tertiary text-12px'>
            {t('settings.brainbookDeletePropagation')}
          </Typography.Paragraph>

          <Typography.Text className='text-t-secondary'>
            {t('settings.brainbookPendingCount', { count: status.pending_count })}
          </Typography.Text>
          <Typography.Text className='text-t-secondary'>
            {t('settings.brainbookLastSync', { time: lastSync })}
          </Typography.Text>

          <div className='flex items-center gap-8px'>
            <Button disabled={busy || !status.sync_enabled} onClick={() => void handleSyncNow()}>
              {t('settings.brainbookSyncNow')}
            </Button>
            <Button status='warning' disabled={busy} onClick={() => void handleSignOut()}>
              {t('settings.brainbookSignOut')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default BrainbookModalContent;
