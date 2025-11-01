import SwiftUI

struct AgentPickerView: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var agentService = AgentService.shared

    var body: some View {
        NavigationView {
            List {
                // Global AI Section
                Section {
                    ForEach(globalAgents) { agent in
                        Button {
                            selectAgent(agent)
                        } label: {
                            AgentRow(agent: agent, isSelected: agentService.selectedAgent?.id == agent.id)
                        }
                        .buttonStyle(.plain)
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
                                    AgentRow(agent: agent, isSelected: agentService.selectedAgent?.id == agent.id)
                                }
                                .buttonStyle(.plain)
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
            .navigationTitle("Switch Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
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

    private func selectAgent(_ agent: Agent) {
        agentService.selectAgent(agent)
        dismiss()
    }
}

#Preview {
    AgentPickerView()
}
