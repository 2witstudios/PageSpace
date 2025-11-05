import SwiftUI
import MarkdownUI

struct MessageRow: View {
    let message: Message
    let onCopy: (() -> Void)?
    let onEdit: (() -> Void)?
    let onRetry: (() -> Void)?
    let onDelete: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(message.parts) { part in
                    MessagePartView(part: part, role: message.role)
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

struct MessagePartView: View {
    let part: MessagePart
    let role: MessageRole

    var body: some View {
        switch part {
        case .text(let textPart):
            Markdown(textPart.text)
                .markdownTheme(.pagespace)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .tool(let tool):
            ToolView(tool: tool)
        }
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
    VStack(spacing: 0) {
        MessageRow(
            message: Message(
                role: .user,
                parts: [.text(TextPart(text: "Hello, can you help me with **markdown** formatting? I need to see `inline code` and:\n\n```swift\nlet test = \"code blocks\"\n```"))]
            ),
            onCopy: nil,
            onEdit: nil,
            onRetry: nil,
            onDelete: nil
        )

        MessageRow(
            message: Message(
                role: .assistant,
                parts: [
                    .text(TextPart(text: """
I can help you with **markdown** formatting! Here are some examples:

# Heading 1
## Heading 2
### Heading 3

**Bold text** and *italic text* work great. You can also use `inline code` or code blocks:

```swift
struct Example {
    let value: String
}
```

Here's a list:
- First item
- Second item
- Third item

And even [links](https://example.com) and tables:

| Feature | Status |
|---------|--------|
| Bold    | ✅     |
| Code    | ✅     |

> This is a blockquote with important information.
""")),
                    .tool(ToolPart(
                        type: "tool-list_drives",
                        toolCallId: "call_123",
                        toolName: "list_drives",
                        input: ["query": AnyCodable("example")],
                        output: AnyCodable(["drives": ["Drive 1", "Drive 2"]]),
                        state: .outputAvailable
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
