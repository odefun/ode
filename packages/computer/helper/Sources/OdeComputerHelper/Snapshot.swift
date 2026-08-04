import Foundation

struct ElementFrame: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var centerX: Double { x + width / 2 }
    var centerY: Double { y + height / 2 }
}

struct CachedElement: Codable {
    let id: String
    let role: String
    let title: String?
    let frame: ElementFrame
}

struct CachedSnapshot: Codable {
    let id: String
    let applicationName: String
    let bundleIdentifier: String?
    let processIdentifier: Int32
    let windowTitle: String?
    let createdAt: Date
    let elements: [CachedElement]
}

enum SnapshotStore {
    private static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Ode/Computer Service/Snapshots", isDirectory: true)
    }

    static func save(_ snapshot: CachedSnapshot) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(snapshot)
        try data.write(to: directory.appendingPathComponent("\(snapshot.id).json"), options: .atomic)
        prune()
    }

    static func load(id: String) throws -> CachedSnapshot {
        let url = directory.appendingPathComponent("\(id).json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw HelperError.operationFailed("Desktop snapshot '\(id)' was not found; observe the app again")
        }
        return try JSONDecoder().decode(CachedSnapshot.self, from: Data(contentsOf: url))
    }

    private static func prune() {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        let sorted = urls.sorted {
            let lhs = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let rhs = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return lhs > rhs
        }
        for url in sorted.dropFirst(20) {
            try? FileManager.default.removeItem(at: url)
        }
    }
}
