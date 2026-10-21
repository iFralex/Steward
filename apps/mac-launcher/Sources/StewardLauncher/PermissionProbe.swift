import Foundation
import Darwin

enum DataAccess: Equatable {
    case readable
    case denied
    case unavailable
}

struct ProtectedDataProbe {
    let name: String
    let directory: URL
    let database: String?

    func check() -> DataAccess {
        do {
            // access(2)/fileExists alone can succeed without TCC data access.
            _ = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            if let database {
                let fd = open(directory.appendingPathComponent(database).path, O_RDONLY | O_CLOEXEC)
                guard fd >= 0 else { return Self.classify(errno) }
                defer { close(fd) }
                var byte: UInt8 = 0
                if read(fd, &byte, 1) < 0 { return Self.classify(errno) }
            }
            return .readable
        } catch {
            let error = error as NSError
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoPermissionError { return .denied }
            let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError
            if error.domain == NSPOSIXErrorDomain { return Self.classify(Int32(error.code)) }
            if let underlying, underlying.domain == NSPOSIXErrorDomain { return Self.classify(Int32(underlying.code)) }
            return .unavailable
        }
    }

    static func classify(_ code: Int32) -> DataAccess {
        code == EPERM || code == EACCES ? .denied : .unavailable
    }

    static func defaults(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [ProtectedDataProbe] {
        [
            ProtectedDataProbe(name: "data.mail", directory: home.appendingPathComponent("Library/Mail"), database: nil),
            ProtectedDataProbe(name: "data.calendar", directory: home.appendingPathComponent("Library/Group Containers/group.com.apple.calendar"), database: "Calendar.sqlitedb"),
        ]
    }
}

// Reminders are per session and authorization state, never a permanent record
// that a dialog was displayed. A later revocation becomes actionable again.
struct PermissionReminder {
    private var shown: [String: String] = [:]

    mutating func shouldPresent(_ permission: String, state: String?, manual: Bool) -> Bool {
        guard let state else { shown.removeValue(forKey: permission); return false }
        let present = manual || shown[permission] != state
        shown[permission] = state
        return present
    }
}
