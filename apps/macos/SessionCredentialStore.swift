import Foundation
import CryptoKit

enum SessionStoreError: Error { case unavailable, invalid }

final class SessionCredentialStore {
    private let runtimeRoot: URL
    private static let envId = "one-person-company-7dao3979fd72e"
    private static let context = Data("vibe-improve.session.v1:one-person-company-7dao3979fd72e".utf8)
    init(runtimeRoot: URL) { self.runtimeRoot = runtimeRoot }
    static func sanitize(_ value: Any) throws -> [String: Any] {
        guard let record = value as? [String: Any],
              let version = record["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), [1.0, 2.0].contains(version.doubleValue),
              record["envId"] as? String == envId,
              let access = record["accessToken"] as? String, let refresh = record["refreshToken"] as? String,
              validToken(access), validToken(refresh) else { throw SessionStoreError.invalid }
        if version.intValue == 1 {
            guard record.count == 4 else { throw SessionStoreError.invalid }
            return record
        }
        let optionalCount = (record["licenseClock"] == nil ? 0 : 1) + (record["networkRetry"] == nil ? 0 : 1)
        guard record.count == 10 + optionalCount, (record["licenseClock"] == nil || validLicenseClock(record["licenseClock"])), (record["networkRetry"] == nil || validNetworkRetry(record["networkRetry"])), integer(record["accessExpiresAt"], minimum: 1), integer(record["sessionExpiresAt"], minimum: 1), integer(record["validatedAt"], minimum: 1),
              let expires = record["sessionExpiresAt"] as? NSNumber, let validated = record["validatedAt"] as? NSNumber,
              expires.doubleValue > validated.doubleValue, expires.doubleValue - validated.doubleValue <= 604_800_000,
              let user = record["user"] as? [String: Any], user.count == 3, text(user["id"], maximum: 256, empty: false),
              text(user["email"], maximum: 320), text(user["nickname"], maximum: 256), text(record["scope"], maximum: 1024),
              validLicenseCache(record["licenseCache"], userID: user["id"] as? String) else { throw SessionStoreError.invalid }
        return record
    }
    private static func integer(_ value: Any?, minimum: Double = 0, maximum: Double = 9_007_199_254_740_991) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let n = number.doubleValue
        return n.isFinite && n.rounded() == n && n >= minimum && n <= maximum
    }
    private static func validNetworkRetry(_ value: Any?) -> Bool {
        guard let retry = value as? [String: Any], Set(retry.keys) == Set(["attempts", "nextRetryAt", "refreshDevices"]),
              integer(retry["attempts"], maximum: 3), integer(retry["nextRetryAt"], minimum: 1),
              let flag = retry["refreshDevices"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else {return false}
        return true
    }
    private static func validLicenseClock(_ value: Any?) -> Bool {
        if value is NSNull {return true}
        guard let clock = value as? [String: Any], Set(clock.keys) == Set(["schemaVersion", "bootId", "continuousMs", "serverTimeMs"]),
              integer(clock["schemaVersion"], minimum: 1, maximum: 1), let boot = clock["bootId"] as? String,
              boot.range(of: "^[a-zA-Z0-9_-]{16,128}$", options: .regularExpression) != nil,
              integer(clock["continuousMs"]), integer(clock["serverTimeMs"], minimum: 1) else {return false}
        return true
    }
    private static func text(_ value: Any?, maximum: Int, empty: Bool = true) -> Bool {
        guard let value = value as? String else { return false }
        return (empty || !value.isEmpty) && value.count <= maximum && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }
    private static func validLicenseCache(_ value: Any?, userID: String?) -> Bool {
        if value is NSNull { return true }
        guard let cache = value as? [String: Any], [6, 8, 9].contains(cache.count), integer(cache["checkedAt"], minimum: 1),
              let status = cache["status"] as? String, ["valid", "unlicensed", "expired", "revoked", "device_unbound", "device_revoked", "device_limit", "invalid"].contains(status),
              text(cache["bindingId"], maximum: 256), text(cache["licenseId"], maximum: 256), integer(cache["maxDevices"], maximum: 1000) else { return false }
        if cache.count >= 8 {
            guard let token = cache["leaseToken"] as? String, token.isEmpty || token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  validLeaseRenewal(cache["renewal"]) else { return false }
        }
        if cache.count == 9 {
            guard validDeviceList(cache["deviceList"], userID: userID, licenseID: cache["licenseId"] as? String) else { return false }
        }
        if cache["certificate"] is NSNull { return status != "valid" }
        guard let cert = cache["certificate"] as? [String: Any], cert.count == 4,
              cert["algorithm"] as? String == "Ed25519", text(cert["keyId"], maximum: 200, empty: false),
              text(cert["payload"], maximum: 16_384, empty: false), text(cert["signature"], maximum: 128, empty: false) else { return false }
        return true
    }
    private static func validDeviceList(_ value: Any?, userID: String?, licenseID: String?) -> Bool {
        if value is NSNull { return true }
        guard let list = value as? [String: Any], list.count == 5, integer(list["checkedAt"], minimum: 1),
              text(list["userId"], maximum: 256, empty: false), list["userId"] as? String == userID,
              text(list["licenseId"], maximum: 256), list["licenseId"] as? String == licenseID,
              integer(list["maxDevices"], maximum: 100), let devices = list["devices"] as? [[String: Any]], devices.count <= 100 else { return false }
        var ids = Set<String>()
        for device in devices {
            guard device.count == 4, text(device["deviceId"], maximum: 128, empty: false),
                  let id = device["deviceId"] as? String, ids.insert(id).inserted,
                  text(device["bindingId"], maximum: 80), text(device["deviceName"], maximum: 80), text(device["lastSeenAt"], maximum: 64) else { return false }
        }
        return true
    }
    private static func validLeaseRenewal(_ value: Any?) -> Bool {
        if value is NSNull { return true }
        guard let renewal = value as? [String: Any], renewal.count == 6,
              let requestID = renewal["requestId"] as? String, UUID(uuidString: requestID) != nil,
              let renewalID = renewal["renewalId"] as? String, renewalID.range(of: "^renew_[a-f0-9]{32}$", options: .regularExpression) != nil,
              let nextToken = renewal["nextLeaseToken"] as? String, nextToken.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              integer(renewal["startedAt"], minimum: 1), integer(renewal["retryCount"], maximum: 5), integer(renewal["nextRetryAt"]) else { return false }
        return true
    }
    private static func validToken(_ value: String) -> Bool {
        (8...16384).contains(value.utf8.count) && value.utf8.allSatisfy { $0 >= 33 && $0 <= 126 }
    }
    private func directory() throws -> RuntimeDirectory { try RuntimeDirectory(url: runtimeRoot).child("auth") }
    func read() throws -> [String: Any]? {
        let directory = try directory()
        return try directory.locked {
            guard let data = try directory.read("session.json", maximumBytes: 60_000) else { return nil }
            guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any], envelope.count == 3,
                  let version = envelope["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
                  envelope["algorithm"] as? String == "AES-256-GCM",
                  let payload = envelope["payload"] as? String, let combined = Data(base64Encoded: payload),
                  combined.count >= 28, combined.count <= 40_028, combined.base64EncodedString() == payload,
                  let key = try directory.read("session.key", maximumBytes: 32), key.count == 32 else { throw SessionStoreError.invalid }
            guard let box = try? AES.GCM.SealedBox(combined: combined),
                  let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Self.context),
                  let record = try? JSONSerialization.jsonObject(with: plain) else { throw SessionStoreError.invalid }
            return try Self.sanitize(record)
        }
    }
    func write(_ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: Self.sanitize(value), options: [.sortedKeys])
        guard data.count <= 40_000 else { throw SessionStoreError.invalid }
        let directory = try directory()
        try directory.locked {
            let key: Data
            if let saved = try directory.read("session.key", maximumBytes: 32) {
                guard saved.count == 32 else { throw SessionStoreError.invalid }
                key = saved
            } else {
                guard try directory.read("session.json", maximumBytes: 60_000) == nil else { throw SessionStoreError.invalid }
                key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
                try directory.write("session.key", data: key)
            }
            let box = try AES.GCM.seal(data, using: SymmetricKey(data: key), authenticating: Self.context)
            guard let combined = box.combined else { throw SessionStoreError.unavailable }
            let envelope: [String: Any] = ["schemaVersion": 1, "algorithm": "AES-256-GCM", "payload": combined.base64EncodedString()]
            try directory.write("session.json", data: JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys]))
        }
    }
    func clear() throws {
        let directory = try directory()
        try directory.locked {
            try directory.remove("session.json")
            try directory.remove("session.key")
        }
    }
}
