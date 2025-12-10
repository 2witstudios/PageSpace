'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText, Download, ExternalLink, Loader2 } from 'lucide-react';

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
    }).format(amount / 100);
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
      <div className="text-center py-8 border rounded-lg bg-muted/30">
        <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
        <p className="text-muted-foreground">No invoices yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="grid grid-cols-12 gap-4 px-4 py-2 text-sm font-medium text-muted-foreground border-b">
        <div className="col-span-3">Date</div>
        <div className="col-span-4">Description</div>
        <div className="col-span-2 text-right">Amount</div>
        <div className="col-span-1 text-center">Status</div>
        <div className="col-span-2 text-right">Actions</div>
      </div>

      {/* Invoice rows */}
      {invoices.map((invoice) => {
        const colors = statusColors[invoice.status] || statusColors.draft;
        return (
          <div
            key={invoice.id}
            className="grid grid-cols-12 gap-4 px-4 py-3 border rounded-lg bg-card items-center"
          >
            <div className="col-span-3 text-sm">
              {formatDate(invoice.created)}
            </div>
            <div className="col-span-4 text-sm truncate">
              {invoice.description || `Invoice ${invoice.number || ''}`}
            </div>
            <div className="col-span-2 text-right font-medium">
              {formatCurrency(invoice.amountPaid || invoice.amountDue, invoice.currency)}
            </div>
            <div className="col-span-1 text-center">
              <Badge variant="secondary" className={`${colors.bg} ${colors.text} capitalize`}>
                {invoice.status}
              </Badge>
            </div>
            <div className="col-span-2 flex justify-end gap-1">
              {invoice.hostedInvoiceUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => window.open(invoice.hostedInvoiceUrl!, '_blank')}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              )}
              {invoice.invoicePdf && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => window.open(invoice.invoicePdf!, '_blank')}
                >
                  <Download className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {/* Load More */}
      {hasMore && (
        <Button
          variant="outline"
          onClick={onLoadMore}
          disabled={loading}
          className="w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading...
            </>
          ) : (
            'Load More'
          )}
        </Button>
      )}
    </div>
  );
}
