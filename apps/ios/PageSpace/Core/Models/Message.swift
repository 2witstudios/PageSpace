import Foundation

// MARK: - Message Models

struct Message: Identifiable, Codable, Equatable {
    let id: String
    let role: MessageRole
    var parts: [MessagePart]
    let createdAt: Date
    let isActive: Bool?  // Optional - backend doesn't send this field (internal database only)
    var editedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, role, parts, createdAt, isActive, editedAt
    }

    init(
        id: String = UUID().uuidString,
        role: MessageRole,
        parts: [MessagePart],
        createdAt: Date = Date(),
        isActive: Bool? = nil,
        editedAt: Date? = nil
    ) {
        self.id = id
        self.role = role
        self.parts = parts
        self.createdAt = createdAt
        self.isActive = isActive
        self.editedAt = editedAt
    }
}

enum MessageRole: String, Codable {
    case user
    case assistant
}

// MARK: - Message Parts (Polymorphic)

enum MessagePart: Codable, Equatable, Identifiable {
    case text(TextPart)
    case tool(ToolPart)

    var id: String {
        switch self {
        case .text(let part):
            return part.id ?? UUID().uuidString
        case .tool(let part):
            return part.id ?? part.toolCallId  // Use toolCallId as stable identifier
        }
    }

    // Custom coding to handle polymorphic parts
    enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        if type == "text" {
            let textPart = try TextPart(from: decoder)
            self = .text(textPart)
        } else if type.hasPrefix("tool-") {
            // Handle any tool type (e.g., "tool-list_drives", "tool-read_page", etc.)
            let toolPart = try ToolPart(from: decoder)
            self = .tool(toolPart)
        } else {
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
        case .tool(let part):
            try part.encode(to: encoder)
        }
    }
}

// MARK: - Text Part

struct TextPart: Codable, Equatable {
    let id: String?  // Optional - backend doesn't send IDs for message parts
    let type: String
    let text: String

    init(id: String? = nil, text: String) {
        self.id = id
        self.type = "text"
        self.text = text
    }
}

// MARK: - Tool State

enum ToolState: String, Codable {
    case inputStreaming = "input-streaming"
    case inputAvailable = "input-available"
    case outputAvailable = "output-available"
    case outputError = "output-error"
    case done
    case streaming
}

// MARK: - Tool Part

struct ToolPart: Codable, Equatable {
    let id: String?  // Optional - backend doesn't send IDs for message parts
    let type: String  // "tool-{toolName}" (e.g., "tool-list_drives")
    let toolCallId: String
    let toolName: String
    let input: [String: AnyCodable]?
    let output: AnyCodable?
    let state: ToolState

    init(id: String? = nil, type: String, toolCallId: String, toolName: String, input: [String: AnyCodable]? = nil, output: AnyCodable? = nil, state: ToolState) {
        self.id = id
        self.type = type
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.input = input
        self.output = output
        self.state = state
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
    let createdAt: Date  // Preserve timestamp from when streaming started

    init(id: String, role: MessageRole) {
        self.id = id
        self.role = role
        self.parts = []
        self.isComplete = false
        self.createdAt = Date()  // Capture when streaming begins
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

    mutating func addTool(_ tool: ToolPart) {
        parts.append(.tool(tool))
    }

    mutating func updateOrAddTool(_ tool: ToolPart) {
        // Check if tool with this toolCallId already exists
        if let index = parts.firstIndex(where: {
            if case .tool(let existingTool) = $0, existingTool.toolCallId == tool.toolCallId {
                return true
            }
            return false
        }), case .tool(let existingTool) = parts[index] {
            // Update existing tool with new input/state (preserve output if it exists)
            parts[index] = .tool(ToolPart(
                id: existingTool.id,
                type: tool.type,
                toolCallId: tool.toolCallId,
                toolName: tool.toolName,
                input: tool.input ?? existingTool.input,
                output: existingTool.output,
                state: tool.state
            ))
        } else {
            // Tool doesn't exist yet, add it
            parts.append(.tool(tool))
        }
    }

    mutating func updateTool(toolCallId: String, output: AnyCodable?, state: ToolState) {
        // Find and update existing tool part by toolCallId
        if let index = parts.firstIndex(where: {
            if case .tool(let toolPart) = $0, toolPart.toolCallId == toolCallId {
                return true
            }
            return false
        }), case .tool(let existingTool) = parts[index] {
            parts[index] = .tool(ToolPart(
                id: existingTool.id,
                type: existingTool.type,
                toolCallId: existingTool.toolCallId,
                toolName: existingTool.toolName,
                input: existingTool.input,
                output: output,
                state: state
            ))
        }
    }

    func toMessage() -> Message {
        return Message(id: id, role: role, parts: parts, createdAt: createdAt)
    }
}
