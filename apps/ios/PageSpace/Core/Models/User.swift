import Foundation

struct User: Identifiable, Codable {
    let id: String
    let email: String
    let name: String?
    let image: String?
}

struct LoginRequest: Codable {
    let email: String
    let password: String
    let deviceId: String
    let platform: String
    let deviceName: String?
    let appVersion: String?
    let deviceToken: String?
}

struct SignupRequest: Codable {
    let name: String
    let email: String
    let password: String
    let confirmPassword: String
    let deviceId: String
    let platform: String
    let deviceName: String?
    let appVersion: String?
}

struct LoginResponse: Codable {
    let user: User
    let token: String
    let refreshToken: String
    let csrfToken: String
    let deviceToken: String?
}

struct RefreshRequest: Codable {
    let refreshToken: String
    let deviceToken: String?
    let deviceId: String
    let platform: String
}

struct RefreshResponse: Codable {
    let token: String
    let refreshToken: String
    let csrfToken: String
    let deviceToken: String?
}

struct OAuthExchangeRequest: Codable {
    let idToken: String
    let deviceId: String
    let platform: String
    let deviceName: String?
    let appVersion: String?
    let deviceToken: String?
}

struct DeviceRefreshRequest: Codable {
    let deviceToken: String
    let deviceId: String
    let userAgent: String?
    let appVersion: String?
}

struct AISettings: Codable {
    let currentProvider: String
    let currentModel: String
    let userSubscriptionTier: String?
    let providers: ProviderStatuses
    let isAnyProviderConfigured: Bool

    // Legacy support for old API responses
    var provider: String { currentProvider }
    var model: String { currentModel }

    enum CodingKeys: String, CodingKey {
        case currentProvider, currentModel, userSubscriptionTier, providers, isAnyProviderConfigured
    }
}

struct ProviderStatuses: Codable {
    let pagespace: ProviderStatus?
    let openrouter: ProviderStatus?
    let google: ProviderStatus?
    let openai: ProviderStatus?
    let anthropic: ProviderStatus?
    let xai: ProviderStatus?
    let ollama: ProviderStatus?
    let lmstudio: ProviderStatus?
    let glm: ProviderStatus?

    enum CodingKeys: String, CodingKey {
        case pagespace, openrouter, google, openai, anthropic, xai, ollama, lmstudio, glm
    }
}

struct ProviderStatus: Codable {
    let isConfigured: Bool
    let hasApiKey: Bool?
    let hasBaseUrl: Bool?

    enum CodingKeys: String, CodingKey {
        case isConfigured, hasApiKey, hasBaseUrl
    }
}

struct AgentConfig: Codable {
    let aiProvider: String?
    let aiModel: String?
    let systemPrompt: String?
    let allowedTools: [String]?

    enum CodingKeys: String, CodingKey {
        case aiProvider, aiModel, systemPrompt, allowedTools
    }
}

// MARK: - AISettings Extensions

extension AISettings {
    /// Check if a provider is configured and available for use
    /// - Parameter provider: The provider ID (e.g., "pagespace", "openrouter", "google")
    /// - Returns: True if the provider is configured with necessary credentials
    func isProviderConfigured(_ provider: String) -> Bool {
        switch provider {
        case "pagespace":
            return providers.pagespace?.isConfigured ?? false
        case "openrouter", "openrouter_free":
            return providers.openrouter?.isConfigured ?? false
        case "google":
            return providers.google?.isConfigured ?? false
        case "openai":
            return providers.openai?.isConfigured ?? false
        case "anthropic":
            return providers.anthropic?.isConfigured ?? false
        case "xai":
            return providers.xai?.isConfigured ?? false
        case "ollama":
            return providers.ollama?.isConfigured ?? false
        case "lmstudio":
            return providers.lmstudio?.isConfigured ?? false
        case "glm":
            return providers.glm?.isConfigured ?? false
        default:
            return false
        }
    }
}
