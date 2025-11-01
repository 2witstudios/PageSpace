import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var authManager: AuthManager
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                Section("Account") {
                    if let user = authManager.currentUser {
                        HStack {
                            Text("Email")
                            Spacer()
                            Text(user.email)
                                .foregroundColor(.secondary)
                        }

                        if let name = user.name {
                            HStack {
                                Text("Name")
                                Spacer()
                                Text(name)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }

                Section("AI Settings") {
                    NavigationLink {
                        AISettingsView()
                    } label: {
                        HStack {
                            Image(systemName: "brain")
                            Text("Provider & Model")
                        }
                    }
                }

                Section {
                    Button(role: .destructive) {
                        authManager.logout()
                    } label: {
                        HStack {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                            Text("Sign Out")
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

struct AISettingsView: View {
    @State private var settings: AISettings?
    @State private var isLoading = false
    @State private var error: String?

    private let aiService = AIService.shared

    var body: some View {
        List {
            if isLoading {
                ProgressView()
            } else if let settings = settings {
                Section("Current Configuration") {
                    HStack {
                        Text("Provider")
                        Spacer()
                        Text(settings.provider)
                            .foregroundColor(.secondary)
                    }

                    HStack {
                        Text("Model")
                        Spacer()
                        Text(settings.model)
                            .foregroundColor(.secondary)
                    }
                }

                if let error = error {
                    Section {
                        Text(error)
                            .foregroundColor(.red)
                            .font(.caption)
                    }
                }
            }
        }
        .navigationTitle("AI Settings")
        .task {
            await loadSettings()
        }
    }

    private func loadSettings() async {
        isLoading = true
        error = nil

        do {
            settings = try await aiService.getSettings()
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }
}

#Preview {
    SettingsView()
        .environmentObject(AuthManager.shared)
}
