import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/renderer/pages/login';
import SiderFooter from '@/renderer/components/layout/Sider/SiderFooter';
import { getBuiltinSettingsNavItems } from '@/renderer/pages/settings/components/SettingsPageWrapper';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  continueWithoutBrainbook: vi.fn(),
  options: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({
    status: 'unauthenticated',
    login: mocks.login,
    continueWithoutBrainbook: mocks.continueWithoutBrainbook,
  }),
}));
vi.mock('@/renderer/services/brainbook/brainbookApi', () => ({ getBrainbookLoginOptions: mocks.options }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => {
  const translate = (key: string) => key;
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }) };
});
vi.mock('@/renderer/services/i18n', () => ({ changeLanguage: vi.fn() }));

describe('BrainBook login', () => {
  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, 'electronAPI');
    vi.clearAllMocks();
    mocks.options.mockResolvedValue({ configured: true });
    mocks.login.mockResolvedValue({ success: false, code: 'invalidCredentials' });
    mocks.continueWithoutBrainbook.mockReturnValue(true);
  });

  it('submits Supabase email credentials and removes legacy saved passwords', async () => {
    localStorage.setItem('rememberedPassword', 'legacy-password');
    render(<LoginPage />);
    const email = await screen.findByLabelText('settings.brainbookEmail');
    expect(localStorage.getItem('rememberedPassword')).toBeNull();
    fireEvent.change(email, { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }));
    await waitFor(() =>
      expect(mocks.login).toHaveBeenCalledWith({
        username: 'user@example.com',
        password: 'secret',
        remember: false,
        provider: 'supabase',
      })
    );
    expect(screen.getByLabelText('login.password')).toHaveValue('');
  });

  it('allows regular local AionUI when Supabase is not configured on desktop', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} });
    mocks.options.mockResolvedValue({ configured: false });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'login.submit' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'login.continueWithoutBrainbook' }));
    expect(mocks.continueWithoutBrainbook).toHaveBeenCalledOnce();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('remembers the account name but never the password after successful login', async () => {
    mocks.login.mockResolvedValue({ success: true });
    render(<LoginPage />);
    fireEvent.change(await screen.findByLabelText('settings.brainbookEmail'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByLabelText('login.rememberMe'));
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }));
    await waitFor(() => expect(localStorage.getItem('rememberMe')).toBe('true'));
    expect(localStorage.getItem('rememberedUsername')).not.toBeNull();
    expect(localStorage.getItem('rememberedPassword')).toBeNull();
  });

  it('continues into local AionUI without submitting BrainBook credentials on desktop', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} });
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'login.continueWithoutBrainbook' }));
    expect(mocks.continueWithoutBrainbook).toHaveBeenCalledOnce();
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith('/guid', { replace: true });
    Reflect.deleteProperty(window, 'electronAPI');
  });
});

describe('BrainBook top-level navigation', () => {
  it('does not show BrainBook in the sidebar footer', () => {
    const openSettings = vi.fn();
    render(
      <SiderFooter
        isMobile={false}
        isSettings={false}
        theme='light'
        siderTooltipProps={{}}
        onSettingsClick={openSettings}
        onThemeToggle={vi.fn()}
      />
    );
    expect(screen.queryByText('settings.brainbook')).toBeNull();
    fireEvent.click(screen.getByText('common.settings'));
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('does not include BrainBook in Settings navigation', () => {
    const items = getBuiltinSettingsNavItems(true, (key) => key);
    expect(items.map((item) => item.id)).not.toContain('brainbook');
  });
});
