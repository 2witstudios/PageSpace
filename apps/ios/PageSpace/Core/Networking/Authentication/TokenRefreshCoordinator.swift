import Foundation

/// Thread-safe coordinator for JWT token refresh operations
/// Prevents multiple simultaneous refresh attempts and coordinates retry logic
actor TokenRefreshCoordinator {
    static let shared = TokenRefreshCoordinator()

    private var isRefreshing = false

    private init() {}

    // MARK: - Public Interface

    /// Attempt to refresh the authentication token if needed
    /// Returns true if refresh succeeded, false otherwise
    func refreshTokenIfNeeded() async throws -> Bool {
        // Check if another request is already refreshing
        if isRefreshing {
            // Wait a bit for the other refresh to complete
            try await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds
            // Return true if token is now available (refresh succeeded)
            return AuthManager.shared.getToken() != nil
        }

        // Try to begin refresh
        guard beginRefresh() else {
            // Another task started refreshing between check and begin
            try await Task.sleep(nanoseconds: 500_000_000)
            return AuthManager.shared.getToken() != nil
        }

        defer {
            endRefresh()
        }

        do {
            // Attempt to refresh the token (returns Void, throws on error)
            try await AuthManager.shared.refreshToken()

            // Check if we now have a valid token
            if AuthManager.shared.getToken() != nil {
                print("✅ Token refresh successful")
                return true
            } else {
                print("❌ Token refresh failed - no token after refresh")
                await MainActor.run {
                    AuthManager.shared.logout()
                }
                return false
            }
        } catch {
            print("❌ Token refresh error: \(error.localizedDescription)")
            // Clear tokens on error
            await MainActor.run {
                AuthManager.shared.logout()
            }
            return false
        }
    }

    // MARK: - Private Coordination

    private func beginRefresh() -> Bool {
        if isRefreshing {
            return false // Already refreshing
        }
        isRefreshing = true
        return true
    }

    private func endRefresh() {
        isRefreshing = false
    }

    func isCurrentlyRefreshing() -> Bool {
        return isRefreshing
    }
}
