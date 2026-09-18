'use client';

import { Button } from '@/components/ui/button';

export function SideQuestionCard({ state, onDismiss }: { state: { question: string; text: string; loading: boolean; error: string | null }; onDismiss: () => void }) {
  return <section data-testid="side-question-card" aria-label="Side question" className="rounded-md border border-dashed border-primary/40 bg-primary/5 p-3 text-sm">
    <div className="flex items-start justify-between gap-3"><div><p className="font-medium">Side question</p><p className="text-muted-foreground">{state.question}</p></div><Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss side question">Dismiss</Button></div>
    <div className="mt-2 whitespace-pre-wrap" role="status" aria-live="polite" aria-busy={state.loading}>{state.error ? <span className="text-destructive">{state.error}</span> : state.text || 'Thinking…'}</div>
  </section>;
}
