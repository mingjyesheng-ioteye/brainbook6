export const BRAINBOOK_BRAND = {
  productName: 'BrainBook',
  parentProductName: 'AionUI',
  parentPlatformName: 'AionUI Platform',
  websiteUrl: 'https://www.brainbook.space',
  installUrl: 'https://www.brainbook.space/install',
  sourceUrl: 'https://github.com/mingjyesheng-ioteye/brainbook6',
  releasesUrl: 'https://github.com/mingjyesheng-ioteye/brainbook6/releases',
  aionUiSourceUrl: 'https://github.com/iOfficeAI/AionUi',
  aionCoreSourceUrl: 'https://github.com/iOfficeAI/AionCore',
} as const;

const BRAINBOOK_ASSISTANT_IDS = new Set([
  'arcmercer_user',
  'customer_support',
  'demo_user',
  'develop_user',
  'guardian',
  'samsara',
  'springboard',
]);

const BRAINBOOK_SKILL_IDS = new Set([
  'arcmercer_user',
  'browser-automation',
  'customer_support',
  'demo_user',
  'develop_user',
  'guardian',
  'samsara',
  'springboard',
]);

export const isBrainbookAssistantId = (id: string): boolean => BRAINBOOK_ASSISTANT_IDS.has(id);

export const isBrainbookSkillId = (id: string): boolean => BRAINBOOK_SKILL_IDS.has(id);

export function partitionBrainbookAssets<T>(
  items: readonly T[],
  getId: (item: T) => string,
  isBrainbookId: (id: string) => boolean
) {
  const brainbook: T[] = [];
  const platform: T[] = [];

  for (const item of items) {
    (isBrainbookId(getId(item)) ? brainbook : platform).push(item);
  }

  return { brainbook, platform };
}
