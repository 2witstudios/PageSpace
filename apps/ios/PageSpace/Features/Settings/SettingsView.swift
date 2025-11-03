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
    @State private var selectedProvider: String = "pagespace"
    @State private var selectedModel: String = "glm-4.5-air"
    @State private var saveTask: Task<Void, Never>?

    private let aiService = AIService.shared

    /// Get list of configured providers only
    private var configuredProviders: [String] {
        guard let settings = settings else { return [] }
        return getProviderList().filter { isProviderConfigured($0, in: settings) }
    }

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
                        ForEach(configuredProviders, id: \.self) { providerId in
                            Text(getProviderName(providerId))
                                .tag(providerId)
                        }
                    }
                    .onChange(of: selectedProvider) { oldValue, newValue in
                        // Update model to default for new provider
                        let defaultModel = getDefaultModel(for: newValue)

                        // Ensure the default model is accessible to the user
                        if hasModelAccess(provider: newValue, model: defaultModel, userTier: settings.userSubscriptionTier) {
                            selectedModel = defaultModel
                        } else {
                            // Find first accessible model for this provider
                            let models = getModelsForProvider(newValue)
                            if let firstAccessible = models.keys.sorted().first(where: {
                                hasModelAccess(provider: newValue, model: $0, userTier: settings.userSubscriptionTier)
                            }) {
                                selectedModel = firstAccessible
                            } else {
                                selectedModel = defaultModel // Fallback
                            }
                        }

                        // Auto-save after provider change
                        Task {
                            await autoSaveSettings()
                        }
                    }

                    Picker("Model", selection: $selectedModel) {
                        ForEach(Array(getModelsForProvider(selectedProvider).sorted(by: { $0.key < $1.key })), id: \.key) { key, value in
                            let hasAccess = hasModelAccess(
                                provider: selectedProvider,
                                model: key,
                                userTier: settings.userSubscriptionTier
                            )
                            let needsSubscription = requiresSubscription(
                                provider: selectedProvider,
                                model: key
                            )

                            HStack {
                                Text(value)
                                    .foregroundColor(hasAccess ? .primary : .secondary)

                                if needsSubscription && !hasAccess {
                                    Spacer()
                                    Text("Pro/Business")
                                        .font(.caption2)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.orange.opacity(0.2))
                                        .foregroundColor(.orange)
                                        .cornerRadius(4)
                                }
                            }
                            .tag(key)
                        }
                    }
                    .disabled(getModelsForProvider(selectedProvider).isEmpty)
                    .onChange(of: selectedModel) { oldValue, newValue in
                        // Validate that the selected model is accessible
                        if !hasModelAccess(provider: selectedProvider, model: newValue, userTier: settings.userSubscriptionTier) {
                            // User selected a restricted model, revert to previous or default
                            if hasModelAccess(provider: selectedProvider, model: oldValue, userTier: settings.userSubscriptionTier) {
                                selectedModel = oldValue
                            } else {
                                selectedModel = getDefaultModel(for: selectedProvider)
                            }
                        } else {
                            // Model is accessible, auto-save
                            Task {
                                await autoSaveSettings()
                            }
                        }
                    }
                } header: {
                    Text("Default AI Provider")
                } footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your selections are saved automatically. Only configured providers are shown.")
                            .font(.caption)

                        // Show upgrade notice if viewing PageSpace provider without Pro/Business
                        if selectedProvider == "pagespace" &&
                           !hasModelAccess(provider: "pagespace", model: "glm-4.6", userTier: settings.userSubscriptionTier) {
                            Text("Upgrade to Pro or Business to access advanced models")
                                .font(.caption)
                                .foregroundColor(.blue)
                                .padding(.top, 4)
                        }
                    }
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
            }
        }
        .navigationTitle("AI Settings")
        .task {
            await loadSettings()
        }
    }

    private func loadSettings() async {
        isLoading = true

        do {
            let loadedSettings = try await aiService.getSettings()
            settings = loadedSettings
            selectedProvider = loadedSettings.currentProvider
            selectedModel = loadedSettings.currentModel

            // Validate that user has access to the loaded model
            if !hasModelAccess(provider: selectedProvider, model: selectedModel, userTier: loadedSettings.userSubscriptionTier) {
                print("⚠️ User does not have access to \(selectedModel), resetting to accessible model")
                // Find first accessible model for this provider
                let models = getModelsForProvider(selectedProvider)
                if let firstAccessible = models.keys.sorted().first(where: {
                    hasModelAccess(provider: selectedProvider, model: $0, userTier: loadedSettings.userSubscriptionTier)
                }) {
                    selectedModel = firstAccessible
                    print("✅ Reset to accessible model: \(firstAccessible)")
                }
            }
        } catch {
            print("❌ Failed to load AI settings: \(error)")
        }

        isLoading = false
    }

    /// Auto-save settings with debouncing to prevent rapid-fire saves
    private func autoSaveSettings() async {
        // Cancel any pending save task
        saveTask?.cancel()

        saveTask = Task {
            // Debounce: wait 300ms before saving
            try? await Task.sleep(nanoseconds: 300_000_000)

            // Check if task was cancelled
            guard !Task.isCancelled else { return }

            // Validate settings are loaded
            guard let currentSettings = settings else { return }

            // Validate user has access to the selected model
            guard hasModelAccess(
                provider: selectedProvider,
                model: selectedModel,
                userTier: currentSettings.userSubscriptionTier
            ) else {
                print("⚠️ Skipping save - user doesn't have access to \(selectedModel)")
                return
            }

            // Save to backend
            do {
                let updatedSettings = try await aiService.updateSettings(
                    provider: selectedProvider,
                    model: selectedModel
                )
                settings = updatedSettings
                print("✅ Auto-saved AI settings: \(selectedProvider)/\(selectedModel)")
            } catch {
                print("❌ Failed to auto-save AI settings: \(error)")
            }
        }

        await saveTask?.value
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
