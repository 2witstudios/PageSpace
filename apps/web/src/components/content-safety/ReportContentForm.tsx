'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * The public content report form. Anyone can use it; no account needed.
 *
 * Kept free of `@pagespace/lib` imports so the page stays a small client bundle:
 * the categories and the CyberTipline address mirror `content-safety/reports.ts`,
 * and the server's answer carries the authoritative guidance text.
 */

export const REPORT_CATEGORY_OPTIONS = [
  { value: 'csam', label: 'Child sexual abuse material' },
  { value: 'illegal_other', label: 'Other illegal content' },
  { value: 'malware', label: 'Malware or phishing' },
  { value: 'copyright', label: 'Copyright infringement' },
  { value: 'harassment', label: 'Harassment or abuse' },
  { value: 'other', label: 'Something else' },
] as const;

type Category = (typeof REPORT_CATEGORY_OPTIONS)[number]['value'];

const CYBERTIPLINE_URL = 'https://report.cybertip.org/';
const HONEYPOT_FIELD = '_hp';

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; message: string; csam: boolean }
  | { kind: 'error'; message: string };

function CsamNotice() {
  return (
    <Alert variant="destructive" data-testid="csam-guidance">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>Do not download, screenshot or forward it</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Please do not download, screenshot, save or forward the material, even to report it. The address of the
          page is all we need.
        </p>
        <p>
          You can also report it directly to the National Center for Missing &amp; Exploited Children (NCMEC):{' '}
          <a href={CYBERTIPLINE_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline">
            CyberTipline
          </a>
          .
        </p>
      </AlertDescription>
    </Alert>
  );
}

export function ReportContentForm() {
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<Category | ''>('');
  const [description, setDescription] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!category) return;
    setStatus({ kind: 'submitting' });
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, category, description, contactEmail, [HONEYPOT_FIELD]: honeypot }),
      });
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (!res.ok) {
        setStatus({ kind: 'error', message: data?.error ?? 'Something went wrong. Please try again.' });
        return;
      }
      setStatus({ kind: 'done', message: data?.message ?? 'Report received. Thank you.', csam: category === 'csam' });
    } catch {
      setStatus({ kind: 'error', message: 'Something went wrong. Please try again.' });
    }
  };

  if (status.kind === 'done') {
    return (
      <div className="space-y-4" role="status">
        <p className="text-base">{status.message}</p>
        {status.csam && <CsamNotice />}
      </div>
    );
  }

  const submitting = status.kind === 'submitting';

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="report-url">Address of the page</Label>
        <Input
          id="report-url"
          type="url"
          required
          maxLength={2048}
          placeholder="https://example.pagespace.site/page"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">A site published on PageSpace, including custom domains.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="report-category">What is wrong with it?</Label>
        <select
          id="report-category"
          required
          value={category}
          onChange={(e) => setCategory(e.target.value as Category | '')}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="" disabled>
            Choose one
          </option>
          {REPORT_CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {category === 'csam' && <CsamNotice />}

      <div className="space-y-2">
        <Label htmlFor="report-description">Details (optional)</Label>
        <Textarea
          id="report-description"
          maxLength={2000}
          rows={4}
          placeholder={category === 'csam' ? 'You do not need to describe the material.' : 'What should we know?'}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="report-contact">Your email (optional)</Label>
        <Input
          id="report-contact"
          type="email"
          maxLength={254}
          autoComplete="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">Only if you want us to be able to follow up.</p>
      </div>

      {/* Honeypot: off-screen and skipped by keyboard and screen readers. A person never fills it. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
        <label htmlFor="report-website">Website</label>
        <input id="report-website" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
      </div>

      {status.kind === 'error' && (
        <p className="text-sm text-destructive" role="alert">
          {status.message}
        </p>
      )}

      <Button type="submit" disabled={submitting || !url.trim() || !category} className="w-full">
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Send report
      </Button>
    </form>
  );
}
