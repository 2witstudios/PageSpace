import Foundation
import Combine

@MainActor
class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published var isAuthenticated = false
    @Published var currentUser: User?
    @Published var csrfToken: String?

    private let keychainService = "com.pagespace.mobile"
    private let tokenKey = "jwt_token"
    private let csrfKey = "csrf_token"

    private init() {
        // Load token from Keychain on init
        if let token = loadToken() {
            isAuthenticated = true
            // TODO: Validate token and load user info
        }
    }

    // MARK: - Authentication

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
        csrfToken = response.csrfToken
        saveCSRFToken(response.csrfToken)

        // Update state
        currentUser = response.user
        isAuthenticated = true

        return response.user
    }

    func logout() {
        deleteToken()
        deleteCSRFToken()
        currentUser = nil
        csrfToken = nil
        isAuthenticated = false
    }

    func getToken() -> String? {
        loadToken()
    }

    func getCSRFToken() -> String? {
        csrfToken ?? loadCSRFToken()
    }

    // MARK: - Keychain Operations

    private func saveToken(_ token: String) {
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

    private func loadToken() -> String? {
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

    private func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenKey
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func saveCSRFToken(_ token: String) {
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

    private func loadCSRFToken() -> String? {
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

    private func deleteCSRFToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: csrfKey
        ]
        SecItemDelete(query as CFDictionary)
    }
}
