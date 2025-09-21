'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Check, Crown, Zap, HardDrive, Clock, ExternalLink } from 'lucide-react';

interface SubscriptionData {
  subscriptionTier: 'normal' | 'pro' | 'business';
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
  normal: {
    current: number;
    limit: number;
    remaining: number;
  };
  extraThinking: {
    current: number;
    limit: number;
    remaining: number;
  };
}

interface SubscriptionCardProps {
  subscription: SubscriptionData;
  usage: UsageData;
  onUpgrade: () => void;
  onManageBilling: () => void;
}

export function SubscriptionCard({
  subscription,
  usage,
  onUpgrade,
  onManageBilling
}: SubscriptionCardProps) {
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [isManaging, setIsManaging] = useState(false);

  const isPro = subscription.subscriptionTier === 'pro';
  const isBusiness = subscription.subscriptionTier === 'business';
  const isPaid = isPro || isBusiness;
  const isActive = subscription.subscription?.status === 'active';
  const isCanceling = subscription.subscription?.cancelAtPeriodEnd;

  const handleUpgrade = async () => {
    setIsUpgrading(true);
    try {
      await onUpgrade();
    } finally {
      setIsUpgrading(false);
    }
  };

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
  const normalUsagePercentage = usage.normal.limit === -1 ? 0 :
    (usage.normal.current / usage.normal.limit) * 100;

  // Calculate extra thinking usage percentage
  const extraThinkingPercentage = usage.extraThinking.limit === 0 ? 0 :
    (usage.extraThinking.current / usage.extraThinking.limit) * 100;

  return (
    <div className="space-y-6">
      {/* Current Plan */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="flex items-center gap-2">
                {isBusiness ? (
                  <>
                    <Crown className="h-5 w-5 text-purple-500" />
                    Business Plan
                  </>
                ) : isPro ? (
                  <>
                    <Crown className="h-5 w-5 text-yellow-500" />
                    Pro Plan
                  </>
                ) : (
                  <>
                    <Zap className="h-5 w-5 text-blue-500" />
                    Normal Plan
                  </>
                )}
              </CardTitle>
              {isPaid && (
                <Badge variant={isActive ? "default" : "secondary"}>
                  {isCanceling ? "Canceling" : subscription.subscription?.status || "Unknown"}
                </Badge>
              )}
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold">
                {isBusiness ? "$199.99" : isPro ? "$29.99" : "Free"}
              </div>
              {isPaid && <div className="text-sm text-muted-foreground">per month</div>}
            </div>
          </div>
          <CardDescription>
            {isBusiness
              ? "500 AI calls per day, 50GB storage, and 50 Extra Thinking calls"
              : isPro
              ? "50 AI calls per day, 2GB storage, and 10 Extra Thinking calls"
              : "20 AI calls per day, 500MB storage"
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Plan Features */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <Zap className="h-4 w-4" />
                AI Calls
              </h4>
              <div className="text-sm text-muted-foreground">
                {`${usage.normal.limit} built-in PageSpace AI calls per day`}
              </div>
              <Progress value={normalUsagePercentage} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {usage.normal.current} / {usage.normal.limit} used today
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Storage
              </h4>
              <div className="text-sm text-muted-foreground">
                {isBusiness ? "50GB" : isPro ? "2GB" : "500MB"} storage limit
              </div>
              <Progress value={storagePercentage} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {storageUsedMB}MB / {storageQuotaMB}MB used
              </div>
            </div>
          </div>

          {/* Extra Thinking for Pro and Business */}
          {isPaid && usage.extraThinking.limit > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <h4 className="font-medium flex items-center gap-2">
                  <Crown className="h-4 w-4 text-yellow-500" />
                  Extra Thinking
                </h4>
                <div className="text-sm text-muted-foreground">
                  Advanced AI thinking - {usage.extraThinking.limit} calls per day
                </div>
                <Progress value={extraThinkingPercentage} className="h-2" />
                <div className="text-xs text-muted-foreground">
                  {usage.extraThinking.current} / {usage.extraThinking.limit} used today
                </div>
              </div>
            </>
          )}

          {/* Billing Period for Paid Plans */}
          {isPaid && subscription.subscription && (
            <>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  {isCanceling ? "Active until" : "Next billing"}
                </span>
                <span>
                  {new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}
                </span>
              </div>
            </>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 pt-4">
            {subscription.subscriptionTier === 'normal' ? (
              <Button
                onClick={handleUpgrade}
                disabled={isUpgrading}
                className="flex-1"
              >
                {isUpgrading ? "Processing..." : "Upgrade to Pro"}
              </Button>
            ) : subscription.subscriptionTier === 'pro' ? (
              <div className="flex gap-2 w-full">
                <Button
                  onClick={handleUpgrade}
                  disabled={isUpgrading}
                  className="flex-1"
                >
                  {isUpgrading ? "Processing..." : "Upgrade to Business"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleManageBilling}
                  disabled={isManaging}
                  className="flex items-center gap-2"
                >
                  <ExternalLink className="h-4 w-4" />
                  {isManaging ? "Opening..." : "Billing"}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={handleManageBilling}
                disabled={isManaging}
                className="flex items-center gap-2 w-full"
              >
                <ExternalLink className="h-4 w-4" />
                {isManaging ? "Opening..." : "Manage Billing"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Comparison Card for Normal Users */}
      {!isPaid && (
        <Card className="border-yellow-200 dark:border-yellow-800 bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-950/50 dark:to-orange-950/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-yellow-500" />
              Upgrade Your Plan
            </CardTitle>
            <CardDescription>
              Pro and Business plans with generous limits
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <h4 className="font-medium mb-2">Pro Plan - $29.99/month:</h4>
                <ul className="space-y-1 text-sm">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    50 AI calls/day (2.5x more)
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    10 Extra Thinking calls/day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    2GB storage (4x more)
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    Advanced AI model access
                  </li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium mb-2">Business Plan - $199.99/month:</h4>
                <ul className="space-y-1 text-sm">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    500 AI calls/day (25x more)
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    50 Extra Thinking calls/day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    50GB storage (100x more)
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    Enterprise features
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}