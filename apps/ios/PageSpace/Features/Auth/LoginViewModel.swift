import Foundation
import Combine
import GoogleSignIn
import UIKit

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
            // Provide user-friendly error messages
            switch apiError {
            case .unauthorized:
                self.error = "Invalid email or password. Please try again."
            case .rateLimitExceeded:
                self.error = "Too many login attempts. Please wait a few minutes and try again."
            case .serverError:
                self.error = "Server error. Please try again later."
            case .networkError:
                self.error = "Network connection failed. Please check your internet."
            case .decodingError:
                self.error = "Unexpected response from server. Please try again."
            default:
                self.error = apiError.localizedDescription
            }
        } catch {
            self.error = "Unable to sign in. Please try again later."
        }

        isLoading = false
    }

    func signInWithGoogle() async {
        isLoading = true
        error = nil

        do {
            // Get the root view controller
            guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let rootViewController = windowScene.windows.first?.rootViewController else {
                throw NSError(
                    domain: "LoginViewModel",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Unable to find root view controller"]
                )
            }

            // Perform Google Sign-In
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: rootViewController)

            // Get ID token
            guard let idToken = result.user.idToken?.tokenString else {
                throw NSError(
                    domain: "LoginViewModel",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to get ID token from Google"]
                )
            }

            // Exchange ID token with backend
            _ = try await AuthManager.shared.loginWithGoogle(idToken: idToken)
            // Navigation handled by app root view
        } catch let apiError as APIError {
            // Provide user-friendly error messages for OAuth
            switch apiError {
            case .unauthorized:
                self.error = "Google authentication failed. Please try again."
            case .rateLimitExceeded:
                self.error = "Too many authentication attempts. Please wait a few minutes and try again."
            case .serverError:
                self.error = "Server error during Google Sign-In. Please try again later."
            case .networkError:
                self.error = "Network connection failed. Please check your internet."
            case .decodingError:
                self.error = "Unexpected response from server. Please try again."
            default:
                self.error = apiError.localizedDescription
            }
        } catch {
            // Check if user cancelled
            if (error as NSError).domain == "com.google.GIDSignIn" && (error as NSError).code == -5 {
                // User cancelled - don't show error
                self.error = nil
            } else {
                self.error = "Google Sign-In failed. Please try again."
            }
        }

        isLoading = false
    }
}
