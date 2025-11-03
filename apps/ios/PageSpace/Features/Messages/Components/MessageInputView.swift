import SwiftUI

struct MessageInputView: View {
    @Binding var text: String
    let placeholder: String
    let isDisabled: Bool
    let isSending: Bool
    let onSend: () -> Void

    init(
        text: Binding<String>,
        placeholder: String = "Message...",
        isDisabled: Bool = false,
        isSending: Bool = false,
        onSend: @escaping () -> Void
    ) {
        self._text = text
        self.placeholder = placeholder
        self.isDisabled = isDisabled
        self.isSending = isSending
        self.onSend = onSend
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isDisabled && !isSending
    }

    var body: some View {
        HStack(spacing: 12) {
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .disabled(isDisabled || isSending)
                .submitLabel(.send)
                .onSubmit {
                    if canSend {
                        send()
                    }
                }

            Button(action: send) {
                if isSending {
                    ProgressView()
                        .frame(width: 32, height: 32)
                } else {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(canSend ? DesignTokens.Colors.primary : .gray)
                }
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }

    private func send() {
        guard canSend else { return }
        onSend()
    }
}

#Preview("Empty State") {
    @Previewable @State var text = ""

    MessageInputView(
        text: $text,
        onSend: {
            print("Send:", text)
        }
    )
}

#Preview("With Text") {
    @Previewable @State var text = "Hello, world!"

    MessageInputView(
        text: $text,
        onSend: {
            print("Send:", text)
        }
    )
}

#Preview("Disabled") {
    @Previewable @State var text = "Can't send this"

    MessageInputView(
        text: $text,
        isDisabled: true,
        onSend: {
            print("Send:", text)
        }
    )
}

#Preview("Sending") {
    @Previewable @State var text = "Sending..."

    MessageInputView(
        text: $text,
        isSending: true,
        onSend: {
            print("Send:", text)
        }
    )
}

#Preview("Multi-line") {
    @Previewable @State var text = "This is a longer message that spans multiple lines to demonstrate the text field expansion behavior."

    MessageInputView(
        text: $text,
        onSend: {
            print("Send:", text)
            text = ""
        }
    )
}
