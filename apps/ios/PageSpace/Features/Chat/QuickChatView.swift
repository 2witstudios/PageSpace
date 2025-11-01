import SwiftUI

/// Quick access chat view that defaults to Global Assistant
/// but allows switching to any agent via the picker
struct QuickChatView: View {
    @StateObject private var agentService = AgentService.shared
    @State private var showAgentPicker = false
    @State private var isSidebarOpen = false

    var body: some View {
        NavigationView {
            Group {
                if let currentAgent = agentService.selectedAgent {
                    ChatView(agent: currentAgent, isSidebarOpen: $isSidebarOpen)
                } else if agentService.isLoading {
                    ProgressView("Loading...")
                } else {
                    VStack(spacing: 16) {
                        Image(systemName: "brain.head.profile")
                            .font(.system(size: 60))
                            .foregroundColor(.secondary)
                        Text("No agent selected")
                            .font(.headline)
                        Button("Select Agent") {
                            showAgentPicker = true
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .sheet(isPresented: $showAgentPicker) {
                AgentPickerView()
            }
            .task {
                if agentService.agents.isEmpty {
                    await agentService.loadAllAgents()
                }
            }
        }
    }
}

#Preview {
    QuickChatView()
}
