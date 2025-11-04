//
//  FolderDetailView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Folder detail view showing nested children (drill-down pattern)
//

import SwiftUI

struct FolderDetailView: View {
    let page: Page // The folder page

    var body: some View {
        Group {
            if let children = page.children, !children.isEmpty {
                ScrollView {
                    FileTreeView(pages: children)
                        .padding(.top, DesignTokens.Spacing.small)
                }
            } else {
                emptyFolderView
            }
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var emptyFolderView: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Spacer()

            Image(systemName: "folder")
                .font(.system(size: 64))
                .foregroundColor(.secondary)

            Text("Empty Folder")
                .font(.title2)
                .fontWeight(.semibold)

            Text("This folder doesn't contain any pages yet.")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignTokens.Spacing.xlarge)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    NavigationStack {
        FolderDetailView(
            page: Page(
                id: "folder1",
                driveId: "drive1",
                title: "Projects",
                type: .folder,
                parentId: nil,
                position: 1.0,
                createdAt: Date(),
                updatedAt: Date(),
                children: [
                    Page(
                        id: "doc1",
                        driveId: "drive1",
                        title: "Project A",
                        type: .document,
                        parentId: "folder1",
                        position: 1.0,
                        createdAt: Date(),
                        updatedAt: Date()
                    ),
                    Page(
                        id: "folder2",
                        driveId: "drive1",
                        title: "Subfolder",
                        type: .folder,
                        parentId: "folder1",
                        position: 2.0,
                        createdAt: Date(),
                        updatedAt: Date(),
                        children: [
                            Page(
                                id: "doc2",
                                driveId: "drive1",
                                title: "Nested Doc",
                                type: .document,
                                parentId: "folder2",
                                position: 1.0,
                                createdAt: Date(),
                                updatedAt: Date()
                            )
                        ]
                    )
                ]
            )
        )
        .navigationDestination(for: Page.self) { page in
            if page.type == .folder {
                FolderDetailView(page: page)
            } else {
                Text("Page: \(page.title)")
            }
        }
    }
}
