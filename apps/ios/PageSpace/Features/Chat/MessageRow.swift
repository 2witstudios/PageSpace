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

        case .toolCall(let toolCall):
            ToolCallView(toolCall: toolCall)

        case .toolResult(let toolResult):
            ToolResultView(toolResult: toolResult)
        }
    }
}

struct ToolCallView: View {
    let toolCall: ToolCallPart
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation {
                    isExpanded.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: "wrench.and.screwdriver")
                    Text(formatToolName(toolCall.toolName))
                        .font(.subheadline)
                        .fontWeight(.medium)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                }
            }
            .foregroundColor(.secondary)

            if isExpanded, let input = toolCall.input {
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
        }
        .padding(8)
        .background(Color(.systemGray4).opacity(0.3))
        .cornerRadius(8)
    }

    private func formatToolName(_ name: String) -> String {
        // Convert snake_case to Title Case
        name.split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    private func formatJSON(_ value: AnyCodable) -> String {
        String(describing: value.value)
    }
}

struct ToolResultView: View {
    let toolResult: ToolResultPart
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation {
                    isExpanded.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: toolResult.isError ? "exclamationmark.triangle" : "checkmark.circle")
                    Text(toolResult.isError ? "Tool Error" : "Tool Result")
                        .font(.subheadline)
                        .fontWeight(.medium)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                }
            }
            .foregroundColor(toolResult.isError ? .red : .green)

            if isExpanded, let result = toolResult.result {
                Text(formatJSON(result))
                    .font(.caption)
                    .monospaced()
                    .padding(8)
                    .background(Color(.systemGray5))
                    .cornerRadius(8)
            }
        }
        .padding(8)
        .background(Color(.systemGray4).opacity(0.3))
        .cornerRadius(8)
    }

    private func formatJSON(_ value: AnyCodable) -> String {
        String(describing: value.value)
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
                .toolCall(ToolCallPart(
                    toolCallId: "call_123",
                    toolName: "search_pages",
                    input: AnyCodable(["query": "example"])
                ))
            ]
        ))
    }
    .padding()
}
