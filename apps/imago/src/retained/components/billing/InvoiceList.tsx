'use client';

import { dollarsFromCents } from '@/retained/lib/subscription/credits';

import { Button } from '@/retained/components/ui/button';
import { Badge } from '@/retained/components/ui/badge';
import { FileText, Loader2 } from 'lucide-react';

export interface Invoice {
  id: string;
  number: string | null;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string;
  periodStart: string | null;
  periodEnd: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  description: string | null;
}

interface InvoiceListProps {
  invoices: Invoice[];
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
}

const statusColors: Record<string, { bg: string; text: string }> = {
  paid: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-300' },
  open: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300' },
  draft: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-300' },
  uncollectible: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300' },
  void: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-500' },
};

/**
 * Invoice history as a flat table: date, description, amount, a status pill, and the
 * PDF and View links for each invoice, with Load more under it.
 */
export function InvoiceList({
  invoices,
  hasMore,
  onLoadMore,
  loading = false,
}: InvoiceListProps) {
  const formatCurrency = (amount: number, currency: string) => {
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

  if (invoices.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <FileText className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No invoices yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="border-b border-border pb-2 font-medium">Date</th>
              <th className="border-b border-border pb-2 pr-3 font-medium">Description</th>
              <th className="border-b border-border pb-2 text-right font-medium">Amount</th>
              <th className="border-b border-border pb-2 pl-4 font-medium">Status</th>
              <th className="border-b border-border pb-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const colors = statusColors[invoice.status] || statusColors.draft;
              return (
                <tr key={invoice.id}>
                  <td className="whitespace-nowrap border-b border-border/60 py-2.5">
                    {formatDate(invoice.created)}
                  </td>
                  <td className="border-b border-border/60 py-2.5 pr-3">
                    {invoice.description || `Invoice ${invoice.number || ''}`}
                  </td>
                  <td className="border-b border-border/60 py-2.5 text-right font-mono tabular-nums">
                    {formatCurrency(invoice.amountPaid || invoice.amountDue, invoice.currency)}
                  </td>
                  <td className="border-b border-border/60 py-2.5 pl-4">
                    <Badge variant="secondary" className={`${colors.bg} ${colors.text} capitalize`}>
                      {invoice.status}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap border-b border-border/60 py-2.5 text-right">
                    {invoice.invoicePdf && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() => window.open(invoice.invoicePdf!, '_blank')}
                        aria-label="Download invoice PDF"
                      >
                        PDF
                      </Button>
                    )}
                    {invoice.invoicePdf && invoice.hostedInvoiceUrl && (
                      <span aria-hidden="true" className="px-1.5 text-border">·</span>
                    )}
                    {invoice.hostedInvoiceUrl && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() => window.open(invoice.hostedInvoiceUrl!, '_blank')}
                        aria-label="View invoice online"
                      >
                        View
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div>
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
