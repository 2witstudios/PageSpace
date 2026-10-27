"use client";

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, Globe, Palette, Home, FormInput } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CanvasSettingsMenu, type CanvasSettingsCategory } from './CanvasSettingsMenu';
import { CanvasPublishSettingsSection } from './CanvasPublishSettingsSection';
import { CanvasAppearanceSettingsSection } from './CanvasAppearanceSettingsSection';
import { CanvasHomePageSettingsSection } from './CanvasHomePageSettingsSection';
import CanvasFormsSettingsSection from './CanvasFormsSettingsSection';

const CATEGORIES: CanvasSettingsCategory[] = [
  { key: 'publish', title: 'Publish', description: 'Title, description, and share image for search and social', icon: Globe },
  { key: 'appearance', title: 'Appearance', description: 'Whether this page follows PageSpace\'s light/dark theme', icon: Palette },
  { key: 'home', title: 'Home & 404 page', description: 'Assign this page as the drive\'s landing or 404 page', icon: Home },
  { key: 'forms', title: 'Forms', description: 'Wire up <form> tags on this page to a Sheet', icon: FormInput },
];

const CATEGORY_TITLES: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.title]));

interface CanvasSettingsPanelProps {
  pageId: string;
  content: string;
  onContentChange: (value: string) => void;
}

/**
 * Entry point for the canvas Settings tab: a category menu you click into,
 * URL-addressable via `?category=` so a direct link/refresh lands straight
 * on a category (e.g. `?tab=settings&category=forms`) — see the plan's
 * navigation-model note on why this is a query param rather than a real
 * nested route.
 */
export function CanvasSettingsPanel({ pageId, content, onContentChange }: CanvasSettingsPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const category = searchParams.get('category');

  const setCategory = useCallback((next: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) {
      params.set('category', next);
    } else {
      params.delete('category');
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  if (!category || !CATEGORY_TITLES[category]) {
    return (
      <div className="p-4 max-w-2xl">
        <CanvasSettingsMenu categories={CATEGORIES} onSelect={setCategory} />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setCategory(null)}>
        <ChevronLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <h2 className="text-lg font-medium">{CATEGORY_TITLES[category]}</h2>
      {category === 'publish' && <CanvasPublishSettingsSection pageId={pageId} />}
      {category === 'appearance' && <CanvasAppearanceSettingsSection pageId={pageId} />}
      {category === 'home' && <CanvasHomePageSettingsSection pageId={pageId} />}
      {category === 'forms' && (
        <CanvasFormsSettingsSection pageId={pageId} content={content} onContentChange={onContentChange} />
      )}
    </div>
  );
}
