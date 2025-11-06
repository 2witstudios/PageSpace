//
//  ProviderModelPicker.swift
//  PageSpace
//
//  Provider and model selector UI component
//

import SwiftUI

struct ProviderModelPicker: View {
    @EnvironmentObject var conversationManager: ConversationManager
    @Environment(\.dismiss) var dismiss

    @State private var selectedProvider: String
    @State private var selectedModel: String

    init() {
        // Initialize with current values from ConversationManager
        // This will be overridden in onAppear with actual values
        _selectedProvider = State(initialValue: "pagespace")
        _selectedModel = State(initialValue: "glm-4.5-air")
    }

    /// Get list of configured providers only
    private var configuredProviders: [String] {
        getProviderList().filter { conversationManager.isProviderConfigured($0) }
    }

    /// Get user subscription tier from provider settings
    private var userSubscriptionTier: String? {
        conversationManager.settingsState.providerSettings?.userSubscriptionTier
    }

    var body: some View {
        NavigationView {
            Form {
                Section {
                    // Provider Picker - Only show configured providers
                    Picker("Provider", selection: $selectedProvider) {
                        ForEach(configuredProviders, id: \.self) { providerId in
                            Text(getProviderName(providerId))
                                .tag(providerId)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityLabel("AI Provider")
                    .accessibilityHint("Select which AI service to use")
                    .accessibilityIdentifier("provider-selector")
                    .onChange(of: selectedProvider) { oldValue, newValue in
                        // Update model to default for new provider
                        let defaultModel = getDefaultModel(for: newValue)

                        // Ensure the default model is accessible to the user
                        if hasModelAccess(provider: newValue, model: defaultModel, userTier: userSubscriptionTier) {
                            selectedModel = defaultModel
                        } else {
                            // Find first accessible model for this provider
                            let models = getModelsForProvider(newValue)
                            if let firstAccessible = models.keys.sorted().first(where: {
                                hasModelAccess(provider: newValue, model: $0, userTier: userSubscriptionTier)
                            }) {
                                selectedModel = firstAccessible
                            } else {
                                selectedModel = defaultModel // Fallback
                            }
                        }
                    }

                    // Model Picker
                    Picker("Model", selection: $selectedModel) {
                        let models = getModelsForProvider(selectedProvider)
                        let sortedKeys = models.keys.sorted()

                        ForEach(sortedKeys, id: \.self) { key in
                            if let displayName = models[key] {
                                let hasAccess = hasModelAccess(
                                    provider: selectedProvider,
                                    model: key,
                                    userTier: userSubscriptionTier
                                )
                                let needsSubscription = requiresSubscription(
                                    provider: selectedProvider,
                                    model: key
                                )

                                HStack {
                                    Text(displayName)
                                        .foregroundColor(hasAccess ? .primary : .secondary)

                                    if needsSubscription && !hasAccess {
                                        Spacer()
                                        Text("Pro/Business")
                                            .font(.caption2)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(DesignTokens.Colors.warning.opacity(0.2))
                                            .foregroundColor(DesignTokens.Colors.warning)
                                            .cornerRadius(4)
                                    }
                                }
                                .tag(key)
                            }
                        }
                    }
                    .id(selectedModel) // Force picker to rebuild when selection changes
                    .pickerStyle(.menu)
                    .accessibilityLabel("AI Model")
                    .accessibilityHint("Select which model variant to use")
                    .accessibilityIdentifier("model-selector")
                    .disabled(getModelsForProvider(selectedProvider).isEmpty)
                    .onChange(of: selectedModel) { oldValue, newValue in
                        // Validate that the selected model is accessible
                        if !hasModelAccess(provider: selectedProvider, model: newValue, userTier: userSubscriptionTier) {
                            // User selected a restricted model, revert to previous or default
                            if hasModelAccess(provider: selectedProvider, model: oldValue, userTier: userSubscriptionTier) {
                                selectedModel = oldValue
                            } else {
                                selectedModel = getDefaultModel(for: selectedProvider)
                            }
                        }
                    }

                } header: {
                    Text("AI Configuration")
                } footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        if let agentOverride = conversationManager.settingsState.agentConfigOverrides,
                           agentOverride.aiProvider != nil || agentOverride.aiModel != nil {
                            Text("This conversation uses page-specific AI settings")
                                .font(.caption)
                                .foregroundColor(DesignTokens.Colors.warning)
                        }

                        // Show upgrade notice if viewing PageSpace provider without Pro/Business
                        if selectedProvider == "pagespace" &&
                           !hasModelAccess(provider: "pagespace", model: "glm-4.6", userTier: userSubscriptionTier) {
                            Text("Upgrade to Pro or Business to access advanced models")
                                .font(.caption)
                                .foregroundColor(DesignTokens.Colors.primary)
                        }
                    }
                }
            }
            .navigationTitle("AI Provider")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        Task {
                            await conversationManager.updateProvider(selectedProvider, model: selectedModel)
                            dismiss()
                        }
                    }
                }
            }
        }
        .onAppear {
            print("🔍 ProviderModelPicker.onAppear")
            print("   ConversationManager.selectedProvider: \(conversationManager.settingsState.selectedProvider)")
            print("   ConversationManager.selectedModel: \(conversationManager.settingsState.selectedModel)")
            print("   User subscription tier: \(userSubscriptionTier ?? "nil")")

            // Load current values from ConversationManager
            selectedProvider = conversationManager.settingsState.selectedProvider
            selectedModel = conversationManager.settingsState.selectedModel

            // Validate that selected model exists for the selected provider
            let availableModels = getModelsForProvider(selectedProvider)
            print("   Available models for \(selectedProvider): \(availableModels.keys.sorted())")
            print("   Selected model '\(selectedModel)' exists: \(availableModels.keys.contains(selectedModel))")

            if !availableModels.keys.contains(selectedModel) {
                // Model doesn't exist for this provider, use default
                let defaultModel = getDefaultModel(for: selectedProvider)
                print("   ⚠️ Model not found, using default: \(defaultModel)")
                selectedModel = defaultModel
            }

            // Validate that user has access to the selected model
            if !hasModelAccess(provider: selectedProvider, model: selectedModel, userTier: userSubscriptionTier) {
                print("   ⚠️ User does not have access to \(selectedModel), resetting to accessible model")
                // Find first accessible model for this provider
                if let firstAccessible = availableModels.keys.sorted().first(where: {
                    hasModelAccess(provider: selectedProvider, model: $0, userTier: userSubscriptionTier)
                }) {
                    selectedModel = firstAccessible
                    print("   ✅ Reset to accessible model: \(firstAccessible)")
                }
            }
        }
    }
}

// MARK: - Compact Picker Button

/// Compact button view for triggering the provider/model picker
struct ProviderPickerButton: View {
    @EnvironmentObject var conversationManager: ConversationManager
    @State private var showingPicker = false

    var body: some View {
        Button {
            showingPicker = true
        } label: {
            Image(systemName: "cpu")
                .font(.system(size: 17, weight: .medium))
                .foregroundColor(DesignTokens.Colors.primary)
        }
        .accessibilityLabel("Select AI Provider")
        .accessibilityHint("Choose which AI provider and model to use for conversations")
        .accessibilityIdentifier("provider-picker-button")
        .sheet(isPresented: $showingPicker) {
            ProviderModelPicker()
                .environmentObject(conversationManager)
        }
    }
}

// MARK: - Preview

#Preview {
    ProviderModelPicker()
        .environmentObject(ConversationManager.shared)
}

#Preview("Button") {
    ProviderPickerButton()
        .environmentObject(ConversationManager.shared)
}
