import SwiftUI

struct AgentListView: View {
    @StateObject private var agentService = AgentService.shared
    @StateObject private var conversationManager = ConversationManager.shared
    @State private var selectedAgent: Agent?
    @State private var isSidebarOpen = false

    var body: some View {
        NavigationStack {
            ZStack {
                if agentService.isLoading && agentService.agents.isEmpty {
                    ProgressView("Loading agents...")
                } else if agentService.agents.isEmpty {
                    emptyState
                } else {
                    List {
                        // Global AI Section
                        Section {
                            ForEach(globalAgents) { agent in
                                NavigationLink(value: agent) {
                                    AgentRow(agent: agent, isSelected: agentService.selectedAgent?.id == agent.id)
                                }
                            }
                        } header: {
                            Text("Personal Assistant")
                        }

                        // Page AI Agents by Drive
                        ForEach(groupedPageAgents.keys.sorted(), id: \.self) { driveName in
                            if let agents = groupedPageAgents[driveName] {
                                Section {
                                    ForEach(agents) { agent in
                                        NavigationLink(value: agent) {
                                            AgentRow(agent: agent, isSelected: agentService.selectedAgent?.id == agent.id)
                                        }
                                    }
                                } header: {
                                    HStack {
                                        Image(systemName: "folder")
                                        Text(driveName)
                                    }
                                }
                            }
                        }
                    }
                    .navigationDestination(for: Agent.self) { agent in
                        // Select agent when navigating (updates ConversationManager state)
                        ChatView(isSidebarOpen: $isSidebarOpen)
                            .environmentObject(conversationManager)
                            .environmentObject(agentService)
                            .onAppear {
                                agentService.selectAgent(agent)
                            }
                    }
                    .refreshable {
                        await agentService.loadAllAgents()
                    }
                }
            }
            .navigationTitle("Agents")
            .task {
                if agentService.agents.isEmpty {
                    await agentService.loadAllAgents()
                }
            }
        }
    }

    private var globalAgents: [Agent] {
        agentService.agents.filter { $0.type == .global }
    }

    private var pageAgents: [Agent] {
        agentService.agents.filter { $0.type == .pageAI }
    }

    private var groupedPageAgents: [String: [Agent]] {
        Dictionary(grouping: pageAgents) { agent in
            agent.driveName ?? "Unknown"
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 60))
                .foregroundColor(.secondary)
            Text("No AI agents found")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Create an AI chat page in PageSpace to see it here")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

struct AgentRow: View {
    let agent: Agent
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: agent.icon)
                .font(.title3)
                .foregroundColor(agent.type == .global ? .blue : .purple)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 4) {
                Text(agent.title)
                    .font(.headline)

                if let subtitle = agent.subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.blue)
            }
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    AgentListView()
}
