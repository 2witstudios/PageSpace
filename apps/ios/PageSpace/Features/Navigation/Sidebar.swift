//
//  Sidebar.swift
//  PageSpace
//
//  Created on 2025-11-01.
//  Redesigned for minimal, modern aesthetic matching web app
//

import SwiftUI

/// Navigation destinations for sidebar
enum SidebarDestination: Hashable {
    case agents
    case messages
}

/// Left sliding sidebar with minimal, modern design
/// Features: Ghost button navigation, hairline separators, refined typography
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
                .padding(.horizontal, DesignTokens.Spacing.large)
                .padding(.top, DesignTokens.Spacing.large)

            // Hairline separator
            hairlineSeparator
                .padding(.top, DesignTokens.Spacing.medium)

            // Recents Section Header
            recentsHeader
                .padding(.horizontal, DesignTokens.Spacing.large)
                .padding(.top, DesignTokens.Spacing.sectionHeaderTop)
                .padding(.bottom, DesignTokens.Spacing.sectionHeaderBottom)

            // Conversation List
            ScrollView {
                ConversationList(agentService: agentService, closeSidebar: {
                    withAnimation(DesignTokens.Animation.sidebarSlide) {
                        isOpen = false
                    }
                })
                .padding(.horizontal, DesignTokens.Spacing.large)
            }

            // Hairline separator
            hairlineSeparator

            // User Profile Footer
            userProfileFooter
        }
        .frame(width: DesignTokens.Spacing.sidebarWidth)
        .background(DesignTokens.Colors.sidebarBackground)
        .task {
            // Load agents when sidebar appears
            if agentService.agents.isEmpty {
                await agentService.loadAllAgents()
            }
        }
    }

    // MARK: - Navigation Buttons

    private var navigationButtons: some View {
        VStack(spacing: DesignTokens.Spacing.xsmall) {
            // Agents Button
            GhostNavigationButton(
                icon: "person.2.fill",
                title: "Agents",
                action: {
                    onNavigate(.agents)
                    withAnimation(DesignTokens.Animation.sidebarSlide) {
                        isOpen = false
                    }
                }
            )

            // Messages Button
            GhostNavigationButton(
                icon: "message.circle.fill",
                title: "Messages",
                action: {
                    onNavigate(.messages)
                    withAnimation(DesignTokens.Animation.sidebarSlide) {
                        isOpen = false
                    }
                }
            )

            // Files Button (disabled/placeholder)
            GhostNavigationButton(
                icon: "doc.fill",
                title: "Files",
                action: {},
                isDisabled: true
            )
        }
    }

    // MARK: - Section Header

    private var recentsHeader: some View {
        Text("Recents")
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundColor(DesignTokens.Colors.extraMutedText)
            .tracking(DesignTokens.Typography.captionTracking)
            .textCase(.uppercase)
    }

    // MARK: - Hairline Separator

    private var hairlineSeparator: some View {
        Rectangle()
            .fill(DesignTokens.Colors.separator)
            .frame(height: 0.5)
    }

    // MARK: - User Profile Footer

    private var userProfileFooter: some View {
        Button(action: {
            showSettings = true
        }) {
            HStack(spacing: DesignTokens.Spacing.medium) {
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
                                avatarFallback
                            @unknown default:
                                avatarFallback
                            }
                        }
                    } else {
                        avatarFallback
                    }
                }
                .frame(width: 40, height: 40)
                .clipShape(Circle())

                // User Info - Name only, cleaner
                if let user = authManager.currentUser {
                    Text(user.name ?? "User")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(.primary)
                        .lineLimit(1)
                        .tracking(DesignTokens.Typography.bodyTracking)
                } else {
                    Text("Loading...")
                        .font(.subheadline)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }

                Spacer()

                // Settings Icon - gear instead of ellipsis
                Image(systemName: "gearshape.fill")
                    .font(.system(size: DesignTokens.IconSize.small))
                    .foregroundColor(DesignTokens.Colors.mutedText)
            }
            .padding(DesignTokens.Spacing.large)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
        .sheet(isPresented: $showSettings) {
            SettingsSheet()
                .environmentObject(authManager)
        }
    }

    // MARK: - Avatar Fallback

    private var avatarFallback: some View {
        Circle()
            .fill(LinearGradient(
                colors: [DesignTokens.Colors.brandBlue, DesignTokens.Colors.brandBlueDark],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ))
            .overlay(
                Text(userInitials)
                    .font(.headline)
                    .foregroundColor(.white)
            )
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

// MARK: - Ghost Navigation Button Component

/// Minimal ghost button for sidebar navigation - inspired by Claude Code
/// No background by default, subtle hover states, clean typography
struct GhostNavigationButton: View {
    let icon: String
    let title: String
    let action: () -> Void
    var isDisabled: Bool = false

    @State private var isPressed = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: DesignTokens.Spacing.small) {
                Image(systemName: icon)
                    .font(.system(size: DesignTokens.IconSize.medium))
                    .foregroundColor(foregroundColor)
                    .frame(width: DesignTokens.IconSize.large)

                Text(title)
                    .font(.body)
                    .fontWeight(.medium)
                    .foregroundColor(foregroundColor)
                    .tracking(DesignTokens.Typography.bodyTracking)

                Spacer()

                if isDisabled {
                    Text("Soon")
                        .font(.caption2)
                        .foregroundColor(Color.secondary.opacity(0.5))
                        .padding(.horizontal, DesignTokens.Spacing.xxsmall)
                        .padding(.vertical, DesignTokens.Spacing.xxxsmall)
                        .background(Color.secondary.opacity(0.08))
                        .cornerRadius(DesignTokens.CornerRadius.small)
                }
            }
            .padding(.vertical, DesignTokens.Spacing.sidebarItemVertical)
            .padding(.horizontal, DesignTokens.Spacing.sidebarItemHorizontal)
            .background(backgroundColor)
            .contentShape(Rectangle())
            .animation(DesignTokens.Animation.quickTransition, value: isPressed)
        }
        .buttonStyle(GhostButtonStyle(isPressed: $isPressed))
        .disabled(isDisabled)
    }

    private var foregroundColor: Color {
        if isDisabled {
            return Color.secondary.opacity(0.5)
        }
        return .primary
    }

    private var backgroundColor: Color {
        if isPressed && !isDisabled {
            return DesignTokens.Colors.hoverBackground
        }
        return Color.clear
    }
}

// MARK: - Ghost Button Style

/// Custom button style for ghost buttons with press state
struct GhostButtonStyle: ButtonStyle {
    @Binding var isPressed: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .onChange(of: configuration.isPressed) { oldValue, newValue in
                isPressed = newValue
            }
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
                    .offset(x: isOpen ? 0 : -DesignTokens.Spacing.sidebarWidth)
                }
            }
        }
    }

    return PreviewWrapper()
}
