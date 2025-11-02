import SwiftUI

struct MessageRow: View {
    let message: Message

    var body: some View {
        HStack {
            if message.role == .user {
                Spacer()
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 8) {
                ForEach(message.parts) { part in
                    MessagePartView(part: part)
                }

                Text(message.createdAt, style: .time)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            .padding(12)
            .background(message.role == .user ? Color.blue : Color(.systemGray6))
            .foregroundColor(message.role == .user ? .white : .primary)
            .cornerRadius(16)
            .frame(maxWidth: UIScreen.main.bounds.width * 0.75, alignment: message.role == .user ? .trailing : .leading)

            if message.role == .assistant {
                Spacer()
            }
        }
    }
}

struct MessagePartView: View {
    let part: MessagePart

    var body: some View {
        switch part {
        case .text(let textPart):
            Text(textPart.text)
                .textSelection(.enabled)

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
            return .red
        case .outputAvailable, .done:
            return .green
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

#Preview {
    VStack {
        MessageRow(message: Message(
            role: .user,
            parts: [.text(TextPart(text: "Hello, how can you help me?"))]
        ))

        MessageRow(message: Message(
            role: .assistant,
            parts: [
                .text(TextPart(text: "I can help you with many things! Let me search for information.")),
                .tool(ToolPart(
                    type: "tool-list_drives",
                    toolCallId: "call_123",
                    toolName: "list_drives",
                    input: ["query": AnyCodable("example")],
                    output: AnyCodable(["drives": ["Drive 1", "Drive 2"]]),
                    state: .outputAvailable
                ))
            ]
        ))
    }
    .padding()
}
