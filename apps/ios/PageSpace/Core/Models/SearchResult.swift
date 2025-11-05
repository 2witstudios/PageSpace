import Foundation

enum SearchResultType: String, Codable, Hashable {
    case page
    case drive
    case user
}

struct SearchResult: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let type: SearchResultType
    let pageType: PageType?
    let driveId: String?
    let driveName: String?
    let description: String?
    let avatarUrl: String?

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case type
        case pageType
        case driveId
        case driveName
        case description
        case avatarUrl
    }
}

struct SearchResponse: Codable {
    let results: [SearchResult]
}
