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
    case files
    case drive(String)
    case page(String)
    case channel(MessageThread)
    case directMessage(MessageThread)
}

/// Left sliding sidebar with minimal, modern design
/// Features: Ghost button navigation, hairline separators, refined typography
struct Sidebar: View {
    @Binding var isOpen: Bool
    @ObservedObject var agentService: AgentService
    @EnvironmentObject var authManager: AuthManager
    @ObservedObject private var searchService = SearchService.shared

    // Navigation callback
    var onNavigate: (SidebarDestination) -> Void

    @State private var showSettings = false
    @State private var searchText = ""
    @State private var searchError: String?
    @FocusState private var isSearchFieldFocused: Bool

    private var isSearchActive: Bool {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Search Field (above navigation)
            searchField
                .padding(.horizontal, DesignTokens.Spacing.large)
                .padding(.top, DesignTokens.Spacing.large)

            if isSearchActive {
                searchResultsSection
            } else {
                // Hairline separator between search and navigation buttons
                hairlineSeparator
                    .padding(.top, DesignTokens.Spacing.medium)

                // Navigation Buttons Section
                navigationButtons
                    .padding(.horizontal, DesignTokens.Spacing.large)
                    .padding(.top, DesignTokens.Spacing.medium)

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
        .onChange(of: searchText) { _, newValue in
            searchError = nil
            searchService.updateQuery(newValue)
        }
        .onChange(of: isOpen) { _, newValue in
            if !newValue {
                resetSearch()
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

            // Files Button
            GhostNavigationButton(
                icon: "doc.fill",
                title: "Files",
                action: {
                    onNavigate(.files)
                    withAnimation(DesignTokens.Animation.sidebarSlide) {
                        isOpen = false
                    }
                }
            )
        }
    }

    // MARK: - Search

    private var searchField: some View {
        HStack(spacing: DesignTokens.Spacing.small) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(DesignTokens.Colors.mutedText)

            TextField("Search pages, drives, and users", text: $searchText)
                .focused($isSearchFieldFocused)
                .textFieldStyle(.plain)
                .disableAutocorrection(true)
                .textInputAutocapitalization(.never)
                .onSubmit {
                    searchService.updateQuery(searchText)
                }

            if !searchText.isEmpty {
                Button(action: {
                    resetSearch()
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.vertical, DesignTokens.Spacing.small)
        .padding(.horizontal, DesignTokens.Spacing.medium)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.CornerRadius.large)
                .fill(Color(uiColor: .systemGray6))
        )
    }

    private var searchResultsSection: some View {
        ScrollView {
            VStack(spacing: 0) {
                if searchService.isSearching {
                    searchStatusRow(message: "Searching...", showSpinner: true)
                } else {
                    let errorMessage = searchError ?? searchService.errorMessage

                    if let errorMessage {
                        searchStatusRow(
                            icon: "exclamationmark.triangle.fill",
                            message: errorMessage,
                            color: DesignTokens.Colors.error
                        )
                    }

                    if searchService.results.isEmpty {
                        if errorMessage == nil {
                            searchStatusRow(icon: "questionmark.circle", message: "No matches found")
                        }
                    } else {
                        ForEach(Array(searchService.results.enumerated()), id: \.element.id) { index, result in
                            SearchResultRow(
                                iconName: iconName(for: result),
                                accentColor: accentColor(for: result),
                                title: result.title,
                                subtitle: subtitle(for: result),
                                badge: badgeLabel(for: result)
                            ) {
                                handleSearchSelection(result)
                            }

                            if index < searchService.results.count - 1 {
                                Rectangle()
                                    .fill(DesignTokens.Colors.separator)
                                    .frame(height: 0.5)
                                    .padding(.leading, DesignTokens.Spacing.large + DesignTokens.IconSize.large + DesignTokens.Spacing.small)
                            }
                        }
                    }
                }

                Spacer(minLength: DesignTokens.Spacing.xlarge)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, DesignTokens.Spacing.large)
            .padding(.top, DesignTokens.Spacing.small)
            .padding(.bottom, DesignTokens.Spacing.medium)
        }
    }

    @ViewBuilder
    private func searchStatusRow(
        icon: String? = nil,
        message: String,
        color: Color = DesignTokens.Colors.mutedText,
        showSpinner: Bool = false
    ) -> some View {
        HStack(spacing: DesignTokens.Spacing.small) {
            if showSpinner {
                ProgressView()
                    .scaleEffect(0.75)
            } else if let icon {
                Image(systemName: icon)
                    .foregroundColor(color)
                    .font(.system(size: DesignTokens.IconSize.medium))
            }

            Text(message)
                .font(.caption)
                .foregroundColor(color)
                .multilineTextAlignment(.leading)

            Spacer()
        }
        .padding(.horizontal, DesignTokens.Spacing.large)
        .padding(.top, DesignTokens.Spacing.small)
    }

    private func handleSearchSelection(_ result: SearchResult) {
        switch result.type {
        case .drive:
            onNavigate(.drive(result.id))
            closeSidebarAndReset()
        case .page:
            handlePageSelection(result)
        case .user:
            handleUserSelection(result)
        }
    }

    private func handlePageSelection(_ result: SearchResult) {
        guard let pageType = result.pageType else {
            navigateToPageDetail(result.id)
            return
        }

        switch pageType {
        case .aiChat:
            openAIChat(pageId: result.id)
        case .channel:
            openChannel(result)
        default:
            navigateToPageDetail(result.id)
        }
    }

    private func handleUserSelection(_ result: SearchResult) {
        searchError = nil
        Task {
            await openDirectMessage(for: result)
        }
    }

    private func openAIChat(pageId: String) {
        if let agent = agentService.agents.first(where: { $0.pageId == pageId }) {
            agentService.selectAgent(agent)
            closeSidebarAndReset()
        } else {
            navigateToPageDetail(pageId)
        }
    }

    private func openChannel(_ result: SearchResult) {
        let thread = MessageThread(
            id: result.id,
            type: .channel,
            title: result.title,
            subtitle: result.driveName,
            lastMessage: nil,
            lastMessageAt: Date(),
            unreadCount: nil,
            avatarUrl: nil,
            otherUserId: nil,
            otherUser: nil,
            pageId: result.id,
            driveId: result.driveId,
            driveName: result.driveName
        )

        onNavigate(.channel(thread))
        closeSidebarAndReset()
    }

    private func navigateToPageDetail(_ pageId: String) {
        onNavigate(.page(pageId))
        closeSidebarAndReset()
    }

    private func closeSidebarAndReset() {
        withAnimation(DesignTokens.Animation.sidebarSlide) {
            isOpen = false
        }
        resetSearch()
    }

    private func resetSearch() {
        searchText = ""
        searchError = nil
        searchService.clearResults()
        isSearchFieldFocused = false
    }

    private func iconName(for result: SearchResult) -> String {
        switch result.type {
        case .drive:
            return "externaldrive"
        case .user:
            return "person.circle.fill"
        case .page:
            guard let pageType = result.pageType else { return "doc.text" }
            switch pageType {
            case .document:
                return "doc.text"
            case .folder:
                return "folder"
            case .channel:
                return "number"
            case .aiChat:
                return "bubble.left.and.text.bubble.right"
            case .canvas:
                return "sparkles"
            case .file:
                return "doc.richtext"
            case .sheet:
                return "tablecells"
            }
        }
    }

    private func accentColor(for result: SearchResult) -> Color {
        switch result.type {
        case .drive:
            return DesignTokens.Colors.brandBlue
        case .user:
            return DesignTokens.Colors.mutedText
        case .page:
            guard let pageType = result.pageType else {
                return DesignTokens.Colors.brandBlue
            }
            switch pageType {
            case .channel:
                return DesignTokens.Colors.channel
            case .aiChat:
                return DesignTokens.Colors.brandBlueDark
            default:
                return DesignTokens.Colors.brandBlue
            }
        }
    }

    private func badgeLabel(for result: SearchResult) -> String? {
        switch result.type {
        case .drive:
            return "Drive"
        case .user:
            return "User"
        case .page:
            guard let pageType = result.pageType else { return "Page" }
            switch pageType {
            case .document:
                return "Document"
            case .folder:
                return "Folder"
            case .channel:
                return "Channel"
            case .aiChat:
                return "AI Chat"
            case .canvas:
                return "Canvas"
            case .file:
                return "File"
            case .sheet:
                return "Sheet"
            }
        }
    }

    private func subtitle(for result: SearchResult) -> String? {
        switch result.type {
        case .drive:
            return result.description
        case .user:
            return result.description
        case .page:
            if let driveName = result.driveName {
                return driveName
            }
            return result.description
        }
    }

    private func openDirectMessage(for result: SearchResult) async {
        let dmService = MessagesManager.shared.directMessagesService

        do {
            let conversation = try await dmService.createConversation(recipientId: result.id)
            let currentUserId = authManager.currentUser?.id ?? ""
            let thread = MessageThread.from(conversation: conversation, currentUserId: currentUserId)

            await MainActor.run {
                let manager = MessagesManager.shared

                if let existingIndex = manager.threads.firstIndex(where: { $0.id == thread.id }) {
                    manager.threads[existingIndex] = thread
                } else {
                    manager.threads.insert(thread, at: 0)
                }

                onNavigate(.directMessage(thread))
                closeSidebarAndReset()
            }
        } catch {
            await MainActor.run {
                searchError = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
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

// MARK: - Search Result Row

// MARK: - Ghost Navigation Button Component

/// Minimal ghost button for sidebar navigation - inspired by Claude Code
private struct SearchResultRow: View {
    let iconName: String
    let accentColor: Color
    let title: String
    let subtitle: String?
    let badge: String?
    let action: () -> Void

    @State private var isPressed = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: DesignTokens.Spacing.medium) {
                Image(systemName: iconName)
                    .font(.system(size: DesignTokens.IconSize.medium))
                    .foregroundColor(accentColor)
                    .frame(width: DesignTokens.IconSize.large, alignment: .center)

                VStack(alignment: .leading, spacing: DesignTokens.Spacing.xxxsmall) {
                    Text(title)
                        .font(.body)
                        .fontWeight(.medium)
                        .foregroundColor(.primary)
                        .lineLimit(1)

                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundColor(DesignTokens.Colors.mutedText)
                            .lineLimit(1)
                    }
                }

                Spacer()

                if let badge {
                    Text(badge)
                        .font(.caption2)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                        .padding(.horizontal, DesignTokens.Spacing.xxsmall)
                        .padding(.vertical, DesignTokens.Spacing.xxxsmall)
                        .background(DesignTokens.Colors.separator.opacity(0.8))
                        .cornerRadius(DesignTokens.CornerRadius.small)
                }
            }
            .padding(.vertical, DesignTokens.Spacing.small)
            .padding(.horizontal, DesignTokens.Spacing.sidebarItemHorizontal)
            .background(isPressed ? DesignTokens.Colors.hoverBackground : Color.clear)
            .cornerRadius(DesignTokens.CornerRadius.large)
        }
        .buttonStyle(GhostButtonStyle(isPressed: $isPressed))
    }
}

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
