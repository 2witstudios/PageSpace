//
//  FilePreviewView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Preview files (images, PDFs, etc.)
//

import SwiftUI
import QuickLook

struct FilePreviewView: View {
    let page: Page

    @State private var fileURL: URL?
    @State private var isLoading = false
    @State private var error: Error?

    var body: some View {
        VStack {
            if isLoading {
                loadingView
            } else if let error = error {
                errorView(error: error)
            } else {
                fileInfoView
            }
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - File Info View

    private var fileInfoView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignTokens.Spacing.large) {
                // File header
                fileHeader

                Divider()

                // File metadata
                fileMetadata

                // Preview placeholder
                previewPlaceholder
            }
            .padding()
        }
    }

    // MARK: - File Header

    private var fileHeader: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.xsmall) {
            HStack {
                Image(systemName: "paperclip")
                    .font(.system(size: 20))
                    .foregroundColor(.gray)

                Text("File")
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

    // MARK: - File Metadata

    private var fileMetadata: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.small) {
            Text("File Information")
                .font(.subheadline)
                .fontWeight(.semibold)

            VStack(alignment: .leading, spacing: DesignTokens.Spacing.xsmall) {
                // File size
                if let fileSize = page.fileSize {
                    MetadataRow(label: "Size", value: formatFileSize(fileSize))
                }

                // MIME type
                if let mimeType = page.mimeType {
                    MetadataRow(label: "Type", value: mimeType)
                }

                // Original filename
                if let originalFileName = page.originalFileName {
                    MetadataRow(label: "Filename", value: originalFileName)
                }

                // Processing status
                if let status = page.processingStatus {
                    MetadataRow(label: "Status", value: status.capitalized)
                }
            }
            .padding(DesignTokens.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DesignTokens.Colors.separator.opacity(0.3))
            .cornerRadius(DesignTokens.CornerRadius.medium)
        }
    }

    // MARK: - Preview Placeholder

    private var previewPlaceholder: some View {
        VStack(spacing: DesignTokens.Spacing.medium) {
            Image(systemName: "doc.fill")
                .font(.system(size: 48))
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("File preview coming soon")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("Full file preview and download will be available in a future update.")
                .font(.caption)
                .foregroundColor(DesignTokens.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DesignTokens.Spacing.xxlarge)
    }

    // MARK: - Loading View

    private var loadingView: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            ProgressView()
                .scaleEffect(1.2)

            Text("Loading file...")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Error View

    private func errorView(error: Error) -> some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundColor(DesignTokens.Colors.error)

            Text("Failed to load file")
                .font(.headline)

            Text(error.localizedDescription)
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignTokens.Spacing.xlarge)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func formattedDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func formatFileSize(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useAll]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

// MARK: - Metadata Row Component

private struct MetadataRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label + ":")
                .font(.caption)
                .foregroundColor(DesignTokens.Colors.mutedText)

            Spacer()

            Text(value)
                .font(.body)
                .fontWeight(.medium)
        }
    }
}

#Preview {
    NavigationStack {
        FilePreviewView(
            page: Page(
                id: "1",
                driveId: "drive1",
                title: "example-document.pdf",
                type: .file,
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
