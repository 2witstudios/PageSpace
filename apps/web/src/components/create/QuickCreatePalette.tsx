'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, Upload,
  FileText, FileCode, FileSpreadsheet, FileImage, File,
  Folder, BotMessageSquare, MessagesSquare, SquareCheckBig, SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { useSWRConfig } from 'swr';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useUIStore } from '@/stores/useUIStore';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { useBreadcrumbs } from '@/hooks/useBreadcrumbs';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { matchesKeyEvent, getEffectiveBinding } from '@/stores/useHotkeyStore';
import { isEditingActive } from '@/stores/useEditingStore';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import type { TreePage } from '@/hooks/usePageTree';
import {
  PageType,
  Page,
  getCreatablePageTypes,
  getDefaultContent,
  getPageTypeConfig,
} from '@pagespace/lib/client-safe';

type Phase = 'type-select' | 'name-entry';

const PAGE_TYPE_COLORS: Partial<Record<PageType, string>> = {
  [PageType.DOCUMENT]:  '#60a5fa',
  [PageType.AI_CHAT]:   '#e879f9',
  [PageType.TASK_LIST]: '#fb923c',
  [PageType.CHANNEL]:   '#38bdf8',
  [PageType.FOLDER]:    '#fbbf24',
  [PageType.SHEET]:     '#34d399',
  [PageType.CANVAS]:    '#f472b6',
  [PageType.CODE]:      '#a78bfa',
  [PageType.FILE]:      '#94a3b8',
  [PageType.TERMINAL]:  '#6ee7b7',
};

const PAGE_TYPE_ICON_COMPONENTS: Record<string, LucideIcon> = {
  FileText, FileCode, FileSpreadsheet, FileImage, File,
  Folder, BotMessageSquare, MessagesSquare, SquareCheckBig, SquareTerminal,
};

function getPageTypeIconData(type: PageType): { Icon: LucideIcon; color: string } {
  const config = getPageTypeConfig(type);
  return {
    Icon: PAGE_TYPE_ICON_COMPONENTS[config.iconName] ?? File,
    color: PAGE_TYPE_COLORS[type] ?? '#94a3b8',
  };
}

function KbdHint({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-[3px]">
      {keys.map((k) => (
        <kbd key={k} className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border bg-muted px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground">
          {k}
        </kbd>
      ))}
    </span>
  );
}

function PageIconBadge({ type, size = 'md' }: { type: PageType; size?: 'sm' | 'md' }) {
  const { Icon, color } = getPageTypeIconData(type);
  const dim = size === 'sm' ? 20 : 24;
  const iconSize = size === 'sm' ? 12 : 14;
  const radius = size === 'sm' ? 5 : 6;
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: dim, height: dim, borderRadius: radius, background: `color-mix(in oklch, ${color} 15%, transparent)` }}
    >
      <Icon size={iconSize} color={color} strokeWidth={1.5} />
    </span>
  );
}

const treeFetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  return res.json() as Promise<TreePage[]>;
};

function useCachedPageTree(driveId: string | undefined) {
  return useSWR<TreePage[]>(
    driveId ? `/api/drives/${driveId}/pages` : null,
    treeFetcher,
    { revalidateOnFocus: false, revalidateOnMount: false }
  );
}

export default function QuickCreatePalette() {
  const params = useParams();
  const { mutate: swrMutate } = useSWRConfig();
  const rawDriveId = params?.driveId;
  const rawPageId = params?.pageId;
  const rawPath = params?.path;
  const driveId = Array.isArray(rawDriveId) ? rawDriveId[0] : (rawDriveId ?? undefined);
  // Support both the page route (/dashboard/[driveId]/[pageId]) and the
  // files route (/dashboard/[driveId]/files/[[...path]]) which stores the
  // active folder/page in params.path[0] instead of params.pageId.
  const pageId =
    Array.isArray(rawPageId) ? rawPageId[0]
    : rawPageId
    ? rawPageId
    : Array.isArray(rawPath) ? rawPath[0]
    : undefined;

  const quickCreateOpen = useUIStore((s) => s.quickCreateOpen);
  const quickCreateParentOverride = useUIStore((s) => s.quickCreateParentOverride);
  const openQuickCreate = useUIStore((s) => s.openQuickCreate);
  const closeQuickCreate = useUIStore((s) => s.closeQuickCreate);

  const { navigateToPage } = usePageNavigation();
  const { preferences } = useDisplayPreferences();
  const { data: tree } = useCachedPageTree(driveId);

  const [phase, setPhase] = useState<Phase>('type-select');
  const [selectedType, setSelectedType] = useState<PageType | null>(null);
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derive which parent to create in
  const effectiveParentId = useMemo<string | null>(() => {
    if (quickCreateParentOverride !== undefined) return quickCreateParentOverride;
    if (!pageId || !tree) return null;
    const found = findNodeAndParent(tree, pageId);
    if (!found) return null;
    return found.node.type === PageType.FOLDER ? found.node.id : found.node.parentId;
  }, [quickCreateParentOverride, pageId, tree]);

  const { breadcrumbs } = useBreadcrumbs(effectiveParentId);

  const contextLabel = useMemo(() => {
    if (!effectiveParentId) return 'Drive root';
    if (!breadcrumbs?.length) return '…';
    return breadcrumbs.map((b) => b.title).join(' › ');
  }, [effectiveParentId, breadcrumbs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const binding = getEffectiveBinding('pages.quick-create');
      if (matchesKeyEvent(binding, e) && !isEditingActive() && driveId && !quickCreateOpen) {
        e.preventDefault();
        openQuickCreate();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [driveId, openQuickCreate, quickCreateOpen]);

  // Reset when palette closes
  useEffect(() => {
    if (!quickCreateOpen) {
      setPhase('type-select');
      setSelectedType(null);
      setName('');
      setIsCreating(false);
      setSelectedFile(null);
    }
  }, [quickCreateOpen]);

  // Auto-focus name input on phase 2
  useEffect(() => {
    if (phase === 'name-entry' && selectedType !== PageType.FILE) {
      const timer = setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [phase, selectedType]);

  const handleSelectType = useCallback((type: PageType) => {
    const config = getPageTypeConfig(type);
    setSelectedType(type);
    setName(`Untitled ${config.displayName}`);
    setPhase('name-entry');
    if (type === PageType.FILE) {
      // Defer past the Radix Dialog open animation so the native file picker
      // doesn't fight focus-trap or get swallowed by browsers mid-animation.
      setTimeout(() => fileInputRef.current?.click(), 100);
    }
  }, []);

  const handleCreate = useCallback(async () => {
    if (!driveId || !selectedType || isCreating) return;

    if (selectedType === PageType.FILE) {
      if (!selectedFile) {
        toast.error('Please select a file to upload');
        return;
      }
      setIsCreating(true);
      try {
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('driveId', driveId);
        if (effectiveParentId) formData.append('parentId', effectiveParentId);
        if (name.trim()) formData.append('title', name.trim());

        const response = await fetchWithAuth('/api/upload', { method: 'POST', body: formData });
        if (!response.ok) {
          const err = (await response.json()) as { error?: string };
          throw new Error(err.error ?? 'Failed to upload file');
        }
        const result = (await response.json()) as { page: Page };
        closeQuickCreate();
        await swrMutate(`/api/drives/${driveId}/pages`);
        await navigateToPage(result.page.id, driveId);
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setIsCreating(false);
      }
      return;
    }

    setIsCreating(true);
    try {
      const contentMode =
        selectedType === PageType.DOCUMENT && preferences.defaultMarkdownMode ? 'markdown' : undefined;

      const newPage = await post<Page>('/api/pages', {
        title: name.trim() || `Untitled ${getPageTypeConfig(selectedType).displayName}`,
        type: selectedType,
        driveId,
        parentId: effectiveParentId,
        content: getDefaultContent(selectedType),
        ...(contentMode && { contentMode }),
      });

      closeQuickCreate();
      await swrMutate(`/api/drives/${driveId}/pages`);
      await navigateToPage(newPage.id, driveId);
    } catch (error) {
      toast.error((error as Error).message ?? 'Failed to create page');
    } finally {
      setIsCreating(false);
    }
  }, [driveId, selectedType, isCreating, selectedFile, name, effectiveParentId, preferences, closeQuickCreate, navigateToPage]);

  const handleKeyDownNameEntry = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void handleCreate();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setPhase('type-select');
      }
    },
    [handleCreate]
  );

  const creatableTypes = getCreatablePageTypes();

  if (!quickCreateOpen) return null;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="*/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            setSelectedFile(file);
            setName(file.name);
          }
          e.target.value = '';
        }}
      />

      {phase === 'type-select' && (
        <CommandDialog
          open={quickCreateOpen}
          onOpenChange={(open) => !open && closeQuickCreate()}
          title="Create new page"
          description="Choose a page type to create"
          showCloseButton={false}
          className="max-w-[480px]"
        >
          <div className="px-3 py-2 border-b">
            <p className="text-xs text-muted-foreground">
              In: <span className="font-medium">{contextLabel}</span>
            </p>
          </div>
          <div className="relative">
            <CommandInput placeholder="Search page types…" autoFocus />
            <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              <KbdHint keys={['⌥', 'N']} />
            </div>
          </div>
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No matching types.</CommandEmpty>
            <CommandGroup>
              {creatableTypes.map((type) => {
                const config = getPageTypeConfig(type);
                return (
                  <CommandItem
                    key={type}
                    value={`${config.displayName} ${config.description}`}
                    onSelect={() => handleSelectType(type)}
                    className="flex items-center gap-3 py-2.5"
                  >
                    <PageIconBadge type={type} />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{config.displayName}</span>
                      <span className="text-xs text-muted-foreground">{config.description}</span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      )}

      {phase === 'name-entry' && selectedType && (
        <CommandDialog
          open={quickCreateOpen}
          onOpenChange={(open) => !open && closeQuickCreate()}
          title="Name your page"
          description="Enter a name for the new page"
          showCloseButton={false}
          className="max-w-[480px]"
        >
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <button
              onClick={() => setPhase('type-select')}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Back to type selection"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <PageIconBadge type={selectedType} size="sm" />
            <span className="text-sm font-medium">{getPageTypeConfig(selectedType).displayName}</span>
          </div>

          <div className="px-4 py-4 flex flex-col gap-4">
            {selectedType === PageType.FILE ? (
              <div className="flex flex-col gap-3">
                {selectedFile ? (
                  <div className="flex items-center gap-2 p-3 rounded-md border bg-muted/30">
                    <span className="text-sm truncate flex-1">{selectedFile.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      className="shrink-0 h-7 px-2 text-xs"
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full h-20 border-dashed flex-col gap-2"
                  >
                    <Upload className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Click to select a file</span>
                  </Button>
                )}
                {selectedFile && (
                  <Input
                    ref={nameInputRef}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="File name (optional)"
                    onKeyDown={handleKeyDownNameEntry}
                    className="h-9"
                  />
                )}
              </div>
            ) : (
              <Input
                ref={nameInputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`Untitled ${getPageTypeConfig(selectedType).displayName}`}
                onKeyDown={handleKeyDownNameEntry}
                className="h-9 text-sm"
              />
            )}

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Creating in: <span className="font-medium">{contextLabel}</span>
              </p>
              <Button
                size="sm"
                onClick={() => void handleCreate()}
                disabled={isCreating || (selectedType === PageType.FILE && !selectedFile)}
                className="h-7 px-3 text-xs"
              >
                {isCreating ? 'Creating…' : selectedType === PageType.FILE ? 'Upload' : 'Create'}
              </Button>
            </div>
          </div>
        </CommandDialog>
      )}
    </>
  );
}
