'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Check, Crown, Zap, HardDrive, Clock, ExternalLink } from 'lucide-react';

interface SubscriptionData {
  subscriptionTier: 'normal' | 'pro';
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

  // Calculate AI usage percentage for normal tier
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
                {isPro ? (
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
              {isPro && (
                <Badge variant={isActive ? "default" : "secondary"}>
                  {isCanceling ? "Canceling" : subscription.subscription?.status || "Unknown"}
                </Badge>
              )}
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold">
                {isPro ? "$15" : "Free"}
              </div>
              {isPro && <div className="text-sm text-muted-foreground">per month</div>}
            </div>
          </div>
          <CardDescription>
            {isPro
              ? "Unlimited AI calls, 2GB storage, and Extra Thinking access"
              : "100 AI calls per day, 500MB storage"
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
                {isPro ? "Unlimited Normal calls" : `${usage.normal.limit} Normal calls per day`}
              </div>
              {!isPro && (
                <>
                  <Progress value={normalUsagePercentage} className="h-2" />
                  <div className="text-xs text-muted-foreground">
                    {usage.normal.current} / {usage.normal.limit} used today
                  </div>
                </>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Storage
              </h4>
              <div className="text-sm text-muted-foreground">
                {isPro ? "2GB" : "500MB"} storage limit
              </div>
              <Progress value={storagePercentage} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {storageUsedMB}MB / {storageQuotaMB}MB used
              </div>
            </div>
          </div>

          {/* Extra Thinking for Pro */}
          {isPro && (
            <>
              <Separator />
              <div className="space-y-2">
                <h4 className="font-medium flex items-center gap-2">
                  <Crown className="h-4 w-4 text-yellow-500" />
                  Extra Thinking
                </h4>
                <div className="text-sm text-muted-foreground">
                  Advanced AI model (Gemini 2.5 Pro) - 10 calls per day
                </div>
                <Progress value={extraThinkingPercentage} className="h-2" />
                <div className="text-xs text-muted-foreground">
                  {usage.extraThinking.current} / {usage.extraThinking.limit} used today
                </div>
              </div>
            </>
          )}

          {/* Billing Period for Pro */}
          {isPro && subscription.subscription && (
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
            {!isPro ? (
              <Button
                onClick={handleUpgrade}
                disabled={isUpgrading}
                className="flex-1"
              >
                {isUpgrading ? "Processing..." : "Upgrade to Pro"}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={handleManageBilling}
                disabled={isManaging}
                className="flex items-center gap-2"
              >
                <ExternalLink className="h-4 w-4" />
                {isManaging ? "Opening..." : "Manage Billing"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Comparison Card for Normal Users */}
      {!isPro && (
        <Card className="border-yellow-200 dark:border-yellow-800 bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-950/50 dark:to-orange-950/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-yellow-500" />
              Upgrade to Pro
            </CardTitle>
            <CardDescription>
              Much more generous than Notion AI and other competitors
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <h4 className="font-medium mb-2">What you&apos;ll get:</h4>
                <ul className="space-y-1 text-sm">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    Unlimited Normal AI calls
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
                <h4 className="font-medium mb-2">Compare to others:</h4>
                <ul className="space-y-1 text-sm text-foreground/70 dark:text-foreground/80">
                  <li>• Notion AI: ~40 requests/month</li>
                  <li>• ChatGPT Plus: $20/month</li>
                  <li>• Claude Pro: $20/month</li>
                  <li>• PageSpace Pro: $15/month</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}