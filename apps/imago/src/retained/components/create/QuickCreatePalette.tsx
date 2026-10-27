'use client';

import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useParams, usePathname } from '@/retained-adapters/navigation';
import {
  ArrowLeft, Upload,
  FileText, FileCode, FileSpreadsheet, FileImage, File,
  Folder, BotMessageSquare, MessagesSquare, SquareCheckBig,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { useSWRConfig } from 'swr';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/retained/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/retained/components/ui/dialog';
import { Popover, PopoverAnchor, PopoverContent } from '@/retained/components/ui/popover';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { post, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { uploadFileToS3 } from '@/retained/lib/upload/orchestrator';
import { useUIStore } from '@/retained/stores/useUIStore';
import { usePageNavigation } from '@/retained/hooks/usePageNavigation';
import { useBreadcrumbs } from '@/retained/hooks/useBreadcrumbs';
import { useDisplayPreferences } from '@/retained/hooks/useDisplayPreferences';
import { matchesKeyEvent, getEffectiveBinding } from '@/retained/stores/useHotkeyStore';
import { isEditingActive } from '@/retained/stores/useEditingStore';
import { findNodeAndParent } from '@/retained/lib/tree/tree-utils';
import { resolveSidebarVariant } from '@/retained/components/layout/left-sidebar/sidebar-routes';
import type { TreePage } from '@/retained/hooks/usePageTree';
import {
  PageType,
  Page,
  getCreatablePageTypes,
  getDefaultContent,
  getPageTypeConfig,
} from '@pagespace/lib/client-safe';

/** The three steps of the create palette (C-Files-NewPage): pick a type, name it, or upload a file. */
type Phase = 'type-select' | 'name-entry' | 'upload';

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
};

const PAGE_TYPE_ICON_COMPONENTS: Record<string, LucideIcon> = {
  FileText, FileCode, FileSpreadsheet, FileImage, File,
  Folder, BotMessageSquare, MessagesSquare, SquareCheckBig,
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

  const pathname = usePathname();
  // The Agents routes bind this hotkey to their OWN palette — the spawn
  // selector, which is what "new" means there (a session, or an environment to
  // run one in), not a page type. `AgentsSidebar` owns that handler, so this
  // one must stand down or both would fire on the same keystroke. The matcher
  // is the sidebar's own, rather than a second regex that could drift from it.
  const onAgentsRoute = resolveSidebarVariant(pathname ?? '') === 'agents';

  const quickCreateOpen = useUIStore((s) => s.quickCreateOpen);
  const quickCreateParentOverride = useUIStore((s) => s.quickCreateParentOverride);
  const quickCreateAnchor = useUIStore((s) => s.quickCreateAnchor);
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
      if (matchesKeyEvent(binding, e) && !isEditingActive() && driveId && !quickCreateOpen && !onAgentsRoute) {
        e.preventDefault();
        openQuickCreate(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [driveId, openQuickCreate, quickCreateOpen, onAgentsRoute]);

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
    // A file keeps its own name (taken from the picked file); a page is named before it is created.
    setName(type === PageType.FILE ? '' : `Untitled ${config.displayName}`);
    setPhase(type === PageType.FILE ? 'upload' : 'name-entry');
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
        const page = await uploadFileToS3(selectedFile, {
          driveId,
          parentId: effectiveParentId,
          title: name.trim() || undefined,
        });
        // Close only once the navigation is under way (the tab bar's New tab
        // request is withdrawn by the next press after the palette closes),
        // and close even if that fails: the page exists either way.
        try {
          await swrMutate(`/api/drives/${driveId}/pages`);
          await navigateToPage(page.id, driveId);
        } finally {
          closeQuickCreate();
        }
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

      try {
        await swrMutate(`/api/drives/${driveId}/pages`);
        await navigateToPage(newPage.id, driveId);
      } finally {
        closeQuickCreate();
      }
    } catch (error) {
      toast.error((error as Error).message ?? 'Failed to create page');
    } finally {
      setIsCreating(false);
    }
  }, [driveId, selectedType, isCreating, selectedFile, name, effectiveParentId, preferences, closeQuickCreate, swrMutate, navigateToPage]);

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

  const creatableTypes = useMemo(() => getCreatablePageTypes(), []);

  if (!quickCreateOpen) return null;

  const selectedDisplayName = selectedType ? getPageTypeConfig(selectedType).displayName : '';

  const onOpenChange = (open: boolean) => {
    if (!open) closeQuickCreate();
  };

  const stepHeader = (title: string) => (
    <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1.5">
      <button
        type="button"
        onClick={() => setPhase('type-select')}
        className="text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Back to type selection"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      {selectedType ? <PageIconBadge type={selectedType} size="sm" /> : null}
      <span className="text-[13.5px] font-semibold">{title}</span>
    </div>
  );

  const pickStep = (
    <Command>
      <div className="px-4 pt-3 pb-2">
        <div className="text-[13.5px] font-semibold">Create new page</div>
        <div className="text-xs text-muted-foreground">
          Choose a page type to create · in <span className="font-medium text-foreground">{contextLabel}</span>
        </div>
      </div>
      <CommandInput placeholder="Search page types…" aria-label="Search page types" autoFocus className="focus-visible:ring-0" />
      <CommandList aria-label="Page types" className="max-h-[360px]">
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
                {type === PageType.FILE ? <span className="ml-auto text-[11.5px] text-muted-foreground">Upload</span> : null}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
      <div className="flex gap-3.5 border-t px-3.5 py-2 text-[11.5px] text-muted-foreground">
        <span><KbdHint keys={['↑↓']} /> choose</span>
        <span><KbdHint keys={['Enter']} /> next</span>
        <span><KbdHint keys={['Esc']} /> close</span>
      </div>
    </Command>
  );

  const nameStep = (
    <div>
      {stepHeader('Name your page')}
      <div className="flex flex-col gap-2 px-4 pt-1 pb-4">
        <label htmlFor="quick-create-name" className="text-xs text-muted-foreground">
          Enter a name for the new page
        </label>
        <Input
          id="quick-create-name"
          ref={nameInputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Untitled ${selectedDisplayName}`}
          onKeyDown={handleKeyDownNameEntry}
          className="h-9 text-sm focus-visible:ring-0"
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => setPhase('type-select')} className="h-8 px-3.5">
            Back
          </Button>
          <Button size="sm" onClick={() => void handleCreate()} disabled={isCreating} className="h-8 px-3.5">
            {isCreating ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );

  const uploadStep = (
    <div>
      {stepHeader('Upload a file')}
      <div className="flex flex-col gap-2.5 px-4 pt-1 pb-4">
        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          className="h-[110px] w-full flex-col gap-1.5 border-dashed"
        >
          <Upload className="h-5 w-5 text-muted-foreground" />
          <span className="text-[13px] text-muted-foreground">
            {selectedFile ? selectedFile.name : 'Click to select a file'}
          </span>
        </Button>
        <label htmlFor="quick-create-file-name" className="sr-only">File name (optional)</label>
        <Input
          id="quick-create-file-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="File name (optional)"
          onKeyDown={handleKeyDownNameEntry}
          className="h-9 text-sm"
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => setPhase('type-select')} className="h-8 px-3.5">
            Back
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={isCreating || !selectedFile}
            className="h-8 px-3.5"
          >
            {isCreating ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>
  );

  const step: ReactNode =
    phase === 'type-select' ? pickStep : phase === 'name-entry' ? nameStep : uploadStep;

  // The same palette in two presentations: anchored under the control that opened it (the Files
  // pane "+"), or the centred dialog when it was opened from elsewhere.
  const panel = quickCreateAnchor ? (
    <Popover open onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={{ current: quickCreateAnchor }} />
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        aria-label="Create new page"
        className="w-[360px] overflow-hidden p-0"
      >
        {step}
      </PopoverContent>
    </Popover>
  ) : (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-[360px] gap-0 overflow-hidden p-0" aria-label="Create new page">
        <DialogHeader className="sr-only">
          <DialogTitle>Create new page</DialogTitle>
          <DialogDescription>Choose a page type to create</DialogDescription>
        </DialogHeader>
        {step}
      </DialogContent>
    </Dialog>
  );

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
      {panel}
    </>
  );
}
