'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Calendar, Receipt } from 'lucide-react';

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

export function UpcomingInvoice({ invoice }: UpcomingInvoiceProps) {
  const formatCurrency = (amount: number, currency: string = 'usd') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  if (!invoice) {
    return (
      <div className="text-center py-6 border rounded-lg bg-muted/30">
        <Receipt className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No upcoming invoice</p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Calendar className="h-4 w-4" />
          <span className="text-sm">
            {invoice.nextPaymentAttempt
              ? `Next payment: ${formatDate(invoice.nextPaymentAttempt)}`
              : 'Upcoming'}
          </span>
        </div>
        <div className="text-2xl font-bold">
          {formatCurrency(invoice.amountDue, invoice.currency)}
        </div>
      </div>

      {invoice.lines.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          {invoice.lines.slice(0, 3).map((line, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-muted-foreground truncate mr-4">
                {line.description || 'Subscription'}
              </span>
              <span className="font-medium">
                {formatCurrency(line.amount, invoice.currency)}
              </span>
            </div>
          ))}
          {invoice.lines.length > 3 && (
            <div className="text-xs text-muted-foreground">
              +{invoice.lines.length - 3} more items
            </div>
          )}
        </div>
      )}
    </div>
  );
}
