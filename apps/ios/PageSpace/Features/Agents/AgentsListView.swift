import SwiftUI

/// Full-screen agent selection view for sidebar navigation
/// Selects an agent and dismisses to return to chat
struct AgentsListView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var agentService = AgentService.shared

    var body: some View {
        Group {
            if agentService.isLoading && agentService.agents.isEmpty {
                ProgressView("Loading agents...")
            } else if agentService.agents.isEmpty {
                emptyState
            } else {
                List {
                    // Global AI Section
                    Section {
                        ForEach(globalAgents) { agent in
                            Button {
                                selectAgent(agent)
                            } label: {
                                AgentRowSelectable(
                                    agent: agent,
                                    isSelected: agentService.selectedAgent?.id == agent.id
                                )
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
                                    Button {
                                        selectAgent(agent)
                                    } label: {
                                        AgentRowSelectable(
                                            agent: agent,
                                            isSelected: agentService.selectedAgent?.id == agent.id
                                        )
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
                .refreshable {
                    await agentService.loadAllAgents()
                }
            }
        }
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.large)
        .task {
            if agentService.agents.isEmpty {
                await agentService.loadAllAgents()
            }
        }
    }

    // MARK: - Actions

    private func selectAgent(_ agent: Agent) {
        agentService.selectAgent(agent)
        dismiss()
    }

    // MARK: - Computed Properties

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

/// Agent row component with selection indicator
struct AgentRowSelectable: View {
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
                    .foregroundColor(.primary)

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
        .contentShape(Rectangle())
    }
}

#Preview {
    NavigationStack {
        AgentsListView()
    }
}
