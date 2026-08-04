import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct PermissionState {
    let screenRecording: Bool
    let accessibility: Bool

    var allGranted: Bool { screenRecording && accessibility }

    var json: [String: Any] {
        [
            "permissions": [
                [
                    "name": "Screen Recording",
                    "isGranted": screenRecording,
                    "isRequired": true,
                    "grantInstructions": "System Settings > Privacy & Security > Screen & System Audio Recording",
                ],
                [
                    "name": "Accessibility",
                    "isGranted": accessibility,
                    "isRequired": true,
                    "grantInstructions": "System Settings > Privacy & Security > Accessibility",
                ],
            ],
            "allGranted": allGranted,
            "source": "ode",
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "fun.ode.app",
        ]
    }
}

enum Permissions {
    static func current() -> PermissionState {
        PermissionState(
            screenRecording: CGPreflightScreenCaptureAccess(),
            accessibility: AXIsProcessTrusted()
        )
    }

    @MainActor
    static func request() async -> PermissionState {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        // TCC prompts are delivered through the app run loop. Keep the short-
        // lived command process alive long enough for macOS to register Ode and
        // present both consent surfaces.
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if current().allGranted { break }
        }
        return current()
    }

    @MainActor
    static func openSettings(kind: String) throws {
        let pane: String
        switch kind.lowercased() {
        case "screen", "screen-recording", "recording":
            pane = "Privacy_ScreenCapture"
        case "accessibility", "ax":
            pane = "Privacy_Accessibility"
        default:
            throw HelperError.invalidArguments("Expected settings kind: screen-recording or accessibility")
        }
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else {
            throw HelperError.operationFailed("Unable to construct the System Settings URL")
        }
        NSWorkspace.shared.open(url)
    }
}
