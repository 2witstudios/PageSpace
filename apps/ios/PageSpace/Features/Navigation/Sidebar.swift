//
//  Sidebar.swift
//  PageSpace
//
//  Created on 2025-11-01.
//

import SwiftUI

/// Left sliding sidebar with navigation, agent selection, and conversation history
struct Sidebar: View {
    @Binding var isOpen: Bool
    @ObservedObject var agentService: AgentService
    @State private var expandedSections: Set<SidebarSection> = [.agents]
    @State private var showSettings = false

    enum SidebarSection: String, CaseIterable {
        case chats = "Chats"
        case agents = "Agents"
        case files = "Files"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header with New Chat button
            header

            Divider()

            // Main content
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    // Chats Section
                    sectionHeader(.chats)
                    if expandedSections.contains(.chats) {
                        ConversationList(agentService: agentService, closeSidebar: {
                            withAnimation(.easeInOut(duration: 0.3)) {
                                isOpen = false
                            }
                        })
                    }

                    Divider()
                        .padding(.vertical, 8)

                    // Agents Section
                    sectionHeader(.agents)
                    if expandedSections.contains(.agents) {
                        agentsSection
                    }

                    Divider()
                        .padding(.vertical, 8)

                    // Files Section
                    sectionHeader(.files)
                    if expandedSections.contains(.files) {
                        filesPlaceholder
                    }
                }
                .padding(.horizontal)
            }

            Divider()

            // Footer with Settings
            footer
        }
        .frame(width: 280)
        .background(Color(UIColor.systemBackground))
        .task {
            // Load agents when sidebar appears
            if agentService.agents.isEmpty {
                await agentService.loadAllAgents()
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text("PageSpace")
                .font(.headline)
            Spacer()
            Button(action: {
                withAnimation(.easeInOut(duration: 0.3)) {
                    isOpen = false
                }
            }) {
                Image(systemName: "xmark")
                    .foregroundColor(.secondary)
            }
        }
        .padding()
    }

    // MARK: - Section Headers

    private func sectionHeader(_ section: SidebarSection) -> some View {
        Button(action: {
            withAnimation(.easeInOut(duration: 0.2)) {
                if expandedSections.contains(section) {
                    expandedSections.remove(section)
                } else {
                    expandedSections.insert(section)
                }
            }
        }) {
            HStack {
                Text(section.rawValue)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
                Spacer()
                Image(systemName: expandedSections.contains(section) ? "chevron.down" : "chevron.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.vertical, 8)
        }
        .buttonStyle(PlainButtonStyle())
    }

    // MARK: - Agents Section

    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Global Agents
            if !globalAgents.isEmpty {
                Text("Global")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.top, 4)

                ForEach(globalAgents) { agent in
                    agentRow(agent)
                }
            }

            // Page AI Agents by Drive
            ForEach(groupedPageAgents.keys.sorted(), id: \.self) { driveName in
                if let agents = groupedPageAgents[driveName] {
                    Text(driveName)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .padding(.top, 8)

                    ForEach(agents) { agent in
                        agentRow(agent)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func agentRow(_ agent: Agent) -> some View {
        Button(action: {
            // Start new chat with this agent
            agentService.selectAgent(agent)
            withAnimation(.easeInOut(duration: 0.3)) {
                isOpen = false
            }
        }) {
            HStack(spacing: 8) {
                Image(systemName: agent.icon)
                    .font(.caption)
                    .foregroundColor(agent.type == .global ? .blue : .purple)
                    .frame(width: 20)
                Text(agent.title)
                    .font(.subheadline)
                    .foregroundColor(.primary)
                    .lineLimit(1)
                Spacer()
                if agentService.selectedAgent?.id == agent.id {
                    Image(systemName: "checkmark")
                        .font(.caption2)
                        .foregroundColor(.blue)
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(
                agentService.selectedAgent?.id == agent.id ?
                Color.blue.opacity(0.1) : Color.clear
            )
            .cornerRadius(6)
        }
        .buttonStyle(PlainButtonStyle())
    }

    // MARK: - Files Section

    private var filesPlaceholder: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Files coming soon")
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.vertical, 4)
        }
    }

    // MARK: - Footer

    private var footer: some View {
        Button(action: {
            showSettings = true
        }) {
            HStack {
                Image(systemName: "gearshape")
                Text("Settings")
                    .font(.subheadline)
                Spacer()
            }
            .padding()
        }
        .buttonStyle(PlainButtonStyle())
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(AuthManager.shared)
        }
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
}

#Preview {
    struct PreviewWrapper: View {
        @State private var isOpen = true

        var body: some View {
            ZStack(alignment: .leading) {
                Color.gray.opacity(0.2)
                    .ignoresSafeArea()

                if isOpen {
                    Sidebar(
                        isOpen: $isOpen,
                        agentService: AgentService.shared
                    )
                    .offset(x: isOpen ? 0 : -280)
                }
            }
        }
    }

    return PreviewWrapper()
}
