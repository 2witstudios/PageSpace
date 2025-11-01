import Foundation

// MARK: - Message Models

struct Message: Identifiable, Codable, Equatable {
    let id: String
    let role: MessageRole
    var parts: [MessagePart]
    let createdAt: Date
    let isActive: Bool

    enum CodingKeys: String, CodingKey {
        case id, role, parts, createdAt, isActive
    }

    init(id: String = UUID().uuidString, role: MessageRole, parts: [MessagePart], createdAt: Date = Date(), isActive: Bool = true) {
        self.id = id
        self.role = role
        self.parts = parts
        self.createdAt = createdAt
        self.isActive = isActive
    }
}

enum MessageRole: String, Codable {
    case user
    case assistant
}

// MARK: - Message Parts (Polymorphic)

enum MessagePart: Codable, Equatable, Identifiable {
    case text(TextPart)
    case toolCall(ToolCallPart)
    case toolResult(ToolResultPart)

    var id: String {
        switch self {
        case .text(let part):
            return part.id
        case .toolCall(let part):
            return part.id
        case .toolResult(let part):
            return part.id
        }
    }

    // Custom coding to handle polymorphic parts
    enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "text":
            let textPart = try TextPart(from: decoder)
            self = .text(textPart)
        case "tool-call":
            let toolCall = try ToolCallPart(from: decoder)
            self = .toolCall(toolCall)
        case "tool-result":
            let toolResult = try ToolResultPart(from: decoder)
            self = .toolResult(toolResult)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown message part type: \(type)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let part):
            try part.encode(to: encoder)
        case .toolCall(let part):
            try part.encode(to: encoder)
        case .toolResult(let part):
            try part.encode(to: encoder)
        }
    }
}

// MARK: - Text Part

struct TextPart: Codable, Equatable {
    let id: String
    let type: String
    let text: String

    init(id: String = UUID().uuidString, text: String) {
        self.id = id
        self.type = "text"
        self.text = text
    }
}

// MARK: - Tool Call Part

struct ToolCallPart: Codable, Equatable {
    let id: String
    let type: String
    let toolCallId: String
    let toolName: String
    let input: AnyCodable?

    init(id: String = UUID().uuidString, toolCallId: String, toolName: String, input: AnyCodable? = nil) {
        self.id = id
        self.type = "tool-call"
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.input = input
    }
}

// MARK: - Tool Result Part

struct ToolResultPart: Codable, Equatable {
    let id: String
    let type: String
    let toolCallId: String
    let result: AnyCodable?
    let isError: Bool

    init(id: String = UUID().uuidString, toolCallId: String, result: AnyCodable? = nil, isError: Bool = false) {
        self.id = id
        self.type = "tool-result"
        self.toolCallId = toolCallId
        self.result = result
        self.isError = isError
    }
}

// MARK: - AnyCodable (for dynamic JSON)

struct AnyCodable: Codable, Equatable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if let intValue = try? container.decode(Int.self) {
            value = intValue
        } else if let doubleValue = try? container.decode(Double.self) {
            value = doubleValue
        } else if let stringValue = try? container.decode(String.self) {
            value = stringValue
        } else if let boolValue = try? container.decode(Bool.self) {
            value = boolValue
        } else if let arrayValue = try? container.decode([AnyCodable].self) {
            value = arrayValue.map { $0.value }
        } else if let dictValue = try? container.decode([String: AnyCodable].self) {
            value = dictValue.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Could not decode value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch value {
        case let intValue as Int:
            try container.encode(intValue)
        case let doubleValue as Double:
            try container.encode(doubleValue)
        case let stringValue as String:
            try container.encode(stringValue)
        case let boolValue as Bool:
            try container.encode(boolValue)
        case let arrayValue as [Any]:
            try container.encode(arrayValue.map { AnyCodable($0) })
        case let dictValue as [String: Any]:
            try container.encode(dictValue.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: encoder.codingPath,
                    debugDescription: "Could not encode value"
                )
            )
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Basic equality - you may need to expand this
        String(describing: lhs.value) == String(describing: rhs.value)
    }
}

// MARK: - Streaming Message (for SSE)

struct StreamingMessage {
    var id: String
    var role: MessageRole
    var parts: [MessagePart]
    var isComplete: Bool

    init(id: String, role: MessageRole) {
        self.id = id
        self.role = role
        self.parts = []
        self.isComplete = false
    }

    mutating func appendText(_ text: String) {
        if case .text(let lastTextPart) = parts.last {
            // Append to existing text part
            parts.removeLast()
            let updatedText = TextPart(id: lastTextPart.id, text: lastTextPart.text + text)
            parts.append(.text(updatedText))
        } else {
            // Create new text part
            parts.append(.text(TextPart(text: text)))
        }
    }

    mutating func addToolCall(_ toolCall: ToolCallPart) {
        parts.append(.toolCall(toolCall))
    }

    mutating func addToolResult(_ toolResult: ToolResultPart) {
        parts.append(.toolResult(toolResult))
    }

    func toMessage() -> Message {
        Message(id: id, role: role, parts: parts, createdAt: Date())
    }
}
