import CoreGraphics
import CoreText
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct CaptureResult {
    let rawPath: String
    let annotatedPath: String?
    let windowID: CGWindowID
}

enum WindowCapture {
    static func capture(
        pid: pid_t,
        preferredTitle: String?,
        path: String,
        annotate: Bool,
        elements: [CachedElement]
    ) async throws -> CaptureResult {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError.permissionDenied("Screen Recording permission is required")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.frame.width > 20 && $0.frame.height > 20 }
        guard let window = chooseWindow(candidates, preferredTitle: preferredTitle) else {
            throw HelperError.operationFailed("No capturable window was found for PID \(pid)")
        }

        let scale = displayScale(for: window.frame)
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(window.frame.width * scale))
        configuration.height = max(1, Int(window.frame.height * scale))
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        try writePNG(image, to: path)

        var annotatedPath: String?
        if annotate {
            let url = URL(fileURLWithPath: path)
            let annotated = url.deletingPathExtension().appendingPathExtension("annotated.png").path
            let marked = try drawAnnotations(on: image, windowFrame: window.frame, elements: elements)
            try writePNG(marked, to: annotated)
            annotatedPath = annotated
        }
        return CaptureResult(rawPath: path, annotatedPath: annotatedPath, windowID: window.windowID)
    }

    private static func chooseWindow(_ windows: [SCWindow], preferredTitle: String?) -> SCWindow? {
        if let preferredTitle, !preferredTitle.isEmpty,
           let exact = windows.first(where: { $0.title?.localizedCaseInsensitiveContains(preferredTitle) == true }) {
            return exact
        }
        return windows.max { lhs, rhs in
            lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
        }
    }

    private static func displayScale(for frame: CGRect) -> CGFloat {
        for display in NSScreen.screens where display.frame.intersects(frame) {
            return display.backingScaleFactor
        }
        return NSScreen.main?.backingScaleFactor ?? 2
    }

    private static func writePNG(_ image: CGImage, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw HelperError.operationFailed("Unable to create screenshot destination")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw HelperError.operationFailed("Unable to write screenshot to \(path)")
        }
    }

    private static func drawAnnotations(
        on image: CGImage,
        windowFrame: CGRect,
        elements: [CachedElement]
    ) throws -> CGImage {
        let width = image.width
        let height = image.height
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw HelperError.operationFailed("Unable to allocate annotation canvas")
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let scaleX = CGFloat(width) / max(windowFrame.width, 1)
        let scaleY = CGFloat(height) / max(windowFrame.height, 1)

        for element in elements {
            let localX = CGFloat(element.frame.x) - windowFrame.minX
            let localY = CGFloat(element.frame.y) - windowFrame.minY
            let localWidth = CGFloat(element.frame.width)
            let localHeight = CGFloat(element.frame.height)
            guard localX + localWidth >= 0, localY + localHeight >= 0,
                  localX <= windowFrame.width, localY <= windowFrame.height else { continue }
            let rect = CGRect(
                x: localX * scaleX,
                y: CGFloat(height) - ((localY + localHeight) * scaleY),
                width: localWidth * scaleX,
                height: localHeight * scaleY
            ).intersection(CGRect(x: 0, y: 0, width: width, height: height))
            guard rect.width >= 3, rect.height >= 3 else { continue }
            context.setStrokeColor(CGColor(red: 1, green: 0.18, blue: 0.12, alpha: 0.9))
            context.setLineWidth(max(2, scaleX))
            context.stroke(rect)
            drawLabel(element.id, at: CGPoint(x: rect.minX, y: min(CGFloat(height) - 18, rect.maxY)), in: context)
        }
        guard let result = context.makeImage() else {
            throw HelperError.operationFailed("Unable to render annotated screenshot")
        }
        return result
    }

    private static func drawLabel(_ text: String, at point: CGPoint, in context: CGContext) {
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 12, nil)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: CGColor(gray: 1, alpha: 1),
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        let line = CTLineCreateWithAttributedString(attributed)
        let bounds = CTLineGetBoundsWithOptions(line, [.useOpticalBounds])
        let background = CGRect(x: point.x, y: point.y, width: bounds.width + 8, height: 17)
        context.setFillColor(CGColor(red: 0.85, green: 0.08, blue: 0.04, alpha: 0.95))
        context.fill(background)
        context.textPosition = CGPoint(x: point.x + 4, y: point.y + 3)
        CTLineDraw(line, context)
    }
}
