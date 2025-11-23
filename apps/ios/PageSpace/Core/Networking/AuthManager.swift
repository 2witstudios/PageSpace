import Foundation
import Combine
import Security
import GoogleSignIn
import UIKit

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

@MainActor
class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published var isAuthenticated = false
    @Published var isCheckingAuth = true
    @Published var currentUser: User?
    @Published var csrfToken: String?

    private let keychainService = "com.pagespace.mobile"
    private let tokenKey = "jwt_token"
    private let csrfKey = "csrf_token"
    private let deviceTokenKey = "device_token"
    private let deviceIdKey = "device_id"

    // Clock skew buffer for JWT expiration validation (in seconds)
    // Accounts for differences between server and device time
    private let clockSkewBufferSeconds: TimeInterval = 60

    private let platformIdentifier = "ios"

    private init() {
        // Load token from Keychain on init
        Task {
            isCheckingAuth = true

            if let token = loadToken() {
                // Check if token is expired before using it
                if isTokenExpired(token) {
                    print("Token expired on init - attempting device token refresh")
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
            } else if let storedDeviceToken = loadDeviceToken() {
                print("[AuthManager] No access token found - attempting device token authentication")
                do {
                    try await authenticateWithDeviceToken(storedDeviceToken)
                    try await loadCurrentUser()
                } catch {
                    print("[AuthManager] Device token authentication failed: \(error.localizedDescription)")
                    logout()
                }
            }

            isCheckingAuth = false
        }
    }

    // MARK: - Device Metadata Helpers

    nonisolated private func ensureDeviceIdentifier() -> String {
        if let stored = loadDeviceIdentifier() {
            return stored
        }

        let identifier = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        do {
            try saveDeviceIdentifier(identifier)
        } catch {
            print("[AuthManager] Failed to persist device identifier: \(error.localizedDescription)")
        }
        return identifier
    }

    nonisolated private func currentDeviceName() -> String {
        UIDevice.current.name
    }

    nonisolated private func currentUserAgent() -> String {
        let device = UIDevice.current
        return "\(device.model)/\(device.systemName) \(device.systemVersion)"
    }

    nonisolated private func currentAppVersion() -> String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    // MARK: - Authentication

    func login(email: String, password: String) async throws -> User {
        let request = LoginRequest(
            email: email,
            password: password,
            deviceId: ensureDeviceIdentifier(),
            platform: platformIdentifier,
            deviceName: currentDeviceName(),
            appVersion: currentAppVersion(),
            deviceToken: loadDeviceToken()
        )
        let endpoint = APIEndpoints.login

        let response: LoginResponse = try await APIClient.shared.request(
            endpoint: endpoint,
            method: .POST,
            body: request
        )

        // Save tokens to Keychain (device-token-only pattern)
        try saveToken(response.token)
        try saveCSRFToken(response.csrfToken)
        try saveDeviceToken(response.deviceToken)

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

    func signup(name: String, email: String, password: String, confirmPassword: String) async throws -> User {
        let request = SignupRequest(
            name: name,
            email: email,
            password: password,
            confirmPassword: confirmPassword,
            deviceId: ensureDeviceIdentifier(),
            platform: platformIdentifier,
            deviceName: currentDeviceName(),
            appVersion: currentAppVersion()
        )
        let endpoint = APIEndpoints.signup

        let response: LoginResponse = try await APIClient.shared.request(
            endpoint: endpoint,
            method: .POST,
            body: request
        )

        // Save tokens to Keychain (device-token-only pattern)
        try saveToken(response.token)
        try saveCSRFToken(response.csrfToken)
        try saveDeviceToken(response.deviceToken)

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

    func loginWithGoogle(idToken: String) async throws -> User {
        let request = OAuthExchangeRequest(
            idToken: idToken,
            deviceId: ensureDeviceIdentifier(),
            platform: platformIdentifier,
            deviceName: currentDeviceName(),
            appVersion: currentAppVersion(),
            deviceToken: loadDeviceToken()
        )
        let endpoint = APIEndpoints.oauthGoogleExchange

        let response: LoginResponse = try await APIClient.shared.request(
            endpoint: endpoint,
            method: .POST,
            body: request
        )

        // Save tokens to Keychain (device-token-only pattern)
        try saveToken(response.token)
        try saveCSRFToken(response.csrfToken)
        try saveDeviceToken(response.deviceToken)

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

    func refreshToken() async throws {
        // Device-token-only pattern: Use device token for refresh (90-day sessions)
        guard let deviceToken = loadDeviceToken() else {
            throw APIError.unauthorized
        }

        let request = RefreshRequest(
            deviceToken: deviceToken,
            deviceId: ensureDeviceIdentifier(),
            platform: platformIdentifier
        )

        let response: RefreshResponse = try await APIClient.shared.request(
            endpoint: APIEndpoints.refresh,
            method: .POST,
            body: request
        )

        // Save new tokens (no refresh token in response anymore)
        try saveToken(response.token)
        try saveCSRFToken(response.csrfToken)
        try saveDeviceToken(response.deviceToken)
        csrfToken = response.csrfToken
    }

    private func authenticateWithDeviceToken(_ deviceToken: String) async throws {
        let request = DeviceRefreshRequest(
            deviceToken: deviceToken,
            deviceId: ensureDeviceIdentifier(),
            userAgent: currentUserAgent(),
            appVersion: currentAppVersion()
        )

        let response: RefreshResponse = try await APIClient.shared.request(
            endpoint: APIEndpoints.deviceRefresh,
            method: .POST,
            body: request
        )

        try saveToken(response.token)
        try saveCSRFToken(response.csrfToken)
        try saveDeviceToken(response.deviceToken)
        csrfToken = response.csrfToken
        isAuthenticated = true
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

    func logout() {
        deleteToken()
        deleteCSRFToken()
        deleteDeviceToken()
        currentUser = nil
        csrfToken = nil
        isAuthenticated = false
        isCheckingAuth = false
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
    nonisolated func isTokenExpired(_ token: String) -> Bool {
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

    /// Check if a JWT token is expiring soon (within buffer period)
    /// - Parameters:
    ///   - token: The JWT token string
    ///   - bufferSeconds: Time buffer in seconds (default 300 = 5 minutes)
    /// - Returns: True if token expires within buffer period
    nonisolated func isTokenExpiringSoon(_ token: String, bufferSeconds: TimeInterval = 300) -> Bool {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return true }

        var payload = String(parts[1])
        let remainder = payload.count % 4
        if remainder > 0 {
            payload += String(repeating: "=", count: 4 - remainder)
        }

        let base64 = payload
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = json["exp"] as? TimeInterval else {
            return true
        }

        let now = Date().timeIntervalSince1970
        return now > (exp - bufferSeconds)
    }

    // MARK: - Proactive Token Refresh

    /// Extract expiry timestamp from JWT token
    /// - Parameter token: The JWT token string
    /// - Returns: Expiry timestamp as TimeInterval, or 0 if invalid
    nonisolated private func getTokenExpiryTime(_ token: String) -> TimeInterval {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return 0 }

        var payload = String(parts[1])
        let remainder = payload.count % 4
        if remainder > 0 {
            payload += String(repeating: "=", count: 4 - remainder)
        }

        let base64 = payload
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = json["exp"] as? TimeInterval else {
            return 0
        }

        return exp
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

    nonisolated private func saveDeviceToken(_ token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: deviceTokenKey,
            kSecValueData as String: data
        ]

        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status: status)
        }
    }

    nonisolated private func loadDeviceToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: deviceTokenKey,
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

    nonisolated private func deleteDeviceToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: deviceTokenKey
        ]
        SecItemDelete(query as CFDictionary)
    }

    nonisolated private func saveDeviceIdentifier(_ identifier: String) throws {
        guard let data = identifier.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: deviceIdKey,
            kSecValueData as String: data
        ]

        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status: status)
        }
    }

    nonisolated private func loadDeviceIdentifier() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: deviceIdKey,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let identifier = String(data: data, encoding: .utf8) else {
            return nil
        }

        return identifier
    }
}
