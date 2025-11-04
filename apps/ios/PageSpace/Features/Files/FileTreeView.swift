//
//  FileTreeView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Hierarchical file tree with expand/collapse (pages only, no drives)
//

import SwiftUI

// MARK: - Flattened Page Model

struct FlattenedPage: Identifiable {
    let id: String
    let page: Page
    let level: Int
    let isExpandable: Bool
}

// MARK: - File Tree View

struct FileTreeView: View {
    let pages: [Page]

    @State private var expandedPageIds: Set<String> = []

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(flattenedPages) { item in
                if item.page.type == .folder {
                    // Folders: tap to expand/collapse, no navigation
                    FileRowView(
                        page: item.page,
                        level: item.level,
                        isExpanded: expandedPageIds.contains(item.id),
                        onTap: {
                            toggleExpand(item.page)
                        },
                        onToggleExpand: {
                            toggleExpand(item.page)
                        },
                        isNavigable: false // Button wrapper for tap handling
                    )
                    .id(item.id)
                } else {
                    // Non-folders: navigate to detail view
                    NavigationLink(value: item.page) {
                        FileRowView(
                            page: item.page,
                            level: item.level,
                            isExpanded: false,
                            onTap: { }, // Unused when navigable
                            onToggleExpand: { }, // Unused when navigable
                            isNavigable: true // Bare content for NavigationLink
                        )
                    }
                    .buttonStyle(.plain)
                    .id(item.id)
                }
            }
        }
    }

    // MARK: - Flattened Tree

    /// Flatten the hierarchical tree into a linear list with level metadata
    /// This avoids AnyView type erasure and improves performance
    private var flattenedPages: [FlattenedPage] {
        flatten(pages: pages, level: 0)
    }

    private func flatten(pages: [Page], level: Int) -> [FlattenedPage] {
        pages.flatMap { page -> [FlattenedPage] in
            let hasChildren = page.children?.isEmpty == false
            var result = [FlattenedPage(
                id: page.id,
                page: page,
                level: level,
                isExpandable: hasChildren
            )]

            // Recursively add children if expanded
            if expandedPageIds.contains(page.id), let children = page.children, !children.isEmpty {
                result += flatten(pages: children, level: level + 1)
            }

            return result
        }
    }

    // MARK: - Actions

    private func toggleExpand(_ page: Page) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if expandedPageIds.contains(page.id) {
                expandedPageIds.remove(page.id)
            } else {
                expandedPageIds.insert(page.id)
            }
        }
    }
}

#Preview {
    let samplePages = [
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
                ),
                Page(
                    id: "3",
                    driveId: "drive1",
                    title: "Project B",
                    type: .folder,
                    parentId: "1",
                    position: 2.0,
                    createdAt: Date(),
                    updatedAt: Date(),
                    children: [
                        Page(
                            id: "4",
                            driveId: "drive1",
                            title: "Design Doc",
                            type: .document,
                            parentId: "3",
                            position: 1.0,
                            createdAt: Date(),
                            updatedAt: Date()
                        )
                    ]
                )
            ]
        ),
        Page(
            id: "5",
            driveId: "drive1",
            title: "AI Assistant",
            type: .aiChat,
            parentId: nil,
            position: 2.0,
            createdAt: Date(),
            updatedAt: Date()
        )
    ]

    return NavigationStack {
        ScrollView {
            FileTreeView(pages: samplePages)
                .padding()
        }
        .navigationDestination(for: Page.self) { page in
            Text("Page Detail: \(page.title)")
        }
    }
}
