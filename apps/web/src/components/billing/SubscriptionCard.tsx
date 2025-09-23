'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Crown, Zap, HardDrive, Clock, ExternalLink, AlertTriangle } from 'lucide-react';
import { getPlan } from '@/lib/subscription/plans';

interface SubscriptionData {
  subscriptionTier: 'free' | 'pro' | 'business';
  subscription?: {
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  };
  storage: {
    used: number;
    quota: number;
    tier: string;
  };
}

interface UsageData {
  standard: {
    current: number;
    limit: number;
    remaining: number;
  };
  pro: {
    current: number;
    limit: number;
    remaining: number;
  };
}

interface SubscriptionCardProps {
  subscription: SubscriptionData;
  usage: UsageData;
  onManageBilling: () => void;
}

export function SubscriptionCard({
  subscription,
  usage,
  onManageBilling
}: SubscriptionCardProps) {
  const [isManaging, setIsManaging] = useState(false);

  const plan = getPlan(subscription.subscriptionTier);
  const isPaid = subscription.subscriptionTier !== 'free';
  const isActive = subscription.subscription?.status === 'active';
  const isCanceling = subscription.subscription?.cancelAtPeriodEnd;

  const handleManageBilling = async () => {
    setIsManaging(true);
    try {
      await onManageBilling();
    } finally {
      setIsManaging(false);
    }
  };

  // Calculate storage usage percentage
  const storagePercentage = (subscription.storage.used / subscription.storage.quota) * 100;
  const storageUsedMB = Math.round(subscription.storage.used / (1024 * 1024));
  const storageQuotaMB = Math.round(subscription.storage.quota / (1024 * 1024));

  // Calculate AI usage percentage
  const standardUsagePercentage = usage.standard.limit === -1 ? 0 :
    (usage.standard.current / usage.standard.limit) * 100;

  // Calculate extra thinking usage percentage
  const proPercentage = usage.pro.limit === 0 ? 0 :
    (usage.pro.current / usage.pro.limit) * 100;

  // Check for usage warnings
  const isNearLimit = (usage.standard.current / usage.standard.limit) > 0.8;
  const isStorageNearLimit = storagePercentage > 80;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full ${plan.accentColor}`}>
              <plan.icon className={`h-5 w-5 ${plan.iconColor}`} />
            </div>
            <div>
              <CardTitle className="flex items-center gap-2">
                {plan.displayName}
                {isPaid && (
                  <Badge variant={isActive ? "default" : "secondary"}>
                    {isCanceling ? "Canceling" : subscription.subscription?.status || "Unknown"}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-sm">
                Your current subscription and usage
              </CardDescription>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xl font-bold">{plan.price.formatted}</div>
            {isPaid && <div className="text-xs text-muted-foreground">per month</div>}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Usage Warnings */}
        {(isNearLimit || isStorageNearLimit) && (
          <div className="p-3 rounded-lg bg-yellow-50 border border-yellow-200 dark:bg-yellow-950/20 dark:border-yellow-800">
            <div className="flex items-center gap-2 text-yellow-800 dark:text-yellow-200">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm font-medium">
                {isNearLimit && isStorageNearLimit
                  ? "You're approaching your AI calls and storage limits"
                  : isNearLimit
                  ? "You're approaching your daily AI call limit"
                  : "You're approaching your storage limit"
                }
              </span>
            </div>
          </div>
        )}

        {/* Usage Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* AI Calls */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              <span className="text-sm font-medium">AI Calls Today</span>
            </div>
            <Progress value={standardUsagePercentage} className="h-2" />
            <div className="text-xs text-muted-foreground">
              {usage.standard.current} / {usage.standard.limit} used
            </div>
          </div>

          {/* Storage */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              <span className="text-sm font-medium">Storage</span>
            </div>
            <Progress value={storagePercentage} className="h-2" />
            <div className="text-xs text-muted-foreground">
              {storageUsedMB}MB / {storageQuotaMB}MB used
            </div>
          </div>

          {/* Pro AI or Empty Slot */}
          {usage.pro.limit > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Crown className="h-4 w-4 text-yellow-500" />
                <span className="text-sm font-medium">Pro AI</span>
              </div>
              <Progress value={proPercentage} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {usage.pro.current} / {usage.pro.limit} used
              </div>
            </div>
          ) : (
            <div className="space-y-2 opacity-50">
              <div className="flex items-center gap-2">
                <Crown className="h-4 w-4" />
                <span className="text-sm font-medium">Pro AI</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full dark:bg-gray-700"></div>
              <div className="text-xs text-muted-foreground">
                Not available on Free plan
              </div>
            </div>
          )}
        </div>

        {/* Billing Period for Paid Plans */}
        {isPaid && subscription.subscription && (
          <>
            <Separator />
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                {isCanceling ? "Active until" : "Next billing"}
              </span>
              <span className="font-medium">
                {new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}
              </span>
            </div>
          </>
        )}

        {/* Manage Billing Button */}
        {isPaid && (
          <div className="pt-2">
            <Button
              variant="outline"
              onClick={handleManageBilling}
              disabled={isManaging}
              className="w-full flex items-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              {isManaging ? "Opening..." : "Manage Billing"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}