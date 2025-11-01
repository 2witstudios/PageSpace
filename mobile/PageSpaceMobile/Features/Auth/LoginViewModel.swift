import Foundation
import Combine

@MainActor
class LoginViewModel: ObservableObject {
    @Published var email = ""
    @Published var password = ""
    @Published var isLoading = false
    @Published var error: String?

    var isFormValid: Bool {
        !email.isEmpty && !password.isEmpty && email.contains("@")
    }

    func login() async {
        guard isFormValid else {
            error = "Please enter a valid email and password"
            return
        }

        isLoading = true
        error = nil

        do {
            _ = try await AuthManager.shared.login(email: email, password: password)
            // Navigation handled by app root view
        } catch let apiError as APIError {
            error = apiError.localizedDescription
        } catch {
            error = "Login failed: \(error.localizedDescription)"
        }

        isLoading = false
    }
}
