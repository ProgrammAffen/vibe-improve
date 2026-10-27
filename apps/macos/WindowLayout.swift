import Foundation

enum WindowLayout {
    static let videoSize = CGSize(width: 1920, height: 1080)
    static let minimumContentSize = CGSize(width: 1024, height: 576)
    static func initialContentSize(available: CGSize, decorationHeight: CGFloat) -> CGSize {
        let scale = min(1, max(1, available.width) / videoSize.width, max(1, available.height - max(0, decorationHeight)) / videoSize.height)
        return CGSize(width: videoSize.width * scale, height: videoSize.height * scale)
    }
}
