//
//  FileSystemService.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Manages drive and page file system state for navigation
//

import Foundation
import Combine
import os.log

// MARK: - File System Error

enum FileSystemError: Error, Equatable {
    case loadFailed(String)
    case networkError
    case unauthorized
    case notFound
    case unknown

    var localizedDescription: String {
        switch self {
        case .loadFailed(let message):
            return message
        case .networkError:
            return "Network connection failed. Please check your internet connection."
        case .unauthorized:
            return "You don't have permission to access this content."
        case .notFound:
            return "The requested content was not found."
        case .unknown:
            return "An unexpected error occurred. Please try again."
        }
    }
}

// MARK: - Drive Item Model

/// Represents a drive with its page tree
struct DriveItem: Identifiable {
    let id: String
    let drive: Drive
    let pages: [Page]
}

// MARK: - File System Service

/// Manages unified file tree with drives at root level
@MainActor
class FileSystemService: ObservableObject {
    static let shared = FileSystemService()

    private let apiClient = APIClient.shared
    private let logger = Logger(subsystem: "com.pagespace.ios", category: "FileSystem")

    // MARK: - Published State

    @Published var driveItems: [DriveItem] = []
    @Published var isLoading = false
    @Published var error: FileSystemError?

    // MARK: - Initialization

    private init() {}

    // MARK: - Drive Operations

    /// Load all drives and their page trees, merging into unified view
    func loadDrives() async {
        isLoading = true
        error = nil

        do {
            // Fetch all drives
            let drives: [Drive] = try await apiClient.request(
                endpoint: APIEndpoints.drives,
                method: .GET,
                body: nil as String?,
                queryParams: nil
            )

            // Fetch pages for each drive in parallel
            let items = try await withThrowingTaskGroup(of: DriveItem.self) { group in
                for drive in drives {
                    group.addTask {
                        let pages: [Page] = try await self.apiClient.request(
                            endpoint: APIEndpoints.drivePages(driveId: drive.id),
                            method: .GET,
                            body: nil as String?,
                            queryParams: nil
                        )
                        return DriveItem(id: drive.id, drive: drive, pages: pages)
                    }
                }

                var result: [DriveItem] = []
                for try await item in group {
                    result.append(item)
                }
                return result
            }

            // Sort: owned drives first, then alphabetical
            driveItems = items.sorted { lhs, rhs in
                // Prioritize owned drives
                if lhs.drive.isOwned != rhs.drive.isOwned {
                    return lhs.drive.isOwned == true
                }
                // Then sort alphabetically
                return lhs.drive.name < rhs.drive.name
            }

            isLoading = false
        } catch let apiError as APIError {
            isLoading = false
            switch apiError {
            case .unauthorized:
                self.error = .unauthorized
                logger.error("Failed to load drives: Unauthorized")
            case .networkError:
                self.error = .networkError
                logger.error("Failed to load drives: Network error")
            default:
                self.error = .loadFailed("Failed to load drives")
                logger.error("Failed to load drives: \(apiError.localizedDescription)")
            }
        } catch {
            isLoading = false
            self.error = .unknown
            logger.error("Failed to load drives: \(error.localizedDescription)")
        }
    }

    /// Refresh all drives and their page trees
    func refreshDrives() async {
        await loadDrives()
    }

    /// Get a specific page by ID
    func getPage(pageId: String) async throws -> Page {
        isLoading = true
        error = nil

        defer {
            isLoading = false
        }

        do {
            let page: Page = try await apiClient.request(
                endpoint: APIEndpoints.page(pageId: pageId),
                method: .GET,
                body: nil as String?,
                queryParams: nil
            )
            return page
        } catch let apiError as APIError {
            switch apiError {
            case .unauthorized:
                self.error = .unauthorized
                logger.error("Failed to load page: Unauthorized")
            case .notFound:
                self.error = .notFound
                logger.error("Failed to load page: Not found")
            case .networkError:
                self.error = .networkError
                logger.error("Failed to load page: Network error")
            default:
                self.error = .loadFailed("Failed to load page")
                logger.error("Failed to load page: \(apiError.localizedDescription)")
            }
            throw apiError
        } catch {
            self.error = .unknown
            logger.error("Failed to load page: \(error.localizedDescription)")
            throw error
        }
    }

    // MARK: - Helper Methods

    /// Find a page in the tree by ID (recursive search across all drives)
    func findPage(id: String) -> Page? {
        for driveItem in driveItems {
            if let found = findPageInTree(id: id, pages: driveItem.pages) {
                return found
            }
        }
        return nil
    }

    private func findPageInTree(id: String, pages: [Page]) -> Page? {
        for page in pages {
            if page.id == id {
                return page
            }
            if let children = page.children, let found = findPageInTree(id: id, pages: children) {
                return found
            }
        }
        return nil
    }

    /// Clear all state (useful for logout)
    func reset() {
        driveItems = []
        isLoading = false
        error = nil
    }
}
