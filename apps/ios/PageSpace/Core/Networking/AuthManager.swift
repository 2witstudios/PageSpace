import Foundation
import Combine
import Security
import GoogleSignIn

enum KeychainError: Error, LocalizedError {
    case encodingFailed
    case saveFailed(status: OSStatus)
    case loadFailed(status: OSStatus)

    var errorDescription: String? {
        switch self {
        case .encodingFailed:
            return "Failed to encode token for Keychain storage"
        case .saveFailed(let status):
            return "Failed to save to Keychain (status: \(status))"
        case .loadFailed(let status):
            return "Failed to load from Keychain (status: \(status))"
        }
    }
}

class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @MainActor @Published var isAuthenticated = false
    @MainActor @Published var currentUser: User?
    @MainActor @Published var csrfToken: String?

    private let keychainService = "com.pagespace.mobile"
    private let tokenKey = "jwt_token"
    private let refreshTokenKey = "refresh_token"
    private let csrfKey = "csrf_token"

    // Clock skew buffer for JWT expiration validation (in seconds)
    // Accounts for differences between server and device time
    private let clockSkewBufferSeconds: TimeInterval = 60

    private init() {
        // Load token from Keychain on init
        Task { @MainActor in
            if let token = loadToken() {
                // Check if token is expired before using it
                if isTokenExpired(token) {
                    print("Token expired on init - attempting refresh")
                    do {
                        try await refreshToken()
                        try await loadCurrentUser()
                    } catch {
                        print("Failed to refresh expired token: \(error.localizedDescription)")
                        logout()
                    }
                } else {
                    // Token is still valid, load user
                    do {
                        try await loadCurrentUser()
                    } catch {
                        print("Failed to load user on init: \(error.localizedDescription)")
                        logout()
                    }
                }
            }
        }
    }

    // MARK: - Authentication

    @MainActor
    func login(email: String, password: String) async throws -> User {
        let request = LoginRequest(email: email, password: password)
        let endpoint = APIEndpoints.login

        let response: LoginResponse = try await APIClient.shared.request(
            endpoint: endpoint,
            method: .POST,
            body: request
        )

        // Save tokens to Keychain (throws on failure)
        try saveToken(response.token)
        try saveRefreshToken(response.refreshToken)
        try saveCSRFToken(response.csrfToken)

        // Update state
        csrfToken = response.csrfToken
        currentUser = response.user
        isAuthenticated = true

        // Verify token persistence
        guard getToken() == response.token else {
            throw NSError(
                domain: "AuthManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to persist authentication token"]
            )
        }

        return response.user
    }

    @MainActor
    func signup(name: String, email: String, password: String, confirmPassword: String) async throws -> User {
        let request = SignupRequest(
            name: name,
            email: email,
            password: password,
            confirmPassword: confirmPassword
        )
        let endpoint = APIEndpoints.signup

        let response: LoginResponse = try await APIClient.shared.request(
            endpoint: endpoint,
            method: .POST,
            body: request
        )

        // Save tokens to Keychain (throws on failure)
        try saveToken(response.token)
        try saveRefreshToken(response.refreshToken)
        try saveCSRFToken(response.csrfToken)

        // Update state
        csrfToken = response.csrfToken
        currentUser = response.user
        isAuthenticated = true

        // Verify token persistence
        guard getToken() == response.token else {
            throw NSError(
                domain: "AuthManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to persist authentication token"]
            )
        }

        return response.user
    }

    @MainActor
    func loginWithGoogle(idToken: String) async throws -> User {
        let request = OAuthExchangeRequest(idToken: idToken)
        let endpoint = APIEndpoints.oauthGoogleExchange

        let response: LoginResponse = try await APIClient.shared.request(
            endpoint: endpoint,
            method: .POST,
            body: request
        )

        // Save tokens to Keychain (throws on failure)
        try saveToken(response.token)
        try saveRefreshToken(response.refreshToken)
        try saveCSRFToken(response.csrfToken)

        // Update state
        csrfToken = response.csrfToken
        currentUser = response.user
        isAuthenticated = true

        // Verify token persistence
        guard getToken() == response.token else {
            throw NSError(
                domain: "AuthManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to persist authentication token"]
            )
        }

        return response.user
    }

    @MainActor
    func refreshToken() async throws {
        guard let refreshToken = loadRefreshToken() else {
            throw APIError.unauthorized
        }

        let request = RefreshRequest(refreshToken: refreshToken)
        let endpoint = APIEndpoints.refresh

        let response: RefreshResponse = try await APIClient.shared.request(
            endpoint: endpoint,
            method: .POST,
            body: request
        )

        // Save new tokens (throws on failure)
        try saveToken(response.token)
        try saveRefreshToken(response.refreshToken)
        try saveCSRFToken(response.csrfToken)
        csrfToken = response.csrfToken
    }

    @MainActor
    func loadCurrentUser() async throws {
        let endpoint = APIEndpoints.me

        do {
            let user: User = try await APIClient.shared.request(
                endpoint: endpoint,
                method: .GET
            )

            // Update current user
            currentUser = user
            isAuthenticated = true
        } catch APIError.unauthorized {
            // Token is invalid or expired - clear authentication
            logout()
            throw APIError.unauthorized
        } catch {
            // Other errors - don't logout, just rethrow
            throw error
        }
    }

    @MainActor
    func logout() {
        deleteToken()
        deleteRefreshToken()
        deleteCSRFToken()
        currentUser = nil
        csrfToken = nil
        isAuthenticated = false
    }

    nonisolated func getToken() -> String? {
        loadToken()
    }

    nonisolated func getCSRFToken() -> String? {
        loadCSRFToken()
    }

    // MARK: - Token Validation

    /// Check if a JWT token is expired
    /// - Parameter token: The JWT token string
    /// - Returns: True if expired or invalid, false if still valid
    nonisolated private func isTokenExpired(_ token: String) -> Bool {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else {
            print("[AuthManager] JWT validation failed: Invalid JWT format (expected 3 parts, got \(parts.count))")
            return true
        }

        // Decode the payload (second part of JWT)
        var payload = String(parts[1])

        // Add base64 padding if needed
        let remainder = payload.count % 4
        if remainder > 0 {
            payload += String(repeating: "=", count: 4 - remainder)
        }

        // Convert URL-safe base64 to standard base64
        let base64 = payload
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        // Attempt to decode base64
        guard let data = Data(base64Encoded: base64) else {
            print("[AuthManager] JWT validation failed: Invalid base64 encoding in payload")
            return true
        }

        // Attempt to parse JSON
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            print("[AuthManager] JWT validation failed: Invalid JSON structure in payload")
            return true
        }

        // Check for exp claim
        guard let exp = json["exp"] as? TimeInterval else {
            print("[AuthManager] JWT validation failed: Missing or invalid 'exp' claim in payload")
            return true
        }

        // Check if token is expired (with buffer for clock skew)
        let now = Date().timeIntervalSince1970
        let isExpired = now > (exp - clockSkewBufferSeconds)

        if isExpired {
            let timeUntilExpiry = exp - now
            print("[AuthManager] Token expired: now=\(now), exp=\(exp), expired by \(-timeUntilExpiry)s")
        }

        return isExpired
    }

    // MARK: - Keychain Operations

    nonisolated private func saveToken(_ token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenKey,
            kSecValueData as String: data
        ]

        // Delete existing item first
        SecItemDelete(query as CFDictionary)

        // Add new item and check status
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status: status)
        }
    }

    nonisolated private func loadToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenKey,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }

        return token
    }

    nonisolated private func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenKey
        ]
        SecItemDelete(query as CFDictionary)
    }

    nonisolated private func saveCSRFToken(_ token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: csrfKey,
            kSecValueData as String: data
        ]

        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status: status)
        }
    }

    nonisolated private func loadCSRFToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: csrfKey,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }

        return token
    }

    nonisolated private func deleteCSRFToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: csrfKey
        ]
        SecItemDelete(query as CFDictionary)
    }

    nonisolated private func saveRefreshToken(_ token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: refreshTokenKey,
            kSecValueData as String: data
        ]

        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status: status)
        }
    }

    nonisolated private func loadRefreshToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: refreshTokenKey,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }

        return token
    }

    nonisolated private func deleteRefreshToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: refreshTokenKey
        ]
        SecItemDelete(query as CFDictionary)
    }
}
