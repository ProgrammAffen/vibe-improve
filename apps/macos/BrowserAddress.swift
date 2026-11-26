import Darwin
import Foundation

// Check the URL presented to the browser. WebKit still resolves the hostname
// and applies its normal network and transport policies.
enum BrowserAddress {
    private static let maximumLength = 8_192
    private static let localSuffixes: Set<String> = [
        "local", "localhost", "localdomain", "internal", "lan", "home", "test",
        "invalid", "onion", "corp", "intranet",
    ]

    static func url(_ input: String, assumeHTTPS: Bool = false) -> URL? {
        guard safeText(input) else { return nil }
        var address = assumeHTTPS ? input.trimmingCharacters(in: .whitespaces) : input
        if assumeHTTPS && address.hasPrefix("//") {
            address = "https:" + address
        } else if assumeHTTPS && address.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) == nil {
            address = "https://" + address
        }
        guard let url = URL(string: address), permits(url) else { return nil }
        return url
    }

    static func permits(_ url: URL) -> Bool {
        let address = url.absoluteString
        guard safeText(address), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              address.prefix(scheme.count + 3).lowercased() == "\(scheme)://",
              url.user == nil, url.password == nil, let host = url.host?.lowercased(), !host.isEmpty
        else { return false }

        let authority = address.dropFirst(scheme.count + 3).prefix { !"/?#".contains($0) }
        guard !authority.contains("%"), permitsPort(in: authority) else { return false }
        if host.contains(":") { return publicIPv6(host) }

        let name = host.hasSuffix(".") ? String(host.dropLast()) : host
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        guard let last = labels.last, !last.isEmpty else { return false }
        // WebKit accepts additional IPv4 spellings. Only canonical dotted
        // decimal addresses are accepted here, so alternate forms cannot pass
        // through the hostname branch.
        if last.utf8.allSatisfy(asciiDigit) || (last.hasPrefix("0x") && last.utf8.dropFirst(2).allSatisfy(asciiHexDigit)) {
            return publicIPv4(labels)
        }
        return name.utf8.count <= 253 && labels.count >= 2 && labels.allSatisfy(validDomainLabel)
            && !localSuffixes.contains(String(last)) && name != "home.arpa" && !name.hasSuffix(".home.arpa")
    }

    private static func safeText(_ address: String) -> Bool {
        !address.isEmpty && address.utf8.count <= maximumLength && !address.contains("\\")
            && !address.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    private static func permitsPort(in authority: Substring) -> Bool {
        let suffix: Substring
        if authority.hasPrefix("[") {
            guard let end = authority.firstIndex(of: "]") else { return false }
            suffix = authority[authority.index(after: end)...]
        } else if let colon = authority.firstIndex(of: ":") {
            suffix = authority[colon...]
        } else {
            return true
        }
        if suffix.isEmpty { return true }
        let digits = suffix.dropFirst()
        guard suffix.first == ":", !digits.isEmpty, digits.utf8.allSatisfy(asciiDigit),
              let port = Int(digits) else { return false }
        return (1...65_535).contains(port)
    }

    private static func validDomainLabel(_ label: Substring) -> Bool {
        !label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
            && label.utf8.allSatisfy { asciiLetter($0) || asciiDigit($0) || $0 == 45 }
    }

    private static func asciiDigit(_ byte: UInt8) -> Bool { (48...57).contains(byte) }
    private static func asciiLetter(_ byte: UInt8) -> Bool { (97...122).contains(byte) }
    private static func asciiHexDigit(_ byte: UInt8) -> Bool { asciiDigit(byte) || (97...102).contains(byte) }

    private static func publicIPv4(_ labels: [Substring]) -> Bool {
        let octets = labels.compactMap { UInt8($0) }
        guard labels.count == 4, octets.count == 4, zip(labels, octets).allSatisfy({ $0.0 == String($0.1) }) else { return false }
        let a = octets[0], b = octets[1], c = octets[2]
        switch (a, b, c) {
        case (0, _, _), (10, _, _), (127, _, _), (224...255, _, _), (100, 64...127, _),
             (169, 254, _), (172, 16...31, _), (192, 0, 0), (192, 0, 2), (192, 88, 99),
             (192, 168, _), (198, 18...19, _), (198, 51, 100), (203, 0, 113):
            return false
        default:
            return true
        }
    }

    private static func publicIPv6(_ host: String) -> Bool {
        let literal = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
        var address = in6_addr()
        guard literal.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return false }
        return withUnsafeBytes(of: &address) { bytes in
            let first = bytes[0], second = bytes[1], third = bytes[2], fourth = bytes[3]
            // Global unicast, excluding protocol, relay and documentation ranges.
            guard first & 0xe0 == 0x20 else { return false }
            if first == 0x20 && second == 0x01 && (third < 0x02 || (third == 0x0d && fourth == 0xb8)) { return false }
            if first == 0x20 && second == 0x02 { return false }
            return !(first == 0x3f && second == 0xff && third < 0x10)
        }
    }
}
