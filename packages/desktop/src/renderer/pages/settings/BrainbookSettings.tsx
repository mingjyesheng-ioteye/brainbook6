/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import BrainbookModalContent from '@/renderer/components/settings/SettingsModal/contents/BrainbookModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';

const BrainbookSettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <BrainbookModalContent />
    </SettingsPageWrapper>
  );
};

export default BrainbookSettings;
