'use client';

import { useState } from 'react';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { MapPin, Pencil, Loader2, AlertCircle, Check } from 'lucide-react';
import { put } from '@/lib/auth/auth-fetch';

export interface BillingAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

interface BillingAddressFormProps {
  address: BillingAddress | null;
  name: string | null;
  onUpdate: () => void;
}

const COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'JP', name: 'Japan' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'SG', name: 'Singapore' },
  // Add more as needed
];

export function BillingAddressForm({
  address,
  name,
  onUpdate,
}: BillingAddressFormProps) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [formData, setFormData] = useState({
    name: name || '',
    line1: address?.line1 || '',
    line2: address?.line2 || '',
    city: address?.city || '',
    state: address?.state || '',
    postal_code: address?.postal_code || '',
    country: address?.country || 'US',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await put('/api/stripe/billing-address', {
        name: formData.name,
        address: {
          line1: formData.line1,
          line2: formData.line2 || undefined,
          city: formData.city,
          state: formData.state || undefined,
          postal_code: formData.postal_code || undefined,
          country: formData.country,
        },
      });

      setSuccess(true);
      setEditing(false);
      onUpdate();

      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError('Failed to update billing address');
    } finally {
      setLoading(false);
    }
  };

  const hasAddress = address?.line1;

  if (!editing && !hasAddress) {
    return (
      <div className="text-center py-6 border rounded-lg bg-muted/30">
        <MapPin className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground mb-4">No billing address on file</p>
        <Button variant="outline" onClick={() => setEditing(true)}>
          Add Address
        </Button>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="border rounded-lg bg-card p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            {name && <div className="font-medium">{name}</div>}
            <div className="text-sm text-muted-foreground space-y-0.5">
              <div>{address?.line1}</div>
              {address?.line2 && <div>{address.line2}</div>}
              <div>
                {[address?.city, address?.state, address?.postal_code]
                  .filter(Boolean)
                  .join(', ')}
              </div>
              <div>{COUNTRIES.find(c => c.code === address?.country)?.name || address?.country}</div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
        </div>

        {success && (
          <Alert className="mt-4 border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20">
            <Check className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700 dark:text-green-300">
              Address updated successfully
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="border rounded-lg bg-card p-4 space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder="Full name"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="line1">Address Line 1</Label>
        <Input
          id="line1"
          value={formData.line1}
          onChange={(e) => setFormData({ ...formData, line1: e.target.value })}
          placeholder="Street address"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="line2">Address Line 2 (optional)</Label>
        <Input
          id="line2"
          value={formData.line2}
          onChange={(e) => setFormData({ ...formData, line2: e.target.value })}
          placeholder="Apartment, suite, etc."
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            value={formData.city}
            onChange={(e) => setFormData({ ...formData, city: e.target.value })}
            placeholder="City"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="state">State/Province</Label>
          <Input
            id="state"
            value={formData.state}
            onChange={(e) => setFormData({ ...formData, state: e.target.value })}
            placeholder="State"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="postal_code">Postal Code</Label>
          <Input
            id="postal_code"
            value={formData.postal_code}
            onChange={(e) => setFormData({ ...formData, postal_code: e.target.value })}
            placeholder="ZIP / Postal code"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <Select
            value={formData.country}
            onValueChange={(value) => setFormData({ ...formData, country: value })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select country" />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((country) => (
                <SelectItem key={country.code} value={country.code}>
                  {country.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setEditing(false)}
          disabled={loading}
          className="flex-1"
        >
          Cancel
        </Button>
        <Button type="submit" disabled={loading} className="flex-1">
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            'Save Address'
          )}
        </Button>
      </div>
    </form>
  );
}
