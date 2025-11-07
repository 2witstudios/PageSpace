import Foundation

/// Thread-safe coordinator for JWT token refresh operations
/// Prevents multiple simultaneous refresh attempts and coordinates retry logic
/// Uses continuations to ensure waiting requests receive the refresh result
actor TokenRefreshCoordinator {
    static let shared = TokenRefreshCoordinator()

    private var isRefreshing = false
    private var waitingContinuations: [CheckedContinuation<Bool, Error>] = []

    private init() {}

    // MARK: - Public Interface

    /// Attempt to refresh the authentication token if needed
    /// Returns true if refresh succeeded and token is valid, false otherwise
    /// If another refresh is in progress, suspends until that refresh completes
    func refreshTokenIfNeeded() async throws -> Bool {
        // If already refreshing, wait for that refresh to complete
        if isRefreshing {
            return try await withCheckedThrowingContinuation { continuation in
                waitingContinuations.append(continuation)
            }
        }

        // Begin refresh
        isRefreshing = true

        defer {
            isRefreshing = false
        }

        do {
            // Attempt to refresh the token (returns Void, throws on error)
            try await AuthManager.shared.refreshToken()

            // Verify we have a VALID (not expired) token
            if let token = AuthManager.shared.getToken(),
               !AuthManager.shared.isTokenExpired(token) {
                print("✅ Token refresh successful - token is valid")
                resumeWaitingRequests(with: true)
                return true
            } else {
                print("❌ Token refresh failed - no valid token after refresh")
                await MainActor.run {
                    AuthManager.shared.logout()
                }
                resumeWaitingRequests(with: false)
                return false
            }
        } catch {
            print("❌ Token refresh error: \(error.localizedDescription)")
            // Clear tokens on error
            await MainActor.run {
                AuthManager.shared.logout()
            }
            resumeWaitingRequests(with: false)
            return false
        }
    }

    // MARK: - Private Coordination

    /// Resume all waiting requests with the refresh result
    private func resumeWaitingRequests(with result: Bool) {
        for continuation in waitingContinuations {
            continuation.resume(returning: result)
        }
        waitingContinuations.removeAll()
    }

    /// Check if a refresh is currently in progress (for debugging/testing)
    func isCurrentlyRefreshing() -> Bool {
        return isRefreshing
    }
}
