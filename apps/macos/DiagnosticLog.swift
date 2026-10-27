import Foundation
import Darwin

final class DiagnosticLog {
    static let maximumBytes = 1_048_576
    private static let clientEvents: Set<String> = ["app.started", "operation.started", "operation.completed", "operation.failed", "cloud.started", "cloud.completed", "cloud.failed", "background.started", "background.completed", "background.failed", "runtime.error", "runtime.unhandled_rejection"]
    private static let nativeEvents: Set<String> = ["native.started", "native.server.ready", "native.server.failed", "native.local.started", "native.local.failed", "native.remote.started", "native.remote.failed", "native.offline.started", "native.navigation.completed", "native.agent.completed", "native.agent.failed"]
    private static let operations: Set<String> = ["project.storage", "auth.login", "auth.registration.send", "auth.registration.verify", "auth.password.reset.send", "auth.password.reset", "auth.password.change.send", "auth.password.change", "auth.logout", "auth.session.refresh", "auth.session.restore", "auth.session.persist", "auth.session.clear", "auth.identity.read", "license.activate", "license.bind", "license.revoke", "license.refresh", "license.status", "license.devices", "license.renew", "license.certificate.verify"]
    private static let levels: Set<String> = ["debug", "info", "warn", "error"]
    private static let resultCodes: Set<String> = ["OK", "DEVICE_BINDING_CONFIRMATION_REQUIRED", "NETWORK_RETRIES_EXHAUSTED", "LICENSE_CLOCK_UNTRUSTED", "SESSION_STORAGE_UNAVAILABLE", "SESSION_STORAGE_INVALID", "BUSY", "AUTH_REQUIRED", "AUTH_CONTEXT_UNAVAILABLE", "AUTH_CONTEXT_UNSUPPORTED", "ACTIVATION_CODE_UNAVAILABLE", "INVALID_ACTIVATION_CODE", "DEVICE_LIMIT_REACHED", "DEVICE_REVOKED", "DEVICE_NOT_FOUND", "LICENSE_ALREADY_ACTIVE", "LICENSE_REQUIRED", "LICENSE_EXPIRED", "LICENSE_REVOKED", "LICENSE_INVALID", "LICENSE_CHANGED", "CERTIFICATE_INVALID", "RATE_LIMITED", "VERIFICATION_REQUIRED", "EMAIL_ALREADY_SIGNED_IN", "SERVICE_UNCONFIGURED", "PASSWORD_INVALID", "RESEND_TOO_SOON", "SERVICE_UNAVAILABLE", "INVALID_REQUEST", "INVALID_CREDENTIALS", "SESSION_INVALID", "UNKNOWN_ERROR", "RUNTIME_ERROR", "UNHANDLED_REJECTION", "GRANT_EXPIRED", "INVALID_GRANT", "IDEMPOTENCY_KEY_REUSED", "DATA_INTEGRITY_ERROR", "SIGNING_KEY_INVALID", "DATABASE_UNAVAILABLE", "DATABASE_UNSUPPORTED", "AUTH_EMAIL_INVALID", "AUTH_EMAIL_EXISTS", "AUTH_EMAIL_UNVERIFIED", "AUTH_CODE_INVALID", "AUTH_CODE_EXPIRED", "AUTH_CODE_REJECTED", "AUTH_PASSWORD_WEAK", "AUTH_USER_NOT_FOUND", "AUTH_USER_BLOCKED", "AUTH_PROVIDER_DISABLED", "AUTH_CLIENT_DISABLED", "AUTH_DOMAIN_DENIED", "AUTH_CHANNEL_UNCONFIGURED", "AUTH_MAIL_DELIVERY_FAILED", "AUTH_CAPTCHA_REQUIRED", "AUTH_CAPTCHA_INVALID", "AUTH_MFA_REQUIRED", "AUTH_PRECONDITION_FAILED", "AUTH_PARAMETER_MISSING", "PASSWORD_MISMATCH", "DATABASE_CONFLICT", "DATABASE_PERMISSION_DENIED", "DATABASE_COLLECTION_MISSING", "NETWORK_OFFLINE", "NETWORK_TIMEOUT", "NETWORK_UNREACHABLE", "REQUEST_ABORTED", "PROVIDER_ERROR"]
    private static let licenseStatuses: Set<String> = ["valid", "unlicensed", "expired", "revoked", "device_limit", "device_unbound", "device_revoked", "offline_valid", "renewal_retry", "lease_expired", "network_error", "checking", "invalid"]
    private static let stages: Set<String> = ["client.operation", "client.validation", "auth.password.signin", "auth.registration.send", "auth.registration.verify", "auth.reset.send", "auth.reset.verify", "auth.change.send", "auth.change.verify", "auth.identity.read", "auth.session.refresh", "auth.session.restore", "auth.session.persist", "auth.session.clear", "auth.signout", "cloud.invoke", "license.verify", "cloud.import", "cloud.config", "cloud.request", "cloud.identity", "cloud.signer", "cloud.repository", "runtime.global"]
    private static let reasons: Set<String> = ["clock_untrusted", "credentials_rejected", "email_invalid", "email_exists", "email_unverified", "user_not_found", "user_blocked", "code_invalid", "code_expired", "code_invalid_or_expired", "password_policy", "password_mismatch", "transaction_conflict", "database_permission_denied", "database_collection_missing", "provider_disabled", "client_disabled", "domain_denied", "channel_unconfigured", "mail_delivery_failed", "captcha_required", "captcha_invalid", "mfa_required", "precondition_failed", "missing_parameter", "rate_limited", "session_invalid", "offline", "timeout", "unreachable", "aborted", "provider_internal", "provider_unmapped", "parameter_invalid", "license_business", "certificate_invalid", "database_unavailable", "database_unsupported", "data_integrity", "configuration_invalid", "authorization_required", "runtime_exception", "activation_not_found", "activation_used", "activation_wrong_product", "activation_record_invalid", "activation_signature_invalid", "activation_format_invalid", "grant_expired", "entitlement_already_active", "device_limit_reached", "device_revoked", "license_expired"]
    private static let providerCodes: Set<String> = ["aborted", "access_denied", "account_selection_required", "already_exists", "cancelled", "captcha_invalid", "captcha_required", "consent_required", "data_loss", "deadline_exceeded", "failed_precondition", "interaction_required", "internal", "invalid_argument", "invalid_credentials", "invalid_grant", "invalid_password", "invalid_request", "invalid_request_object", "invalid_request_uri", "invalid_scope", "invalid_status", "invalid_two_factor", "invalid_two_factor_recovery", "invalid_username_or_password", "invalid_verification_code", "local", "login_method_disabled", "login_required", "login_type_disabled", "mfa_phone_required", "missing_required_param", "not_found", "out_of_range", "password_not_set", "permission_denied", "provider_error", "provider_not_enabled", "registration_not_supported", "request_not_supported", "request_uri_not_supported", "resource_exhausted", "server_error", "temporarily_unavailable", "two_factor_required", "unauthenticated", "unauthorized_client", "unavailable", "under_review", "unimplemented", "unknown", "unsupported_response_type", "user_blocked", "user_not_found", "user_pending", "wrong_password", "unreachable", "invalid_email", "email_exists", "user_already_exists", "invalid_code", "code_expired", "otp_expired", "password_too_weak", "weak_password", "email_not_confirmed", "email_not_verified", "invalid_token", "token_expired", "refresh_token_expired", "invalid_refresh_token", "max_attempts_exceeded", "email_rate_limit_exceeded", "too_many_requests", "smtp_error"]
    private static let errorTypes: Set<String> = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "DOMException", "AbortError", "TimeoutError", "AuthError", "CloudBaseAuthError", "CloudbaseError", "CloudBaseError", "LicenseError"]
    private static let sites: Set<String> = ["client_api", "client_logger", "client_app", "client_bundle", "cloud_entry", "cloud_service", "cloud_repository", "cloud_auth"]
    private static let providerCategories: Set<String> = ["INVALID_CREDENTIALS", "USER_NOT_FOUND", "USER_STATUS_ABNORMAL", "RATE_LIMITED", "PROVIDER_NOT_ENABLED", "INVALID_PARAMS", "VERIFICATION_FAILED", "SERVICE_ERROR", "PRECONDITION_FAILED", "UNKNOWN"]
    private let queue = DispatchQueue(label: "vibe-improve.diagnostics")
    private let runtime: URL
    private let directory: URL
    private let sessionID = UUID().uuidString.lowercased()
    private let formatter: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter()
        value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return value
    }()
    init(runtimeRoot: URL) {
        runtime = runtimeRoot.standardizedFileURL
        directory = runtime.appendingPathComponent("logs", isDirectory: true)
    }
    func record(_ event: String, level: String = "info", resultCode: String = "OK") {
        guard Self.nativeEvents.contains(event), Self.levels.contains(level), Self.resultCodes.contains(resultCode) else { return }
        queue.sync {
            self.append(["schemaVersion": 1, "timestamp": self.formatter.string(from: Date()), "level": level, "event": event, "sessionId": self.sessionID, "resultCode": resultCode])
        }
    }
    func receive(_ value: [String: Any]) {
        guard let entry = Self.sanitize(value) else { return }
        queue.sync { self.append(entry) }
    }
    func clear() {
        queue.sync {
            guard self.prepareDirectory() else { return }
            for index in 0...2 {
                let path = self.file(index).path
                if self.regularOrMissing(path) { try? FileManager.default.removeItem(atPath: path) }
            }
        }
    }
    func exportData(_ frontendText: String) -> Data? {
        guard frontendText.utf8.count <= 262_144,
              let decoded = try? JSONSerialization.jsonObject(with: Data(frontendText.utf8)) as? [String: Any],
              let incoming = decoded["entries"] as? [[String: Any]], incoming.count <= 300 else { return nil }
        return queue.sync {
            let entries = incoming.compactMap { Self.sanitize($0) }
            var nativeEntries: [[String: Any]] = []
            if self.prepareDirectory() {
                for index in stride(from: 2, through: 0, by: -1) {
                    let descriptor = open(self.file(index).path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                    guard descriptor >= 0 else { continue }
                    defer { close(descriptor) }
                    var metadata = stat()
                    guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_nlink == 1, metadata.st_size <= Self.maximumBytes else { continue }
                    var bytes = [UInt8](repeating: 0, count: Int(metadata.st_size))
                    let count = read(descriptor, &bytes, bytes.count)
                    guard count >= 0 else { continue }
                    let text = String(decoding: bytes.prefix(count), as: UTF8.self)
                    for line in text.split(separator: "\n") {
                        guard line.utf8.count < 4096, let item = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], let safe = Self.sanitize(item, allowNative: true) else { continue }
                        nativeEntries.append(safe)
                    }
                }
            }
            return try? JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "exportedAt": self.formatter.string(from: Date()), "entries": entries, "nativeEntries": nativeEntries], options: [.prettyPrinted, .sortedKeys])
        }
    }
    static func sanitize(_ value: [String: Any], allowNative: Bool = false) -> [String: Any]? {
        guard let version = value["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.intValue == 1, version.doubleValue == 1,
              let timestamp = value["timestamp"] as? String, timestamp.count == 24,
              timestamp.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil,
              let level = value["level"] as? String, levels.contains(level),
              let event = value["event"] as? String, clientEvents.contains(event) || (allowNative && nativeEvents.contains(event)),
              let session = value["sessionId"] as? String, validUUID(session) else { return nil }
        let date = ISO8601DateFormatter()
        date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard date.date(from: timestamp) != nil else { return nil }
        var safe: [String: Any] = ["schemaVersion": 1, "timestamp": timestamp, "level": level, "event": event, "sessionId": session.lowercased()]
        if let trace = value["traceId"] as? String, validUUID(trace) { safe["traceId"] = trace.lowercased() }
        if let operation = value["operation"] as? String, operations.contains(operation) { safe["operation"] = operation }
        if let result = value["resultCode"] as? String, resultCodes.contains(result) { safe["resultCode"] = result }
        if let status = value["licenseStatus"] as? String, licenseStatuses.contains(status) { safe["licenseStatus"] = status }
        if let duration = value["durationMs"] as? NSNumber, CFGetTypeID(duration) != CFBooleanGetTypeID(), duration.doubleValue.isFinite {
            safe["durationMs"] = Int(min(86_400_000, max(0, duration.doubleValue)).rounded())
        }
        for key in ["parentTraceId", "serverTraceId", "providerRequestId"] {
            if let item = value[key] as? String, validUUID(item) { safe[key] = item.lowercased() }
        }
        let enums: [String: Set<String>] = ["causeCode": resultCodes, "stage": stages, "reason": reasons, "providerCode": providerCodes, "providerCategory": providerCategories, "errorType": errorTypes, "site": sites]
        for (key, allowed) in enums { if let item = value[key] as? String, allowed.contains(item) { safe[key] = item } }
        for (key, bounds) in ["httpStatus": (100,599), "providerErrorNumber": (0,65535), "retryAfterSeconds": (0,86400), "line": (1,10000000), "column": (1,10000000)] {
            if let item = value[key] as? NSNumber, CFGetTypeID(item) != CFBooleanGetTypeID(), item.doubleValue.isFinite, item.doubleValue == Double(item.intValue), item.intValue >= bounds.0, item.intValue <= bounds.1 { safe[key] = item.intValue }
        }
        if let item = value["retryable"] as? NSNumber, CFGetTypeID(item) == CFBooleanGetTypeID() { safe["retryable"] = item.boolValue }
        return safe
    }
    private static func validUUID(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: [.regularExpression, .caseInsensitive]) != nil
    }
    private func file(_ index: Int) -> URL {
        directory.appendingPathComponent(index == 0 ? "native.ndjson" : "native.\(index).ndjson")
    }
    private func prepareDirectory() -> Bool {
        let files = FileManager.default
        for path in [runtime, directory] {
            if let attributes = try? files.attributesOfItem(atPath: path.path) {
                guard attributes[.type] as? FileAttributeType == .typeDirectory else { return false }
            } else {
                do { try files.createDirectory(at: path, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
                catch { return false }
            }
            guard (try? files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)) != nil else { return false }
        }
        return true
    }
    private func regularOrMissing(_ path: String) -> Bool {
        var metadata = stat()
        if lstat(path, &metadata) == 0 { return metadata.st_mode & S_IFMT == S_IFREG && metadata.st_nlink == 1 }
        return errno == ENOENT
    }
    private func append(_ entry: [String: Any]) {
        guard prepareDirectory(), let encoded = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]), encoded.count < 4096 else { return }
        let files = FileManager.default
        for index in 0...2 {
            let path = file(index).path
            guard regularOrMissing(path) else { return }
            if files.fileExists(atPath: path), (try? files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)) == nil { return }
        }
        let size = ((try? files.attributesOfItem(atPath: file(0).path)[.size]) as? NSNumber)?.intValue ?? 0
        if size + encoded.count + 1 > Self.maximumBytes {
            try? files.removeItem(at: file(2))
            for index in stride(from: 1, through: 0, by: -1) {
                if files.fileExists(atPath: file(index).path) {
                    do { try files.moveItem(at: file(index), to: file(index + 1)) } catch { return }
                }
            }
        }
        let descriptor = open(file(0).path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_nlink == 1, fchmod(descriptor, 0o600) == 0 else { return }
        var line = encoded
        line.append(0x0a)
        line.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let count = write(descriptor, base.advanced(by: offset), buffer.count - offset)
                if count <= 0 { return }
                offset += count
            }
        }
    }
}
