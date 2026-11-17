import AVFoundation
import Foundation

struct ResourceWhisper {
    static let locales = ["auto", "zh-CN", "en-US"]
    private static let clipLength = 120_000
    private static let sampleRate: Int32 = 16_000
    private static let maximumChunkBytes = 512 * 1024

    private enum Failure: String, Error { case moved, noAudio, noSpeech, speechUnavailable, speechFailed, speechPaused }
    private struct Cue: Codable {
        let location: ResourceLocation
        let text: String
    }
    private struct Chunk: Codable {
        let start: Int
        let end: Int
        let cues: [Cue]
    }

    private let engine: URL
    private let weights: URL

    init(engine: URL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/vibe-whisper"),
         weights: URL = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/Whisper/ggml-small-q5_1.bin")) {
        self.engine = engine
        self.weights = weights
    }

    func transcribe(_ item: LearningResource, in directory: RuntimeDirectory, continueWhile: @escaping () -> Bool,
                    progress: (Int, Int, Bool) throws -> Void) throws -> ResourceExtraction {
        var read = item.read, total = item.total, hasTranscript = item.hasTranscript == true
        do {
            guard let url = try? ResourceExtractors.fileURL(item) else { throw Failure.moved }
            guard FileManager.default.isExecutableFile(atPath: engine.path),
                  FileManager.default.isReadableFile(atPath: weights.path) else { throw Failure.speechUnavailable }
            let asset = AVURLAsset(url: url)
            guard let tracks = ResourceMedia.loadMedia({ try await asset.loadTracks(withMediaType: .audio) })
            else { throw Failure.speechUnavailable }
            guard let track = tracks.first else { throw Failure.noAudio }
            guard let range = ResourceMedia.loadMedia({ try await track.load(.timeRange) }),
                  range.start.isNumeric, CMTimeRangeGetEnd(range).isNumeric else { throw Failure.speechUnavailable }
            let from = max(0, CMTimeConvertScale(range.start, timescale: 1_000, method: .roundTowardZero).value)
            let until = CMTimeConvertScale(CMTimeRangeGetEnd(range), timescale: 1_000, method: .roundAwayFromZero).value
            guard let start = Int(exactly: from), let end = Int(exactly: until), end > start else { throw Failure.noAudio }
            let seconds = (end - start - 1) / 1_000 + 1
            total = seconds

            return try directory.locked {
                let scratch = "audio.pcm"
                defer { try? directory.remove(scratch) }
                var cursor = start, index = 0, cues: [Cue] = []
                var useCPU = false
                func report() throws {
                    read = cursor == end ? seconds : (cursor - start) / 1_000
                    hasTranscript = !cues.isEmpty
                    try progress(read ?? 0, seconds, hasTranscript)
                }

                while cursor < end, let saved = try Self.chunk(index, in: directory) {
                    guard saved.start == cursor, saved.end == cursor + min(Self.clipLength, end - cursor)
                    else { throw Failure.speechFailed }
                    cues.append(contentsOf: saved.cues)
                    cursor = saved.end
                    index += 1
                }
                try report()

                while cursor < end {
                    guard continueWhile() else { throw Failure.speechPaused }
                    guard ResourceExtractors.stamp(url) == item.stamp else { throw Failure.moved }
                    let next = cursor + min(Self.clipLength, end - cursor)
                    let audio = try Self.pcm(asset, track: track, from: cursor, to: next, continueWhile: continueWhile)
                    let part = try recognize(audio, from: cursor, to: next, locale: item.speechLocale ?? "auto",
                                             in: directory, scratch: scratch, useCPU: &useCPU, continueWhile: continueWhile)
                    guard continueWhile() else { throw Failure.speechPaused }
                    guard ResourceExtractors.stamp(url) == item.stamp else { throw Failure.moved }
                    try directory.write(Self.filename(index), data: JSONEncoder().encode(Chunk(start: cursor, end: next, cues: part)))
                    cues.append(contentsOf: part)
                    cursor = next
                    index += 1
                    try report()
                }

                guard ResourceExtractors.stamp(url) == item.stamp else { throw Failure.moved }
                var result = ResourceExtractors.excerpts(cues.map { ($0.location, $0.text) }, minimumLetters: 0,
                                                        emptyReason: Failure.noSpeech.rawValue, read: seconds, total: seconds)
                result.read = seconds
                result.total = seconds
                result.hasTranscript = hasTranscript
                return result
            }
        } catch RuntimeFileError.busy {
            throw RuntimeFileError.busy
        } catch {
            let why = (error as? Failure) ?? (continueWhile() ? .speechFailed : .speechPaused)
            let status: ResourceStatus = [.noAudio, .speechUnavailable].contains(why) ? .attachment : .needsAttention
            return ResourceExtraction(status: status, reason: why.rawValue, read: read, total: total, hasTranscript: hasTranscript)
        }
    }

    static func transcript(in directory: RuntimeDirectory) throws -> String {
        var lines: [String] = []
        var index = 0
        while let chunk = try chunk(index, in: directory) {
            lines.append(contentsOf: chunk.cues.map { cue in
                let seconds = cue.location.start / 1_000
                let time = String(format: "%02d:%02d:%02d", seconds / 3_600, seconds / 60 % 60, seconds % 60)
                return time + "  " + cue.text
            })
            index += 1
        }
        guard !lines.isEmpty else { throw ResourceError.unavailable }
        return lines.joined(separator: "\n\n")
    }

    private static func filename(_ index: Int) -> String { "chunk-\(index).json" }

    private static func chunk(_ index: Int, in directory: RuntimeDirectory) throws -> Chunk? {
        try directory.read(filename(index), maximumBytes: maximumChunkBytes)
            .map { try JSONDecoder().decode(Chunk.self, from: $0) }
    }

    private static func pcm(_ asset: AVURLAsset, track: AVAssetTrack, from start: Int, to end: Int,
                            continueWhile: () -> Bool) throws -> Data {
        let reader = try AVAssetReader(asset: asset)
        let offset = CMTime(value: Int64(start), timescale: 1_000)
        reader.timeRange = CMTimeRange(start: offset, duration: CMTime(value: Int64(end - start), timescale: 1_000))
        let output = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw Failure.speechUnavailable }
        reader.add(output)
        guard reader.startReading() else { throw Failure.speechUnavailable }
        defer { reader.cancelReading() }

        let samples = (end - start) * Int(sampleRate) / 1_000
        let sampleBytes = MemoryLayout<Int16>.size
        var bytes = Data(count: samples * sampleBytes)
        while let buffer = output.copyNextSampleBuffer() {
            guard continueWhile() else { throw Failure.speechPaused }
            let time = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(buffer), offset)
            guard time.isNumeric, let block = CMSampleBufferGetDataBuffer(buffer) else { throw Failure.speechFailed }
            let position = Int(CMTimeConvertScale(time, timescale: sampleRate, method: .roundHalfAwayFromZero).value)
            let available = CMBlockBufferGetDataLength(block) / sampleBytes
            if position >= samples || position <= -available { continue }
            let skip = max(0, -position)
            let writeAt = max(0, position)
            let count = min(available - skip, samples - writeAt)
            let copied = bytes.withUnsafeMutableBytes { destination in
                CMBlockBufferCopyDataBytes(block, atOffset: skip * sampleBytes, dataLength: count * sampleBytes,
                                           destination: destination.baseAddress!.advanced(by: writeAt * sampleBytes))
            }
            guard copied == noErr else { throw Failure.speechFailed }
        }
        guard reader.status == .completed else { throw Failure.speechFailed }
        return bytes
    }

    private func recognize(_ pcm: Data, from start: Int, to end: Int, locale: String, in directory: RuntimeDirectory,
                           scratch: String, useCPU: inout Bool, continueWhile: @escaping () -> Bool) throws -> [Cue] {
        if pcm.allSatisfy({ $0 == 0 }) { return [] }
        try directory.write(scratch, data: pcm)
        defer { try? directory.remove(scratch) }
        let language = ["zh-CN": "zh", "en-US": "en"][locale] ?? "auto"
        let args = [weights.path, directory.url.appendingPathComponent(scratch).path, language]
        func run(useCPU: Bool) throws -> (bytes: Data, status: Int32) {
            try ResourceCommand.run(engine.path, args + (useCPU ? ["--cpu"] : []),
                                    maximum: Self.maximumChunkBytes / 3, seconds: 600, continueWhile: continueWhile)
        }
        var response = try run(useCPU: useCPU)
        if response.status != 0 && !useCPU && continueWhile() {
            useCPU = true
            response = try run(useCPU: true)
        }
        guard response.status == 0, let output = String(data: response.bytes, encoding: .utf8) else { throw Failure.speechFailed }
        return try output.split(separator: "\n").compactMap { row in
            let fields = row.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard fields.count == 3, let low = Int(fields[0]), let high = Int(fields[1]), low >= 0, high >= low
            else { throw Failure.speechFailed }
            let text = ResourceExtractors.cleaned(String(fields[2]))
            guard low < end - start, text.unicodeScalars.contains(where: CharacterSet.alphanumerics.contains)
            else { return nil }
            return Cue(location: ResourceLocation(kind: "time", start: start + low, end: start + min(end - start, high)), text: text)
        }
    }
}
