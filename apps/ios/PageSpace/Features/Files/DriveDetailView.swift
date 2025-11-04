//
//  DriveDetailView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Shows the file tree for a specific drive
//

import SwiftUI

struct DriveDetailView: View {
    let driveItem: DriveItem

    var body: some View {
        ScrollView {
            FileTreeView(pages: driveItem.pages)
                .padding(.horizontal, DesignTokens.Spacing.medium)
                .padding(.vertical, DesignTokens.Spacing.small)
        }
        .navigationTitle(driveItem.drive.name)
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(for: Page.self) { page in
            PageDetailView(pageId: page.id)
        }
    }
}

#Preview {
    NavigationStack {
        DriveDetailView(
            driveItem: DriveItem(
                id: "drive1",
                drive: Drive(
                    id: "drive1",
                    name: "Personal",
                    slug: "personal",
                    description: nil,
                    ownerId: "user1",
                    createdAt: Date(),
                    updatedAt: Date(),
                    isOwned: true,
                    role: "OWNER"
                ),
                pages: [
                    Page(
                        id: "1",
                        driveId: "drive1",
                        title: "Projects",
                        type: .folder,
                        parentId: nil,
                        position: 1.0,
                        createdAt: Date(),
                        updatedAt: Date(),
                        children: [
                            Page(
                                id: "2",
                                driveId: "drive1",
                                title: "Project A",
                                type: .document,
                                parentId: "1",
                                position: 1.0,
                                createdAt: Date(),
                                updatedAt: Date()
                            )
                        ]
                    )
                ]
            )
        )
    }
}
