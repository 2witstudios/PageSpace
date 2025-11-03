import Foundation
import Combine
import Security

class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @MainActor @Published var isAuthenticated = false
    @MainActor @Published var currentUser: User?
    @MainActor @Published var csrfToken: String?

    private let keychainService = "com.pagespace.mobile"
    private let tokenKey = "jwt_token"
    private let refreshTokenKey = "refresh_token"
    private let csrfKey = "csrf_token"

    private init() {
        // Load token from Keychain on init
        Task { @MainActor in
            if loadToken() != nil {
                // Validate token and load user info
                do {
                    try await loadCurrentUser()
                } catch {
                    // If token validation fails, logout
                    print("Failed to load user on init: \(error.localizedDescription)")
                    logout()
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

        // Save tokens to Keychain
        saveToken(response.token)
        saveRefreshToken(response.refreshToken)
        csrfToken = response.csrfToken
        saveCSRFToken(response.csrfToken)

        // Update state
        currentUser = response.user
        isAuthenticated = true

        // Verify token persistence before proceeding
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

        // Save tokens to Keychain
        saveToken(response.token)
        saveRefreshToken(response.refreshToken)
        csrfToken = response.csrfToken
        saveCSRFToken(response.csrfToken)

        // Update state
        currentUser = response.user
        isAuthenticated = true

        // Verify token persistence before proceeding
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

        // Save new tokens
        saveToken(response.token)
        saveRefreshToken(response.refreshToken)
        csrfToken = response.csrfToken
        saveCSRFToken(response.csrfToken)
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

    // MARK: - Keychain Operations

    nonisolated private func saveToken(_ token: String) {
        let data = token.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenKey,
            kSecValueData as String: data
        ]

        // Delete existing item first
        SecItemDelete(query as CFDictionary)

        // Add new item
        SecItemAdd(query as CFDictionary, nil)
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

    nonisolated private func saveCSRFToken(_ token: String) {
        let data = token.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: csrfKey,
            kSecValueData as String: data
        ]

        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
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

    nonisolated private func saveRefreshToken(_ token: String) {
        let data = token.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: refreshTokenKey,
            kSecValueData as String: data
        ]

        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
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
