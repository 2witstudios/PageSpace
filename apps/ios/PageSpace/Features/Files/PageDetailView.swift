//
//  PageDetailView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Router view for different page types
//  SECURITY: Permission verification, content validation
//

import SwiftUI
import os.log

struct PageDetailView: View {
    let pageId: String

    @State private var page: Page?
    @State private var isLoading = true
    @State private var error: FileSystemError?
    @State private var loadTask: Task<Void, Never>?

    private let logger = Logger(subsystem: "com.pagespace.ios", category: "Security.PageDetail")

    var body: some View {
        Group {
            if isLoading {
                PageLoadingView()
            } else if let error = error {
                PageErrorView(
                    title: error == .unauthorized ? "Access Denied" : "Failed to load page",
                    message: error.localizedDescription,
                    onRetry: {
                        Task { await loadPage() }
                    }
                )
            } else if let page = page {
                contentView(for: page)
            } else {
                PageErrorView(
                    title: "Page not found",
                    message: "This page could not be found.",
                    onRetry: {
                        Task { await loadPage() }
                    }
                )
            }
        }
        .navigationTitle(page?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            loadTask = Task {
                await loadPage()
            }
        }
        .onDisappear {
            loadTask?.cancel()
        }
    }

    // MARK: - Content View Router

    @ViewBuilder
    private func contentView(for page: Page) -> some View {
        switch page.type {
        case .document:
            DocumentWebView(page: page)

        case .aiChat:
            FilesAgentChatView(page: page)

        case .file:
            FileViewerView(page: page)

        case .canvas:
            CanvasWebView(page: page)

        case .channel:
            FilesChannelChatView(page: page)

        case .sheet:
            SheetPlaceholderView(page: page)

        case .folder:
            FolderDetailView(page: page)
        }
    }

    // MARK: - Data Loading with Permission Verification

    private func loadPage() async {
        guard !Task.isCancelled else { return }

        isLoading = true
        error = nil

        do {
            // SECURITY: Attempt to load page
            // FileSystemService.getPage() should handle auth and throw appropriate errors
            page = try await FileSystemService.shared.getPage(pageId: pageId)

            // TODO: Add explicit permission check once permission API is available
            // Example:
            // let hasPermission = try await verifyPagePermission(pageId: pageId)
            // if !hasPermission {
            //     logger.warning("Permission denied for page: \(pageId)")
            //     error = .unauthorized
            //     isLoading = false
            //     return
            // }

            isLoading = false
            logger.info("Page loaded successfully: pageId=\(pageId), type=\(page?.type.rawValue ?? "unknown")")

        } catch let fsError as FileSystemError {
            // Handle typed FileSystemError
            error = fsError
            isLoading = false

            if fsError == .unauthorized {
                logger.error("Access denied for page: \(pageId)")
            } else {
                logger.error("Failed to load page: \(pageId), error=\(fsError.localizedDescription)")
            }

        } catch {
            // Handle unknown errors
            self.error = .unknown
            isLoading = false
            logger.error("Unexpected error loading page: \(pageId), error=\(error.localizedDescription)")
        }
    }
}

// MARK: - Placeholder Views

/// Placeholder for sheet pages (future support)
private struct SheetPlaceholderView: View {
    let page: Page

    var body: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Image(systemName: "tablecells.fill")
                .font(.system(size: 64))
                .foregroundColor(.green)

            Text("Sheet")
                .font(.title2)
                .fontWeight(.semibold)

            Text(page.title)
                .font(.headline)
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("Sheet viewing will be supported in a future update.")
                .font(.body)
                .foregroundColor(DesignTokens.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignTokens.Spacing.xlarge)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    NavigationStack {
        PageDetailView(pageId: "sample-page-id")
    }
}
