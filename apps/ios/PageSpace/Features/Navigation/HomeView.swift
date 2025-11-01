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
    @State private var isSidebarOpen: Bool = false

    var body: some View {
        ZStack(alignment: .leading) {
            // Main chat view (always present)
            if let selectedAgent = agentService.selectedAgent {
                ChatView(
                    agent: selectedAgent,
                    isSidebarOpen: $isSidebarOpen
                )
                .id(selectedAgent.id) // Force recreation when agent changes
                .zIndex(0)
            } else {
                // Show loading or empty state when no agent selected
                VStack {
                    ProgressView("Loading...")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .zIndex(0)
            }

            // Sidebar (slides in from left)
            if isSidebarOpen {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.3)) {
                            isSidebarOpen = false
                        }
                    }
                    .zIndex(1)

                Sidebar(
                    isOpen: $isSidebarOpen,
                    agentService: agentService
                )
                .offset(x: isSidebarOpen ? 0 : -280)
                .animation(.spring(response: 0.3, dampingFraction: 0.8), value: isSidebarOpen)
                .zIndex(2)
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
}

#Preview {
    HomeView()
}
