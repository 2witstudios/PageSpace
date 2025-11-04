//
//  FileViewerView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Multi-format file viewer (PDF, images, QuickLook)
//  SECURITY: URL validation, HTTPS only, domain allowlist
//

import SwiftUI
import PDFKit
import QuickLook
import os.log

struct FileViewerView: View {
    let page: Page

    private let logger = Logger(subsystem: "com.pagespace.ios", category: "Security.FileViewer")
    @State private var shareableFile: ShareableFile?
    @State private var isPreparingShare = false

    var body: some View {
        VStack(spacing: 0) {
            // File metadata header
            FileMetadataHeader(page: page)

            Divider()

            // File content viewer
            FileContentView(page: page, logger: logger)
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                shareButton
            }
        }
    }

    @ViewBuilder
    private var shareButton: some View {
        if let shareableFile {
            ShareLink(
                item: shareableFile,
                preview: SharePreview(
                    shareableFile.filename,
                    image: Image(systemName: "doc")
                )
            ) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        } else {
            Button(action: {
                Task {
                    await prepareFileForSharing()
                }
            }) {
                if isPreparingShare {
                    ProgressView()
                } else {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
            .disabled(isPreparingShare)
        }
    }

    private func prepareFileForSharing() async {
        isPreparingShare = true
        defer { isPreparingShare = false }

        let downloader = FileDownloader()
        shareableFile = await downloader.downloadFile(page: page)

        if shareableFile == nil {
            logger.error("Failed to prepare file for sharing: \(page.id)")
            // Could show an alert here in future enhancement
        }
    }
}

// MARK: - URL Security Validation

private func validateFileURL(_ urlString: String?) -> URL? {
    guard let urlString = urlString,
          let url = URL(string: urlString),
          let scheme = url.scheme?.lowercased(),
          let host = url.host?.lowercased() else {
        return nil
    }

    // SECURITY: Validate scheme (HTTPS in production, HTTP allowed in DEBUG)
    #if DEBUG
    guard scheme == "https" || scheme == "http" else {
        Logger(subsystem: "com.pagespace.ios", category: "Security")
            .warning("Blocked non-HTTP/HTTPS URL: \(urlString)")
        return nil
    }
    #else
    guard scheme == "https" else {
        Logger(subsystem: "com.pagespace.ios", category: "Security")
            .warning("Blocked non-HTTPS URL: \(urlString)")
        return nil
    }
    #endif

    // SECURITY: Domain allowlist - derive from AppEnvironment
    let apiHost = AppEnvironment.apiBaseURL.host?.lowercased() ?? "localhost"
    let allowedDomains = [apiHost]

    // Check if host matches any allowed domain (ignoring port)
    let isAllowed = allowedDomains.contains { allowedDomain in
        host == allowedDomain || host.hasSuffix(".\(allowedDomain)")
    }

    guard isAllowed else {
        Logger(subsystem: "com.pagespace.ios", category: "Security")
            .warning("Blocked URL from unauthorized domain: \(host), expected: \(allowedDomains)")
        return nil
    }

    // SECURITY: Prevent directory traversal
    let path = url.path
    guard !path.contains("..") && !path.contains("//") else {
        Logger(subsystem: "com.pagespace.ios", category: "Security")
            .warning("Blocked URL with path traversal: \(path)")
        return nil
    }

    return url
}

// MARK: - File Metadata Header

private struct FileMetadataHeader: View {
    let page: Page

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.small) {
            if let fileName = page.originalFileName {
                HStack(spacing: DesignTokens.Spacing.xsmall) {
                    Image(systemName: fileIcon)
                        .foregroundColor(DesignTokens.Colors.brandBlue)
                    Text(fileName)
                        .font(.subheadline)
                        .fontWeight(.medium)
                }
            }

            HStack(spacing: DesignTokens.Spacing.medium) {
                if let mimeType = page.mimeType {
                    Label(mimeType, systemImage: "doc.text")
                        .font(.caption)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }

                if let fileSize = page.fileSize {
                    Label(formatFileSize(fileSize), systemImage: "arrow.down.circle")
                        .font(.caption)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }
            }
        }
        .padding(DesignTokens.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
    }

    private var fileIcon: String {
        guard let mimeType = page.mimeType else { return "doc" }

        if mimeType.starts(with: "image/") {
            return "photo"
        } else if mimeType == "application/pdf" {
            return "doc.text.fill"
        } else if mimeType.contains("word") || mimeType.contains("document") {
            return "doc.richtext"
        } else if mimeType.contains("sheet") || mimeType.contains("excel") {
            return "tablecells"
        } else {
            return "doc"
        }
    }

    private func formatFileSize(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

// MARK: - File Content View

private struct FileContentView: View {
    let page: Page
    let logger: Logger

    var body: some View {
        Group {
            // SECURITY: Check file size before attempting to load
            if let fileSize = page.fileSize, fileSize > 50_000_000 {
                // File too large (>50MB)
                VStack(spacing: DesignTokens.Spacing.large) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 48))
                        .foregroundColor(DesignTokens.Colors.error)

                    Text("File Too Large")
                        .font(.headline)

                    Text("This file is too large to preview on mobile (max 50MB).")
                        .font(.subheadline)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, DesignTokens.Spacing.xlarge)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let mimeType = page.mimeType {
                if mimeType.starts(with: "image/") {
                    ImageViewer(page: page, logger: logger)
                } else if mimeType == "application/pdf" {
                    PDFViewer(page: page, logger: logger)
                } else {
                    QuickLookViewer(page: page)
                }
            } else {
                UnsupportedFileView(page: page)
            }
        }
    }
}

// MARK: - Image Viewer

private struct ImageViewer: View {
    let page: Page
    let logger: Logger

    var body: some View {
        Group {
            // Construct API endpoint URL for file viewing
            let fileURLString = "\(AppEnvironment.apiBaseURL)/api/files/\(page.id)/view"
            if let validURL = validateFileURL(fileURLString) {
                // SECURITY: URL validated, safe to load with authentication
                // Use UIScrollView-based zoom view (same approach as PDFViewer)
                ZoomableImageView(url: validURL, logger: logger)
            } else {
                // SECURITY: Invalid or missing URL
                VStack(spacing: DesignTokens.Spacing.medium) {
                    Image(systemName: "exclamationmark.shield.fill")
                        .font(.system(size: 48))
                        .foregroundColor(DesignTokens.Colors.error)
                    Text("Invalid or insecure image URL")
                        .font(.subheadline)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }
                .onAppear {
                    logger.error("Invalid image URL for page: \(page.id)")
                }
            }
        }
    }
}

// MARK: - PDF Viewer

private struct PDFViewer: View {
    let page: Page
    let logger: Logger

    var body: some View {
        Group {
            // Construct API endpoint URL for file viewing
            let fileURLString = "\(AppEnvironment.apiBaseURL)/api/files/\(page.id)/view"
            if let validURL = validateFileURL(fileURLString) {
                // SECURITY: URL validated, safe to load
                PDFKitView(url: validURL, logger: logger)
            } else {
                // SECURITY: Invalid or missing URL
                VStack(spacing: DesignTokens.Spacing.medium) {
                    Image(systemName: "exclamationmark.shield.fill")
                        .font(.system(size: 48))
                        .foregroundColor(DesignTokens.Colors.error)
                    Text("Invalid or insecure PDF URL")
                        .font(.subheadline)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }
                .onAppear {
                    logger.error("Invalid PDF URL for page: \(page.id)")
                }
            }
        }
    }
}

private struct PDFKitView: UIViewRepresentable {
    let url: URL
    let logger: Logger

    @State private var isLoading = true

    func makeUIView(context: Context) -> PDFView {
        let pdfView = PDFView()
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical

        // Load PDF asynchronously to avoid blocking UI
        Task {
            do {
                // SECURITY: Create authenticated URLRequest
                var request = URLRequest(url: url)
                request.httpMethod = "GET"

                // Add authentication headers
                if let token = AuthManager.shared.getToken() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                } else {
                    logger.warning("No JWT token available for PDF request")
                }

                if let csrfToken = AuthManager.shared.getCSRFToken() {
                    request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
                }

                // Make authenticated request
                let (data, response) = try await URLSession.shared.data(for: request)

                guard let httpResponse = response as? HTTPURLResponse,
                      (200...299).contains(httpResponse.statusCode) else {
                    logger.error("Failed to load PDF: Invalid HTTP response (status: \((response as? HTTPURLResponse)?.statusCode ?? -1))")
                    return
                }

                // Verify content type
                if let contentType = httpResponse.mimeType,
                   !contentType.starts(with: "application/pdf") {
                    logger.warning("PDF URL returned unexpected content type: \(contentType)")
                }

                if let document = PDFDocument(data: data) {
                    await MainActor.run {
                        pdfView.document = document
                    }
                } else {
                    logger.error("Failed to create PDFDocument from data")
                }
            } catch {
                logger.error("Failed to load PDF: \(error.localizedDescription)")
            }
        }

        return pdfView
    }

    func updateUIView(_ pdfView: PDFView, context: Context) {
        // No updates needed
    }
}

// MARK: - QuickLook Viewer

private struct QuickLookViewer: View {
    let page: Page
    @State private var showingPreview = false

    var body: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 64))
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("Preview Available")
                .font(.headline)

            Text(page.originalFileName ?? "Document")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)

            Button {
                showingPreview = true
            } label: {
                Text("Open Preview")
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, DesignTokens.Spacing.large)
                    .padding(.vertical, DesignTokens.Spacing.small)
                    .background(DesignTokens.Colors.brandBlue)
                    .cornerRadius(DesignTokens.CornerRadius.medium)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showingPreview) {
            // In production, would show QuickLook preview
            Text("QuickLook Preview would appear here")
        }
    }
}

// MARK: - Unsupported File View

private struct UnsupportedFileView: View {
    let page: Page

    var body: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Image(systemName: "doc.questionmark")
                .font(.system(size: 64))
                .foregroundColor(DesignTokens.Colors.mutedText)

            Text("Unsupported File Type")
                .font(.headline)

            Text("This file type cannot be previewed on mobile.")
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignTokens.Spacing.xlarge)

            Button {
                // In production, would trigger download
                print("Download tapped")
            } label: {
                Label("Download", systemImage: "arrow.down.circle")
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
}

#Preview("PDF") {
    NavigationStack {
        FileViewerView(
            page: Page(
                id: "1",
                driveId: "drive1",
                title: "Sample PDF",
                type: .file,
                parentId: nil,
                position: 1.0,
                createdAt: Date(),
                updatedAt: Date(),
                fileSize: 1024000,
                mimeType: "application/pdf",
                originalFileName: "document.pdf",
                filePath: "/files/sample.pdf"
            )
        )
    }
}

#Preview("Image") {
    NavigationStack {
        FileViewerView(
            page: Page(
                id: "2",
                driveId: "drive1",
                title: "Sample Image",
                type: .file,
                parentId: nil,
                position: 1.0,
                createdAt: Date(),
                updatedAt: Date(),
                fileSize: 2048000,
                mimeType: "image/png",
                originalFileName: "photo.png",
                filePath: "/files/photo.png"
            )
        )
    }
}
