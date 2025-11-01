import Foundation

// MARK: - Page Models

struct Page: Identifiable, Codable {
    let id: String
    let driveId: String
    let title: String
    let type: PageType
    let parentId: String?
    let position: Int
    let createdAt: Date
    let updatedAt: Date

    // AI Chat config (if type == AI_CHAT) - flattened from backend
    var aiProvider: String?
    var aiModel: String?
    var systemPrompt: String?
    var enabledTools: [String]?

    // Tree structure support
    var children: [Page]?

    // Computed property for path generation
    var path: String {
        // Fallback path based on title if needed
        return "/\(title.lowercased().replacingOccurrences(of: " ", with: "-"))"
    }
}

enum PageType: String, Codable {
    case folder = "FOLDER"
    case document = "DOCUMENT"
    case channel = "CHANNEL"
    case aiChat = "AI_CHAT"
    case canvas = "CANVAS"
    case file = "FILE"
    case sheet = "SHEET"
}

// MARK: - Page AI Configuration
// NOTE: AI config is now flattened directly into Page struct (see lines 15-19)

// MARK: - Drive Models

struct Drive: Identifiable, Codable {
    let id: String
    let name: String
    let slug: String
    let description: String?
    let ownerId: String
    let createdAt: Date
    let updatedAt: Date
    let isActive: Bool?  // Optional - backend may not return this

    // Additional fields from backend
    let isOwned: Bool?  // Whether current user owns this drive
    let role: String?   // User's role in this drive (OWNER, ADMIN, MEMBER, VIEWER)
}

// NOTE: DriveListResponse removed - API returns [Drive] array directly
// NOTE: PageListResponse removed - API returns [Page] tree array directly

// MARK: - Agent Model (Unified representation)

struct Agent: Identifiable, Codable, Hashable {
    let id: String
    let type: AgentType
    let title: String
    let subtitle: String?
    let icon: String // SF Symbol name
    let driveId: String?
    let driveName: String?

    // For Page AI agents
    let pageId: String?
    let pagePath: String?

    // Flattened AI config from page
    let aiProvider: String?
    let aiModel: String?
    let systemPrompt: String?
    let enabledTools: [String]?

    // For Global AI
    let conversationId: String?

    init(id: String, type: AgentType, title: String, subtitle: String? = nil, icon: String = "brain", driveId: String? = nil, driveName: String? = nil, pageId: String? = nil, pagePath: String? = nil, aiProvider: String? = nil, aiModel: String? = nil, systemPrompt: String? = nil, enabledTools: [String]? = nil, conversationId: String? = nil) {
        self.id = id
        self.type = type
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.driveId = driveId
        self.driveName = driveName
        self.pageId = pageId
        self.pagePath = pagePath
        self.aiProvider = aiProvider
        self.aiModel = aiModel
        self.systemPrompt = systemPrompt
        self.enabledTools = enabledTools
        self.conversationId = conversationId
    }

    // Create from Global AI conversation
    static func fromGlobalConversation(_ conversation: Conversation) -> Agent {
        Agent(
            id: "global_\(conversation.id)",
            type: .global,
            title: conversation.title ?? "Global Assistant",
            subtitle: "Your personal AI assistant",
            icon: "brain.head.profile",
            conversationId: conversation.id
        )
    }

    // Create from Page AI
    static func fromPage(_ page: Page, drive: Drive) -> Agent {
        Agent(
            id: "page_\(page.id)",
            type: .pageAI,
            title: page.title,
            subtitle: "\(drive.name) • \(page.path)",
            icon: "bubble.left.and.text.bubble.right",
            driveId: drive.id,
            driveName: drive.name,
            pageId: page.id,
            pagePath: page.path,
            aiProvider: page.aiProvider,
            aiModel: page.aiModel,
            systemPrompt: page.systemPrompt,
            enabledTools: page.enabledTools
        )
    }
}

enum AgentType: String, Codable {
    case global = "GLOBAL"
    case pageAI = "PAGE_AI"
}

// MARK: - Page AI Message Request

struct PageAIMessageRequest: Codable {
    let messages: [Message]
    let chatId: String // pageId
    let conversationId: String?
    let selectedProvider: String?
    let selectedModel: String?
    let pageContext: PageContext?

    struct PageContext: Codable {
        let pageId: String
        let pageTitle: String
        let pageType: String
        let pagePath: String
        let parentPath: String?
        let breadcrumbs: [String]
        let driveId: String
        let driveName: String
        let driveSlug: String
    }
}

// MARK: - Page AI Messages Response

struct PageAIMessagesResponse: Codable {
    let messages: [Message]
}
