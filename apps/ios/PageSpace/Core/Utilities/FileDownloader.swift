//
//  FileDownloader.swift
//  PageSpace
//
//  Utility for downloading files from PageSpace API with authentication.
//  Used for sharing/exporting files to iOS share sheet.
//

import Foundation
import os.log

/// Downloads files from PageSpace API with authentication for sharing/export
actor FileDownloader {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "PageSpace", category: "FileDownloader")

    /// Downloads a file from the API and prepares it for sharing
    /// - Parameter page: The page representing the file to download
    /// - Returns: A ShareableFile ready for iOS share sheet, or nil if download fails
    func downloadFile(page: Page) async -> ShareableFile? {
        guard page.type == .file else {
            logger.error("Page \(page.id) is not a FILE type")
            return nil
        }

        // Construct API endpoint URL
        let fileURLString = "\(AppEnvironment.apiBaseURL)/api/files/\(page.id)/view"

        guard let url = URL(string: fileURLString) else {
            logger.error("Invalid URL: \(fileURLString)")
            return nil
        }

        do {
            // Fetch auth tokens on MainActor
            let (token, csrfToken) = await MainActor.run {
                (AuthManager.shared.getToken(), AuthManager.shared.getCSRFToken())
            }

            // SECURITY: Create authenticated URLRequest
            var request = URLRequest(url: url)
            request.httpMethod = "GET"

            // Add authentication headers
            if let token = token {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            } else {
                logger.warning("No JWT token available for file download")
            }

            if let csrfToken = csrfToken {
                request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
            }

            // Make authenticated request
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                logger.error("Invalid HTTP response for file download")
                return nil
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                logger.error("Failed to download file: HTTP \(httpResponse.statusCode)")
                return nil
            }

            // Extract MIME type from response
            let mimeType = httpResponse.mimeType ?? page.mimeType ?? "application/octet-stream"

            // Determine filename
            let filename = determineFilename(
                page: page,
                mimeType: mimeType,
                contentDisposition: httpResponse.value(forHTTPHeaderField: "Content-Disposition")
            )

            logger.info("Successfully downloaded file: \(filename) (\(data.count) bytes)")

            return ShareableFile(
                data: data,
                filename: filename,
                mimeType: mimeType
            )

        } catch {
            logger.error("Error downloading file: \(error.localizedDescription)")
            return nil
        }
    }

    /// Determines the appropriate filename for the downloaded file
    private func determineFilename(page: Page, mimeType: String, contentDisposition: String?) -> String {
        // Try to extract filename from Content-Disposition header
        if let disposition = contentDisposition,
           let filenameMatch = disposition.range(of: "filename=\"([^\"]+)\"", options: .regularExpression) {
            let filename = String(disposition[filenameMatch])
                .replacingOccurrences(of: "filename=\"", with: "")
                .replacingOccurrences(of: "\"", with: "")
            if !filename.isEmpty {
                return filename
            }
        }

        // Use original filename if available
        if let originalFilename = page.originalFileName, !originalFilename.isEmpty {
            return originalFilename
        }

        // Fall back to page title with appropriate extension
        let baseName = page.title.isEmpty ? "file" : page.title
        let cleanName = baseName.replacingOccurrences(of: "/", with: "-")

        // Add extension based on MIME type if not present
        if !cleanName.contains(".") {
            let ext = extensionForMimeType(mimeType)
            return "\(cleanName).\(ext)"
        }

        return cleanName
    }

    /// Maps MIME types to file extensions
    private func extensionForMimeType(_ mimeType: String) -> String {
        switch mimeType.lowercased() {
        // Images
        case "image/png": return "png"
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "image/heic": return "heic"
        case "image/svg+xml": return "svg"

        // Documents
        case "application/pdf": return "pdf"
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "docx"
        case "application/msword": return "doc"
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return "xlsx"
        case "application/vnd.ms-excel": return "xls"
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation": return "pptx"
        case "application/vnd.ms-powerpoint": return "ppt"

        // Text
        case "text/plain": return "txt"
        case "text/html": return "html"
        case "text/markdown": return "md"
        case "application/json": return "json"
        case "application/xml", "text/xml": return "xml"

        // Archives
        case "application/zip": return "zip"
        case "application/x-tar": return "tar"
        case "application/gzip": return "gz"

        // Video
        case "video/mp4": return "mp4"
        case "video/quicktime": return "mov"
        case "video/x-msvideo": return "avi"

        // Audio
        case "audio/mpeg": return "mp3"
        case "audio/wav": return "wav"
        case "audio/aac": return "aac"

        default: return "bin"
        }
    }
}
