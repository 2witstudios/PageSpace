//
//  ShareableFile.swift
//  PageSpace
//
//  A model representing a file that can be shared via iOS native share sheet.
//  Conforms to Transferable protocol for seamless ShareLink integration.
//

import SwiftUI
import UniformTypeIdentifiers

/// A file that can be shared via iOS share sheet to Files app, email, messages, etc.
struct ShareableFile: Transferable {
    let data: Data
    let filename: String
    let mimeType: String

    /// Determines the appropriate UTType based on MIME type
    private var contentType: UTType {
        // Map MIME types to UTTypes
        switch mimeType.lowercased() {
        // Images
        case "image/png":
            return .png
        case "image/jpeg", "image/jpg":
            return .jpeg
        case "image/gif":
            return .gif
        case "image/webp":
            return .webP
        case "image/heic":
            return .heic
        case "image/svg+xml":
            return .svg

        // Documents
        case "application/pdf":
            return .pdf
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            return .init(filenameExtension: "docx") ?? .data
        case "application/msword":
            return .init(filenameExtension: "doc") ?? .data
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
            return .init(filenameExtension: "xlsx") ?? .data
        case "application/vnd.ms-excel":
            return .init(filenameExtension: "xls") ?? .data
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
            return .init(filenameExtension: "pptx") ?? .data
        case "application/vnd.ms-powerpoint":
            return .init(filenameExtension: "ppt") ?? .data

        // Text
        case "text/plain":
            return .plainText
        case "text/html":
            return .html
        case "text/markdown":
            return .init(filenameExtension: "md") ?? .plainText
        case "application/json":
            return .json
        case "application/xml", "text/xml":
            return .xml

        // Archives
        case "application/zip":
            return .zip
        case "application/x-tar":
            return .init(filenameExtension: "tar") ?? .data
        case "application/gzip":
            return .init(filenameExtension: "gz") ?? .data

        // Video
        case "video/mp4":
            return .mpeg4Movie
        case "video/quicktime":
            return .quickTimeMovie
        case "video/x-msvideo":
            return .avi

        // Audio
        case "audio/mpeg":
            return .mp3
        case "audio/wav":
            return .wav
        case "audio/aac":
            return .init(filenameExtension: "aac") ?? .audio

        // Default fallback
        default:
            // Try to infer from filename extension
            if let ext = filename.split(separator: ".").last,
               let type = UTType(filenameExtension: String(ext)) {
                return type
            }
            return .data
        }
    }

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data, exporting: { file in
            // Create temporary file with proper filename
            let fileURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(file.filename)

            // Write data to temporary file
            try file.data.write(to: fileURL)

            // Return file for transfer
            return SentTransferredFile(fileURL)
        })
    }
}
