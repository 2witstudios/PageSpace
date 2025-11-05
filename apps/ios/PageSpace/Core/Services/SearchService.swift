import Foundation

@MainActor
class SearchService: ObservableObject {
    static let shared = SearchService()

    @Published private(set) var results: [SearchResult] = []
    @Published private(set) var isSearching = false
    @Published private(set) var errorMessage: String?

    private let apiClient = APIClient.shared
    private var searchTask: Task<Void, Never>?
    private let debounceInterval: UInt64 = 250_000_000 // 0.25s

    private init() {}

    func updateQuery(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)

        searchTask?.cancel()

        guard trimmed.count >= 2 else {
            results = []
            errorMessage = nil
            isSearching = false
            return
        }

        let interval = debounceInterval
        searchTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: interval)
            } catch {
                return
            }

            guard
                !Task.isCancelled,
                let self
            else { return }

            await self.performSearch(query: trimmed)
        }
    }

    func cancelSearch() {
        searchTask?.cancel()
        searchTask = nil
        isSearching = false
    }

    func clearResults() {
        cancelSearch()
        results = []
        errorMessage = nil
    }

    private func performSearch(query: String) async {
        isSearching = true
        errorMessage = nil

        do {
            let response: SearchResponse = try await apiClient.request(
                endpoint: APIEndpoints.search,
                method: .GET,
                body: nil as String?,
                queryParams: [
                    "q": query,
                    "limit": "20"
                ]
            )

            guard !Task.isCancelled else { return }
            results = response.results
        } catch let apiError as APIError {
            guard !Task.isCancelled else { return }
            results = []
            errorMessage = apiError.errorDescription
        } catch {
            guard !Task.isCancelled else { return }
            results = []
            errorMessage = error.localizedDescription
        }

        guard !Task.isCancelled else { return }
        isSearching = false
    }
}
