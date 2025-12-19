import Foundation

// MARK: - Page Models

struct Page: Identifiable, Codable, Hashable {
    let id: String
    let driveId: String
    let title: String
    let type: PageType
    let parentId: String?
    let position: Double  // Changed from Int to support fractional positions from drag-and-drop reordering
    let createdAt: Date
    let updatedAt: Date

    // AI Chat config (if type == AI_CHAT) - flattened from backend
    var aiProvider: String?
    var aiModel: String?
    var systemPrompt: String?
    var enabledTools: [String]?

    // Content field (for DOCUMENT and CANVAS types)
    var content: String?

    // File-specific fields (if type == FILE)
    var fileSize: Int?
    var mimeType: String?
    var originalFileName: String?
    var filePath: String?
    var processingStatus: String?

    // Tree structure support
    var children: [Page]?

    // Computed property for path generation
    var path: String {
        // Fallback path based on title if needed
        return "/\(title.lowercased().replacingOccurrences(of: " ", with: "-"))"
    }

    // MARK: - Custom Hashable Implementation
    // Only hash by ID to avoid performance issues with recursive children hashing
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: Page, rhs: Page) -> Bool {
        lhs.id == rhs.id
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

    /// Human-readable description for accessibility
    var accessibilityDescription: String {
        switch self {
        case .folder:
            return "Folder"
        case .document:
            return "Document"
        case .channel:
            return "Channel"
        case .aiChat:
            return "AI Chat"
        case .canvas:
            return "Canvas"
        case .file:
            return "File"
        case .sheet:
            return "Sheet"
        }
    }
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

    // Additional fields from backend
    let isOwned: Bool?  // Whether current user owns this drive
    let role: String?   // User's role in this drive (OWNER, ADMIN, MEMBER, VIEWER)
}

// NOTE: DriveListResponse removed - API returns [Drive] array directly
// NOTE: PageListResponse removed - API returns [Page] tree array directly

// MARK: - Agent Model
/// Represents an agent TYPE that the user can select to start a chat
/// NOT used for displaying loaded conversations - use Conversation model instead
/// Agent info for loaded conversations comes from Conversation.type/contextId

struct Agent: Identifiable, Codable, Hashable {
    let id: String
    let type: AgentType
    let title: String          // Display name: "Global Assistant" or page name
    let subtitle: String?      // Description
    let icon: String           // SF Symbol name
    let driveId: String?
    let driveName: String?

    // For Page AI agents
    let pageId: String?        // For .pageAI type
    let pagePath: String?

    // Flattened AI config from page
    let aiProvider: String?
    let aiModel: String?
    let systemPrompt: String?
    let enabledTools: [String]?

    init(id: String, type: AgentType, title: String, subtitle: String? = nil, icon: String = "brain", driveId: String? = nil, driveName: String? = nil, pageId: String? = nil, pagePath: String? = nil, aiProvider: String? = nil, aiModel: String? = nil, systemPrompt: String? = nil, enabledTools: [String]? = nil) {
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

// MARK: - Multi-Drive Agents API Response

struct MultiDriveAgentsResponse: Codable {
    let success: Bool
    let totalCount: Int
    let driveCount: Int
    let summary: String?
    let agentsByDrive: [DriveAgentGroup]?
    let agents: [AgentSummary]? // When groupByDrive=false
}

struct DriveAgentGroup: Codable {
    let driveId: String
    let driveName: String
    let driveSlug: String
    let agentCount: Int
    let agents: [AgentSummary]
}

struct AgentSummary: Codable {
    let id: String
    let title: String?
    let parentId: String?
    let position: Int?
    let aiProvider: String?
    let aiModel: String?
    let hasWelcomeMessage: Bool?
    let createdAt: Date?
    let updatedAt: Date?
    let driveId: String?
    let driveName: String?
    let driveSlug: String?
    let hasSystemPrompt: Bool?
    let systemPromptPreview: String?
    let enabledToolsCount: Int?

    /// Convert to Agent model for UI display
    func toAgent() -> Agent {
        Agent(
            id: "page_\(id)",
            type: .pageAI,
            title: title ?? "Untitled Agent",
            subtitle: driveName.map { "\($0)" },
            icon: "bubble.left.and.text.bubble.right",
            driveId: driveId,
            driveName: driveName,
            pageId: id,
            pagePath: nil,
            aiProvider: aiProvider,
            aiModel: aiModel,
            systemPrompt: nil, // Not included in summary
            enabledTools: nil  // Not included in summary
        )
    }
}
