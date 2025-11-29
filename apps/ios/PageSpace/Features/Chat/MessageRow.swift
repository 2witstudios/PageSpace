import SwiftUI
import MarkdownUI

// MARK: - Tool Status Types for Grouping

enum ToolStatus: Equatable {
    case pending
    case inProgress
    case completed
    case error
}

/// Represents a grouped part for rendering - either text or a group of tool calls
enum GroupedPart: Identifiable {
    case text(TextPart)
    case toolGroup([ToolPart])

    var id: String {
        switch self {
        case .text(let part):
            return "text-\(part.id ?? UUID().uuidString)"
        case .toolGroup(let tools):
            return "tools-\(tools.first?.toolCallId ?? UUID().uuidString)"
        }
    }
}

struct MessageRow: View {
    let message: Message
    let onCopy: (() -> Void)?
    let onEdit: (() -> Void)?
    let onRetry: (() -> Void)?
    let onDelete: (() -> Void)?
    var isStreaming: Bool = false

    /// Groups consecutive tool parts of the same type together
    private var groupedParts: [GroupedPart] {
        var groups: [GroupedPart] = []
        var currentToolGroup: [ToolPart] = []

        for part in message.parts {
            switch part {
            case .text(let textPart):
                // If we have accumulated tool parts, add them as a group
                if !currentToolGroup.isEmpty {
                    groups.append(.toolGroup(currentToolGroup))
                    currentToolGroup = []
                }
                groups.append(.text(textPart))

            case .tool(let toolPart):
                // Check if tool type changed - flush current group if different type
                if !currentToolGroup.isEmpty && currentToolGroup[0].type != toolPart.type {
                    groups.append(.toolGroup(currentToolGroup))
                    currentToolGroup = []
                }
                currentToolGroup.append(toolPart)
            }
        }

        // Add any remaining tool parts
        if !currentToolGroup.isEmpty {
            groups.append(.toolGroup(currentToolGroup))
        }

        return groups
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isInitialLoading {
                LoadingIndicator()
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(groupedParts) { groupedPart in
                        GroupedPartView(groupedPart: groupedPart, role: message.role)
                    }

                    if isStreaming && message.role == .assistant {
                        LoadingIndicator()
                            .padding(.top, 4)
                    }

                    HStack(spacing: 6) {
                        Text(message.createdAt, style: .time)
                            .font(.caption2)
                            .foregroundColor(.secondary)

                        if message.editedAt != nil {
                            Text("Edited")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }

                        Spacer(minLength: 8)

                        if let onRetry = onRetry {
                            actionButton(
                                systemImage: "arrow.clockwise",
                                accessibilityLabel: "Retry response",
                                action: onRetry
                            )
                        }

                        if let onDelete = onDelete {
                            actionButton(
                                systemImage: "trash",
                                accessibilityLabel: "Delete message",
                                action: onDelete
                            )
                        }

                        if let onEdit = onEdit {
                            actionButton(
                                systemImage: "square.and.pencil",
                                accessibilityLabel: "Edit message",
                                action: onEdit
                            )
                        }

                        if let onCopy = onCopy {
                            actionButton(
                                systemImage: "doc.on.doc",
                                accessibilityLabel: "Copy message",
                                action: onCopy
                            )
                        }
                    }
                    .padding(.top, hasActions ? 4 : 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(messageBackground)
            }
        }
    }

    @ViewBuilder
    private var messageBackground: some View {
        if message.role == .user {
            DesignTokens.Colors.primary.opacity(0.08)
        } else {
            DesignTokens.Colors.assistantMessageBackground
        }
    }

    private var hasActions: Bool {
        onCopy != nil || onEdit != nil || onRetry != nil || onDelete != nil
    }

    private var isContentEmpty: Bool {
        if message.parts.isEmpty { return true }
        // Check if all text parts are empty and no tools
        return message.parts.allSatisfy { part in
            if case .text(let textPart) = part {
                return textPart.text.isEmpty
            }
            return false // Tool parts are considered content
        }
    }

    private var isInitialLoading: Bool {
        message.role == .assistant && isStreaming && isContentEmpty
    }

    private func actionButton(systemImage: String, accessibilityLabel: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.footnote)
                .foregroundColor(.secondary)
                .padding(6)
                .background(Color(.systemGray5).opacity(0.6))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// View for rendering grouped parts (text or tool groups)
struct GroupedPartView: View {
    let groupedPart: GroupedPart
    let role: MessageRole

    var body: some View {
        switch groupedPart {
        case .text(let textPart):
            Markdown(textPart.text)
                .markdownTheme(.pagespace)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .toolGroup(let tools):
            GroupedToolCallsView(tools: tools)
        }
    }
}

// MARK: - Grouped Tool Calls View

/// A collapsible view that groups multiple tool calls of the same type
struct GroupedToolCallsView: View {
    let tools: [ToolPart]
    @State private var isExpanded = false

    // MARK: - Status Calculations

    private func getToolStatus(_ state: ToolState) -> ToolStatus {
        switch state {
        case .inputStreaming, .streaming:
            return .inProgress
        case .inputAvailable:
            return .inProgress
        case .outputAvailable, .done:
            return .completed
        case .outputError:
            return .error
        }
    }

    private var summary: (total: Int, completed: Int, inProgress: Int, error: Int, pending: Int) {
        var stats = (total: tools.count, completed: 0, inProgress: 0, error: 0, pending: 0)
        for tool in tools {
            switch getToolStatus(tool.state) {
            case .completed: stats.completed += 1
            case .inProgress: stats.inProgress += 1
            case .error: stats.error += 1
            case .pending: stats.pending += 1
            }
        }
        return stats
    }

    private var groupStatus: ToolStatus {
        let stats = summary
        if stats.error > 0 { return .error }
        if stats.inProgress > 0 { return .inProgress }
        if stats.pending > 0 { return .pending }
        return .completed
    }

    private var summaryText: String {
        let stats = summary
        // Priority order matches groupStatus: error > inProgress > pending > completed
        if stats.error > 0 {
            return "\(stats.error) failed"
        } else if stats.inProgress > 0 {
            return "\(stats.inProgress) active"
        } else if stats.completed == stats.total {
            return "all done"
        } else {
            return "\(stats.completed)/\(stats.total)"
        }
    }

    private var toolDisplayName: String {
        guard let firstTool = tools.first else { return "Tool" }
        return formatToolName(firstTool.toolName)
    }

    private var activeToolIndex: Int? {
        tools.firstIndex { tool in
            let status = getToolStatus(tool.state)
            return status == .inProgress || status == .error
        }
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Group Header Button
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    // Chevron
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .frame(width: 12)

                    // Status Icon
                    statusIcon
                        .frame(width: 14)

                    // Tool count and name
                    Text("\(tools.count) \(toolDisplayName)\(tools.count != 1 ? "s" : "")")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.primary)

                    Spacer()

                    // Summary text
                    Text(summaryText)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)

            // Expanded Tool Calls
            if isExpanded {
                Divider()
                    .padding(.horizontal, 8)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(tools.enumerated()), id: \.element.toolCallId) { index, tool in
                        let isActive = index == activeToolIndex
                        CompactToolView(tool: tool, isActive: isActive)
                    }
                }
                .padding(8)
            }
        }
        .background(Color(.systemGray5).opacity(0.5))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.systemGray4).opacity(0.5), lineWidth: 1)
        )
    }

    // MARK: - Status Icon

    @ViewBuilder
    private var statusIcon: some View {
        switch groupStatus {
        case .inProgress:
            ProgressView()
                .scaleEffect(0.6)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundColor(DesignTokens.Colors.success)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundColor(DesignTokens.Colors.error)
        case .pending:
            Image(systemName: "clock")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    // MARK: - Helpers

    private func formatToolName(_ name: String) -> String {
        name.split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}

// MARK: - Compact Tool View (for inside grouped container)

/// A more compact tool view for display inside the grouped container
struct CompactToolView: View {
    let tool: ToolPart
    let isActive: Bool
    @State private var isExpanded = false

    private func getToolStatus(_ state: ToolState) -> ToolStatus {
        switch state {
        case .inputStreaming, .streaming:
            return .inProgress
        case .inputAvailable:
            return .inProgress
        case .outputAvailable, .done:
            return .completed
        case .outputError:
            return .error
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    toolIcon
                        .font(.caption2)
                    Text(formatToolName(tool.toolName))
                        .font(.caption)
                        .fontWeight(.medium)
                    Spacer()
                    if tool.state == .streaming || tool.state == .inputStreaming {
                        ProgressView()
                            .scaleEffect(0.5)
                    }
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                }
                .foregroundColor(foregroundColor)
            }
            .buttonStyle(.plain)

            if isExpanded {
                // Show input if available
                if let input = tool.input {
                    Text("Input:")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)

                    Text(formatJSON(input))
                        .font(.caption2)
                        .monospaced()
                        .padding(6)
                        .background(Color(.systemGray6))
                        .cornerRadius(6)
                }

                // Show output if available
                if let output = tool.output {
                    Text(tool.state == .outputError ? "Error:" : "Output:")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)
                        .padding(.top, 2)

                    Text(formatJSON(output))
                        .font(.caption2)
                        .monospaced()
                        .padding(6)
                        .background(Color(.systemGray6))
                        .cornerRadius(6)
                }
            }
        }
        .padding(8)
        .background(Color(.systemGray6).opacity(0.6))
        .cornerRadius(6)
        .overlay(
            Group {
                if isActive {
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(DesignTokens.Colors.primary.opacity(0.5), lineWidth: 1.5)
                }
            }
        )
    }

    private var toolIcon: some View {
        Group {
            switch tool.state {
            case .outputError:
                Image(systemName: "exclamationmark.triangle")
            case .outputAvailable, .done:
                Image(systemName: "checkmark.circle")
            case .streaming, .inputStreaming:
                Image(systemName: "arrow.clockwise")
            default:
                Image(systemName: "wrench.and.screwdriver")
            }
        }
    }

    private var foregroundColor: Color {
        switch tool.state {
        case .outputError:
            return DesignTokens.Colors.error
        case .outputAvailable, .done:
            return DesignTokens.Colors.success
        default:
            return .secondary
        }
    }

    private func formatToolName(_ name: String) -> String {
        name.split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    private func formatJSON(_ value: Any) -> String {
        if let dict = value as? [String: Any] {
            return String(describing: dict)
        } else if let codable = value as? AnyCodable {
            return String(describing: codable.value)
        }
        return String(describing: value)
    }
}

struct ToolView: View {
    let tool: ToolPart
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation {
                    isExpanded.toggle()
                }
            } label: {
                HStack {
                    toolIcon
                    Text(formatToolName(tool.toolName))
                        .font(.subheadline)
                        .fontWeight(.medium)
                    Spacer()
                    toolStateIndicator
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                }
            }
            .foregroundColor(foregroundColor)

            if isExpanded {
                // Show input if available
                if let input = tool.input {
                    Text("Input:")
                        .font(.caption)
                        .fontWeight(.semibold)

                    Text(formatJSON(input))
                        .font(.caption)
                        .monospaced()
                        .padding(8)
                        .background(Color(.systemGray5))
                        .cornerRadius(8)
                }

                // Show output if available
                if let output = tool.output {
                    Text(tool.state == .outputError ? "Error:" : "Output:")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .padding(.top, 4)

                    Text(formatJSON(output))
                        .font(.caption)
                        .monospaced()
                        .padding(8)
                        .background(Color(.systemGray5))
                        .cornerRadius(8)
                }
            }
        }
        .padding(8)
        .background(Color(.systemGray4).opacity(0.3))
        .cornerRadius(8)
    }

    private var toolIcon: some View {
        Group {
            switch tool.state {
            case .outputError:
                Image(systemName: "exclamationmark.triangle")
            case .outputAvailable, .done:
                Image(systemName: "checkmark.circle")
            case .streaming, .inputStreaming:
                Image(systemName: "arrow.clockwise")
            default:
                Image(systemName: "wrench.and.screwdriver")
            }
        }
    }

    private var toolStateIndicator: some View {
        Group {
            switch tool.state {
            case .streaming, .inputStreaming:
                ProgressView()
                    .scaleEffect(0.7)
            default:
                EmptyView()
            }
        }
    }

    private var foregroundColor: Color {
        switch tool.state {
        case .outputError:
            return DesignTokens.Colors.error
        case .outputAvailable, .done:
            return DesignTokens.Colors.success
        default:
            return .secondary
        }
    }

    private func formatToolName(_ name: String) -> String {
        // Convert snake_case to Title Case
        name.split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    private func formatJSON(_ value: Any) -> String {
        if let dict = value as? [String: Any] {
            return String(describing: dict)
        } else if let codable = value as? AnyCodable {
            return String(describing: codable.value)
        }
        return String(describing: value)
    }
}

// MARK: - Custom Markdown Theme

extension Theme {
    static let pagespace = Theme()
        .text {
            ForegroundColor(.primary)
            FontSize(16)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.94))
            BackgroundColor(Color(.systemGray5).opacity(0.8))
        }
        .strong {
            FontWeight(.semibold)
        }
        .emphasis {
            FontStyle(.italic)
        }
        .link {
            ForegroundColor(DesignTokens.Colors.primary)
            UnderlineStyle(.single)
        }
        .heading1 { configuration in
            VStack(alignment: .leading, spacing: 0) {
                configuration.label
                    .markdownMargin(top: .zero, bottom: .em(0.3))
                    .markdownTextStyle {
                        FontWeight(.bold)
                        FontSize(.em(2))
                    }
                Divider()
            }
        }
        .heading2 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle {
                    FontWeight(.bold)
                    FontSize(.em(1.5))
                }
        }
        .heading3 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.25))
                }
        }
        .heading4 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.1))
                }
        }
        .heading5 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1))
                }
        }
        .heading6 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(0.9))
                    ForegroundColor(.secondary)
                }
        }
        .paragraph { configuration in
            configuration.label
                .markdownMargin(top: .zero, bottom: .em(0.8))
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: .em(0.2))
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .padding(12)
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.88))
                    }
            }
            .background(Color(.systemGray5))
            .cornerRadius(8)
            .markdownMargin(top: .em(0.5), bottom: .em(0.8))
        }
        .blockquote { configuration in
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.secondary.opacity(0.5))
                    .frame(width: 4)
                configuration.label
                    .markdownTextStyle {
                        ForegroundColor(.secondary)
                    }
                    .padding(.leading, 12)
            }
            .markdownMargin(top: .em(0.5), bottom: .em(0.8))
        }
        .table { configuration in
            configuration.label
                .markdownTableBorderStyle(.init(color: .secondary.opacity(0.3)))
                .markdownTableBackgroundStyle(
                    .alternatingRows(Color(.systemGray6).opacity(0.5), Color.clear)
                )
                .markdownMargin(top: .em(0.5), bottom: .em(0.8))
        }
}

#Preview {
    ScrollView {
        VStack(spacing: 0) {
            MessageRow(
                message: Message(
                    role: .user,
                    parts: [.text(TextPart(text: "Search for all documents about AI and list the drives"))]
                ),
                onCopy: nil,
                onEdit: nil,
                onRetry: nil,
                onDelete: nil
            )

            // Example with grouped tool calls (multiple searches)
            MessageRow(
                message: Message(
                    role: .assistant,
                    parts: [
                        .text(TextPart(text: "Let me search for documents about AI across your drives.")),
                        // Multiple search tool calls of the same type - these will be grouped
                        .tool(ToolPart(
                            type: "tool-regex_search",
                            toolCallId: "call_001",
                            toolName: "regex_search",
                            input: ["pattern": AnyCodable("AI"), "path": AnyCodable("/docs")],
                            output: AnyCodable(["matches": 5]),
                            state: .outputAvailable
                        )),
                        .tool(ToolPart(
                            type: "tool-regex_search",
                            toolCallId: "call_002",
                            toolName: "regex_search",
                            input: ["pattern": AnyCodable("machine learning"), "path": AnyCodable("/docs")],
                            output: AnyCodable(["matches": 3]),
                            state: .outputAvailable
                        )),
                        .tool(ToolPart(
                            type: "tool-regex_search",
                            toolCallId: "call_003",
                            toolName: "regex_search",
                            input: ["pattern": AnyCodable("neural network"), "path": AnyCodable("/docs")],
                            output: nil,
                            state: .streaming
                        )),
                        // Different tool type - will create new group
                        .tool(ToolPart(
                            type: "tool-list_drives",
                            toolCallId: "call_004",
                            toolName: "list_drives",
                            input: nil,
                            output: AnyCodable(["drives": ["Personal", "Work", "Archive"]]),
                            state: .done
                        )),
                        .text(TextPart(text: "I found several documents about AI topics. The search is still in progress for neural network content."))
                    ]
                ),
                onCopy: nil,
                onEdit: nil,
                onRetry: nil,
                onDelete: nil
            )

            // Example with error state
            MessageRow(
                message: Message(
                    role: .assistant,
                    parts: [
                        .text(TextPart(text: "I'll read those pages for you.")),
                        .tool(ToolPart(
                            type: "tool-read_page",
                            toolCallId: "call_005",
                            toolName: "read_page",
                            input: ["pageId": AnyCodable("page_123")],
                            output: AnyCodable(["content": "Page content here..."]),
                            state: .done
                        )),
                        .tool(ToolPart(
                            type: "tool-read_page",
                            toolCallId: "call_006",
                            toolName: "read_page",
                            input: ["pageId": AnyCodable("page_456")],
                            output: AnyCodable(["error": "Page not found"]),
                            state: .outputError
                        ))
                    ]
                ),
                onCopy: nil,
                onEdit: nil,
                onRetry: nil,
                onDelete: nil
            )
        }
    }
}
