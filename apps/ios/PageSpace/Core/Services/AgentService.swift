import Foundation
import Combine

@MainActor
class AgentService: ObservableObject {
    static let shared = AgentService()

    @Published var agents: [Agent] = []
    @Published var selectedAgent: Agent?
    @Published var isLoading = false
    @Published var error: String?

    private let conversationService = ConversationService.shared
    private let apiClient = APIClient.shared

    private init() {}

    // MARK: - Load All Agents (Global + Page AI)

    func loadAllAgents() async {
        isLoading = true
        error = nil

        var allAgents: [Agent] = []
        var globalAgent: Agent?
        var errorMessages: [String] = []

        // 1. Create Global Assistant agent (no conversation ID needed)
        globalAgent = Agent(
            id: "global_default",
            type: .global,
            title: "Global Assistant",
            subtitle: "Your personal AI assistant",
            icon: "brain.head.profile"
        )
        allAgents.append(globalAgent!)
        print("✅ Global Assistant agent created")

        // 2. Load all drives and their AI chat pages
        do {
            let drives: [Drive] = try await apiClient.request(
                endpoint: APIEndpoints.drives,
                method: .GET
            )
            print("✅ Loaded \(drives.count) drives")

            // For each drive, load pages and filter AI_CHAT pages
            for drive in drives {
                do {
                    // Backend returns tree array directly (not wrapped)
                    let pageTree: [Page] = try await apiClient.request(
                        endpoint: APIEndpoints.drivePages(driveId: drive.id),
                        method: .GET
                    )

                    // Flatten tree structure to get all pages
                    let allPages = flattenPageTree(pageTree)
                    print("✅ Drive '\(drive.name)': Loaded \(allPages.count) pages")

                    // Filter to AI_CHAT pages only
                    let aiChatPages = allPages.filter { $0.type == .aiChat }
                    print("  └─ Found \(aiChatPages.count) AI chat pages")

                    // Create agents from AI chat pages
                    for page in aiChatPages {
                        let agent = Agent.fromPage(page, drive: drive)
                        allAgents.append(agent)
                    }
                } catch {
                    // Log error but continue with other drives
                    let errorMsg = "Failed to load pages for drive '\(drive.name)': \(error.localizedDescription)"
                    errorMessages.append(errorMsg)
                    print("❌ \(errorMsg)")
                }
            }
        } catch {
            // If we can't load drives, that's a critical error
            errorMessages.append("Failed to load drives: \(error.localizedDescription)")
            print("❌ Drives error: \(error)")
        }

        // Update published property with whatever we managed to load
        agents = allAgents
        print("📊 Total agents loaded: \(allAgents.count)")

        // Set default selected agent to global if none selected
        if selectedAgent == nil, let defaultAgent = globalAgent {
            selectedAgent = defaultAgent
        }

        // Set error message if any errors occurred (but don't fail completely)
        if !errorMessages.isEmpty {
            self.error = errorMessages.joined(separator: "\n")
        }

        isLoading = false
    }

    // MARK: - Select Agent

    func selectAgent(_ agent: Agent) {
        print("🎯 AgentService.selectAgent - agent: \(agent.title), type: \(agent.type)")
        self.selectedAgent = agent

        // Update ConversationManager's selected agent info for new conversations
        let conversationManager = ConversationManager.shared

        if agent.type == .global {
            conversationManager.selectedAgentType = "global"
            conversationManager.selectedAgentContextId = nil
        } else if agent.type == .pageAI {
            conversationManager.selectedAgentType = "page"
            conversationManager.selectedAgentContextId = agent.pageId
        }

        // Create fresh conversation
        conversationManager.createNewConversation()
    }

    // MARK: - Update Global Agent Conversation ID
    // NOTE: This method is no longer needed with ConversationManager architecture
    // Kept for backwards compatibility but can be removed in future cleanup

    // MARK: - Get Drives

    func getDrives() async throws -> [Drive] {
        let drives: [Drive] = try await apiClient.request(
            endpoint: APIEndpoints.drives,
            method: .GET
        )
        return drives
    }

    // MARK: - Get Pages for Drive

    func getPages(driveId: String) async throws -> [Page] {
        // Backend returns tree array directly
        let pageTree: [Page] = try await apiClient.request(
            endpoint: APIEndpoints.drivePages(driveId: driveId),
            method: .GET
        )
        // Return flattened list
        return flattenPageTree(pageTree)
    }

    // MARK: - Get AI Chat Pages Only

    func getAIChatPages(driveId: String) async throws -> [Page] {
        let pages = try await getPages(driveId: driveId)
        return pages.filter { $0.type == .aiChat }
    }

    // MARK: - Tree Flattening Helper

    private func flattenPageTree(_ pages: [Page]) -> [Page] {
        var result: [Page] = []

        for page in pages {
            // Add the current page
            result.append(page)

            // Recursively add all children
            if let children = page.children {
                result.append(contentsOf: flattenPageTree(children))
            }
        }

        return result
    }
}
