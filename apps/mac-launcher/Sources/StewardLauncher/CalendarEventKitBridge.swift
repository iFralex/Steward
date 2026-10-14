import EventKit
import Foundation

final class CalendarEventKitBridge {
    let root: URL
    private let requests: URL
    private let processing: URL
    private let responses: URL
    private let store = EKEventStore()
    private let queue = DispatchQueue(label: "com.steward.calendar-eventkit-bridge")
    private var timer: DispatchSourceTimer?

    init(root: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Steward/calendar-bridge", isDirectory: true)) {
        self.root = root
        self.requests = root.appendingPathComponent("requests", isDirectory: true)
        self.processing = root.appendingPathComponent("processing", isDirectory: true)
        self.responses = root.appendingPathComponent("responses", isDirectory: true)
    }

    func start() {
        for directory in [root, requests, processing, responses] {
            try? FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        recoverInterruptedRequests()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    func requestAccess() {
        Task {
            do {
                let granted = try await store.requestFullAccessToEvents()
                if granted { store.reset() }
                else { NSLog("Calendar full access was not granted") }
            } catch {
                NSLog("Calendar full-access request failed: \(error.localizedDescription)")
            }
        }
    }

    private func recoverInterruptedRequests() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: processing, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "json" {
            let id = file.deletingPathExtension().lastPathComponent
            writeResponse(id: id, body: [
                "id": id,
                "ok": false,
                "outcomeUnknown": true,
                "error": "Steward restarted while Calendar was processing the request; reconciliation must determine the outcome.",
            ])
            try? FileManager.default.removeItem(at: file)
        }
    }

    private func poll() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: requests, includingPropertiesForKeys: nil) else { return }
        for requestURL in files.filter({ $0.pathExtension == "json" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let id = requestURL.deletingPathExtension().lastPathComponent
            let processingURL = processing.appendingPathComponent(requestURL.lastPathComponent)
            do {
                try FileManager.default.moveItem(at: requestURL, to: processingURL)
                let data = try Data(contentsOf: processingURL)
                guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw BridgeError("Invalid JSON request")
                }
                let result = try execute(request)
                writeResponse(id: id, body: ["id": id, "ok": true, "result": result])
            } catch {
                writeResponse(id: id, body: ["id": id, "ok": false, "error": error.localizedDescription])
            }
            try? FileManager.default.removeItem(at: processingURL)
        }
    }

    private func writeResponse(id: String, body: [String: Any]) {
        let finalURL = responses.appendingPathComponent("\(id).json")
        let temporaryURL = responses.appendingPathComponent(".\(id).\(UUID().uuidString).tmp")
        do {
            let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            try data.write(to: temporaryURL, options: .atomic)
            if FileManager.default.fileExists(atPath: finalURL.path) { try FileManager.default.removeItem(at: finalURL) }
            try FileManager.default.moveItem(at: temporaryURL, to: finalURL)
        } catch {
            NSLog("Calendar bridge could not write response \(id): \(error.localizedDescription)")
        }
    }

    private func execute(_ request: [String: Any]) throws -> [String: Any] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw BridgeError("Calendar full access is not granted. Allow Steward in System Settings → Privacy & Security → Calendars.")
        }
        guard let method = request["method"] as? String else { throw BridgeError("Missing Calendar bridge method") }
        let params = request["params"] as? [String: Any] ?? [:]
        switch method {
        case "ping": return ["authorization": "fullAccess"]
        case "create": return try create(params)
        case "update": return try update(params)
        case "delete": return try delete(params)
        default: throw BridgeError("Unknown Calendar bridge method: \(method)")
        }
    }

    private func create(_ params: [String: Any]) throws -> [String: Any] {
        guard let calendarID = params["calendarId"] as? String,
              let calendar = store.calendar(withIdentifier: calendarID) else { throw BridgeError("Calendar not found") }
        guard calendar.allowsContentModifications else { throw BridgeError("Calendar is read-only") }
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        try apply(params, to: event, creating: true)
        try store.save(event, span: event.hasRecurrenceRules ? .futureEvents : .thisEvent, commit: true)
        return ["uid": event.calendarItemIdentifier]
    }

    private func update(_ params: [String: Any]) throws -> [String: Any] {
        guard let uid = params["uid"] as? String,
              let event = store.event(withIdentifier: uid) else { throw BridgeError("Event not found") }
        try apply(params, to: event, creating: false)
        try store.save(event, span: span(params), commit: true)
        return ["uid": event.calendarItemIdentifier]
    }

    private func delete(_ params: [String: Any]) throws -> [String: Any] {
        guard let uid = params["uid"] as? String,
              let event = store.event(withIdentifier: uid) else { throw BridgeError("Event not found") }
        try store.remove(event, span: span(params), commit: true)
        return ["uid": uid]
    }

    private func span(_ params: [String: Any]) -> EKSpan {
        (params["scope"] as? String) == "futureEvents" ? .futureEvents : .thisEvent
    }

    private func apply(_ params: [String: Any], to event: EKEvent, creating: Bool) throws {
        if let summary = params["summary"] as? String { event.title = summary }
        if let value = params["start"] as? String { event.startDate = try date(value) }
        if let value = params["end"] as? String { event.endDate = try date(value) }
        if creating { event.isAllDay = params["allDay"] as? Bool ?? false }
        if let location = params["location"] as? String { event.location = location }
        if let notes = params["description"] as? String { event.notes = notes }
        if let value = params["url"] as? String { event.url = URL(string: value) }
        if let alarms = params["alarms"] as? [NSNumber] {
            event.alarms = alarms.map { EKAlarm(relativeOffset: -$0.doubleValue * 60) }
        }
        if let recurrence = params["recurrenceSpec"] as? [String: Any] {
            event.recurrenceRules?.forEach(event.removeRecurrenceRule)
            event.addRecurrenceRule(try recurrenceRule(recurrence))
        }
        if creating && (event.title?.isEmpty != false || event.startDate == nil || event.endDate == nil) {
            throw BridgeError("summary, start, and end are required")
        }
    }

    private func recurrenceRule(_ spec: [String: Any]) throws -> EKRecurrenceRule {
        guard let rawFrequency = spec["frequency"] as? String else { throw BridgeError("Missing recurrence frequency") }
        let frequency: EKRecurrenceFrequency
        switch rawFrequency {
        case "DAILY": frequency = .daily
        case "WEEKLY": frequency = .weekly
        case "MONTHLY": frequency = .monthly
        case "YEARLY": frequency = .yearly
        default: throw BridgeError("Unsupported recurrence frequency")
        }
        let recurrenceEnd: EKRecurrenceEnd?
        if let count = (spec["count"] as? NSNumber)?.intValue {
            recurrenceEnd = EKRecurrenceEnd(occurrenceCount: count)
        } else if let rawUntil = spec["until"] as? String {
            recurrenceEnd = EKRecurrenceEnd(end: try recurrenceEndDate(rawUntil))
        } else { recurrenceEnd = nil }
        let weekdays = (spec["daysOfWeek"] as? [[String: Any]])?.map { item -> EKRecurrenceDayOfWeek in
            let day: EKWeekday
            switch item["day"] as? String {
            case "MO": day = .monday; case "TU": day = .tuesday; case "WE": day = .wednesday
            case "TH": day = .thursday; case "FR": day = .friday; case "SA": day = .saturday
            default: day = .sunday
            }
            return EKRecurrenceDayOfWeek(day, weekNumber: (item["ordinal"] as? NSNumber)?.intValue ?? 0)
        }
        func numbers(_ key: String) -> [NSNumber]? { spec[key] as? [NSNumber] }
        return EKRecurrenceRule(
            recurrenceWith: frequency,
            interval: (spec["interval"] as? NSNumber)?.intValue ?? 1,
            daysOfTheWeek: weekdays,
            daysOfTheMonth: numbers("daysOfMonth"),
            monthsOfTheYear: numbers("monthsOfYear"),
            weeksOfTheYear: numbers("weeksOfYear"),
            daysOfTheYear: numbers("daysOfYear"),
            setPositions: numbers("setPositions"),
            end: recurrenceEnd
        )
    }

    private func date(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: value) { return date }
        throw BridgeError("Invalid RFC 3339 date: \(value)")
    }

    private func recurrenceEndDate(_ value: String) throws -> Date {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = value.count == 8 ? "yyyyMMdd" : "yyyyMMdd'T'HHmmss'Z'"
        guard let date = formatter.date(from: value) else { throw BridgeError("Invalid recurrence UNTIL") }
        return value.count == 8 ? date.addingTimeInterval(86_399) : date
    }
}

private struct BridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
