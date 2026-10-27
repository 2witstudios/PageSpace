'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, AlertCircle, CheckCircle2, Copy, Check } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface CreateUserFormProps {
  onSuccess?: () => void;
}

export function CreateUserForm({ onSuccess }: CreateUserFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [setupLink, setSetupLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSetupLink(null);
    setCopied(false);

    setIsSubmitting(true);

    try {
      const res = await fetchWithAuth('/api/admin/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, role }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to create user');
        return;
      }

      setSuccess(data.message || 'User created successfully');
      if (typeof data.setupLink === 'string') {
        setSetupLink(data.setupLink);
      }
      setName('');
      setEmail('');
      setRole('user');
      onSuccess?.();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!setupLink) return;
    try {
      await navigator.clipboard.writeText(setupLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (insecure context); the link is still
      // selectable in the read-only input as a fallback.
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {setupLink && (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-sm font-medium">One-time setup link</p>
          <p className="text-xs text-muted-foreground">
            Send this link to the user (expires in 60 minutes). On first sign-in
            they&apos;ll register a passkey to secure their account.
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={setupLink} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            <Button type="button" variant="outline" size="icon" onClick={handleCopy} aria-label="Copy setup link">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="create-name">Full Name</Label>
          <Input
            id="create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dr. Jane Smith"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="create-email">Email</Label>
          <Input
            id="create-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@clinic.local"
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="create-role">Role</Label>
        <Select value={role} onValueChange={(v) => setRole(v as 'user' | 'admin')}>
          <SelectTrigger id="create-role" className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">Staff (User)</SelectItem>
            <SelectItem value="admin">Administrator</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating...
          </>
        ) : (
          'Create User'
        )}
      </Button>
    </form>
  );
}
