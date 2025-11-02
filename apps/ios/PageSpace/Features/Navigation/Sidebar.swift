//
//  Sidebar.swift
//  PageSpace
//
//  Created on 2025-11-01.
//

import SwiftUI

/// Navigation destinations for sidebar
enum SidebarDestination: Hashable {
    case agents
    case channels
}

/// Left sliding sidebar with ChatGPT/Claude-style navigation
/// Features: Agents, Channels, Files buttons at top, Recents list, and user profile footer
struct Sidebar: View {
    @Binding var isOpen: Bool
    @ObservedObject var agentService: AgentService
    @EnvironmentObject var authManager: AuthManager

    // Navigation callback
    var onNavigate: (SidebarDestination) -> Void

    @State private var showSettings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Navigation Buttons Section
            navigationButtons
                .padding(.horizontal)
                .padding(.top, 16)

            Divider()
                .padding(.top, 12)

            // Recents Section Header
            recentsHeader
                .padding(.horizontal)
                .padding(.top, 12)

            // Conversation List
            ScrollView {
                ConversationList(agentService: agentService, closeSidebar: {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isOpen = false
                    }
                })
                .padding(.horizontal)
            }

            Divider()

            // User Profile Footer
            userProfileFooter
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

    // MARK: - Navigation Buttons

    private var navigationButtons: some View {
        VStack(spacing: 8) {
            // Agents Button
            NavigationButton(
                icon: "person.2.fill",
                title: "Agents",
                action: {
                    onNavigate(.agents)
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isOpen = false
                    }
                }
            )

            // Channels Button
            NavigationButton(
                icon: "number.circle.fill",
                title: "Channels",
                action: {
                    onNavigate(.channels)
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isOpen = false
                    }
                }
            )

            // Files Button (disabled/placeholder)
            NavigationButton(
                icon: "doc.fill",
                title: "Files",
                action: {},
                isDisabled: true
            )
        }
    }

    // MARK: - Recents Header

    private var recentsHeader: some View {
        HStack {
            Image(systemName: "clock")
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text("Recents")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(.primary)
            Spacer()
        }
    }

    // MARK: - User Profile Footer

    private var userProfileFooter: some View {
        Button(action: {
            showSettings = true
        }) {
            HStack(spacing: 12) {
                // Avatar Circle
                Group {
                    if let user = authManager.currentUser,
                       let imageURL = user.image,
                       let url = URL(string: imageURL) {
                        // Remote avatar image
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            case .failure, .empty:
                                // Fallback to gradient circle with initials
                                Circle()
                                    .fill(LinearGradient(
                                        colors: [.blue, .purple],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    ))
                                    .overlay(
                                        Text(userInitials)
                                            .font(.headline)
                                            .foregroundColor(.white)
                                    )
                            @unknown default:
                                // Fallback for future cases
                                Circle()
                                    .fill(LinearGradient(
                                        colors: [.blue, .purple],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    ))
                                    .overlay(
                                        Text(userInitials)
                                            .font(.headline)
                                            .foregroundColor(.white)
                                    )
                            }
                        }
                    } else {
                        // Default gradient circle with initials
                        Circle()
                            .fill(LinearGradient(
                                colors: [.blue, .purple],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ))
                            .overlay(
                                Text(userInitials)
                                    .font(.headline)
                                    .foregroundColor(.white)
                            )
                    }
                }
                .frame(width: 40, height: 40)
                .clipShape(Circle())

                // User Info
                VStack(alignment: .leading, spacing: 2) {
                    if let user = authManager.currentUser {
                        Text(user.name ?? "User")
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .foregroundColor(.primary)
                            .lineLimit(1)

                        Text(user.email)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    } else {
                        Text("Loading...")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                // Settings Indicator
                Image(systemName: "ellipsis")
                    .foregroundColor(.secondary)
                    .rotationEffect(.degrees(90))
            }
            .padding()
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
        .sheet(isPresented: $showSettings) {
            SettingsSheet()
                .environmentObject(authManager)
        }
    }

    // MARK: - Computed Properties

    private var userInitials: String {
        guard let user = authManager.currentUser else { return "?" }

        if let name = user.name, !name.isEmpty {
            let components = name.components(separatedBy: " ")
            let initials = components.compactMap { $0.first }.prefix(2)
            return String(initials).uppercased()
        } else {
            return user.email.prefix(1).uppercased()
        }
    }
}

/// Navigation button component for sidebar
struct NavigationButton: View {
    let icon: String
    let title: String
    let action: () -> Void
    var isDisabled: Bool = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.body)
                    .foregroundColor(isDisabled ? .secondary.opacity(0.5) : .primary)
                    .frame(width: 24)

                Text(title)
                    .font(.body)
                    .fontWeight(.medium)
                    .foregroundColor(isDisabled ? .secondary.opacity(0.5) : .primary)

                Spacer()

                if isDisabled {
                    Text("Soon")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.1))
                        .cornerRadius(4)
                }
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.1))
            )
        }
        .buttonStyle(PlainButtonStyle())
        .disabled(isDisabled)
    }
}

#Preview {
    struct PreviewWrapper: View {
        @State private var isOpen = true
        @StateObject private var authManager = AuthManager.shared

        var body: some View {
            ZStack(alignment: .leading) {
                Color.gray.opacity(0.2)
                    .ignoresSafeArea()

                if isOpen {
                    Sidebar(
                        isOpen: $isOpen,
                        agentService: AgentService.shared,
                        onNavigate: { destination in
                            print("Navigate to: \(destination)")
                        }
                    )
                    .environmentObject(authManager)
                    .offset(x: isOpen ? 0 : -280)
                }
            }
        }
    }

    return PreviewWrapper()
}
