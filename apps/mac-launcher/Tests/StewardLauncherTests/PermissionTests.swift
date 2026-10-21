import XCTest
import Darwin
@testable import StewardLauncher

final class PermissionTests: XCTestCase {
    func testRemindersReturnAfterRevocationAndOnNextLaunch() {
        var reminders = PermissionReminder()
        XCTAssertTrue(reminders.shouldPresent("disk", state: "denied", manual: false))
        XCTAssertFalse(reminders.shouldPresent("disk", state: "denied", manual: false))
        XCTAssertTrue(reminders.shouldPresent("disk", state: "denied", manual: true))
        XCTAssertFalse(reminders.shouldPresent("disk", state: nil, manual: false))
        XCTAssertTrue(reminders.shouldPresent("disk", state: "denied", manual: false))
        var nextLaunch = PermissionReminder()
        XCTAssertTrue(nextLaunch.shouldPresent("disk", state: "denied", manual: false))
    }

    func testCalendarAndDiskDecisionsAreIndependent() {
        var reminders = PermissionReminder()
        XCTAssertTrue(reminders.shouldPresent("calendar", state: "denied", manual: false))
        XCTAssertTrue(reminders.shouldPresent("disk", state: "denied", manual: false))
        XCTAssertTrue(reminders.shouldPresent("calendar", state: "restricted", manual: false))
        XCTAssertFalse(reminders.shouldPresent("calendar", state: nil, manual: true))
    }

    func testProbeReadsDatabaseAndDistinguishesMissingData() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = ProtectedDataProbe(name: "test", directory: directory, database: "database")
        XCTAssertEqual(probe.check(), .unavailable)
        try Data("sqlite header".utf8).write(to: directory.appendingPathComponent("database"))
        XCTAssertEqual(probe.check(), .readable)
        XCTAssertEqual(ProtectedDataProbe.classify(EPERM), .denied)
        XCTAssertEqual(ProtectedDataProbe.classify(EACCES), .denied)
        XCTAssertEqual(ProtectedDataProbe.classify(ENOENT), .unavailable)
        XCTAssertEqual(ProtectedDataProbe.classify(EIO), .unavailable)
    }
}
