import AppKit
import Foundation

// The helper is a bundled command process so macOS attributes TCC consent to
// this stable application identity instead of Terminal, Bun, or Ode itself.

@main
struct OdeComputerHelper {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    static func main() async {
        let args = Arguments(values: Array(CommandLine.arguments.dropFirst()))
        do {
            try CallerAuthorization.requireAuthorizedCaller(for: args.command)
            switch args.command {
            case "--version", "version":
                print("Ode Computer Service \(version)")
            case "permissions":
                if args.positional(at: 0) == "request" || args.contains("--request") {
                    emitSuccess(await Permissions.request().json)
                } else {
                    emitSuccess(Permissions.current().json)
                }
            case "open-settings":
                let kind = args.positional(at: 0) ?? "accessibility"
                try await MainActor.run { try Permissions.openSettings(kind: kind) }
                emitSuccess(["opened": kind])
            case "see":
                try await observe(args)
            case "click":
                let target = try required(args.value(after: "--on") ?? args.value(after: "--id"), "--on")
                let snapshot = try required(args.value(after: "--snapshot"), "--snapshot")
                emitSuccess(try await InputActions.click(snapshotID: snapshot, targetID: target, double: args.contains("--double")))
            case "type":
                let text: String
                if args.contains("--stdin") {
                    let data = FileHandle.standardInput.readDataToEndOfFile()
                    guard let value = String(data: data, encoding: .utf8), !value.isEmpty else {
                        throw HelperError.invalidArguments("Expected UTF-8 text on stdin")
                    }
                    text = value
                } else {
                    text = try required(args.positional(at: 0), "text")
                }
                let app = try required(args.value(after: "--app"), "--app")
                emitSuccess(try await InputActions.type(text: text, appName: app))
            case "press":
                let key = try required(args.positional(at: 0), "key")
                let app = try required(args.value(after: "--app"), "--app")
                emitSuccess(try await InputActions.press(key: key, appName: app))
            case "hotkey":
                let keys = try required(args.value(after: "--keys"), "--keys")
                    .split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                let app = try required(args.value(after: "--app"), "--app")
                emitSuccess(try await InputActions.hotkey(keys: keys, appName: app))
            case "scroll":
                let direction = try required(args.value(after: "--direction"), "--direction")
                let amount = Int32(args.value(after: "--amount") ?? "5") ?? 5
                let app = try required(args.value(after: "--app"), "--app")
                emitSuccess(try await InputActions.scroll(
                    direction: direction,
                    amount: amount,
                    appName: app,
                    snapshotID: args.value(after: "--snapshot"),
                    targetID: args.value(after: "--on")
                ))
            case "app":
                guard args.positional(at: 0) == "launch" else {
                    throw HelperError.invalidArguments("Expected: app launch <application>")
                }
                let appName = try required(args.positional(at: 1), "application")
                let app = try await Applications.launch(named: appName)
                emitSuccess(["application_name": app.name, "process_id": app.processIdentifier])
            case "open":
                let rawURL = try required(args.positional(at: 0), "url")
                guard let url = URL(string: rawURL) else { throw HelperError.invalidArguments("Invalid URL") }
                let appName = try required(args.value(after: "--app"), "--app")
                try await Applications.open(url: url, with: appName)
                emitSuccess(["url": rawURL, "application_name": appName])
            case "self-test":
                try await selfTest(args)
            default:
                emitSuccess([
                    "name": "Ode Computer Service",
                    "version": version,
                    "commands": ["permissions", "open-settings", "see", "click", "type", "press", "hotkey", "scroll", "app launch", "open", "self-test"],
                ])
            }
        } catch {
            let code: String
            switch error {
            case HelperError.permissionDenied: code = "PERMISSION_DENIED"
            case HelperError.appNotFound: code = "APP_NOT_FOUND"
            case HelperError.invalidArguments: code = "INVALID_ARGUMENTS"
            default: code = "OPERATION_FAILED"
            }
            emitFailure(error, code: code)
            Foundation.exit(1)
        }
    }

    private static func observe(_ args: Arguments) async throws {
        let appName = try required(args.value(after: "--app"), "--app")
        let app = try await MainActor.run { try Applications.running(named: appName) }
        let observation = try AccessibilitySnapshot.observe(pid: app.processIdentifier)
        let snapshotID = UUID().uuidString.lowercased()
        let snapshot = CachedSnapshot(
            id: snapshotID,
            applicationName: app.name,
            bundleIdentifier: app.bundleIdentifier,
            processIdentifier: app.processIdentifier,
            windowTitle: observation.windowTitle,
            createdAt: Date(),
            elements: observation.elements.map(\.cached)
        )
        try SnapshotStore.save(snapshot)
        var data: [String: Any] = [
            "application_name": app.name,
            "process_id": app.processIdentifier,
            "snapshot_id": snapshotID,
            "ui_elements": observation.elements.map(\.json),
        ]
        if let bundleIdentifier = app.bundleIdentifier { data["bundle_id"] = bundleIdentifier }
        if let windowTitle = observation.windowTitle { data["window_title"] = windowTitle }

        if let path = args.value(after: "--path") {
            let capture = try await WindowCapture.capture(
                pid: app.processIdentifier,
                preferredTitle: observation.windowTitle,
                path: path,
                annotate: args.contains("--annotate"),
                elements: snapshot.elements
            )
            data["screenshot_raw"] = capture.rawPath
            if let annotated = capture.annotatedPath { data["screenshot_annotated"] = annotated }
            data["window_id"] = capture.windowID
        }
        emitSuccess(data)
    }

    private static func selfTest(_ args: Arguments) async throws {
        let permissions = Permissions.current()
        var result: [String: Any] = permissions.json
        var passed = permissions.allGranted
        result["version"] = version
        result["executable"] = CommandLine.arguments.first ?? ""
        if permissions.accessibility,
           let frontmost = await MainActor.run(body: { NSWorkspace.shared.frontmostApplication }),
           frontmost.processIdentifier != ProcessInfo.processInfo.processIdentifier {
            let observation = try AccessibilitySnapshot.observe(pid: frontmost.processIdentifier, limit: 10)
            result["accessibilityProbe"] = [
                "application": frontmost.localizedName ?? frontmost.bundleIdentifier ?? "unknown",
                "elements": observation.elements.count,
            ]
        }
        if permissions.screenRecording,
           let frontmost = await MainActor.run(body: { NSWorkspace.shared.frontmostApplication }),
           frontmost.processIdentifier != ProcessInfo.processInfo.processIdentifier {
            let output = args.value(after: "--path")
                ?? FileManager.default.temporaryDirectory.appendingPathComponent("ode-computer-self-test.png").path
            let capture = try await WindowCapture.capture(
                pid: frontmost.processIdentifier,
                preferredTitle: nil,
                path: output,
                annotate: false,
                elements: []
            )
            result["screenshotProbe"] = ["path": capture.rawPath, "window_id": capture.windowID]
        }
        if permissions.accessibility {
            let calculator = try await Applications.launchNew(named: "Calculator")
            try? await Task.sleep(nanoseconds: 350_000_000)
            _ = try? await InputActions.press(key: "escape", appName: calculator.name)
            let before = try AccessibilitySnapshot.observe(pid: calculator.processIdentifier)
            if let one = before.elements.first(where: { $0.cached.role == "AXButton" && $0.cached.title == "1" }) {
                let snapshotID = UUID().uuidString.lowercased()
                try SnapshotStore.save(CachedSnapshot(
                    id: snapshotID,
                    applicationName: calculator.name,
                    bundleIdentifier: calculator.bundleIdentifier,
                    processIdentifier: calculator.processIdentifier,
                    windowTitle: before.windowTitle,
                    createdAt: Date(),
                    elements: before.elements.map(\.cached)
                ))
                _ = try await InputActions.click(snapshotID: snapshotID, targetID: one.cached.id, double: false)
                try? await Task.sleep(nanoseconds: 250_000_000)
                let after = try AccessibilitySnapshot.observe(pid: calculator.processIdentifier)
                let display = after.elements
                    .compactMap(\.cached.title)
                    .first(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).contains("1") })
                let clicked = display != nil
                result["clickProbe"] = ["clicked": clicked, "application": calculator.name, "display": display ?? ""]
                passed = passed && clicked
                _ = try? await InputActions.press(key: "escape", appName: calculator.name)
            } else {
                result["clickProbe"] = ["clicked": false, "application": calculator.name, "error": "Calculator button 1 was not found"]
                passed = false
            }
            await MainActor.run { calculator.running.terminate() }
        }
        result["passed"] = passed
        emitSuccess(result)
    }

    private static func required(_ value: String?, _ name: String) throws -> String {
        guard let value, !value.isEmpty else { throw HelperError.invalidArguments("\(name) is required") }
        return value
    }
}
