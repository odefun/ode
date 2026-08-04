import AppKit
import Foundation

struct TargetApplication {
    let name: String
    let bundleIdentifier: String?
    let processIdentifier: pid_t
    let running: NSRunningApplication
}

enum Applications {
    @MainActor
    static func running(named query: String) throws -> TargetApplication {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.uppercased().hasPrefix("PID:"),
           let pid = pid_t(normalized.dropFirst(4)),
           let app = NSRunningApplication(processIdentifier: pid) {
            return target(app)
        }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
        if let exact = apps.first(where: {
            $0.bundleIdentifier?.caseInsensitiveCompare(normalized) == .orderedSame
                || $0.localizedName?.caseInsensitiveCompare(normalized) == .orderedSame
        }) {
            return target(exact)
        }
        if let partial = apps.first(where: {
            $0.localizedName?.localizedCaseInsensitiveContains(normalized) == true
        }) {
            return target(partial)
        }
        throw HelperError.appNotFound("Application '\(query)' is not running")
    }

    @MainActor
    static func activate(_ app: TargetApplication) {
        if #available(macOS 14.0, *) {
            app.running.activate()
        } else {
            app.running.activate(options: [.activateIgnoringOtherApps])
        }
    }

    @MainActor
    static func launch(named query: String) async throws -> TargetApplication {
        if let existing = try? running(named: query) {
            activate(existing)
            return existing
        }
        let workspace = NSWorkspace.shared
        let appURL = installedURL(named: query)
        guard let appURL else {
            throw HelperError.appNotFound("Application '\(query)' is not installed")
        }
        let running = try await workspace.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
        let result = target(running)
        activate(result)
        return result
    }

    @MainActor
    static func launchNew(named query: String) async throws -> TargetApplication {
        guard let appURL = installedURL(named: query) else {
            throw HelperError.appNotFound("Application '\(query)' is not installed")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = true
        let running = try await NSWorkspace.shared.openApplication(at: appURL, configuration: configuration)
        let result = target(running)
        activate(result)
        return result
    }

    @MainActor
    static func open(url: URL, with query: String) async throws {
        let workspace = NSWorkspace.shared
        let appURL = installedURL(named: query)
        guard let appURL else {
            throw HelperError.appNotFound("Application '\(query)' is not installed")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            workspace.open([url], withApplicationAt: appURL, configuration: configuration) { _, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    @MainActor
    private static func target(_ app: NSRunningApplication) -> TargetApplication {
        TargetApplication(
            name: app.localizedName ?? app.bundleIdentifier ?? "PID:\(app.processIdentifier)",
            bundleIdentifier: app.bundleIdentifier,
            processIdentifier: app.processIdentifier,
            running: app
        )
    }

    @MainActor
    private static func installedURL(named query: String) -> URL? {
        let workspace = NSWorkspace.shared
        if query.contains("."), let bundleURL = workspace.urlForApplication(withBundleIdentifier: query) {
            return bundleURL
        }
        let appName = query.hasSuffix(".app") ? query : "\(query).app"
        let roots = [
            "/Applications",
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path,
            "/System/Applications",
            "/System/Applications/Utilities",
        ]
        return roots
            .map { URL(fileURLWithPath: $0, isDirectory: true).appendingPathComponent(appName, isDirectory: true) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }
}
