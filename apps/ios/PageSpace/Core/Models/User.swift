import Foundation

struct User: Identifiable, Codable {
    let id: String
    let email: String
    let name: String?
    let image: String?
}

struct LoginRequest: Codable {
    let email: String
    let password: String
}

struct SignupRequest: Codable {
    let name: String
    let email: String
    let password: String
    let confirmPassword: String
}

struct LoginResponse: Codable {
    let user: User
    let token: String
    let refreshToken: String
    let csrfToken: String
}

struct RefreshRequest: Codable {
    let refreshToken: String
}

struct RefreshResponse: Codable {
    let token: String
    let refreshToken: String
    let csrfToken: String
}

struct AISettings: Codable {
    let provider: String
    let model: String
    let apiKeys: [String: String]?

    enum CodingKeys: String, CodingKey {
        case provider, model, apiKeys
    }
}
