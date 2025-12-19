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

        // 1. Create Global Assistant agent (always available)
        let globalAgent = Agent(
            id: "global_default",
            type: .global,
            title: "Global Assistant",
            subtitle: "Your personal AI assistant",
            icon: "brain.head.profile"
        )
        allAgents.append(globalAgent)
        print("✅ Global Assistant agent created")

        // 2. Load all page agents via dedicated multi-drive endpoint
        do {
            let response: MultiDriveAgentsResponse = try await apiClient.request(
                endpoint: APIEndpoints.multiDriveAgents,
                method: .GET
            )
            print("✅ Loaded agents from \(response.driveCount) drives")

            // Convert AgentSummary to Agent models
            if let agentGroups = response.agentsByDrive {
                for group in agentGroups {
                    print("  └─ Drive '\(group.driveName)': \(group.agentCount) agents")
                    for agentSummary in group.agents {
                        allAgents.append(agentSummary.toAgent())
                    }
                }
            } else if let flatAgents = response.agents {
                // Flat list response (groupByDrive=false)
                for agentSummary in flatAgents {
                    allAgents.append(agentSummary.toAgent())
                }
            }

            print("📊 Total page agents loaded: \(response.totalCount)")
        } catch {
            // Log error but don't fail completely - we still have global agent
            let errorMsg = "Failed to load page agents: \(error.localizedDescription)"
            self.error = errorMsg
            print("❌ \(errorMsg)")
        }

        // Update published property
        agents = allAgents
        print("📊 Total agents available: \(allAgents.count)")

        // Set default selected agent to global if none selected
        if selectedAgent == nil {
            selectedAgent = globalAgent
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
