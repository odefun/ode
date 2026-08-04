import ApplicationServices
import Foundation

struct ObservedElement {
    let cached: CachedElement
    let json: [String: Any]
}

struct AccessibilityObservation {
    let windowTitle: String?
    let elements: [ObservedElement]
}

enum AccessibilitySnapshot {
    static func observe(pid: pid_t, limit: Int = 250) throws -> AccessibilityObservation {
        guard AXIsProcessTrusted() else {
            throw HelperError.permissionDenied("Accessibility permission is required")
        }
        let app = AXUIElementCreateApplication(pid)
        let root = copyElement(app, attribute: kAXFocusedWindowAttribute as String)
            ?? copyElements(app, attribute: kAXWindowsAttribute as String).first
            ?? app
        let windowTitle = copyString(root, attribute: kAXTitleAttribute as String)
        var counters: [String: Int] = [:]
        var observed: [ObservedElement] = []
        var visited = Set<CFHashCode>()

        func walk(_ element: AXUIElement, depth: Int) {
            guard observed.count < limit, depth <= 16 else { return }
            let hash = CFHash(element)
            guard !visited.contains(hash) else { return }
            visited.insert(hash)

            let role = copyString(element, attribute: kAXRoleAttribute as String) ?? "AXUnknown"
            let title = firstNonEmpty([
                copyString(element, attribute: kAXTitleAttribute as String),
                copyString(element, attribute: kAXDescriptionAttribute as String),
                copyString(element, attribute: kAXHelpAttribute as String),
                stringValue(element),
            ])
            if let frame = copyFrame(element), shouldExpose(role: role, title: title, frame: frame) {
                let prefix = idPrefix(for: role)
                counters[prefix, default: 0] += 1
                let id = "\(prefix)\(counters[prefix] ?? 1)"
                let cached = CachedElement(id: id, role: role, title: title, frame: frame)
                var json: [String: Any] = [
                    "id": id,
                    "role": displayRole(role),
                    "role_raw": role,
                    "frame": ["x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height],
                    "is_enabled": copyBool(element, attribute: kAXEnabledAttribute as String) ?? true,
                    "is_focused": copyBool(element, attribute: kAXFocusedAttribute as String) ?? false,
                ]
                if let title { json["title"] = title; json["label"] = title }
                observed.append(ObservedElement(cached: cached, json: json))
            }

            for child in copyElements(element, attribute: kAXChildrenAttribute as String) {
                walk(child, depth: depth + 1)
                if observed.count >= limit { break }
            }
        }

        walk(root, depth: 0)
        return AccessibilityObservation(windowTitle: windowTitle, elements: observed)
    }

    private static func shouldExpose(role: String, title: String?, frame: ElementFrame) -> Bool {
        guard frame.width > 0, frame.height > 0, frame.width < 20_000, frame.height < 20_000 else { return false }
        let interactive: Set<String> = [
            kAXButtonRole as String, kAXCheckBoxRole as String, kAXComboBoxRole as String,
            "AXLink", kAXMenuItemRole as String, kAXPopUpButtonRole as String,
            kAXRadioButtonRole as String, kAXSearchFieldSubrole as String, kAXSliderRole as String,
            kAXTextAreaRole as String, kAXTextFieldRole as String, kAXToolbarRole as String,
        ]
        return interactive.contains(role) || title != nil
    }

    private static func idPrefix(for role: String) -> String {
        switch role {
        case "AXButton": return "B"
        case "AXTextField", "AXTextArea", "AXSearchField": return "T"
        case "AXLink": return "L"
        case "AXCheckBox": return "C"
        case "AXMenuItem", "AXMenu": return "M"
        case "AXRadioButton": return "R"
        default: return "E"
        }
    }

    private static func displayRole(_ role: String) -> String {
        role.replacingOccurrences(of: "AX", with: "")
    }

    private static func copyValue(_ element: AXUIElement, attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    private static func copyElement(_ element: AXUIElement, attribute: String) -> AXUIElement? {
        guard let value = copyValue(element, attribute: attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private static func copyElements(_ element: AXUIElement, attribute: String) -> [AXUIElement] {
        guard let value = copyValue(element, attribute: attribute) as? [AXUIElement] else { return [] }
        return value
    }

    private static func copyString(_ element: AXUIElement, attribute: String) -> String? {
        guard let value = copyValue(element, attribute: attribute) else { return nil }
        if let text = value as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let attributed = value as? NSAttributedString { return attributed.string.trimmingCharacters(in: .whitespacesAndNewlines) }
        return nil
    }

    private static func stringValue(_ element: AXUIElement) -> String? {
        guard let value = copyValue(element, attribute: kAXValueAttribute as String) else { return nil }
        if let text = value as? String, text.count <= 300 { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        return nil
    }

    private static func copyBool(_ element: AXUIElement, attribute: String) -> Bool? {
        copyValue(element, attribute: attribute) as? Bool
    }

    private static func copyFrame(_ element: AXUIElement) -> ElementFrame? {
        guard let positionValue = copyValue(element, attribute: kAXPositionAttribute as String),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              let sizeValue = copyValue(element, attribute: kAXSizeAttribute as String),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(positionValue, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size) else { return nil }
        return ElementFrame(x: point.x, y: point.y, width: size.width, height: size.height)
    }

    private static func firstNonEmpty(_ values: [String?]) -> String? {
        values.compactMap { value in
            guard let value else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : String(trimmed.prefix(300))
        }.first
    }
}
