import Foundation

struct LocalClientOrigin {
    let port: UInt16
    var startURL: URL { URL(string: "http://127.0.0.1:\(port)/vibe-improve/")! }

    func permits(_ url: URL) -> Bool {
        let path = url.standardized.path
        return port > 0 && url.scheme == "http" && url.host == "127.0.0.1" &&
        url.port == Int(port) && url.user == nil && url.password == nil &&
        (path == "/vibe-improve" || path.hasPrefix("/vibe-improve/"))
    }
}
