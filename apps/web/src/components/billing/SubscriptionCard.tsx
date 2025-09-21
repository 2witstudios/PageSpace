'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Check, Crown, Zap, HardDrive, Clock, ExternalLink } from 'lucide-react';

interface SubscriptionData {
<<<<<<< Updated upstream
  subscriptionTier: 'free' | 'starter' | 'professional' | 'business' | 'enterprise';
=======
  subscriptionTier: 'free' | 'pro' | 'business';
>>>>>>> Stashed changes
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
  extraThinking?: {
    current: number;
    limit: number;
    remaining: number;
  };
}

interface SubscriptionCardProps {
  subscription: SubscriptionData;
  usage: UsageData;
<<<<<<< Updated upstream
  onUpgrade: (tier: 'starter' | 'professional' | 'business') => void;
=======
  onUpgrade: (tier: 'pro' | 'business') => void;
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
  const isActive = subscription.subscription?.status === 'active';
  const isCanceling = subscription.subscription?.cancelAtPeriodEnd;

  const handleUpgrade = async (tier: 'starter' | 'professional' | 'business') => {
    setIsUpgrading(true);
    try {
      await onUpgrade(tier);
=======
  const tier = subscription.subscriptionTier;
  const isPro = tier === 'pro';
  const isBusiness = tier === 'business';
  const isPaid = isPro || isBusiness;
  const isActive = subscription.subscription?.status === 'active';
  const isCanceling = subscription.subscription?.cancelAtPeriodEnd;

  const handleUpgrade = async (upgradeTier: 'pro' | 'business') => {
    setIsUpgrading(true);
    try {
      await onUpgrade(upgradeTier);
>>>>>>> Stashed changes
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

  // Check if user has a paid subscription
  const isPro = ['starter', 'professional', 'business', 'enterprise'].includes(subscription.subscriptionTier);
  const hasExtraThinking = (usage.extraThinking?.limit || 0) > 0;

  // Calculate AI usage percentage for normal tier
  const normalUsagePercentage = usage.normal.limit === -1 ? 0 :
    (usage.normal.current / usage.normal.limit) * 100;

  // Calculate extra thinking usage percentage
  const extraThinkingPercentage = !usage.extraThinking ? 0 :
    usage.extraThinking.limit === -1 ? 0 :
    usage.extraThinking.limit === 0 ? 0 :
    (usage.extraThinking.current / usage.extraThinking.limit) * 100;

  return (
    <div className="space-y-6">
      {/* Current Plan */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="flex items-center gap-2">
<<<<<<< Updated upstream
                {subscription.subscriptionTier === 'free' ? (
=======
                {isBusiness ? (
                  <>
                    <Crown className="h-5 w-5 text-purple-500" />
                    Business Plan
                  </>
                ) : isPro ? (
>>>>>>> Stashed changes
                  <>
                    <Zap className="h-5 w-5 text-blue-500" />
                    Free Plan
                  </>
                ) : (
                  <>
<<<<<<< Updated upstream
                    <Crown className="h-5 w-5 text-yellow-500" />
                    {subscription.subscriptionTier.charAt(0).toUpperCase() + subscription.subscriptionTier.slice(1)} Plan
=======
                    <Zap className="h-5 w-5 text-blue-500" />
                    Free Plan
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
                {subscription.subscriptionTier === 'free' ? 'Free' :
                 subscription.subscriptionTier === 'starter' ? '$29' :
                 subscription.subscriptionTier === 'professional' ? '$79' :
                 subscription.subscriptionTier === 'business' ? '$199' : 'Custom'}
              </div>
              {subscription.subscriptionTier !== 'free' && subscription.subscriptionTier !== 'enterprise' && (
                <div className="text-sm text-muted-foreground">per month</div>
              )}
            </div>
          </div>
          <CardDescription>
            {subscription.subscriptionTier === 'free'
              ? "15 AI calls per day, 100MB storage"
              : subscription.subscriptionTier === 'starter'
              ? "50 AI calls per day, 10 extra thinking per day, 2GB storage"
              : subscription.subscriptionTier === 'professional'
              ? "200 AI calls per day, 20 extra thinking per day, 10GB storage"
              : subscription.subscriptionTier === 'business'
              ? "500 AI calls per day, 50 extra thinking per day, 50GB storage"
              : "Custom enterprise solution with unlimited AI access"
=======
                {isBusiness ? "$199.99" : isPro ? "$29.99" : "Free"}
              </div>
              {isPaid && <div className="text-sm text-muted-foreground">per month</div>}
            </div>
          </div>
          <CardDescription>
            {isBusiness
              ? "500 AI calls/day, 50GB storage, and 50 Extra Thinking sessions"
              : isPro
              ? "100 AI calls/day, 2GB storage, and 10 Extra Thinking sessions"
              : "25 AI calls per day, 500MB storage"
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
                {subscription.subscriptionTier === 'enterprise' ? "Unlimited built-in PageSpace AI calls" : `${usage.normal.limit} built-in PageSpace AI calls per day`}
              </div>
              {subscription.subscriptionTier !== 'enterprise' && (
                <>
                  <Progress value={normalUsagePercentage} className="h-2" />
                  <div className="text-xs text-muted-foreground">
                    {usage.normal.current} / {usage.normal.limit} used today
                  </div>
                </>
              )}
=======
                {`${usage.normal.limit} built-in PageSpace AI calls per day`}
              </div>
              <Progress value={normalUsagePercentage} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {usage.normal.current} / {usage.normal.limit} used today
              </div>
>>>>>>> Stashed changes
            </div>

            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Storage
              </h4>
              <div className="text-sm text-muted-foreground">
<<<<<<< Updated upstream
                {subscription.subscriptionTier === 'free' ? '100MB' :
                 subscription.subscriptionTier === 'starter' ? '2GB' :
                 subscription.subscriptionTier === 'professional' ? '10GB' :
                 subscription.subscriptionTier === 'business' ? '50GB' : 'Custom'} storage limit
=======
                {isBusiness ? "50GB" : isPro ? "2GB" : "500MB"} storage limit
>>>>>>> Stashed changes
              </div>
              <Progress value={storagePercentage} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {storageUsedMB}MB / {storageQuotaMB}MB used
              </div>
            </div>
          </div>

<<<<<<< Updated upstream
          {/* Extra Thinking for Paid Plans */}
          {hasExtraThinking && (
=======
          {/* Extra Thinking for Pro and Business */}
          {isPaid && usage.extraThinking.limit > 0 && (
>>>>>>> Stashed changes
            <>
              <Separator />
              <div className="space-y-2">
                <h4 className="font-medium flex items-center gap-2">
                  <Crown className={`h-4 w-4 ${isBusiness ? 'text-purple-500' : 'text-yellow-500'}`} />
                  Extra Thinking
                </h4>
                <div className="text-sm text-muted-foreground">
<<<<<<< Updated upstream
                  Advanced AI reasoning - {usage.extraThinking?.limit === -1 ? 'Unlimited' : `${usage.extraThinking?.limit || 0} calls per day`}
=======
                  Advanced AI thinking - {usage.extraThinking.limit} calls per day
                </div>
                <Progress value={extraThinkingPercentage} className="h-2" />
                <div className="text-xs text-muted-foreground">
                  {usage.extraThinking.current} / {usage.extraThinking.limit} used today
>>>>>>> Stashed changes
                </div>
                {usage.extraThinking && usage.extraThinking.limit !== -1 && (
                  <>
                    <Progress value={extraThinkingPercentage} className="h-2" />
                    <div className="text-xs text-muted-foreground">
                      {usage.extraThinking.current} / {usage.extraThinking.limit} used today
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* Billing Period for Paid Plans */}
<<<<<<< Updated upstream
          {subscription.subscriptionTier !== 'free' && subscription.subscription && (
=======
          {isPaid && subscription.subscription && (
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
            {subscription.subscriptionTier === 'free' ? (
              <Button
                onClick={() => handleUpgrade('starter')}
                disabled={isUpgrading}
                className="flex-1"
              >
                {isUpgrading ? "Processing..." : "Upgrade to Starter"}
              </Button>
=======
            {!isPaid ? (
              <div className="flex gap-2 flex-1">
                <Button
                  onClick={() => handleUpgrade('pro')}
                  disabled={isUpgrading}
                  className="flex-1"
                >
                  {isUpgrading ? "Processing..." : "Upgrade to Pro"}
                </Button>
                <Button
                  onClick={() => handleUpgrade('business')}
                  disabled={isUpgrading}
                  variant="outline"
                  className="flex-1"
                >
                  {isUpgrading ? "Processing..." : "Business"}
                </Button>
              </div>
            ) : tier === 'pro' ? (
              <div className="flex gap-2 flex-1">
                <Button
                  variant="outline"
                  onClick={handleManageBilling}
                  disabled={isManaging}
                  className="flex items-center gap-2"
                >
                  <ExternalLink className="h-4 w-4" />
                  {isManaging ? "Opening..." : "Manage Billing"}
                </Button>
                <Button
                  onClick={() => handleUpgrade('business')}
                  disabled={isUpgrading}
                  className="flex-1"
                >
                  {isUpgrading ? "Processing..." : "Upgrade to Business"}
                </Button>
              </div>
>>>>>>> Stashed changes
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

      {/* Comparison Card for Free Users */}
<<<<<<< Updated upstream
      {subscription.subscriptionTier === 'free' && (
=======
      {tier === 'free' && (
>>>>>>> Stashed changes
        <Card className="border-yellow-200 dark:border-yellow-800 bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-950/50 dark:to-orange-950/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-yellow-500" />
              Upgrade Your Plan
            </CardTitle>
            <CardDescription>
              Much more generous than Notion AI and other competitors
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <h4 className="font-medium mb-2">Pro Plan - $29.99/month:</h4>
                <ul className="space-y-1 text-sm">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
<<<<<<< Updated upstream
                    50+ AI calls per day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    10+ Extra Thinking calls/day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    2GB+ storage (20x more)
=======
                    <span>100 AI calls/day</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>10 Extra Thinking calls/day</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>2GB storage (4x more)</span>
>>>>>>> Stashed changes
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Advanced AI model access</span>
                  </li>
                </ul>
              </div>
              <div>
<<<<<<< Updated upstream
                <h4 className="font-medium mb-2">PageSpace Pricing:</h4>
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="font-medium text-foreground">Starter - $29/month</div>
                    <div className="text-foreground/70 dark:text-foreground/80">50 AI calls/day, 10 Extra Thinking, 2GB storage</div>
                  </div>
                  <div>
                    <div className="font-medium text-foreground">Professional - $79/month</div>
                    <div className="text-foreground/70 dark:text-foreground/80">200 AI calls/day, 20 Extra Thinking, 10GB storage</div>
                  </div>
                  <div>
                    <div className="font-medium text-foreground">Business - $199/month</div>
                    <div className="text-foreground/70 dark:text-foreground/80">500 AI calls/day, 50 Extra Thinking, 50GB storage</div>
                  </div>
                </div>
=======
                <h4 className="font-medium mb-2">Business Plan - $199.99/month:</h4>
                <ul className="space-y-1 text-sm">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>500 AI calls/day</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>50 Extra Thinking calls/day</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>50GB storage</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Enterprise features</span>
                  </li>
                </ul>
>>>>>>> Stashed changes
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upgrade Card for Pro Users */}
      {tier === 'pro' && (
        <Card className="border-purple-200 dark:border-purple-800 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-950/50 dark:to-blue-950/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-purple-500" />
              Upgrade to Business
            </CardTitle>
            <CardDescription>
              For teams and power users who need more capacity
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <h4 className="font-medium mb-2">Business Plan - $199.99/month:</h4>
              <ul className="space-y-1 text-sm">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  <span>500 AI calls/day (5x more than Pro)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  <span>50 Extra Thinking calls/day (5x more than Pro)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  <span>50GB storage (25x more than Pro)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  <span>Enterprise processing and priority support</span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}