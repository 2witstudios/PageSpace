/**
 * AI Usage Monitoring Module
 * Comprehensive tracking for AI provider usage, tokens, costs, and performance
 */
/**
 * AI Provider Pricing (per 1M tokens)
 * Prices in USD as of 2025-01
 */
export declare const AI_PRICING: {
    readonly 'anthropic/claude-3.5-sonnet': {
        readonly input: 3;
        readonly output: 15;
    };
    readonly 'anthropic/claude-3-haiku': {
        readonly input: 0.25;
        readonly output: 1.25;
    };
    readonly 'anthropic/claude-opus-4.1': {
        readonly input: 15;
        readonly output: 75;
    };
    readonly 'openai/gpt-4o': {
        readonly input: 2.5;
        readonly output: 10;
    };
    readonly 'openai/gpt-4o-mini': {
        readonly input: 0.15;
        readonly output: 0.6;
    };
    readonly 'openai/gpt-5': {
        readonly input: 10;
        readonly output: 40;
    };
    readonly 'openai/gpt-5-mini': {
        readonly input: 1;
        readonly output: 4;
    };
    readonly 'openai/gpt-5-nano': {
        readonly input: 0.1;
        readonly output: 0.4;
    };
    readonly 'meta-llama/llama-3.1-405b-instruct': {
        readonly input: 3;
        readonly output: 3;
    };
    readonly 'mistralai/mistral-medium-3.1': {
        readonly input: 2.7;
        readonly output: 8.1;
    };
    readonly 'mistralai/mistral-small-3.2-24b-instruct': {
        readonly input: 0.2;
        readonly output: 0.6;
    };
    readonly 'mistralai/codestral-2508': {
        readonly input: 0.3;
        readonly output: 0.9;
    };
    readonly 'google/gemini-2.5-pro': {
        readonly input: 1.25;
        readonly output: 5;
    };
    readonly 'google/gemini-2.5-flash': {
        readonly input: 0.075;
        readonly output: 0.3;
    };
    readonly 'google/gemini-2.5-flash-lite': {
        readonly input: 0.02;
        readonly output: 0.08;
    };
    readonly 'gemini-2.0-flash-exp': {
        readonly input: 0;
        readonly output: 0;
    };
    readonly 'gemini-1.5-flash': {
        readonly input: 0.075;
        readonly output: 0.3;
    };
    readonly 'gemini-1.5-flash-8b': {
        readonly input: 0.0375;
        readonly output: 0.15;
    };
    readonly 'gemini-1.5-pro': {
        readonly input: 1.25;
        readonly output: 5;
    };
    readonly 'gpt-4-turbo': {
        readonly input: 10;
        readonly output: 30;
    };
    readonly 'gpt-4': {
        readonly input: 30;
        readonly output: 60;
    };
    readonly 'gpt-3.5-turbo': {
        readonly input: 0.5;
        readonly output: 1.5;
    };
    readonly 'claude-3-5-sonnet-latest': {
        readonly input: 3;
        readonly output: 15;
    };
    readonly 'claude-3-5-haiku-latest': {
        readonly input: 0.8;
        readonly output: 4;
    };
    readonly 'claude-3-opus-latest': {
        readonly input: 15;
        readonly output: 75;
    };
    readonly 'llama3.2': {
        readonly input: 0;
        readonly output: 0;
    };
    readonly 'llama3.2-vision': {
        readonly input: 0;
        readonly output: 0;
    };
    readonly 'llama3.1': {
        readonly input: 0;
        readonly output: 0;
    };
    readonly 'qwen2.5-coder': {
        readonly input: 0;
        readonly output: 0;
    };
    readonly 'deepseek-r1': {
        readonly input: 0;
        readonly output: 0;
    };
    readonly gemma2: {
        readonly input: 0;
        readonly output: 0;
    };
    readonly mistral: {
        readonly input: 0;
        readonly output: 0;
    };
    readonly phi3: {
        readonly input: 0;
        readonly output: 0;
    };
    readonly default: {
        readonly input: 0;
        readonly output: 0;
    };
};
/**
 * Calculate cost based on tokens and model
 */
export declare function calculateCost(model: string, inputTokens?: number, outputTokens?: number): number;
/**
 * Estimate tokens from text (rough approximation)
 * Generally 1 token ≈ 4 characters for English text
 */
export declare function estimateTokens(text: string): number;
/**
 * Enhanced AI usage tracking with token counting and cost calculation
 */
export interface AIUsageData {
    userId: string;
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    prompt?: string;
    completion?: string;
    duration?: number;
    streamingDuration?: number;
    conversationId?: string;
    messageId?: string;
    pageId?: string;
    driveId?: string;
    success?: boolean;
    error?: string;
    metadata?: any;
}
/**
 * Track AI usage with automatic cost calculation
 */
export declare function trackAIUsage(data: AIUsageData): Promise<void>;
/**
 * Track AI tool usage
 */
export interface AIToolUsage {
    userId: string;
    provider: string;
    model: string;
    toolName: string;
    toolId?: string;
    args?: any;
    result?: any;
    duration?: number;
    success?: boolean;
    error?: string;
    conversationId?: string;
    pageId?: string;
}
export declare function trackAIToolUsage(data: AIToolUsage): Promise<void>;
/**
 * Get AI usage statistics for a user
 */
export declare function getUserAIStats(userId: string, startDate?: Date, endDate?: Date): Promise<{
    totalCost: number;
    totalTokens: number;
    requestCount: number;
    successRate: number;
    averageDuration: number;
    byProvider: Record<string, {
        cost: number;
        tokens: number;
        requests: number;
    }>;
    byModel: Record<string, {
        cost: number;
        tokens: number;
        requests: number;
    }>;
}>;
/**
 * Get popular AI features
 */
export declare function getPopularAIFeatures(limit?: number, startDate?: Date, endDate?: Date): Promise<Array<{
    feature: string;
    count: number;
    users: number;
}>>;
/**
 * Detect error patterns in AI usage
 */
export declare function detectAIErrorPatterns(limit?: number, startDate?: Date): Promise<Array<{
    pattern: string;
    count: number;
    providers: string[];
    models: string[];
    sample: string;
}>>;
/**
 * Calculate token efficiency metrics
 */
export declare function getTokenEfficiencyMetrics(userId?: string, startDate?: Date, endDate?: Date): Promise<{
    averageTokensPerRequest: number;
    averageInputTokens: number;
    averageOutputTokens: number;
    inputOutputRatio: number;
    costPerThousandTokens: number;
    mostEfficientModel: string | null;
    leastEfficientModel: string | null;
}>;
/**
 * Export all monitoring functions for easy access
 */
export declare const AIMonitoring: {
    trackUsage: typeof trackAIUsage;
    trackToolUsage: typeof trackAIToolUsage;
    getUserStats: typeof getUserAIStats;
    getPopularFeatures: typeof getPopularAIFeatures;
    detectErrorPatterns: typeof detectAIErrorPatterns;
    getEfficiencyMetrics: typeof getTokenEfficiencyMetrics;
    calculateCost: typeof calculateCost;
    estimateTokens: typeof estimateTokens;
    pricing: {
        readonly 'anthropic/claude-3.5-sonnet': {
            readonly input: 3;
            readonly output: 15;
        };
        readonly 'anthropic/claude-3-haiku': {
            readonly input: 0.25;
            readonly output: 1.25;
        };
        readonly 'anthropic/claude-opus-4.1': {
            readonly input: 15;
            readonly output: 75;
        };
        readonly 'openai/gpt-4o': {
            readonly input: 2.5;
            readonly output: 10;
        };
        readonly 'openai/gpt-4o-mini': {
            readonly input: 0.15;
            readonly output: 0.6;
        };
        readonly 'openai/gpt-5': {
            readonly input: 10;
            readonly output: 40;
        };
        readonly 'openai/gpt-5-mini': {
            readonly input: 1;
            readonly output: 4;
        };
        readonly 'openai/gpt-5-nano': {
            readonly input: 0.1;
            readonly output: 0.4;
        };
        readonly 'meta-llama/llama-3.1-405b-instruct': {
            readonly input: 3;
            readonly output: 3;
        };
        readonly 'mistralai/mistral-medium-3.1': {
            readonly input: 2.7;
            readonly output: 8.1;
        };
        readonly 'mistralai/mistral-small-3.2-24b-instruct': {
            readonly input: 0.2;
            readonly output: 0.6;
        };
        readonly 'mistralai/codestral-2508': {
            readonly input: 0.3;
            readonly output: 0.9;
        };
        readonly 'google/gemini-2.5-pro': {
            readonly input: 1.25;
            readonly output: 5;
        };
        readonly 'google/gemini-2.5-flash': {
            readonly input: 0.075;
            readonly output: 0.3;
        };
        readonly 'google/gemini-2.5-flash-lite': {
            readonly input: 0.02;
            readonly output: 0.08;
        };
        readonly 'gemini-2.0-flash-exp': {
            readonly input: 0;
            readonly output: 0;
        };
        readonly 'gemini-1.5-flash': {
            readonly input: 0.075;
            readonly output: 0.3;
        };
        readonly 'gemini-1.5-flash-8b': {
            readonly input: 0.0375;
            readonly output: 0.15;
        };
        readonly 'gemini-1.5-pro': {
            readonly input: 1.25;
            readonly output: 5;
        };
        readonly 'gpt-4-turbo': {
            readonly input: 10;
            readonly output: 30;
        };
        readonly 'gpt-4': {
            readonly input: 30;
            readonly output: 60;
        };
        readonly 'gpt-3.5-turbo': {
            readonly input: 0.5;
            readonly output: 1.5;
        };
        readonly 'claude-3-5-sonnet-latest': {
            readonly input: 3;
            readonly output: 15;
        };
        readonly 'claude-3-5-haiku-latest': {
            readonly input: 0.8;
            readonly output: 4;
        };
        readonly 'claude-3-opus-latest': {
            readonly input: 15;
            readonly output: 75;
        };
        readonly 'llama3.2': {
            readonly input: 0;
            readonly output: 0;
        };
        readonly 'llama3.2-vision': {
            readonly input: 0;
            readonly output: 0;
        };
        readonly 'llama3.1': {
            readonly input: 0;
            readonly output: 0;
        };
        readonly 'qwen2.5-coder': {
            readonly input: 0;
            readonly output: 0;
        };
        readonly 'deepseek-r1': {
            readonly input: 0;
            readonly output: 0;
        };
        readonly gemma2: {
            readonly input: 0;
            readonly output: 0;
        };
        readonly mistral: {
            readonly input: 0;
            readonly output: 0;
        };
        readonly phi3: {
            readonly input: 0;
            readonly output: 0;
        };
        readonly default: {
            readonly input: 0;
            readonly output: 0;
        };
    };
};
export default AIMonitoring;
//# sourceMappingURL=ai-monitoring.d.ts.map