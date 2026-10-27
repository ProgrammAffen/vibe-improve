import Foundation
import Darwin

enum LicenseClockError: Error {case unavailable}
enum NativeLicenseClock {
    static func sample() throws -> [String: Any] {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1, size <= 128 else {throw LicenseClockError.unavailable}
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &buffer, &size, nil, 0) == 0 else {throw LicenseClockError.unavailable}
        let boot = String(cString: buffer)
        guard UUID(uuidString: boot) != nil else {throw LicenseClockError.unavailable}
        var info = mach_timebase_info_data_t()
        guard mach_timebase_info(&info) == KERN_SUCCESS, info.denom > 0 else {throw LicenseClockError.unavailable}
        let milliseconds = floor(Double(mach_continuous_time()) * Double(info.numer) / Double(info.denom) / 1_000_000)
        guard milliseconds.isFinite, milliseconds >= 0, milliseconds <= 9_007_199_254_740_991 else {throw LicenseClockError.unavailable}
        return ["schemaVersion":1,"bootId":boot,"continuousMs":milliseconds]
    }
}
