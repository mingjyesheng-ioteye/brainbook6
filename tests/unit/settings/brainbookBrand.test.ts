import { describe, expect, it } from 'vitest';
import { isBrainbookAssistantId, isBrainbookSkillId, partitionBrainbookAssets } from '@/renderer/brainbook/brand';

describe('BrainBook brand inventory', () => {
  it('recognizes generated BrainBook assistant and protected skill IDs', () => {
    expect(isBrainbookAssistantId('springboard')).toBe(true);
    expect(isBrainbookSkillId('gstack')).toBe(true);
  });

  it('does not brand parent assets or obsolete prefixed IDs', () => {
    expect(isBrainbookAssistantId('cowork')).toBe(false);
    expect(isBrainbookAssistantId('brainbook-springboard')).toBe(false);
    expect(isBrainbookSkillId('cron')).toBe(false);
  });

  it('partitions a mixed catalog without changing item order', () => {
    const items = [{ id: 'cowork' }, { id: 'springboard' }, { id: 'gstack' }, { id: 'browser' }];

    const result = partitionBrainbookAssets(items, (item) => item.id, isBrainbookAssistantId);

    expect(result.brainbook.map((item) => item.id)).toEqual(['springboard', 'gstack']);
    expect(result.platform.map((item) => item.id)).toEqual(['cowork', 'browser']);
  });
});
