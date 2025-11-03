//
//  HomeView.swift
//  PageSpace
//
//  Created on 2025-11-01.
//

import SwiftUI

/// Root authenticated container managing chat interface and sidebar navigation
struct HomeView: View {
    @StateObject private var agentService = AgentService.shared
    @StateObject private var conversationManager = ConversationManager.shared
    @EnvironmentObject var authManager: AuthManager

    @State private var isSidebarOpen: Bool = false
    @State private var navigationPath = NavigationPath()

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack(alignment: .leading) {
                // Main chat view (always present)
                ChatView(isSidebarOpen: $isSidebarOpen)
                    .environmentObject(conversationManager)
                    .environmentObject(agentService)
                    .zIndex(0)

                // Sidebar (slides in from left)
                if isSidebarOpen {
                    Color.black.opacity(0.3)
                        .ignoresSafeArea()
                        .onTapGesture {
                            withAnimation(DesignTokens.Animation.sidebarSlide) {
                                isSidebarOpen = false
                            }
                        }
                        .zIndex(1)

                    Sidebar(
                        isOpen: $isSidebarOpen,
                        agentService: agentService,
                        onNavigate: handleNavigation
                    )
                    .environmentObject(conversationManager)
                    .environmentObject(agentService)
                    .offset(x: isSidebarOpen ? 0 : -DesignTokens.Spacing.sidebarWidth)
                    .animation(.spring(response: 0.3, dampingFraction: 0.8), value: isSidebarOpen)
                    .zIndex(2)
                }
            }
            .navigationDestination(for: SidebarDestination.self) { destination in
                switch destination {
                case .agents:
                    AgentsListView(agentService: agentService)
                case .messages:
                    MessagesListView()
                }
            }
        }
        .onAppear {
            // Delay agent loading to ensure auth state is stable after login
            Task {
                try? await Task.sleep(nanoseconds: 200_000_000) // 0.2 seconds
                if agentService.agents.isEmpty {
                    await agentService.loadAllAgents()
                }
            }
        }
    }

    // MARK: - Navigation Handler

    private func handleNavigation(_ destination: SidebarDestination) {
        navigationPath.append(destination)
    }
}

#Preview {
    HomeView()
        .environmentObject(AuthManager.shared)
}
