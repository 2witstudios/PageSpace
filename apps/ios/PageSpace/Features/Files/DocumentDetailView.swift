//
//  DocumentDetailView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Display markdown/rich text document content
//

import SwiftUI

struct DocumentDetailView: View {
    let page: Page

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignTokens.Spacing.large) {
                // Document header
                documentHeader

                Divider()

                // Document content
                // Note: Page model doesn't include content by default
                // Content needs to be fetched via API
                Text("Document content viewing coming soon")
                    .font(.body)
                    .foregroundColor(DesignTokens.Colors.mutedText)
                    .padding()

                Text("Full document content will be loaded from the API in a future update.")
                    .font(.caption)
                    .foregroundColor(DesignTokens.Colors.mutedText)
                    .padding()
            }
            .padding()
        }
    }

    // MARK: - Document Header

    private var documentHeader: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.xsmall) {
            HStack {
                Image(systemName: "doc.text.fill")
                    .font(.system(size: 20))
                    .foregroundColor(.primary)

                Text("Document")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundColor(DesignTokens.Colors.mutedText)
                    .textCase(.uppercase)
                    .tracking(1.2)
            }

            Text(page.title)
                .font(.title2)
                .fontWeight(.bold)

            HStack(spacing: DesignTokens.Spacing.small) {
                Text("Updated \(formattedDate(page.updatedAt))")
                    .font(.caption)
                    .foregroundColor(DesignTokens.Colors.mutedText)
            }
        }
    }

    // MARK: - Content View

    private func contentView(content: String) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.medium) {
            // Try to parse and render markdown
            // For now, we'll display as plain text with basic formatting
            // TODO: Add markdown rendering library for rich formatting
            Text(content)
                .font(.body)
                .lineSpacing(4)
                .textSelection(.enabled)
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: DesignTokens.Spacing.medium) {
            Image(systemName: "doc.text")
                .font(.system(size: 48))
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("This document is empty")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DesignTokens.Spacing.xxlarge)
    }

    // MARK: - Helpers

    private func formattedDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

#Preview {
    NavigationStack {
        DocumentDetailView(
            page: Page(
                id: "1",
                driveId: "drive1",
                title: "Project Overview",
                type: .document,
                parentId: nil,
                position: 1.0,
                createdAt: Date().addingTimeInterval(-86400 * 7),
                updatedAt: Date().addingTimeInterval(-3600),
                aiProvider: nil,
                aiModel: nil,
                systemPrompt: nil,
                enabledTools: nil,
                children: nil
            )
        )
    }
}
