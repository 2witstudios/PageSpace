import Foundation

enum APIEndpoints {
    // MARK: - Authentication
    static let login = "/api/auth/mobile/login"
    static let signup = "/api/auth/mobile/signup"
    static let refresh = "/api/auth/mobile/refresh"
    static let deviceRefresh = "/api/auth/device/refresh"
    static let logout = "/api/auth/logout"
    static let me = "/api/auth/me"

    // MARK: - OAuth
    static let oauthGoogleExchange = "/api/auth/mobile/oauth/google/exchange"

    // MARK: - Conversations (Global AI)
    static let conversations = "/api/ai_conversations"
    static let globalConversation = "/api/ai_conversations/global"

    static func conversation(_ id: String) -> String {
        "/api/ai_conversations/\(id)"
    }

    static func conversationMessages(_ id: String) -> String {
        "/api/ai_conversations/\(id)/messages"
    }

    static func conversationMessage(_ conversationId: String, messageId: String) -> String {
        "/api/ai_conversations/\(conversationId)/messages/\(messageId)"
    }

    static func conversationUsage(_ conversationId: String) -> String {
        "/api/ai_conversations/\(conversationId)/usage"
    }

    // MARK: - AI Settings
    static let aiSettings = "/api/ai/settings"

    // MARK: - Subscriptions & Usage
    static let subscriptionUsage = "/api/subscriptions/usage"

    // MARK: - Page AI (CHAT_AI)
    static let pageAI = "/api/ai/chat"

    static func pageMessages(pageId: String) -> String {
        "/api/ai/chat/messages?pageId=\(pageId)"
    }

    static func pageAgentConfig(pageId: String) -> String {
        "/api/pages/\(pageId)/agent-config"
    }

    // MARK: - Pages & Drives
    static let drives = "/api/drives"

    static func drivePages(driveId: String) -> String {
        "/api/drives/\(driveId)/pages"
    }

    static func page(pageId: String) -> String {
        "/api/pages/\(pageId)"
    }

    // MARK: - Search
    static let search = "/api/search"
}
