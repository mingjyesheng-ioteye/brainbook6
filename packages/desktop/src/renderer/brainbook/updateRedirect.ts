import { openExternalUrl } from '@/renderer/utils/platform';

export const BRAINBOOK_INSTALL_URL = 'https://www.brainbook.space/install';

export async function redirectUpdateToBrainbookInstall(): Promise<boolean> {
  const applicationName = document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content;
  if (applicationName !== 'BrainBook') return false;

  await openExternalUrl(BRAINBOOK_INSTALL_URL);
  return true;
}