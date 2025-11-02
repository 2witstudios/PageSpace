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
                        selectedModel = getDefaultModel(for: newValue)
                    }

                    // Model Picker
                    Picker("Model", selection: $selectedModel) {
                        let models = getModelsForProvider(selectedProvider)
                        let sortedKeys = models.keys.sorted()

                        ForEach(sortedKeys, id: \.self) { key in
                            if let displayName = models[key] {
                                Text(displayName)
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

                } header: {
                    Text("AI Configuration")
                } footer: {
                    if let agentOverride = conversationManager.agentConfigOverrides,
                       agentOverride.aiProvider != nil || agentOverride.aiModel != nil {
                        Text("This conversation uses page-specific AI settings")
                            .font(.caption)
                            .foregroundColor(.orange)
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
            print("   ConversationManager.selectedProvider: \(conversationManager.selectedProvider)")
            print("   ConversationManager.selectedModel: \(conversationManager.selectedModel)")

            // Load current values from ConversationManager
            selectedProvider = conversationManager.selectedProvider
            selectedModel = conversationManager.selectedModel

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
