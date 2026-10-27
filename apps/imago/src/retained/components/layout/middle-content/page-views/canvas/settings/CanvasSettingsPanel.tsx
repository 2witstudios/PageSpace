"use client";

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from '@/retained-adapters/navigation';
import { SettingsSubnav } from '@/ui/files/settings-subnav/settings-subnav';
import { CanvasPublishSettingsSection } from './CanvasPublishSettingsSection';
import { CanvasAppearanceSettingsSection } from './CanvasAppearanceSettingsSection';
import { CanvasHomePageSettingsSection } from './CanvasHomePageSettingsSection';
import CanvasFormsSettingsSection from './CanvasFormsSettingsSection';

type CanvasSettingsKey = 'publish' | 'appearance' | 'home' | 'forms';

const CATEGORIES: readonly { readonly key: CanvasSettingsKey; readonly title: string; readonly description: string }[] = [
  { key: 'publish', title: 'Publish', description: 'Title, description, and share image for search and social' },
  { key: 'appearance', title: 'Appearance', description: 'Whether this page follows PageSpace’s theme' },
  { key: 'home', title: 'Home & 404 page', description: 'Assign this page as the drive’s home or 404 page' },
  { key: 'forms', title: 'Forms', description: 'Wire up <form> tags on this page to a Sheet' },
];

const DEFAULT_CATEGORY: CanvasSettingsKey = 'publish';

const isCanvasSettingsKey = (value: string | null): value is CanvasSettingsKey =>
  CATEGORIES.some((category) => category.key === value);

interface CanvasSettingsPanelProps {
  pageId: string;
  content: string;
  onContentChange: (value: string) => void;
}

/**
 * The canvas Settings tab: the shared settings sub-nav ("Canvas settings", IMC-3.13) with the four
 * categories, and the selected category's form beside it. The category is URL-addressable via
 * `?category=` so a direct link or refresh lands on it (e.g. `?tab=settings&category=forms`); with
 * none, Publish is shown.
 */
export function CanvasSettingsPanel({ pageId, content, onContentChange }: CanvasSettingsPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get('category');
  const category: CanvasSettingsKey = isCanvasSettingsKey(raw) ? raw : DEFAULT_CATEGORY;

  const setCategory = useCallback((next: CanvasSettingsKey) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('category', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, pathname, router]);

  const title = CATEGORIES.find((item) => item.key === category)?.title ?? '';

  return (
    <SettingsSubnav
      navLabel="Canvas settings"
      heading="Canvas settings"
      items={CATEGORIES}
      selected={category}
      onSelect={setCategory}
    >
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <h2 className="text-lg font-medium">{title}</h2>
        {category === 'publish' && <CanvasPublishSettingsSection pageId={pageId} />}
        {category === 'appearance' && <CanvasAppearanceSettingsSection pageId={pageId} />}
        {category === 'home' && <CanvasHomePageSettingsSection pageId={pageId} />}
        {category === 'forms' && (
          <CanvasFormsSettingsSection pageId={pageId} content={content} onContentChange={onContentChange} />
        )}
      </div>
    </SettingsSubnav>
  );
}
