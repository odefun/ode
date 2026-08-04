import Foundation

enum HelperError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case appNotFound(String)
    case permissionDenied(String)
    case operationFailed(String)

    var description: String {
        switch self {
        case .invalidArguments(let message),
             .appNotFound(let message),
             .permissionDenied(let message),
             .operationFailed(let message):
            return message
        }
    }
}

struct Arguments {
    let values: [String]

    var command: String { values.first ?? "help" }

    func value(after flag: String) -> String? {
        guard let index = values.firstIndex(of: flag), index + 1 < values.count else { return nil }
        return values[index + 1]
    }

    func contains(_ flag: String) -> Bool {
        values.contains(flag)
    }

    func positional(at index: Int) -> String? {
        var positional: [String] = []
        var skipNext = false
        let flagsWithValues: Set<String> = [
            "--app", "--path", "--on", "--snapshot", "--keys", "--direction",
            "--amount", "--timeout-seconds", "--wait-until-ready", "--open", "--response-file",
        ]
        for value in values.dropFirst() {
            if skipNext {
                skipNext = false
                continue
            }
            if flagsWithValues.contains(value) {
                skipNext = true
                continue
            }
            if value.hasPrefix("--") { continue }
            positional.append(value)
        }
        return positional.indices.contains(index) ? positional[index] : nil
    }
}

func emitSuccess(_ data: [String: Any] = [:]) {
    emitJSON(["success": true, "data": data])
}

func emitFailure(_ error: Error, code: String = "HELPER_ERROR") {
    emitJSON([
        "success": false,
        "error": [
            "code": code,
            "message": error.localizedDescription == "The operation couldn’t be completed."
                ? String(describing: error)
                : error.localizedDescription,
        ],
    ])
}

func emitJSON(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        FileHandle.standardError.write(Data("Unable to encode helper response\n".utf8))
        return
    }
    let output = Data((text + "\n").utf8)
    FileHandle.standardOutput.write(output)
    if let index = CommandLine.arguments.firstIndex(of: "--response-file"), index + 1 < CommandLine.arguments.count {
        let url = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? output.write(to: url, options: .atomic)
    }
}

extension HelperError: LocalizedError {
    var errorDescription: String? { description }
}
