import Foundation
import Darwin

enum RuntimeFileError: Error { case unavailable, invalid }

final class RuntimeDirectory {
    let url: URL
    private let descriptor: Int32
    init(url: URL, create: Bool = true) throws {
        self.url = url.standardizedFileURL
        if create, mkdir(self.url.path, 0o700) != 0, errno != EEXIST { throw RuntimeFileError.unavailable }
        descriptor = open(self.url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw RuntimeFileError.unavailable }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == geteuid(), fchmod(descriptor, 0o700) == 0 else {
            close(descriptor); throw RuntimeFileError.unavailable
        }
    }
    private init(url: URL, descriptor: Int32) { self.url = url; self.descriptor = descriptor }
    deinit { close(descriptor) }
    func child(_ name: String) throws -> RuntimeDirectory {
        try valid(name)
        if mkdirat(descriptor, name, 0o700) != 0, errno != EEXIST { throw RuntimeFileError.unavailable }
        let child = openat(descriptor, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { throw RuntimeFileError.unavailable }
        var metadata = stat()
        guard fstat(child, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == geteuid(), fchmod(child, 0o700) == 0 else {
            close(child); throw RuntimeFileError.unavailable
        }
        return RuntimeDirectory(url: url.appendingPathComponent(name, isDirectory: true), descriptor: child)
    }
    private func valid(_ name: String) throws {
        guard name != ".", name != "..", name.range(of: "^[A-Za-z0-9._-]{1,100}$", options: .regularExpression) != nil else { throw RuntimeFileError.unavailable }
    }
    private func regular(_ file: Int32) throws -> stat {
        var metadata = stat()
        guard fstat(file, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_nlink == 1, metadata.st_uid == geteuid(), fchmod(file, 0o600) == 0 else { throw RuntimeFileError.unavailable }
        return metadata
    }
    private func regularOrMissing(_ name: String) throws {
        try valid(name)
        var metadata = stat()
        if fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 {
            guard metadata.st_mode & S_IFMT == S_IFREG, metadata.st_nlink == 1, metadata.st_uid == geteuid() else { throw RuntimeFileError.unavailable }
        } else if errno != ENOENT { throw RuntimeFileError.unavailable }
    }
    func read(_ name: String, maximumBytes: Int) throws -> Data? {
        try valid(name)
        let file = openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard file >= 0 else { if errno == ENOENT { return nil }; throw RuntimeFileError.unavailable }
        defer { close(file) }
        let metadata = try regular(file)
        guard metadata.st_size >= 0, metadata.st_size <= maximumBytes else { throw RuntimeFileError.invalid }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(file, &buffer, buffer.count)
            if count < 0 { if errno == EINTR { continue }; throw RuntimeFileError.unavailable }
            if count == 0 { return data }
            guard data.count + count <= maximumBytes else { throw RuntimeFileError.invalid }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
    func write(_ name: String, data: Data) throws {
        try regularOrMissing(name)
        let temporary = ".write-" + UUID().uuidString.lowercased()
        let file = openat(descriptor, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw RuntimeFileError.unavailable }
        defer { close(file); unlinkat(descriptor, temporary, 0) }
        _ = try regular(file)
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw RuntimeFileError.unavailable }
                offset += count
            }
        }
        guard fsync(file) == 0 else { throw RuntimeFileError.unavailable }
        try regularOrMissing(name)
        guard renameat(descriptor, temporary, descriptor, name) == 0, fsync(descriptor) == 0 else { throw RuntimeFileError.unavailable }
    }
    func remove(_ name: String) throws {
        try regularOrMissing(name)
        if unlinkat(descriptor, name, 0) != 0, errno != ENOENT { throw RuntimeFileError.unavailable }
        guard fsync(descriptor) == 0 else { throw RuntimeFileError.unavailable }
    }
    func locked<T>(_ body: () throws -> T) throws -> T {
        let file = openat(descriptor, "session.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw RuntimeFileError.unavailable }
        defer { close(file) }
        _ = try regular(file)
        guard flock(file, LOCK_EX | LOCK_NB) == 0 else { throw RuntimeFileError.unavailable }
        defer { flock(file, LOCK_UN) }
        return try body()
    }
    func migratePreferences(from legacyURL: URL) throws {
        guard try read("preferences.json", maximumBytes: 65_536) == nil else { return }
        var metadata = stat()
        if lstat(legacyURL.path, &metadata) != 0 {
            if errno == ENOENT { return }; throw RuntimeFileError.unavailable
        }
        let legacy = try RuntimeDirectory(url: legacyURL, create: false)
        if let data = try legacy.read("preferences.json", maximumBytes: 65_536) { try write("preferences.json", data: data) }
    }
}
