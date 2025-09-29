"use strict";
/**
 * AI Usage Monitoring Module
 * Comprehensive tracking for AI provider usage, tokens, costs, and performance
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIMonitoring = exports.AI_PRICING = void 0;
exports.calculateCost = calculateCost;
exports.estimateTokens = estimateTokens;
exports.trackAIUsage = trackAIUsage;
exports.trackAIToolUsage = trackAIToolUsage;
exports.getUserAIStats = getUserAIStats;
exports.getPopularAIFeatures = getPopularAIFeatures;
exports.detectAIErrorPatterns = detectAIErrorPatterns;
exports.getTokenEfficiencyMetrics = getTokenEfficiencyMetrics;
const db_1 = require("@pagespace/db");
const logger_database_1 = require("./logger-database");
const logger_config_1 = require("./logger-config");
/**
 * AI Provider Pricing (per 1M tokens)
 * Prices in USD as of 2025-01
 */
exports.AI_PRICING = {
    // OpenRouter Paid Models
    'anthropic/claude-3.5-sonnet': { input: 3.00, output: 15.00 },
    'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
    'anthropic/claude-opus-4.1': { input: 15.00, output: 75.00 },
    'openai/gpt-4o': { input: 2.50, output: 10.00 },
    'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
    'openai/gpt-5': { input: 10.00, output: 40.00 }, // Estimated
    'openai/gpt-5-mini': { input: 1.00, output: 4.00 }, // Estimated
    'openai/gpt-5-nano': { input: 0.10, output: 0.40 }, // Estimated
    'meta-llama/llama-3.1-405b-instruct': { input: 3.00, output: 3.00 },
    'mistralai/mistral-medium-3.1': { input: 2.70, output: 8.10 },
    'mistralai/mistral-small-3.2-24b-instruct': { input: 0.20, output: 0.60 },
    'mistralai/codestral-2508': { input: 0.30, output: 0.90 },
    'google/gemini-2.5-pro': { input: 1.25, output: 5.00 },
    'google/gemini-2.5-flash': { input: 0.075, output: 0.30 },
    'google/gemini-2.5-flash-lite': { input: 0.02, output: 0.08 },
    // Google AI Direct Models
    'gemini-2.0-flash-exp': { input: 0.00, output: 0.00 }, // Free during preview
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
    // OpenAI Direct Models  
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-4': { input: 30.00, output: 60.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    // Anthropic Direct Models
    'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00 },
    'claude-3-5-haiku-latest': { input: 0.80, output: 4.00 },
    'claude-3-opus-latest': { input: 15.00, output: 75.00 },
    // Ollama (local) - no cost
    'llama3.2': { input: 0, output: 0 },
    'llama3.2-vision': { input: 0, output: 0 },
    'llama3.1': { input: 0, output: 0 },
    'qwen2.5-coder': { input: 0, output: 0 },
    'deepseek-r1': { input: 0, output: 0 },
    'gemma2': { input: 0, output: 0 },
    'mistral': { input: 0, output: 0 },
    'phi3': { input: 0, output: 0 },
    // Default/Unknown models
    'default': { input: 0, output: 0 }
};
/**
 * Calculate cost based on tokens and model
 */
function calculateCost(model, inputTokens = 0, outputTokens = 0) {
    const pricing = exports.AI_PRICING[model] || exports.AI_PRICING.default;
    // Convert from per-million to actual cost
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    return Number((inputCost + outputCost).toFixed(6));
}
/**
 * Estimate tokens from text (rough approximation)
 * Generally 1 token ≈ 4 characters for English text
 */
function estimateTokens(text) {
    if (!text)
        return 0;
    return Math.ceil(text.length / 4);
}
/**
 * Track AI usage with automatic cost calculation
 */
async function trackAIUsage(data) {
    try {
        // Calculate tokens if not provided
        let { inputTokens, outputTokens, totalTokens } = data;
        // If we have prompt/completion but no tokens, estimate them
        if (!inputTokens && data.prompt) {
            inputTokens = estimateTokens(data.prompt);
        }
        if (!outputTokens && data.completion) {
            outputTokens = estimateTokens(data.completion);
        }
        // Calculate total if not provided
        if (!totalTokens && (inputTokens || outputTokens)) {
            totalTokens = (inputTokens || 0) + (outputTokens || 0);
        }
        // Calculate cost
        const cost = calculateCost(data.model, inputTokens, outputTokens);
        // Fire and forget - don't await
        (0, logger_database_1.writeAiUsage)({
            userId: data.userId,
            provider: data.provider,
            model: data.model,
            inputTokens,
            outputTokens,
            totalTokens,
            cost,
            duration: data.duration,
            conversationId: data.conversationId,
            messageId: data.messageId,
            pageId: data.pageId,
            driveId: data.driveId,
            success: data.success !== false,
            error: data.error,
            metadata: {
                ...data.metadata,
                streamingDuration: data.streamingDuration,
                prompt: data.prompt?.substring(0, 1000),
                completion: data.completion?.substring(0, 1000)
            },
        }).catch((error) => {
            logger_config_1.loggers.ai.debug('AI usage tracking failed', {
                error: error.message,
                model: data.model,
                provider: data.provider
            });
        });
    }
    catch (error) {
        logger_config_1.loggers.ai.debug('AI usage calculation failed', {
            error: error.message
        });
    }
}
async function trackAIToolUsage(data) {
    trackAIUsage({
        userId: data.userId,
        provider: data.provider,
        model: data.model,
        duration: data.duration,
        conversationId: data.conversationId,
        pageId: data.pageId,
        success: data.success,
        error: data.error,
        metadata: {
            type: 'tool_call',
            toolName: data.toolName,
            toolId: data.toolId,
            args: data.args,
            result: data.result
        }
    });
}
/**
 * Get AI usage statistics for a user
 */
async function getUserAIStats(userId, startDate, endDate) {
    try {
        const conditions = [(0, db_1.eq)(db_1.aiUsageLogs.userId, userId)];
        if (startDate) {
            conditions.push((0, db_1.gte)(db_1.aiUsageLogs.timestamp, startDate));
        }
        if (endDate) {
            conditions.push((0, db_1.lte)(db_1.aiUsageLogs.timestamp, endDate));
        }
        const usage = await db_1.db
            .select({
            provider: db_1.aiUsageLogs.provider,
            model: db_1.aiUsageLogs.model,
            cost: db_1.aiUsageLogs.cost,
            totalTokens: db_1.aiUsageLogs.totalTokens,
            duration: db_1.aiUsageLogs.duration,
            success: db_1.aiUsageLogs.success,
        })
            .from(db_1.aiUsageLogs)
            .where((0, db_1.and)(...conditions));
        // Calculate statistics
        let totalCost = 0;
        let totalTokens = 0;
        let totalDuration = 0;
        let successCount = 0;
        const byProvider = {};
        const byModel = {};
        for (const record of usage) {
            const cost = record.cost || 0;
            const tokens = record.totalTokens || 0;
            totalCost += cost;
            totalTokens += tokens;
            if (record.duration) {
                totalDuration += record.duration;
            }
            if (record.success) {
                successCount++;
            }
            // Aggregate by provider
            if (!byProvider[record.provider]) {
                byProvider[record.provider] = { cost: 0, tokens: 0, requests: 0 };
            }
            byProvider[record.provider].cost += cost;
            byProvider[record.provider].tokens += tokens;
            byProvider[record.provider].requests++;
            // Aggregate by model
            if (!byModel[record.model]) {
                byModel[record.model] = { cost: 0, tokens: 0, requests: 0 };
            }
            byModel[record.model].cost += cost;
            byModel[record.model].tokens += tokens;
            byModel[record.model].requests++;
        }
        return {
            totalCost: Number(totalCost.toFixed(6)),
            totalTokens,
            requestCount: usage.length,
            successRate: usage.length > 0 ? (successCount / usage.length) * 100 : 0,
            averageDuration: usage.length > 0 ? Math.round(totalDuration / usage.length) : 0,
            byProvider,
            byModel,
        };
    }
    catch (error) {
        logger_config_1.loggers.ai.error('Failed to get AI usage stats', error);
        return {
            totalCost: 0,
            totalTokens: 0,
            requestCount: 0,
            successRate: 0,
            averageDuration: 0,
            byProvider: {},
            byModel: {},
        };
    }
}
/**
 * Get popular AI features
 */
async function getPopularAIFeatures(limit = 10, startDate, endDate) {
    try {
        const conditions = [];
        if (startDate) {
            conditions.push((0, db_1.gte)(db_1.aiUsageLogs.timestamp, startDate));
        }
        if (endDate) {
            conditions.push((0, db_1.lte)(db_1.aiUsageLogs.timestamp, endDate));
        }
        // Query to get feature usage from metadata
        const query = conditions.length > 0
            ? db_1.db.select({
                metadata: db_1.aiUsageLogs.metadata,
                userId: db_1.aiUsageLogs.userId,
            })
                .from(db_1.aiUsageLogs)
                .where((0, db_1.and)(...conditions))
            : db_1.db.select({
                metadata: db_1.aiUsageLogs.metadata,
                userId: db_1.aiUsageLogs.userId,
            })
                .from(db_1.aiUsageLogs);
        const usage = await query;
        // Extract and count features
        const featureMap = new Map();
        for (const record of usage) {
            if (record.metadata && typeof record.metadata === 'object') {
                const metadata = record.metadata;
                const feature = metadata.type || metadata.feature || 'general_chat';
                if (!featureMap.has(feature)) {
                    featureMap.set(feature, new Set());
                }
                featureMap.get(feature).add(record.userId);
            }
        }
        // Convert to array and sort
        const features = Array.from(featureMap.entries())
            .map(([feature, users]) => ({
            feature,
            count: users.size,
            users: users.size,
        }))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
        return features;
    }
    catch (error) {
        logger_config_1.loggers.ai.error('Failed to get popular AI features', error);
        return [];
    }
}
/**
 * Detect error patterns in AI usage
 */
async function detectAIErrorPatterns(limit = 10, startDate) {
    try {
        const conditions = [
            (0, db_1.eq)(db_1.aiUsageLogs.success, false)
        ];
        if (startDate) {
            conditions.push((0, db_1.gte)(db_1.aiUsageLogs.timestamp, startDate));
        }
        const errors = await db_1.db
            .select({
            error: db_1.aiUsageLogs.error,
            provider: db_1.aiUsageLogs.provider,
            model: db_1.aiUsageLogs.model,
        })
            .from(db_1.aiUsageLogs)
            .where((0, db_1.and)(...conditions))
            .limit(1000); // Analyze recent 1000 errors
        // Group errors by pattern
        const errorPatterns = new Map();
        for (const record of errors) {
            if (!record.error)
                continue;
            // Extract error pattern (simplified - could be enhanced)
            let pattern = 'unknown_error';
            const error = record.error.toLowerCase();
            if (error.includes('rate limit')) {
                pattern = 'rate_limit_exceeded';
            }
            else if (error.includes('timeout')) {
                pattern = 'request_timeout';
            }
            else if (error.includes('token') && error.includes('limit')) {
                pattern = 'token_limit_exceeded';
            }
            else if (error.includes('invalid') && error.includes('key')) {
                pattern = 'invalid_api_key';
            }
            else if (error.includes('network')) {
                pattern = 'network_error';
            }
            else if (error.includes('model not found')) {
                pattern = 'model_not_found';
            }
            else if (error.includes('context')) {
                pattern = 'context_length_exceeded';
            }
            if (!errorPatterns.has(pattern)) {
                errorPatterns.set(pattern, {
                    count: 0,
                    providers: new Set(),
                    models: new Set(),
                    sample: record.error,
                });
            }
            const patternData = errorPatterns.get(pattern);
            patternData.count++;
            patternData.providers.add(record.provider);
            patternData.models.add(record.model);
        }
        // Convert to array and sort
        return Array.from(errorPatterns.entries())
            .map(([pattern, data]) => ({
            pattern,
            count: data.count,
            providers: Array.from(data.providers),
            models: Array.from(data.models),
            sample: data.sample.substring(0, 200),
        }))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }
    catch (error) {
        logger_config_1.loggers.ai.error('Failed to detect AI error patterns', error);
        return [];
    }
}
/**
 * Calculate token efficiency metrics
 */
async function getTokenEfficiencyMetrics(userId, startDate, endDate) {
    try {
        const conditions = [];
        if (userId) {
            conditions.push((0, db_1.eq)(db_1.aiUsageLogs.userId, userId));
        }
        if (startDate) {
            conditions.push((0, db_1.gte)(db_1.aiUsageLogs.timestamp, startDate));
        }
        if (endDate) {
            conditions.push((0, db_1.lte)(db_1.aiUsageLogs.timestamp, endDate));
        }
        const usage = await db_1.db
            .select({
            model: db_1.aiUsageLogs.model,
            inputTokens: db_1.aiUsageLogs.inputTokens,
            outputTokens: db_1.aiUsageLogs.outputTokens,
            totalTokens: db_1.aiUsageLogs.totalTokens,
            cost: db_1.aiUsageLogs.cost,
        })
            .from(db_1.aiUsageLogs)
            .where(conditions.length > 0 ? (0, db_1.and)(...conditions) : undefined);
        if (usage.length === 0) {
            return {
                averageTokensPerRequest: 0,
                averageInputTokens: 0,
                averageOutputTokens: 0,
                inputOutputRatio: 0,
                costPerThousandTokens: 0,
                mostEfficientModel: null,
                leastEfficientModel: null,
            };
        }
        // Calculate metrics
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalTokens = 0;
        let totalCost = 0;
        const modelEfficiency = new Map();
        for (const record of usage) {
            totalInputTokens += record.inputTokens || 0;
            totalOutputTokens += record.outputTokens || 0;
            totalTokens += record.totalTokens || 0;
            totalCost += record.cost || 0;
            // Track per-model efficiency
            if (!modelEfficiency.has(record.model)) {
                modelEfficiency.set(record.model, { tokens: 0, cost: 0, count: 0 });
            }
            const modelData = modelEfficiency.get(record.model);
            modelData.tokens += record.totalTokens || 0;
            modelData.cost += record.cost || 0;
            modelData.count++;
        }
        // Find most/least efficient models
        let mostEfficient = null;
        let leastEfficient = null;
        for (const [model, data] of modelEfficiency.entries()) {
            if (data.tokens > 0) {
                const costPerToken = data.cost / data.tokens;
                if (!mostEfficient || costPerToken < mostEfficient.costPerToken) {
                    mostEfficient = { model, costPerToken };
                }
                if (!leastEfficient || costPerToken > leastEfficient.costPerToken) {
                    leastEfficient = { model, costPerToken };
                }
            }
        }
        return {
            averageTokensPerRequest: Math.round(totalTokens / usage.length),
            averageInputTokens: Math.round(totalInputTokens / usage.length),
            averageOutputTokens: Math.round(totalOutputTokens / usage.length),
            inputOutputRatio: totalInputTokens > 0 ? Number((totalOutputTokens / totalInputTokens).toFixed(2)) : 0,
            costPerThousandTokens: totalTokens > 0 ? Number((totalCost / totalTokens * 1000).toFixed(4)) : 0,
            mostEfficientModel: mostEfficient?.model || null,
            leastEfficientModel: leastEfficient?.model || null,
        };
    }
    catch (error) {
        logger_config_1.loggers.ai.error('Failed to calculate token efficiency metrics', error);
        return {
            averageTokensPerRequest: 0,
            averageInputTokens: 0,
            averageOutputTokens: 0,
            inputOutputRatio: 0,
            costPerThousandTokens: 0,
            mostEfficientModel: null,
            leastEfficientModel: null,
        };
    }
}
/**
 * Export all monitoring functions for easy access
 */
exports.AIMonitoring = {
    trackUsage: trackAIUsage,
    trackToolUsage: trackAIToolUsage,
    getUserStats: getUserAIStats,
    getPopularFeatures: getPopularAIFeatures,
    detectErrorPatterns: detectAIErrorPatterns,
    getEfficiencyMetrics: getTokenEfficiencyMetrics,
    calculateCost,
    estimateTokens,
    pricing: exports.AI_PRICING,
};
exports.default = exports.AIMonitoring;
