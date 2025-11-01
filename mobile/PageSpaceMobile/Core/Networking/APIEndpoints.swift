import Foundation

enum APIEndpoints {
    // MARK: - Authentication
    static let login = "/api/auth/login"
    static let logout = "/api/auth/logout"
    static let me = "/api/auth/me"

    // MARK: - Conversations (Global AI)
    static let conversations = "/api/ai_conversations"
    static let globalConversation = "/api/ai_conversations/global"

    static func conversation(_ id: String) -> String {
        "/api/ai_conversations/\(id)"
    }

    static func conversationMessages(_ id: String) -> String {
        "/api/ai_conversations/\(id)/messages"
    }

    // MARK: - AI Settings
    static let aiSettings = "/api/ai/settings"

    // MARK: - Page AI (Future)
    static let pageAI = "/api/ai/chat"

    static func pageMessages(pageId: String) -> String {
        "/api/ai/chat/messages?pageId=\(pageId)"
    }

    static func pageAgentConfig(pageId: String) -> String {
        "/api/pages/\(pageId)/agent-config"
    }

    // MARK: - Pages & Drives (Future)
    static let drives = "/api/drives"

    static func drivePages(driveId: String) -> String {
        "/api/drives/\(driveId)/pages"
    }

    static func page(pageId: String) -> String {
        "/api/pages/\(pageId)"
    }
}
