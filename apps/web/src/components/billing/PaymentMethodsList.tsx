'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CreditCard, Trash2, Check, Loader2 } from 'lucide-react';
import { del, patch } from '@/lib/auth/auth-fetch';

export interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

interface PaymentMethodsListProps {
  paymentMethods: PaymentMethod[];
  onRefresh: () => void;
  onAddNew: () => void;
}

const brandIcons: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  jcb: 'JCB',
  diners: 'Diners',
  unionpay: 'UnionPay',
};

export function PaymentMethodsList({
  paymentMethods,
  onRefresh,
  onAddNew,
}: PaymentMethodsListProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  const handleSetDefault = async (id: string) => {
    setProcessing(id);
    try {
      await patch('/api/stripe/payment-methods', { paymentMethodId: id });
      onRefresh();
    } catch (err) {
      console.error('Failed to set default:', err);
    } finally {
      setProcessing(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    setProcessing(deleteId);
    try {
      await del('/api/stripe/payment-methods', { paymentMethodId: deleteId });
      onRefresh();
    } catch (err) {
      console.error('Failed to delete:', err);
    } finally {
      setProcessing(null);
      setDeleteId(null);
    }
  };

  if (paymentMethods.length === 0) {
    return (
      <div className="text-center py-8 border rounded-lg bg-muted/30">
        <CreditCard className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
        <p className="text-muted-foreground mb-4">No payment methods on file</p>
        <Button onClick={onAddNew}>Add Payment Method</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {paymentMethods.map((pm) => (
        <div
          key={pm.id}
          className="flex items-center justify-between p-4 border rounded-lg bg-card"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-7 bg-muted rounded flex items-center justify-center text-xs font-bold uppercase">
              {pm.brand?.slice(0, 4) || 'Card'}
            </div>
            <div>
              <div className="font-medium flex items-center gap-2">
                {brandIcons[pm.brand?.toLowerCase()] || pm.brand || 'Card'} •••• {pm.last4}
                {pm.isDefault && (
                  <Badge variant="secondary" className="text-xs">
                    Default
                  </Badge>
                )}
              </div>
              <div className="text-sm text-muted-foreground">
                Expires {pm.expMonth.toString().padStart(2, '0')}/{pm.expYear}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!pm.isDefault && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSetDefault(pm.id)}
                disabled={processing === pm.id}
              >
                {processing === pm.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-1" />
                    Set Default
                  </>
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteId(pm.id)}
              disabled={processing === pm.id}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}

      <Button variant="outline" onClick={onAddNew} className="w-full">
        + Add Payment Method
      </Button>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Payment Method</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this payment method? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
