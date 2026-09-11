import React from 'react';
import { useTranslation } from 'react-i18next';
import BrainbookAccountContent from './BrainbookAccountContent';

const BrainbookAccountPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <main className='size-full overflow-y-auto bg-bg-1'>
      <div className='mx-auto w-full max-w-960px px-24px py-28px md:px-40px md:py-36px'>
        <header className='mb-28px border-b border-solid border-[var(--color-border-2)] border-t-0 border-x-0 pb-18px'>
          <h1 className='m-0 text-24px font-600 text-t-primary'>{t('settings.brainbook')}</h1>
        </header>
        <BrainbookAccountContent />
      </div>
    </main>
  );
};

export default BrainbookAccountPage;
