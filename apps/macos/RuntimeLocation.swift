import Foundation
import Darwin

enum RuntimeMigrationError: Error { case unsafeSource, incompleteSession, sourceChanged, unavailable }

/// Stable per-user data, independent of the application bundle location.
enum RuntimeLocation {
    static var applicationSupport: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }
    static func prepare(applicationSupport: URL = applicationSupport, legacy: [URL]) throws -> RuntimeDirectory {
        let files = FileManager.default
        try files.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
        try requireDirectory(applicationSupport)
        let parentLock = open(applicationSupport.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parentLock >= 0 else { throw RuntimeMigrationError.unavailable }
        defer { close(parentLock) }
        guard flock(parentLock, LOCK_EX | LOCK_NB) == 0 else { throw RuntimeMigrationError.unavailable }
        defer { flock(parentLock, LOCK_UN) }
        let destination = applicationSupport.appendingPathComponent("Vibe Improve", isDirectory: true)
        let existing = try exists(destination)
        if existing {
            try requireDirectory(destination)
            if try hasPersistentData(destination) {
                try requireIdentity(destination)
                return try RuntimeDirectory(url: destination, create: false)
            }
        }
        for source in legacy.map(\.standardizedFileURL) {
            guard try exists(source) else { continue }
            try requireDirectory(source)
            let names = ["device.json", "preferences.json", "auth", "projects", "agents", "logs"]
            var selected: [String] = []
            for name in names where try exists(source.appendingPathComponent(name)) { selected.append(name) }
            guard selected.contains("device.json") || selected.contains("preferences.json") else {
                if try hasPersistentData(source) { throw RuntimeMigrationError.incompleteSession }
                continue
            }
            try requireIdentity(source)
            for name in selected {
                let item = source.appendingPathComponent(name)
                if ["auth", "projects", "agents", "logs"].contains(name) { try requireDirectory(item) }
                else {
                    var info = stat()
                    guard lstat(item.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw RuntimeMigrationError.unsafeSource }
                }
            }
            let locks = try lockSource(source)
            defer { for lock in locks { flock(lock, LOCK_UN); close(lock) } }
            let auth = source.appendingPathComponent("auth")
            let hasSession = try exists(auth.appendingPathComponent("session.json"))
            let hasKey = try exists(auth.appendingPathComponent("session.key"))
            guard hasSession == hasKey else { throw RuntimeMigrationError.incompleteSession }
            if hasSession {
                guard selected.contains("device.json") || selected.contains("preferences.json") else { throw RuntimeMigrationError.incompleteSession }
                var key = stat()
                guard lstat(auth.appendingPathComponent("session.key").path, &key) == 0, key.st_size == 32 else { throw RuntimeMigrationError.incompleteSession }
            }
            let stage = applicationSupport.appendingPathComponent(".vibe-improve-migrate-" + UUID().uuidString.lowercased(), isDirectory: true)
            guard mkdir(stage.path, 0o700) == 0 else { throw RuntimeMigrationError.unavailable }
            var published = false
            defer { if !published { try? files.removeItem(at: stage) } }
            let input = open(source.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            let output = open(stage.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard input >= 0, output >= 0 else {
                if input >= 0 { close(input) }; if output >= 0 { close(output) }
                throw RuntimeMigrationError.unavailable
            }
            defer { close(input); close(output) }
            var budget = Budget()
            for name in selected { try copy(name, from: input, into: output, sourceRoot: source, relative: name, budget: &budget) }
            if existing, try exists(destination.appendingPathComponent("logs")) {
                let archive = try RuntimeDirectory(url: stage).child("migration-backup")
                let previous = open(destination.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                let archived = open(archive.url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard previous >= 0, archived >= 0 else {
                    if previous >= 0 { close(previous) }; if archived >= 0 { close(archived) }
                    throw RuntimeMigrationError.unavailable
                }
                defer { close(previous); close(archived) }
                try copy("logs", from: previous, into: archived, sourceRoot: destination, relative: "logs", budget: &budget)
            }
            guard fsync(output) == 0 else { throw RuntimeMigrationError.unavailable }
            if existing {
                guard try !hasPersistentData(destination), renamex_np(stage.path, destination.path, UInt32(RENAME_SWAP)) == 0 else { throw RuntimeMigrationError.sourceChanged }
                try? files.removeItem(at: stage)
            } else if renamex_np(stage.path, destination.path, UInt32(RENAME_EXCL)) != 0 {
                throw RuntimeMigrationError.sourceChanged
            }
            published = true
            let parent = open(applicationSupport.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if parent >= 0 { defer { close(parent) }; guard fsync(parent) == 0 else { throw RuntimeMigrationError.unavailable } }
            return try RuntimeDirectory(url: destination, create: false)
        }
        return try RuntimeDirectory(url: destination)
    }
    private struct Budget { var entries = 0; var bytes: Int64 = 0 }
    private static func requireIdentity(_ root: URL) throws {
        if try exists(root.appendingPathComponent("device.json")) { return }
        let fd = open(root.appendingPathComponent("preferences.json").path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw RuntimeMigrationError.incompleteSession }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_nlink == 1, info.st_size > 0, info.st_size <= 65_536 else { throw RuntimeMigrationError.unsafeSource }
        let data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: 65_537) ?? Data()
        var after = stat()
        guard fstat(fd, &after) == 0, same(info, after), data.count == info.st_size, data.count <= 65_536, let record = try JSONSerialization.jsonObject(with: data) as? [String: Any], let identity = record["deviceId"] as? String,
              identity.range(of: "^dev_[A-Za-z0-9_-]{16,124}$", options: .regularExpression) != nil else { throw RuntimeMigrationError.incompleteSession }
    }
    private static func hasPersistentData(_ root: URL) throws -> Bool {
        for name in try FileManager.default.contentsOfDirectory(atPath: root.path) {
            if name == "session.lock" || name == "local-server.json" || name == ".DS_Store" || name.hasPrefix(".write-") { continue }
            if name == "logs" { try requireDirectory(root.appendingPathComponent(name)); continue }
            if ["auth", "projects", "agents"].contains(name) {
                let directory = root.appendingPathComponent(name)
                try requireDirectory(directory)
                let content = try FileManager.default.contentsOfDirectory(atPath: directory.path)
                if content.allSatisfy({ $0 == "session.lock" || $0.hasPrefix(".write-") }) { continue }
            }
            return true
        }
        return false
    }
    private static func exists(_ url: URL) throws -> Bool {
        var info = stat()
        if lstat(url.path, &info) == 0 { return true }
        if errno == ENOENT { return false }
        throw RuntimeMigrationError.unavailable
    }
    private static func requireDirectory(_ url: URL) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid() else { throw RuntimeMigrationError.unsafeSource }
    }
    private static func lockSource(_ source: URL) throws -> [Int32] {
        var locks: [Int32] = []
        do {
            for directory in [source, source.appendingPathComponent("auth"), source.appendingPathComponent("projects"), source.appendingPathComponent("agents")] {
                guard try exists(directory) else { continue }
                try requireDirectory(directory)
                let path = directory.appendingPathComponent("session.lock")
                guard try exists(path) else { continue }
                let fd = open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                guard fd >= 0 else { throw RuntimeMigrationError.unsafeSource }
                var info = stat()
                guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_nlink == 1, flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                    close(fd); throw RuntimeMigrationError.unavailable
                }
                locks.append(fd)
            }
            return locks
        } catch { for fd in locks { flock(fd, LOCK_UN); close(fd) }; throw error }
    }
    private static func copy(_ name: String, from input: Int32, into output: Int32, sourceRoot: URL, relative: String, budget: inout Budget) throws {
        guard name != ".", name != "..", !name.contains("/") else { throw RuntimeMigrationError.unsafeSource }
        if name == "session.lock" || name.hasPrefix(".write-") || name.hasPrefix(".install-") { return }
        budget.entries += 1
        guard budget.entries <= 100_000 else { throw RuntimeMigrationError.unsafeSource }
        var info = stat()
        guard fstatat(input, name, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_uid == geteuid() else { throw RuntimeMigrationError.unsafeSource }
        switch info.st_mode & S_IFMT {
        case S_IFDIR:
            guard mkdirat(output, name, 0o700) == 0 else { throw RuntimeMigrationError.unavailable }
            let source = openat(input, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            let target = openat(output, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard source >= 0, target >= 0 else {
                if source >= 0 { close(source) }; if target >= 0 { close(target) }
                throw RuntimeMigrationError.unsafeSource
            }
            defer { close(source); close(target) }
            var opened = stat()
            guard fstat(source, &opened) == 0, same(info, opened) else { throw RuntimeMigrationError.sourceChanged }
            let duplicate = dup(source)
            guard duplicate >= 0, let directory = fdopendir(duplicate) else {
                if duplicate >= 0 { close(duplicate) }; throw RuntimeMigrationError.unavailable
            }
            defer { closedir(directory) }
            while let entry = readdir(directory) {
                let child = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
                if child == "." || child == ".." { continue }
                try copy(child, from: source, into: target, sourceRoot: sourceRoot, relative: relative + "/" + child, budget: &budget)
            }
            var after = stat()
            guard fstat(source, &after) == 0, same(opened, after), fsync(target) == 0 else { throw RuntimeMigrationError.sourceChanged }
        case S_IFREG:
            guard info.st_nlink == 1, info.st_size >= 0, info.st_size <= 1_073_741_824 else { throw RuntimeMigrationError.unsafeSource }
            budget.bytes += info.st_size
            guard budget.bytes <= 4_294_967_296 else { throw RuntimeMigrationError.unsafeSource }
            let source = openat(input, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            let mode: mode_t = info.st_mode & 0o111 != 0 ? 0o700 : 0o600
            let target = openat(output, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
            guard source >= 0, target >= 0 else {
                if source >= 0 { close(source) }; if target >= 0 { close(target) }
                throw RuntimeMigrationError.unsafeSource
            }
            defer { close(source); close(target) }
            var opened = stat()
            guard fstat(source, &opened) == 0, same(info, opened), opened.st_nlink == 1 else { throw RuntimeMigrationError.sourceChanged }
            var buffer = [UInt8](repeating: 0, count: 131_072), total: Int64 = 0
            while true {
                let length = Darwin.read(source, &buffer, buffer.count)
                if length < 0, errno == EINTR { continue }
                guard length >= 0 else { throw RuntimeMigrationError.unavailable }
                if length == 0 { break }
                total += Int64(length)
                guard total <= info.st_size else { throw RuntimeMigrationError.sourceChanged }
                try buffer.withUnsafeBytes { bytes in
                    var offset = 0
                    while offset < length {
                        let written = Darwin.write(target, bytes.baseAddress!.advanced(by: offset), length - offset)
                        if written < 0, errno == EINTR { continue }
                        guard written > 0 else { throw RuntimeMigrationError.unavailable }
                        offset += written
                    }
                }
            }
            var after = stat(), named = stat()
            guard fstat(source, &after) == 0, fstatat(input, name, &named, AT_SYMLINK_NOFOLLOW) == 0, same(opened, after), same(opened, named), total == info.st_size, fsync(target) == 0 else { throw RuntimeMigrationError.sourceChanged }
        case S_IFLNK:
            var bytes = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
            let length = readlinkat(input, name, &bytes, Int(PATH_MAX))
            guard length > 0, length < Int(PATH_MAX) else { throw RuntimeMigrationError.unsafeSource }
            bytes[Int(length)] = 0
            let link = String(cString: bytes)
            let origin = sourceRoot.appendingPathComponent(relative).deletingLastPathComponent()
            let resolved = origin.appendingPathComponent(link).standardizedFileURL.resolvingSymlinksInPath()
            guard !link.hasPrefix("/"), resolved.path.hasPrefix(sourceRoot.resolvingSymlinksInPath().path + "/"), symlinkat(link, output, name) == 0 else { throw RuntimeMigrationError.unsafeSource }
        default: throw RuntimeMigrationError.unsafeSource
        }
    }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_uid == b.st_uid && a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
}
