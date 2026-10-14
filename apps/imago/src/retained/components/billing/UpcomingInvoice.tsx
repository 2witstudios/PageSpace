'use client';

import { dollarsFromCents } from '@/retained/lib/subscription/credits';

interface UpcomingInvoiceProps {
  invoice: {
    amountDue: number;
    total: number;
    currency: string;
    nextPaymentAttempt: string | null;
    lines: Array<{
      description: string | null;
      amount: number;
    }>;
  } | null;
}

/** The next scheduled invoice as a flat table: its lines, the subtotal and the amount due. */
export function UpcomingInvoice({ invoice }: UpcomingInvoiceProps) {
  const formatCurrency = (amount: number, currency: string = 'usd') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(dollarsFromCents(amount));
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (!invoice) {
    return <p className="text-sm text-muted-foreground">No upcoming invoice</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {invoice.nextPaymentAttempt
          ? `Next payment attempt ${formatDate(invoice.nextPaymentAttempt)}`
          : 'Upcoming'}
      </p>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {invoice.lines.slice(0, 3).map((line, i) => (
            <tr key={i}>
              <td className="border-b border-border/60 py-2 pr-4">{line.description || 'Subscription'}</td>
              <td className="border-b border-border/60 py-2 text-right font-mono tabular-nums">
                {formatCurrency(line.amount, invoice.currency)}
              </td>
            </tr>
          ))}
          {invoice.lines.length > 3 && (
            <tr>
              <td colSpan={2} className="py-2 text-xs text-muted-foreground">
                +{invoice.lines.length - 3} more items
              </td>
            </tr>
          )}
          <tr>
            <td className="border-b border-border/60 py-2 pr-4 text-muted-foreground">Subtotal</td>
            <td className="border-b border-border/60 py-2 text-right font-mono tabular-nums text-muted-foreground">
              {formatCurrency(invoice.total, invoice.currency)}
            </td>
          </tr>
          <tr>
            <td className="pt-2.5 font-semibold">Amount due</td>
            <td className="pt-2.5 text-right font-mono font-semibold tabular-nums">
              {formatCurrency(invoice.amountDue, invoice.currency)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
