import { httpRequest } from '@/common/adapter/httpBridge';
import type { BrainbookSignInRequest, BrainbookStatus } from './types';

export const BRAINBOOK_ACCESS_CHANGED_EVENT = 'brainbook.access.changed';

export async function getBrainbookStatus(): Promise<BrainbookStatus> {
  return httpRequest<BrainbookStatus>('GET', '/api/brainbook/status');
}

export async function signInBrainbook(request: BrainbookSignInRequest): Promise<BrainbookStatus> {
  return httpRequest<BrainbookStatus>('POST', '/api/brainbook/auth/signin', request);
}

export async function signOutBrainbook(): Promise<void> {
  await httpRequest<void>('POST', '/api/brainbook/auth/signout');
}

export async function setBrainbookSync(enabled: boolean): Promise<BrainbookStatus> {
  return httpRequest<BrainbookStatus>('PATCH', '/api/brainbook/sync', { enabled });
}

export async function backfillBrainbook(confirmAccountSwitch = false): Promise<void> {
  await httpRequest<void>('POST', '/api/brainbook/sync/backfill', {
    confirm_account_switch: confirmAccountSwitch,
  });
}
