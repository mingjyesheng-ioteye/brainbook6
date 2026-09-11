import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/renderer/pages/login';

const mocks = vi.hoisted(() => ({ login: vi.fn(), options: vi.fn(), navigate: vi.fn() }));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ status: 'unauthenticated', login: mocks.login }),
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
    vi.clearAllMocks();
    mocks.options.mockResolvedValue({ configured: true });
    mocks.login.mockResolvedValue({ success: false, code: 'invalidCredentials' });
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

  it('preserves local login when Supabase is not configured', async () => {
    mocks.options.mockResolvedValue({ configured: false });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'login.submit' })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }));
    await waitFor(() =>
      expect(mocks.login).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local', username: 'admin' }))
    );
    expect(await screen.findByText('login.errors.invalidCredentials')).toBeInTheDocument();
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
});
