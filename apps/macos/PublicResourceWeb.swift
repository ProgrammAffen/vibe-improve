import Foundation
import Darwin

enum PublicResourceWeb {
    static func address(_ raw: String) -> URL? {
        guard raw.utf8.count <= 2048, !raw.contains("\\"),
              raw.unicodeScalars.allSatisfy({ !CharacterSet.whitespacesAndNewlines.contains($0) && !CharacterSet.controlCharacters.contains($0) }),
              var url = URLComponents(string: raw), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.url?.host?.lowercased(),
              url.user == nil, url.password == nil, url.port == nil || url.port == (scheme == "https" ? 443 : 80),
              host.range(of: #"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$"#, options: .regularExpression) != nil,
              ![".local", ".localhost", ".internal", ".lan", ".home", ".test", ".invalid", ".onion"].contains(where: { host.hasSuffix($0) })
        else { return nil }
        if host.allSatisfy({ $0.isNumber || $0 == "." }), !publicIPv4(host) { return nil }
        url.scheme = scheme
        url.host = host
        url.port = nil
        url.fragment = nil
        if url.path.isEmpty { url.path = "/" }
        return url.url
    }

    static func publicIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        let address = parts.compactMap { UInt8($0) }
        guard parts.count == 4, address.count == 4, zip(parts, address).allSatisfy({ $0.0 == String($0.1) }) else { return false }
        let a = address[0], b = address[1], c = address[2]
        if a == 0 || a == 10 || a == 127 || a >= 224 { return false }
        if (a == 100 && (64...127).contains(b)) || (a == 169 && b == 254) || (a == 172 && (16...31).contains(b)) { return false }
        if a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)) { return false }
        if a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)) { return false }
        return !(a == 203 && b == 0 && c == 113)
    }

    private static func target(_ host: String) -> String? {
        var hints = addrinfo()
        hints.ai_family = AF_INET
        hints.ai_socktype = SOCK_STREAM
        var answers: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &answers) == 0, let first = answers else { return nil }
        defer { freeaddrinfo(first) }
        var candidate: UnsafeMutablePointer<addrinfo>? = first
        while let item = candidate {
            let address = item.pointee
            var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address.ai_addr, address.ai_addrlen, &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: name)
                if publicIPv4(ip) { return ip }
            }
            candidate = address.ai_next
        }
        return nil
    }

    static func fetch(_ input: URL, maximumTime: TimeInterval = 32) -> ResourceExtraction {
        var url = input
        var visited = Set<URL>()
        let deadline = Date().addingTimeInterval(maximumTime)
        let bound = 2 * 1024 * 1024
        for _ in 0...4 {
            guard visited.insert(url).inserted, let host = url.host else { return ResourceExtractors.failure("network") }
            guard let ip = target(host) else { return ResourceExtractors.failure("unreachableLink") }
            let remaining = Int(deadline.timeIntervalSinceNow)
            guard remaining > 0 else { return ResourceExtractors.failure("network") }
            let seconds = min(13, remaining)
            let port = url.scheme == "https" ? 443 : 80
            do {
                let response = try ResourceCommand.run("/usr/bin/curl",
                    ["--disable", "--silent", "--include", "--ipv4", "--globoff", "--http1.1",
                     "--noproxy", "*", "--proto", "=http,https", "--connect-timeout", "5", "--max-time", String(seconds),
                     "--max-filesize", String(bound), "--resolve", "\(host):\(port):\(ip)",
                     "--header", "Accept: text/html,text/plain,application/pdf;q=0.8", "--url", url.absoluteString],
                    maximum: bound + 32_768, seconds: Double(seconds + 1))
                if response.status == 63 { return ResourceExtraction(status: .attachment, reason: "fileTooLarge") }
                guard response.status == 0, let reply = http(response.bytes) else { return ResourceExtractors.failure("network") }
                if [301,302,303,307,308].contains(reply.code) {
                    guard let location = reply.headers["location"], let next = URL(string: location, relativeTo: url)?.absoluteURL,
                          let validated = address(next.absoluteString), !(url.scheme == "https" && validated.scheme == "http")
                    else { return ResourceExtractors.failure("unreachableLink") }
                    url = validated
                    continue
                }
                if [401,402,403].contains(reply.code) { return ResourceExtractors.failure("requiresLogin") }
                guard (200..<300).contains(reply.code) else { return ResourceExtractors.failure("network") }
                let contentType = reply.headers["content-type"]?.lowercased() ?? ""
                if contentType.hasPrefix("application/pdf") { return ResourceExtractors.pdf(data: reply.body) }
                let supported = contentType.isEmpty || ["text/html", "application/xhtml+xml", "text/plain"].contains(where: { contentType.hasPrefix($0) })
                guard supported else { return ResourceExtraction(status: .attachment, reason: "unsupported") }
                guard let text = ResourceExtractors.decoded(reply.body) else { return ResourceExtractors.failure("encoding") }
                return extractText(text, html: !contentType.hasPrefix("text/plain"))
            } catch ResourceError.limit { return ResourceExtraction(status: .attachment, reason: "fileTooLarge") }
            catch { return ResourceExtractors.failure("network") }
        }
        return ResourceExtractors.failure("network")
    }

    private static func http(_ bytes: Data) -> (code: Int, headers: [String: String], body: Data)? {
        let marker = Data([13, 10, 13, 10])
        var offset = bytes.startIndex
        for _ in 0..<4 {
            guard let end = bytes.range(of: marker, in: offset..<bytes.endIndex), end.lowerBound - offset <= 32_768 else { return nil }
            let headers = String(decoding: bytes[offset..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
            guard let status = headers.first?.split(separator: " "), status.count >= 2, status[0].hasPrefix("HTTP/"),
                  let code = Int(status[1]) else { return nil }
            offset = end.upperBound
            if code < 200 { continue }
            var fields: [String: String] = [:]
            for row in headers.dropFirst() {
                guard let colon = row.firstIndex(of: ":") else { continue }
                fields[row[..<colon].lowercased()] = row[row.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            return (code, fields, Data(bytes[offset...]))
        }
        return nil
    }

    static func extractText(_ text: String, html: Bool) -> ResourceExtraction {
        let hasPassword = html && text.range(of: #"(?is)<input\b[^>]*\btype\s*=\s*["']?password\b"#, options: .regularExpression) != nil
        var body = text
        if html {
            body = body.replacingOccurrences(of: #"(?s)<!--.*?-->"#, with: " ", options: .regularExpression)
            body = body.replacingOccurrences(of: #"(?is)<(script|style|template|svg|head|nav|footer|aside|header|form|noscript|button|dialog)\b[^>]*>.*?</\1\s*>"#, with: " ", options: .regularExpression)
            if let article = body.range(of: #"(?is)<article\b[^>]*>.*?</article\s*>"#, options: .regularExpression),
               ResourceExtractors.cleaned(String(body[article]).replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)).count >= 90 {
                body = String(body[article])
            } else if let main = body.range(of: #"(?is)<main\b[^>]*>.*?</main\s*>"#, options: .regularExpression) {
                body = String(body[main])
            }
            body = body.replacingOccurrences(of: #"(?i)</(?:p|li|h[1-6]|blockquote|pre|div|section|article|main)\s*>|<br\b[^>]*>"#, with: "\n", options: .regularExpression)
            body = entities(body.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression))
        }
        var entries: [(ResourceLocation, String)] = []
        var paragraph = 0
        for block in body.components(separatedBy: .newlines) {
            let content = ResourceExtractors.cleaned(block)
            guard !content.isEmpty else { continue }
            paragraph += 1
            if content.unicodeScalars.filter({ CharacterSet.letters.contains($0) }).count >= 20 {
                entries.append((ResourceLocation(kind: "paragraph", start: paragraph), content))
            }
        }
        let textSize = entries.reduce(0) { $0 + $1.1.count }
        guard textSize >= 90 else { return ResourceExtractors.failure(hasPassword ? "requiresLogin" : "emptyPage") }
        return ResourceExtractors.excerpts(entries, minimumLetters: 20)
    }

    static func entities(_ text: String) -> String {
        let pattern = try! NSRegularExpression(pattern: #"&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,12});"#)
        let values = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "ndash": "–", "mdash": "—", "hellip": "…"]
        let source = text as NSString
        let result = NSMutableString(string: text)
        for match in pattern.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            let name = source.substring(with: match.range(at: 1))
            let numeric = name.hasPrefix("#x") ? UInt32(name.dropFirst(2), radix: 16) : name.hasPrefix("#") ? UInt32(name.dropFirst()) : nil
            if let entity = values[name] ?? numeric.flatMap(UnicodeScalar.init).map(String.init) {
                result.replaceCharacters(in: match.range, with: entity)
            }
        }
        return result as String
    }
}
