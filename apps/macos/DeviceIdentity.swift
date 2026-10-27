import Foundation
import CoreFoundation

enum DeviceIdentity {
    static func valid(_ value: String) -> Bool {
        value.range(of: "^dev_[A-Za-z0-9_-]{16,124}$", options: .regularExpression) != nil
    }
    static func load(from runtime: RuntimeDirectory, legacyDeviceID: String?, now: Date = Date()) throws -> String {
        try runtime.locked {
            if let data = try runtime.read("device.json", maximumBytes: 4096) {
                guard let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      record.count == 3,
                      let version = record["version"] as? NSNumber,
                      CFGetTypeID(version) != CFBooleanGetTypeID(), version.intValue == 1, version.doubleValue == 1,
                      let deviceID = record["device_id"] as? String, valid(deviceID),
                      let created = record["created_at"] as? String, ISO8601DateFormatter().date(from: created) != nil
                else { throw RuntimeFileError.invalid }
                return deviceID
            }
            var generator = SystemRandomNumberGenerator()
            let randomID = "dev_" + (0..<24).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }.joined()
            let deviceID = legacyDeviceID.flatMap { valid($0) ? $0 : nil } ?? randomID
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "device_id": deviceID, "created_at": ISO8601DateFormatter().string(from: now)], options: [.sortedKeys])
            try runtime.write("device.json", data: data)
            return deviceID
        }
    }
}
