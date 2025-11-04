//
//  AIConfigDetailView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Display AI chat configuration and settings
//

import SwiftUI

struct AIConfigDetailView: View {
    let page: Page

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignTokens.Spacing.large) {
                // AI Chat header
                aiChatHeader

                Divider()

                // Configuration sections
                if hasAIConfig {
                    aiConfigSections
                } else {
                    noConfigView
                }
            }
            .padding()
        }
    }

    // MARK: - AI Chat Header

    private var aiChatHeader: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.xsmall) {
            HStack {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 20))
                    .foregroundColor(DesignTokens.Colors.brandBlue)

                Text("AI Chat")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundColor(DesignTokens.Colors.mutedText)
                    .textCase(.uppercase)
                    .tracking(1.2)
            }

            Text(page.title)
                .font(.title2)
                .fontWeight(.bold)

            Text("Updated \(formattedDate(page.updatedAt))")
                .font(.caption)
                .foregroundColor(DesignTokens.Colors.mutedText)
        }
    }

    // MARK: - AI Config Sections

    private var aiConfigSections: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.large) {
            // Provider & Model
            if let provider = page.aiProvider, let model = page.aiModel {
                ConfigCard(
                    title: "AI Provider & Model",
                    icon: "cpu",
                    iconColor: DesignTokens.Colors.brandBlue
                ) {
                    VStack(alignment: .leading, spacing: DesignTokens.Spacing.xsmall) {
                        HStack {
                            Text("Provider:")
                                .font(.caption)
                                .foregroundColor(DesignTokens.Colors.mutedText)
                            Spacer()
                            Text(provider)
                                .font(.body)
                                .fontWeight(.medium)
                        }

                        HStack {
                            Text("Model:")
                                .font(.caption)
                                .foregroundColor(DesignTokens.Colors.mutedText)
                            Spacer()
                            Text(model)
                                .font(.body)
                                .fontWeight(.medium)
                        }
                    }
                }
            }

            // System Prompt
            if let systemPrompt = page.systemPrompt, !systemPrompt.isEmpty {
                ConfigCard(
                    title: "System Prompt",
                    icon: "text.quote",
                    iconColor: .purple
                ) {
                    Text(systemPrompt)
                        .font(.body)
                        .lineSpacing(4)
                        .textSelection(.enabled)
                }
            }

            // Enabled Tools
            if let tools = page.enabledTools, !tools.isEmpty {
                ConfigCard(
                    title: "Enabled Tools",
                    icon: "wrench.and.screwdriver",
                    iconColor: .orange
                ) {
                    VStack(alignment: .leading, spacing: DesignTokens.Spacing.xsmall) {
                        ForEach(tools, id: \.self) { tool in
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.caption)
                                    .foregroundColor(.green)

                                Text(tool)
                                    .font(.body)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - No Config View

    private var noConfigView: some View {
        VStack(spacing: DesignTokens.Spacing.medium) {
            Image(systemName: "gearshape")
                .font(.system(size: 48))
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("No AI configuration available")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DesignTokens.Spacing.xxlarge)
    }

    // MARK: - Helpers

    private var hasAIConfig: Bool {
        page.aiProvider != nil || page.aiModel != nil || page.systemPrompt != nil || page.enabledTools != nil
    }

    private func formattedDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Config Card Component

private struct ConfigCard<Content: View>: View {
    let title: String
    let icon: String
    let iconColor: Color
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.small) {
            // Card header
            HStack(spacing: DesignTokens.Spacing.xsmall) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundColor(iconColor)

                Text(title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
            }

            // Card content
            content
                .padding(DesignTokens.Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(DesignTokens.Colors.separator.opacity(0.3))
                .cornerRadius(DesignTokens.CornerRadius.medium)
        }
    }
}

#Preview {
    NavigationStack {
        AIConfigDetailView(
            page: Page(
                id: "1",
                driveId: "drive1",
                title: "Code Assistant",
                type: .aiChat,
                parentId: nil,
                position: 1.0,
                createdAt: Date().addingTimeInterval(-86400 * 7),
                updatedAt: Date().addingTimeInterval(-3600),
                aiProvider: "openai",
                aiModel: "gpt-4",
                systemPrompt: "You are a helpful coding assistant specialized in Swift and iOS development. Provide clear, concise answers with code examples when appropriate.",
                enabledTools: ["read_page", "list_pages", "search_pages", "web_search"],
                children: nil
            )
        )
    }
}
