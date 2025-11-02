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
    @State private var isSaving = false
    @State private var error: String?
    @State private var successMessage: String?
    @State private var selectedProvider: String = "pagespace"
    @State private var selectedModel: String = "glm-4.5-air"

    private let aiService = AIService.shared

    var body: some View {
        List {
            if isLoading {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } else if let settings = settings {
                // Provider Selection
                Section {
                    Picker("Provider", selection: $selectedProvider) {
                        ForEach(getProviderList(), id: \.self) { providerId in
                            HStack {
                                Text(getProviderName(providerId))
                                if !isProviderConfigured(providerId, in: settings) {
                                    Text("(Setup Required)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }
                            .tag(providerId)
                        }
                    }
                    .onChange(of: selectedProvider) { oldValue, newValue in
                        // Update model to default for new provider
                        selectedModel = getDefaultModel(for: newValue)
                    }

                    Picker("Model", selection: $selectedModel) {
                        ForEach(Array(getModelsForProvider(selectedProvider).sorted(by: { $0.key < $1.key })), id: \.key) { key, value in
                            Text(value)
                                .tag(key)
                        }
                    }
                    .disabled(getModelsForProvider(selectedProvider).isEmpty)
                } header: {
                    Text("Default AI Provider")
                } footer: {
                    Text("Choose your default AI provider and model. This can be overridden per conversation.")
                        .font(.caption)
                }

                // Save Button
                Section {
                    Button {
                        Task {
                            await saveSettings()
                        }
                    } label: {
                        if isSaving {
                            HStack {
                                Spacer()
                                ProgressView()
                                    .progressViewStyle(.circular)
                                Text("Saving...")
                                Spacer()
                            }
                        } else {
                            HStack {
                                Spacer()
                                Text("Save Settings")
                                Spacer()
                            }
                        }
                    }
                    .disabled(
                        isSaving ||
                        !isProviderConfigured(selectedProvider, in: settings) ||
                        (selectedProvider == settings.currentProvider && selectedModel == settings.currentModel)
                    )
                }

                // Provider Status
                Section {
                    ProviderStatusRow(
                        provider: "PageSpace",
                        isConfigured: settings.providers.pagespace?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "OpenRouter",
                        isConfigured: settings.providers.openrouter?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "Google AI",
                        isConfigured: settings.providers.google?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "OpenAI",
                        isConfigured: settings.providers.openai?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "Anthropic",
                        isConfigured: settings.providers.anthropic?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "xAI",
                        isConfigured: settings.providers.xai?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "Ollama",
                        isConfigured: settings.providers.ollama?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "LM Studio",
                        isConfigured: settings.providers.lmstudio?.isConfigured ?? false
                    )
                    ProviderStatusRow(
                        provider: "GLM",
                        isConfigured: settings.providers.glm?.isConfigured ?? false
                    )
                } header: {
                    Text("Provider Status")
                } footer: {
                    Text("Configure API keys and settings in the web app to enable providers.")
                        .font(.caption)
                }

                // Status Messages
                if let successMessage = successMessage {
                    Section {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                            Text(successMessage)
                                .foregroundColor(.green)
                        }
                    }
                }

                if let error = error {
                    Section {
                        HStack {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.red)
                            Text(error)
                                .foregroundColor(.red)
                        }
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
            let loadedSettings = try await aiService.getSettings()
            settings = loadedSettings
            selectedProvider = loadedSettings.currentProvider
            selectedModel = loadedSettings.currentModel
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    private func saveSettings() async {
        isSaving = true
        error = nil
        successMessage = nil

        do {
            let updatedSettings = try await aiService.updateSettings(
                provider: selectedProvider,
                model: selectedModel
            )
            settings = updatedSettings
            successMessage = "Settings saved successfully"

            // Clear success message after 3 seconds
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                successMessage = nil
            }
        } catch {
            self.error = "Failed to save: \(error.localizedDescription)"
        }

        isSaving = false
    }

    private func isProviderConfigured(_ provider: String, in settings: AISettings) -> Bool {
        return settings.isProviderConfigured(provider)
    }
}

// MARK: - Provider Status Row

struct ProviderStatusRow: View {
    let provider: String
    let isConfigured: Bool

    var body: some View {
        HStack {
            Text(provider)
            Spacer()
            if isConfigured {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.green)
                Text("Configured")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.orange)
                Text("Setup Required")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
}

#Preview {
    SettingsView()
        .environmentObject(AuthManager.shared)
}
