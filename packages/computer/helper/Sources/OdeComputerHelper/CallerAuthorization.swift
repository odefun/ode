import Foundation
import Security

enum CallerAuthorization {
    private static let publicCommands: Set<String> = [
        "--version", "version", "permissions", "open-settings", "help",
    ]

    static func requireAuthorizedCaller(for command: String) throws {
        if publicCommands.contains(command) { return }
        let own = signingIdentity(for: ProcessInfo.processInfo.processIdentifier)
        let parent = signingIdentity(for: getppid())

        if let ownTeam = own.teamIdentifier {
            guard parent.identifier == "fun.ode.cli", parent.teamIdentifier == ownTeam else {
                throw HelperError.permissionDenied("Ode Computer Service rejected an unsigned or unrelated caller")
            }
            return
        }

        // Source and ad-hoc development builds have no TeamIdentifier. A
        // packaged ad-hoc CLI still carries our explicit identifier; source
        // runs must opt into the weaker local development path.
        if parent.identifier == "fun.ode.cli" { return }
        if ProcessInfo.processInfo.environment["ODE_COMPUTER_DEV_ALLOW_UNVERIFIED"] == "1" { return }
        throw HelperError.permissionDenied("Ode Computer Service requires the signed Ode CLI")
    }

    private static func signingIdentity(for pid: pid_t) -> (identifier: String?, teamIdentifier: String?) {
        var code: SecCode?
        let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              let code else { return (nil, nil) }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
              let staticCode else { return (nil, nil) }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let dictionary = information as? [CFString: Any] else { return (nil, nil) }
        return (
            dictionary[kSecCodeInfoIdentifier] as? String,
            dictionary[kSecCodeInfoTeamIdentifier] as? String
        )
    }
}
