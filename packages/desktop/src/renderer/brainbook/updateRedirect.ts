import { openExternalUrl } from '@/renderer/utils/platform';
import { BRAINBOOK_BRAND } from './brand';

export const BRAINBOOK_INSTALL_URL = BRAINBOOK_BRAND.installUrl;

export function redirectUpdateToBrainbookInstall(): boolean {
  const applicationName = document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content;
  if (applicationName !== BRAINBOOK_BRAND.productName) return false;

  void openExternalUrl(BRAINBOOK_INSTALL_URL);
  return true;
}
