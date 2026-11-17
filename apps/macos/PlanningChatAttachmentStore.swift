import Foundation
import ImageIO
import UniformTypeIdentifiers

final class PlanningChatAttachmentStore {
    private struct Entry: Codable {
        let name: String
        let document: String?
    }

    private static let imageBytes = 480 * 1024
    private static let sourceBytes = 20 * 1024 * 1024
    private let root: RuntimeDirectory

    init(runtime: RuntimeDirectory) throws {
        root = try runtime.child("projects").child("chat-attachments")
    }

    func add(_ urls: [URL], project: String, retaining ids: Set<String>) throws -> [String: Any] {
        let directory = try projectDirectory(project)
        let attachments: [[String: String]] = try directory.locked {
            removeUnused(in: directory, retaining: ids)
            return urls.compactMap { (try? store($0, in: directory))?.reference }
        }
        return ["attachments": attachments, "skipped": urls.count - attachments.count]
    }

    func read(_ id: String, project: String) throws -> PlanningChatAttachment {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw PlanningAgentError.attachment }
        let directory = try projectDirectory(project)
        guard let metadata = try directory.read(id + ".json", maximumBytes: 128 * 1024),
              let entry = try? JSONDecoder().decode(Entry.self, from: metadata)
        else { throw PlanningAgentError.attachment }
        if let document = entry.document {
            return PlanningChatAttachment(id: id, name: entry.name, content: .document(document))
        }
        let filename = id + ".jpg"
        guard let data = try directory.read(filename, maximumBytes: Self.imageBytes), !data.isEmpty
        else { throw PlanningAgentError.attachment }
        return PlanningChatAttachment(id: id, name: entry.name,
                                      content: .image(directory.url.appendingPathComponent(filename), data))
    }

    private func projectDirectory(_ project: String) throws -> RuntimeDirectory {
        guard project.range(of: "^proj_[a-f0-9-]{36}$", options: .regularExpression) != nil
        else { throw PlanningAgentError.attachment }
        return try root.child(project)
    }

    private func store(_ url: URL, in directory: RuntimeDirectory) throws -> PlanningChatAttachment {
        guard let stamp = ResourceExtractors.stamp(url) else { throw PlanningAgentError.attachment }
        let name = String(ResourceExtractors.cleaned(url.lastPathComponent).prefix(180))
        guard !name.isEmpty else { throw PlanningAgentError.attachment }
        let id = UUID().uuidString.lowercased()
        let format = ResourceExtractors.format(url.pathExtension)
        let document: String
        if format == "audio" || format == "video" { throw PlanningAgentError.attachment }
        if ["pdf","captions"].contains(format) || ["docx","rtf"].contains(url.pathExtension.lowercased()) {
            let item = LearningResource(id: id, version: id, format: format, name: name, origin: url.path, stamp: stamp, planning: false)
            let extracted = ResourceExtractors.extract(item)
            document = extracted.segments.map {
                let location = $0.location
                return "[\(location.kind) \(location.start)]\n\($0.text)"
            }.joined(separator: "\n\n")
        } else {
            let bytes = try ResourceExtractors.read(url, stamp: stamp, maximum: Self.sourceBytes)
            if let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
               CGImageSourceGetType(source) != nil {
                let image = try Self.thumbnail(source)
                let filename = id + ".jpg"
                try directory.write(filename, data: image)
                do {
                    try directory.write(id + ".json", data: JSONEncoder().encode(Entry(name: name, document: nil)))
                } catch {
                    try? directory.remove(filename)
                    throw error
                }
                return PlanningChatAttachment(id: id, name: name, content: .image(directory.url.appendingPathComponent(filename), image))
            }
            document = ResourceExtractors.decoded(bytes) ?? ""
        }
        let excerpt = String(document.trimmingCharacters(in: .whitespacesAndNewlines).prefix(12_000))
        guard !excerpt.isEmpty else { throw PlanningAgentError.attachment }
        try directory.write(id + ".json", data: JSONEncoder().encode(Entry(name: name, document: excerpt)))
        return PlanningChatAttachment(id: id, name: name, content: .document(excerpt))
    }

    private static func thumbnail(_ image: CGImageSource) throws -> Data {
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(image, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 1600
              ] as CFDictionary) else { throw PlanningAgentError.attachment }
        for quality in [0.88, 0.72, 0.52] {
            let encoded = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(encoded, UTType.jpeg.identifier as CFString, 1, nil)
            else { break }
            CGImageDestinationAddImage(destination, thumbnail, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            if CGImageDestinationFinalize(destination), encoded.length <= imageBytes { return encoded as Data }
        }
        throw PlanningAgentError.attachment
    }

    private func removeUnused(in directory: RuntimeDirectory, retaining ids: Set<String>) {
        let cutoff = Date().addingTimeInterval(-86_400)
        let paths = (try? FileManager.default.contentsOfDirectory(at: directory.url,
            includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles)) ?? []
        for url in paths where ["jpg","json"].contains(url.pathExtension) {
            let id = url.deletingPathExtension().lastPathComponent
            guard UUID(uuidString: id)?.uuidString.lowercased() == id, !ids.contains(id),
                  let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, date < cutoff
            else { continue }
            try? directory.remove(url.lastPathComponent)
        }
    }
}
