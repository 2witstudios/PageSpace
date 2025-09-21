'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PlanCard } from './PlanCard';
import { getAllPlans, type SubscriptionTier } from '@/lib/subscription/plans';

interface PlanComparisonTableProps {
  currentTier: SubscriptionTier;
  onUpgrade?: (targetTier: SubscriptionTier) => void;
  onManageBilling?: () => void;
}

export function PlanComparisonTable({
  currentTier,
  onUpgrade,
  onManageBilling,
}: PlanComparisonTableProps) {
  const plans = getAllPlans();

  return (
    <div className="space-y-6">
      {/* Section Header */}
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold">Choose Your Plan</h2>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Upgrade to Pro or Business for more AI calls, storage, and advanced features.
          All plans include your own API key support with no limits.
        </p>
      </div>

      {/* Responsive Layout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            currentTier={currentTier}
            isCurrentPlan={plan.id === currentTier}
            onUpgrade={onUpgrade}
            onManageBilling={onManageBilling}
            className={plan.highlighted ? 'relative z-10' : ''}
          />
        ))}
      </div>

      {/* Feature Comparison Table */}
      <Card className="mt-12">
        <CardHeader>
          <CardTitle className="text-center">Detailed Feature Comparison</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-4 pr-6 font-medium">Feature</th>
                  {plans.map((plan) => (
                    <th key={plan.id} className="text-center py-4 px-4 font-medium min-w-32">
                      <div className="flex flex-col items-center gap-1">
                        <plan.icon className={`h-5 w-5 ${plan.iconColor}`} />
                        <span>{plan.name}</span>
                        {plan.id === currentTier && (
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full">
                            Current
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Pricing */}
                <tr className="border-b">
                  <td className="py-4 pr-6 font-medium">Monthly Price</td>
                  {plans.map((plan) => (
                    <td key={plan.id} className="text-center py-4 px-4">
                      <div className="font-bold text-lg">{plan.price.formatted}</div>
                      {plan.price.monthly > 0 && (
                        <div className="text-xs text-muted-foreground">per month</div>
                      )}
                    </td>
                  ))}
                </tr>

                {/* Core Limits */}
                <tr className="border-b">
                  <td className="py-4 pr-6 font-medium">AI Calls per Day</td>
                  {plans.map((plan) => (
                    <td key={plan.id} className="text-center py-4 px-4">
                      <div className="font-semibold">{plan.limits.aiCalls}</div>
                      <div className="text-xs text-muted-foreground">daily limit</div>
                    </td>
                  ))}
                </tr>

                <tr className="border-b">
                  <td className="py-4 pr-6 font-medium">Extra Thinking Calls</td>
                  {plans.map((plan) => (
                    <td key={plan.id} className="text-center py-4 px-4">
                      {plan.limits.extraThinking > 0 ? (
                        <div>
                          <div className="font-semibold text-yellow-600">{plan.limits.extraThinking}</div>
                          <div className="text-xs text-muted-foreground">per day</div>
                        </div>
                      ) : (
                        <div className="text-muted-foreground">—</div>
                      )}
                    </td>
                  ))}
                </tr>

                <tr className="border-b">
                  <td className="py-4 pr-6 font-medium">Storage</td>
                  {plans.map((plan) => (
                    <td key={plan.id} className="text-center py-4 px-4">
                      <div className="font-semibold">{plan.limits.storage.formatted}</div>
                      <div className="text-xs text-muted-foreground">total storage</div>
                    </td>
                  ))}
                </tr>

                <tr className="border-b">
                  <td className="py-4 pr-6 font-medium">Max File Size</td>
                  {plans.map((plan) => (
                    <td key={plan.id} className="text-center py-4 px-4">
                      <div className="font-semibold">{plan.limits.maxFileSize.formatted}</div>
                      <div className="text-xs text-muted-foreground">per file</div>
                    </td>
                  ))}
                </tr>

                {/* Feature Categories */}
                {getUniqueFeatureNames(plans).map((featureName, index) => (
                  <tr key={index} className="border-b">
                    <td className="py-4 pr-6 font-medium">{featureName}</td>
                    {plans.map((plan) => (
                      <td key={plan.id} className="text-center py-4 px-4">
                        {getFeatureIncluded(plan, featureName) ? (
                          <div className="text-green-600 font-semibold">✓</div>
                        ) : (
                          <div className="text-gray-400">—</div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* FAQ Section */}
      <Card>
        <CardHeader>
          <CardTitle>Frequently Asked Questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h4 className="font-medium mb-2">What happens when I hit my daily limit?</h4>
            <p className="text-sm text-muted-foreground">
              Daily limits only apply to built-in PageSpace AI. Your own API keys (OpenAI, Anthropic, Google, etc.) have no limits.
              Usage resets daily at midnight UTC.
            </p>
          </div>

          <div>
            <h4 className="font-medium mb-2">What is Extra Thinking?</h4>
            <p className="text-sm text-muted-foreground">
              Extra Thinking enables advanced AI reasoning capabilities for complex problems.
              Available for Pro (10/day) and Business (50/day) users.
            </p>
          </div>

          <div>
            <h4 className="font-medium mb-2">Can I cancel anytime?</h4>
            <p className="text-sm text-muted-foreground">
              Yes! You can cancel your Pro or Business subscription anytime through the billing portal.
              You&apos;ll keep your paid features until the end of your current billing period.
            </p>
          </div>

          <div>
            <h4 className="font-medium mb-2">How does billing work?</h4>
            <p className="text-sm text-muted-foreground">
              All billing is handled securely through Stripe. You can update payment methods,
              view invoices, and manage your subscription through our billing portal.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Helper functions
function getUniqueFeatureNames(plans: Array<{ features: Array<{ name: string; included: boolean }> }>): string[] {
  const featureSet = new Set<string>();

  // Add features that are relevant for comparison
  const comparisonFeatures = [
    'Advanced AI models',
    'Priority support',
    'Community support'
  ];

  plans.forEach(plan => {
    plan.features.forEach((feature) => {
      if (comparisonFeatures.includes(feature.name)) {
        featureSet.add(feature.name);
      }
    });
  });

  return Array.from(featureSet).sort();
}

function getFeatureIncluded(plan: { features: Array<{ name: string; included: boolean }> }, featureName: string): boolean {
  const feature = plan.features.find((f) => f.name === featureName);
  return feature ? feature.included : false;
}