//
//  FilesView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Main file system browser view - shows list of drives
//

import SwiftUI

struct FilesView: View {
    @ObservedObject private var fileSystemService = FileSystemService.shared

    var body: some View {
        VStack(spacing: 0) {
            // Drive list or loading/error states
            if fileSystemService.isLoading && fileSystemService.driveItems.isEmpty {
                loadingView
            } else if let error = fileSystemService.error {
                errorView(error: error)
            } else if fileSystemService.driveItems.isEmpty {
                emptyStateView
            } else {
                driveListView
            }
        }
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.large)
        .task {
            if fileSystemService.driveItems.isEmpty {
                await fileSystemService.loadDrives()
            }
        }
        .refreshable {
            await fileSystemService.refreshDrives()
        }
    }

    // MARK: - Drive List View

    private var driveListView: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(fileSystemService.driveItems) { driveItem in
                    NavigationLink(value: driveItem.drive.id) {
                        DriveRowView(drive: driveItem.drive)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, DesignTokens.Spacing.medium)
            .padding(.vertical, DesignTokens.Spacing.small)
        }
        .navigationDestination(for: String.self) { driveId in
            if let driveItem = fileSystemService.driveItems.first(where: { $0.drive.id == driveId }) {
                DriveDetailView(driveItem: driveItem)
            }
        }
    }

    // MARK: - Loading View

    private var loadingView: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            ProgressView()
                .scaleEffect(1.2)

            Text("Loading drives...")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Error View

    private func errorView(error: FileSystemError) -> some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundColor(DesignTokens.Colors.error)

            Text("Failed to load drives")
                .font(.headline)

            Text(error.localizedDescription)
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignTokens.Spacing.xlarge)

            Button {
                Task {
                    await fileSystemService.refreshDrives()
                }
            } label: {
                Text("Retry")
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, DesignTokens.Spacing.large)
                    .padding(.vertical, DesignTokens.Spacing.small)
                    .background(DesignTokens.Colors.brandBlue)
                    .cornerRadius(DesignTokens.CornerRadius.medium)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Empty State View

    private var emptyStateView: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Image(systemName: "folder")
                .font(.system(size: 64))
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("No drives yet")
                .font(.headline)
                .foregroundColor(.primary)

            Text("Create a drive in the web app to see it here")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignTokens.Spacing.xlarge)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    NavigationStack {
        FilesView()
    }
}
