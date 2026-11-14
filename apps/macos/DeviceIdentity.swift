import Foundation
import CoreFoundation
import CryptoKit
import IOKit

enum DeviceIdentityError: Error { case hardwareUnavailable }

enum DeviceIdentity {
    static let kind = "macos-platform-uuid-sha256-v1"

    static func valid(_ value: String) -> Bool {
        value.range(of: "^dev_[A-Za-z0-9_-]{16,124}$", options: .regularExpression) != nil
    }
    static func hardwareBound(_ value: String) -> Bool {
        value.range(of: "^dev_hw_[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    static func platformUUID() throws -> String {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard service != IO_OBJECT_NULL else { throw DeviceIdentityError.hardwareUnavailable }
        defer { IOObjectRelease(service) }
        guard let value = IORegistryEntryCreateCFProperty(service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String
        else { throw DeviceIdentityError.hardwareUnavailable }
        return value
    }
    static func current(hardwareUUID: () throws -> String = platformUUID) throws -> String {
        let value = try hardwareUUID().trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$", options: .regularExpression) != nil,
              let uuid = UUID(uuidString: value),
              !["00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"].contains(uuid.uuidString)
        else { throw DeviceIdentityError.hardwareUnavailable }
        let input = Data(("vibe-improve:hardware-device:v1\0macos:IOPlatformUUID\0" + uuid.uuidString.lowercased()).utf8)
        return "dev_hw_" + SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
    }
    static func load(from runtime: RuntimeDirectory, now: Date = Date(), hardwareUUID: () throws -> String = platformUUID) throws -> String {
        let deviceID = try current(hardwareUUID: hardwareUUID)
        return try runtime.locked {
            if let data = try runtime.read("device.json", maximumBytes: 4096) {
                guard let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let version = record["version"] as? NSNumber,
                      CFGetTypeID(version) != CFBooleanGetTypeID(), [1.0, 2.0].contains(version.doubleValue),
                      let savedID = record["device_id"] as? String, valid(savedID),
                      let created = record["created_at"] as? String, ISO8601DateFormatter().date(from: created) != nil
                else { throw RuntimeFileError.invalid }
                if version.intValue == 1 {
                    guard record.count == 3 else { throw RuntimeFileError.invalid }
                } else {
                    guard record.count == 4, record["kind"] as? String == kind, hardwareBound(savedID) else { throw RuntimeFileError.invalid }
                    if savedID == deviceID { return deviceID }
                }
            }
            let data = try JSONSerialization.data(withJSONObject: ["version": 2, "kind": kind, "device_id": deviceID, "created_at": ISO8601DateFormatter().string(from: now)], options: [.sortedKeys])
            try runtime.write("device.json", data: data)
            return deviceID
        }
    }
}
