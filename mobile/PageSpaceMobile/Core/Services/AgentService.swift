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

        do {
            var allAgents: [Agent] = []

            // 1. Load Global AI conversation
            let globalConversation = try await conversationService.getGlobalConversation()
            let globalAgent = Agent.fromGlobalConversation(globalConversation)
            allAgents.append(globalAgent)

            // 2. Load all drives
            let drivesResponse: DriveListResponse = try await apiClient.request(
                endpoint: APIEndpoints.drives,
                method: .GET
            )

            // 3. For each drive, load pages and filter AI_CHAT pages
            for drive in drivesResponse.drives {
                let pagesResponse: PageListResponse = try await apiClient.request(
                    endpoint: APIEndpoints.drivePages(driveId: drive.id),
                    method: .GET
                )

                // Filter to AI_CHAT pages only
                let aiChatPages = pagesResponse.pages.filter { $0.type == .aiChat }

                // Create agents from AI chat pages
                for page in aiChatPages {
                    let agent = Agent.fromPage(page, drive: drive)
                    allAgents.append(agent)
                }
            }

            // Update published property
            agents = allAgents

            // Set default selected agent to global if none selected
            if selectedAgent == nil {
                selectedAgent = globalAgent
            }

        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - Select Agent

    func selectAgent(_ agent: Agent) {
        selectedAgent = agent
    }

    // MARK: - Get Drives

    func getDrives() async throws -> [Drive] {
        let response: DriveListResponse = try await apiClient.request(
            endpoint: APIEndpoints.drives,
            method: .GET
        )
        return response.drives
    }

    // MARK: - Get Pages for Drive

    func getPages(driveId: String) async throws -> [Page] {
        let response: PageListResponse = try await apiClient.request(
            endpoint: APIEndpoints.drivePages(driveId: driveId),
            method: .GET
        )
        return response.pages
    }

    // MARK: - Get AI Chat Pages Only

    func getAIChatPages(driveId: String) async throws -> [Page] {
        let pages = try await getPages(driveId: driveId)
        return pages.filter { $0.type == .aiChat }
    }
}
