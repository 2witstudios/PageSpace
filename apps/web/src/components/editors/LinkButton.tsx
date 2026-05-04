"use client";

import { Editor } from '@tiptap/react';
import { Link as LinkIcon } from 'lucide-react';
import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface LinkButtonProps {
  editor: Editor;
  variant?: 'toolbar' | 'bubble';
}

const DANGEROUS_PROTOCOL = /^\s*(javascript|data|vbscript):/i;
const ABSOLUTE_OR_RELATIVE = /^(https?:\/\/|ftp:\/\/|mailto:|tel:|#|\/|\?|\.{1,2}\/)/i;
const LOOKS_LIKE_HOSTNAME = /^[^\s/?#]+\.[^\s]+/;

export const normalizeUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (DANGEROUS_PROTOCOL.test(trimmed)) return '';
  if (ABSOLUTE_OR_RELATIVE.test(trimmed)) return trimmed;
  if (LOOKS_LIKE_HOSTNAME.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
};

const LinkButton = ({ editor, variant = 'toolbar' }: LinkButtonProps) => {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');
  const inputId = React.useId();

  const isActive = editor.isActive('link');

  const handleOpenChange = (next: boolean) => {
    if (next) {
      const existing = (editor.getAttributes('link').href as string | undefined) ?? '';
      setValue(existing);
    }
    setOpen(next);
  };

  const apply = () => {
    const href = normalizeUrl(value);
    const existingAttrs = editor.getAttributes('link');
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) {
      chain.unsetLink().run();
    } else {
      const { from, to } = editor.state.selection;
      if (from === to && !isActive) {
        chain
          .insertContent({
            type: 'text',
            text: href,
            marks: [{ type: 'link', attrs: { href } }],
          })
          .run();
      } else {
        chain.setLink({ ...existingAttrs, href }).run();
      }
    }
    setOpen(false);
  };

  const remove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const triggerClass =
    variant === 'toolbar'
      ? `p-2 rounded-md transition-colors ${isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`
      : `p-2 rounded ${isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={isActive ? 'Edit link' : 'Add link'}
          onMouseDown={(e) => e.preventDefault()}
          className={triggerClass}
        >
          <LinkIcon size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={inputId}>
            URL
          </label>
          <Input
            id={inputId}
            type="url"
            inputMode="url"
            placeholder="https://example.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            {isActive && (
              <Button type="button" variant="ghost" size="sm" onClick={remove}>
                Remove
              </Button>
            )}
            <Button type="button" size="sm" onClick={apply}>
              {isActive ? 'Update' : 'Save'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default LinkButton;
