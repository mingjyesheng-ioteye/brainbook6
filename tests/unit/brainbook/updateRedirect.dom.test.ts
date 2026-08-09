import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(),
}));

vi.mock('@/renderer/utils/platform', () => ({
  openExternalUrl: openExternalUrlMock,
}));

import {
  BRAINBOOK_INSTALL_URL,
  redirectUpdateToBrainbookInstall,
} from '@/renderer/brainbook/updateRedirect';

describe('redirectUpdateToBrainbookInstall', () => {
  beforeEach(() => {
    openExternalUrlMock.mockReset();
    openExternalUrlMock.mockResolvedValue(undefined);
    document.head.innerHTML = '<meta name="application-name" content="BrainBook">';
  });

  it('opens the temporary BrainBook install page and handles the update action', () => {
    expect(redirectUpdateToBrainbookInstall()).toBe(true);
    expect(openExternalUrlMock).toHaveBeenCalledWith(BRAINBOOK_INSTALL_URL);
  });

  it('leaves the parent updater in control for other application brands', () => {
    document.head.innerHTML = '<meta name="application-name" content="AionUi">';

    expect(redirectUpdateToBrainbookInstall()).toBe(false);
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });
});