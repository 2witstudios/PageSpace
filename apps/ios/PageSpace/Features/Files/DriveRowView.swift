//
//  DriveRowView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Drive row for navigation (like Discord servers)
//

import SwiftUI

struct DriveRowView: View {
    let drive: Drive

    var body: some View {
        HStack(spacing: DesignTokens.Spacing.small) {
            // Colored folder icon
            Image(systemName: "folder.fill")
                .font(.system(size: DesignTokens.IconSize.medium))
                .foregroundColor(driveColor)
                .frame(width: 24)

            // Drive name
            Text(drive.name)
                .font(.body)
                .fontWeight(.medium)
                .foregroundColor(.primary)
                .tracking(DesignTokens.Typography.bodyTracking)
                .lineLimit(1)

            Spacer()

            // Chevron to indicate it's navigable
            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(DesignTokens.Colors.mutedText)
        }
        .padding(.vertical, DesignTokens.Spacing.medium)
        .padding(.horizontal, DesignTokens.Spacing.medium)
        .background(Color.clear)
        .contentShape(Rectangle())
        .accessibilityLabel("Drive: \(drive.name)")
        .accessibilityHint("Double tap to open")
        .accessibilityAddTraits([.isButton])
    }

    // MARK: - Drive Color

    private var driveColor: Color {
        // Brand blue for owned drives, gray for member/admin drives
        drive.isOwned == true ? DesignTokens.Colors.primary : .gray
    }
}

#Preview {
    NavigationStack {
        List {
            NavigationLink(value: "drive1") {
                DriveRowView(
                    drive: Drive(
                        id: "1",
                        name: "Personal",
                        slug: "personal",
                        description: nil,
                        ownerId: "user1",
                        createdAt: Date(),
                        updatedAt: Date(),
                        isOwned: true,
                        role: "OWNER"
                    )
                )
            }
            .buttonStyle(.plain)

            NavigationLink(value: "drive2") {
                DriveRowView(
                    drive: Drive(
                        id: "2",
                        name: "Team Drive",
                        slug: "team",
                        description: nil,
                        ownerId: "user2",
                        createdAt: Date(),
                        updatedAt: Date(),
                        isOwned: false,
                        role: "MEMBER"
                    )
                )
            }
            .buttonStyle(.plain)
        }
    }
}
