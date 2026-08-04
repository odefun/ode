import AppKit
import CoreGraphics
import Foundation

enum InputActions {
    static func click(snapshotID: String, targetID: String, double: Bool) async throws -> [String: Any] {
        try requireAccessibility()
        let snapshot = try SnapshotStore.load(id: snapshotID)
        guard let target = snapshot.elements.first(where: { $0.id == targetID }) else {
            throw HelperError.operationFailed("Element '\(targetID)' is not part of snapshot '\(snapshotID)'")
        }
        let app = try await MainActor.run { try Applications.running(named: "PID:\(snapshot.processIdentifier)") }
        await MainActor.run { Applications.activate(app) }
        try await Task.sleep(nanoseconds: 120_000_000)

        let point = CGPoint(x: target.frame.centerX, y: target.frame.centerY)
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw HelperError.operationFailed("Unable to create an input event source")
        }
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        let count = double ? 2 : 1
        for click in 1...count {
            let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
            let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
            if double { try await Task.sleep(nanoseconds: 70_000_000) }
        }
        return ["action": double ? "double_click" : "click", "target": targetID, "x": point.x, "y": point.y]
    }

    static func type(text: String, appName: String) async throws -> [String: Any] {
        try requireAccessibility()
        let app = try await MainActor.run { try Applications.running(named: appName) }
        await MainActor.run { Applications.activate(app) }
        try await Task.sleep(nanoseconds: 80_000_000)
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw HelperError.operationFailed("Unable to create an input event source")
        }
        let units = Array(text.utf16)
        for start in stride(from: 0, to: units.count, by: 16) {
            let end = min(start + 16, units.count)
            let chunk = Array(units[start..<end])
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
            chunk.withUnsafeBufferPointer { pointer in
                down?.keyboardSetUnicodeString(stringLength: pointer.count, unicodeString: pointer.baseAddress!)
            }
            down?.post(tap: .cghidEventTap)
            CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)?.post(tap: .cghidEventTap)
        }
        return ["action": "type", "characters": text.count]
    }

    static func press(key: String, appName: String) async throws -> [String: Any] {
        try requireAccessibility()
        let app = try await MainActor.run { try Applications.running(named: appName) }
        await MainActor.run { Applications.activate(app) }
        guard let keyCode = keyCode(for: key) else {
            throw HelperError.invalidArguments("Unsupported key '\(key)'")
        }
        try postKey(keyCode, flags: [])
        return ["action": "press", "key": key]
    }

    static func hotkey(keys: [String], appName: String) async throws -> [String: Any] {
        try requireAccessibility()
        guard let final = keys.last, let keyCode = keyCode(for: final) else {
            throw HelperError.invalidArguments("A supported final key is required")
        }
        var flags: CGEventFlags = []
        for key in keys.dropLast().map({ $0.lowercased() }) {
            switch key {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: throw HelperError.invalidArguments("Unsupported modifier '\(key)'")
            }
        }
        let app = try await MainActor.run { try Applications.running(named: appName) }
        await MainActor.run { Applications.activate(app) }
        try postKey(keyCode, flags: flags)
        return ["action": "hotkey", "keys": keys]
    }

    static func scroll(
        direction: String,
        amount: Int32,
        appName: String,
        snapshotID: String?,
        targetID: String?
    ) async throws -> [String: Any] {
        try requireAccessibility()
        let app = try await MainActor.run { try Applications.running(named: appName) }
        await MainActor.run { Applications.activate(app) }
        if let snapshotID, let targetID,
           let target = try SnapshotStore.load(id: snapshotID).elements.first(where: { $0.id == targetID }) {
            let point = CGPoint(x: target.frame.centerX, y: target.frame.centerY)
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        }
        let vertical: Int32
        let horizontal: Int32
        switch direction.lowercased() {
        case "up": vertical = amount; horizontal = 0
        case "down": vertical = -amount; horizontal = 0
        case "left": vertical = 0; horizontal = amount
        case "right": vertical = 0; horizontal = -amount
        default: throw HelperError.invalidArguments("Expected scroll direction: up, down, left, or right")
        }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 2,
            wheel1: vertical,
            wheel2: horizontal,
            wheel3: 0
        ) else { throw HelperError.operationFailed("Unable to create a scroll event") }
        event.post(tap: .cghidEventTap)
        return ["action": "scroll", "direction": direction, "amount": amount]
    }

    private static func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw HelperError.permissionDenied("Accessibility permission is required")
        }
    }

    private static func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            throw HelperError.operationFailed("Unable to create a keyboard event")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private static func keyCode(for raw: String) -> CGKeyCode? {
        let key = raw.lowercased()
        let codes: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
            "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16,
            "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24,
            "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32,
            "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38,
            "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
            ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
            "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
        ]
        return codes[key]
    }
}
