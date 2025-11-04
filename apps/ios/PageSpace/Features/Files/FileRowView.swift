//
//  FileRowView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Individual file/folder row in the tree
//

import SwiftUI

struct FileRowView: View {
    let page: Page
    let level: Int
    let isExpanded: Bool
    let onToggleExpand: () -> Void
    let hasChildren: Bool // Whether this page has children (for chevron display)

    var body: some View {
        rowContent
    }

    // MARK: - Row Content

    private var rowContent: some View {
        HStack(spacing: DesignTokens.Spacing.small) {
            // Indentation for hierarchy
            if level > 0 {
                Color.clear
                    .frame(width: CGFloat(level) * 20)
            }

            // Expand/collapse chevron button (if has children)
            if hasChildren {
                Button(action: onToggleExpand) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(DesignTokens.Colors.mutedText)
                        .frame(width: 16, height: 16)
                }
                .buttonStyle(.plain)
            }

            // Page type icon (non-interactive)
            Image(systemName: iconForPageType(page.type))
                .font(.system(size: DesignTokens.IconSize.medium))
                .foregroundColor(colorForPageType(page.type))
                .frame(width: 24)

            // Page title (wrapped in NavigationLink)
            NavigationLink(value: page) {
                HStack(spacing: DesignTokens.Spacing.small) {
                    Text(page.title)
                        .font(.body)
                        .foregroundColor(.primary)
                        .tracking(DesignTokens.Typography.bodyTracking)
                        .lineLimit(1)

                    Spacer()

                    // Badges for specific types
                    if page.type == .aiChat {
                        Image(systemName: "brain.head.profile")
                            .font(.system(size: 12))
                            .foregroundColor(DesignTokens.Colors.mutedText)
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, DesignTokens.Spacing.small)
        .padding(.horizontal, DesignTokens.Spacing.medium)
        .contentShape(Rectangle())
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(accessibilityHint)
        .accessibilityAddTraits(accessibilityTraits)
    }

    // MARK: - Accessibility

    private var accessibilityLabel: String {
        let typeDescription = page.type.accessibilityDescription
        return "\(typeDescription): \(page.title)"
    }

    private var accessibilityHint: String {
        if hasChildren {
            return isExpanded ? "Double tap to collapse" : "Double tap to expand"
        } else {
            return "Double tap to open"
        }
    }

    private var accessibilityTraits: AccessibilityTraits {
        [.isButton]
    }

    // MARK: - Icon Mapping

    private func iconForPageType(_ type: PageType) -> String {
        switch type {
        case .folder:
            return "folder.fill"
        case .document:
            return "doc.text.fill"
        case .channel:
            return "message.circle.fill"
        case .aiChat:
            return "bubble.left.and.text.bubble.right.fill"
        case .canvas:
            return "paintpalette.fill"
        case .file:
            return "paperclip"
        case .sheet:
            return "tablecells.fill"
        }
    }

    // MARK: - Color Mapping

    private func colorForPageType(_ type: PageType) -> Color {
        switch type {
        case .folder:
            return DesignTokens.Colors.primary
        case .document:
            return .primary
        case .channel:
            return DesignTokens.Colors.channel
        case .aiChat:
            return DesignTokens.Colors.brandBlue
        case .canvas:
            return DesignTokens.Colors.primary
        case .file:
            return .gray
        case .sheet:
            return DesignTokens.Colors.primary
        }
    }
}

#Preview {
    NavigationStack {
        VStack(spacing: 0) {
            FileRowView(
                page: Page(
                    id: "1",
                    driveId: "drive1",
                    title: "Projects",
                    type: .folder,
                    parentId: nil,
                    position: 1.0,
                    createdAt: Date(),
                    updatedAt: Date()
                ),
                level: 0,
                isExpanded: true,
                onToggleExpand: { print("Toggle") },
                hasChildren: true
            )

            FileRowView(
                page: Page(
                    id: "2",
                    driveId: "drive1",
                    title: "Project Document",
                    type: .document,
                    parentId: "1",
                    position: 1.0,
                    createdAt: Date(),
                    updatedAt: Date()
                ),
                level: 1,
                isExpanded: false,
                onToggleExpand: { print("Toggle") },
                hasChildren: false
            )

            FileRowView(
                page: Page(
                    id: "3",
                    driveId: "drive1",
                    title: "AI Assistant",
                    type: .aiChat,
                    parentId: nil,
                    position: 2.0,
                    createdAt: Date(),
                    updatedAt: Date()
                ),
                level: 0,
                isExpanded: false,
                onToggleExpand: { print("Toggle") },
                hasChildren: false
            )

            FileRowView(
                page: Page(
                    id: "4",
                    driveId: "drive1",
                    title: "Design Canvas",
                    type: .canvas,
                    parentId: nil,
                    position: 3.0,
                    createdAt: Date(),
                    updatedAt: Date()
                ),
                level: 0,
                isExpanded: false,
                onToggleExpand: { print("Toggle") },
                hasChildren: false
            )
        }
        .navigationDestination(for: Page.self) { page in
            Text("Page Detail: \(page.title)")
        }
    }
}
