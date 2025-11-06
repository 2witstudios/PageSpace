//
//  SettingsState.swift
//  PageSpace
//
//  Created by Claude Code on 2025-11-05.
//  Purpose: State management for AI provider and model configuration
//

import Foundation
import Observation

/// Observable state object managing AI provider and model settings
@Observable
final class SettingsState {

    // MARK: - Properties

    /// Currently selected AI provider
    var selectedProvider: String

    /// Currently selected AI model
    var selectedModel: String

    /// Provider-specific settings
    var providerSettings: AISettings?

    /// Agent configuration overrides
    var agentConfigOverrides: AgentConfig?

    // MARK: - Initialization

    init(
        selectedProvider: String = "pagespace",
        selectedModel: String = "glm-4.5-air",
        providerSettings: AISettings? = nil,
        agentConfigOverrides: AgentConfig? = nil
    ) {
        self.selectedProvider = selectedProvider
        self.selectedModel = selectedModel
        self.providerSettings = providerSettings
        self.agentConfigOverrides = agentConfigOverrides
    }

    // MARK: - Public Methods

    /// Update the selected provider
    func setProvider(_ provider: String) {
        selectedProvider = provider
    }

    /// Update the selected model
    func setModel(_ model: String) {
        selectedModel = model
    }

    /// Update provider settings
    func setProviderSettings(_ settings: AISettings?) {
        providerSettings = settings
    }

    /// Update agent configuration overrides
    func setAgentConfigOverrides(_ config: AgentConfig?) {
        agentConfigOverrides = config
    }

    /// Clear all settings (reset to defaults)
    func reset() {
        selectedProvider = "pagespace"
        selectedModel = "glm-4.5-air"
        providerSettings = nil
        agentConfigOverrides = nil
    }
}
