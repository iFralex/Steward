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
        guard let method = request["method"] as? String else { throw BridgeError("Missing Calendar bridge method") }
        // Read-only diagnostics must work before access is granted and must not
        // display an authorization prompt or read event/calendar contents.
        if method == "status" {
            let authorization: String
            switch EKEventStore.authorizationStatus(for: .event) {
            case .notDetermined: authorization = "notDetermined"
            case .restricted: authorization = "restricted"
            case .denied: authorization = "denied"
            case .writeOnly: authorization = "writeOnly"
            case .fullAccess: authorization = "fullAccess"
            @unknown default: authorization = "unknown"
            }
            return ["authorization": authorization]
        }
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw BridgeError("[CALENDAR_FULL_ACCESS_REQUIRED] Calendar full access is not granted. Allow Steward in System Settings → Privacy & Security → Calendars. Full Disk Access is a separate permission. No write was executed.")
        }
        if let expiry = request["expiresAtMs"] as? NSNumber,
           Date().timeIntervalSince1970 * 1000 >= expiry.doubleValue {
            throw BridgeError("Calendar request expired before execution; no write was executed")
        }
        let params = request["params"] as? [String: Any] ?? [:]
        switch method {
        case "ping": return ["authorization": "fullAccess"]
        case "search": return try search(params)
        case "read": return ["event": try findEvent(params).map(serialize) as Any? ?? NSNull()]
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
        guard let event = try findEvent(params) else { throw BridgeError("Event not found") }
        if event.hasRecurrenceRules && params["occurrenceStart"] == nil {
            throw BridgeError("Recurring changes require occurrenceStart from search_events")
        }
        try apply(params, to: event, creating: false)
        try store.save(event, span: span(params), commit: true)
        return ["uid": event.calendarItemIdentifier]
    }

    private func delete(_ params: [String: Any]) throws -> [String: Any] {
        guard let event = try findEvent(params) else { throw BridgeError("Event not found") }
        if event.hasRecurrenceRules && params["occurrenceStart"] == nil {
            throw BridgeError("Recurring deletion requires occurrenceStart from search_events")
        }
        try store.remove(event, span: span(params), commit: true)
        return ["uid": params["uid"] as? String ?? "", "scope": params["scope"] as? String ?? "thisEvent"]
    }

    private func findEvent(_ params: [String: Any]) throws -> EKEvent? {
        store.reset()
        guard let uid = params["uid"] as? String else { throw BridgeError("Missing event uid") }
        guard let base = store.event(withIdentifier: uid) ?? store.calendarItem(withIdentifier: uid) as? EKEvent else { return nil }
        guard let occurrence = params["occurrenceStart"] as? String else { return base }
        let start = try date(occurrence)
        let predicate = store.predicateForEvents(withStart: start.addingTimeInterval(-1), end: start.addingTimeInterval(1), calendars: [base.calendar])
        let matches = store.events(matching: predicate).filter {
            $0.calendarItemIdentifier == base.calendarItemIdentifier && abs($0.startDate.timeIntervalSince(start)) < 1
        }
        guard matches.count <= 1 else { throw BridgeError("Ambiguous recurring occurrence") }
        return matches.first
    }

    private func search(_ params: [String: Any]) throws -> [String: Any] {
        store.reset()
        guard let from = params["start"] as? String, let to = params["end"] as? String else { throw BridgeError("Search requires start/end") }
        let start = try date(from), end = try date(to)
        guard end > start, end.timeIntervalSince(start) <= 366 * 86_400 else { throw BridgeError("Calendar range must be positive and at most 366 days") }
        let calendars = store.calendars(for: .event)
        // Filter exact account/title separately; EventKit expands recurring occurrences.
        let selected = calendars.filter { calendar in
            (params["calendar"] as? String).map { $0 == calendar.title } ?? true
        }.filter { calendar in
            (params["account"] as? String).map { $0 == calendar.source.title } ?? true
        }
        if selected.isEmpty { return ["events": []] }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: selected)
        let events = store.events(matching: predicate).filter { $0.startDate < end && $0.endDate > start }
            .sorted { $0.startDate < $1.startDate }
        guard events.count <= 1000 else { throw BridgeError("Calendar range exceeds 1000 occurrences; narrow the range") }
        return ["events": events.map(serialize)]
    }

    private func serialize(_ event: EKEvent) -> [String: Any] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var result: [String: Any] = [
            "uid": event.calendarItemIdentifier, "summary": event.title ?? "",
            "description": event.notes as Any? ?? NSNull(), "location": event.location as Any? ?? NSNull(),
            "start": iso.string(from: event.startDate), "end": iso.string(from: event.endDate),
            "allDay": event.isAllDay, "calendarId": event.calendar.calendarIdentifier,
            "calendar": event.calendar.title, "account": event.calendar.source.title,
            "alarms": (event.alarms ?? []).map { Int(-$0.relativeOffset / 60) },
            "hasRecurrence": event.hasRecurrenceRules, "recurrenceRuleCount": event.recurrenceRules?.count ?? 0, "status": event.status == .canceled ? 3 : 1,
            "url": event.url?.absoluteString as Any? ?? NSNull(),
            "lastModified": event.lastModifiedDate?.timeIntervalSinceReferenceDate ?? 0,
            "occurrenceStart": iso.string(from: event.startDate),
        ]
        if let external = event.calendarItemExternalIdentifier { result["externalId"] = external }
        if let rule = event.recurrenceRules?.first { result["recurrence"] = recurrenceString(rule) }
        return result
    }

    private func recurrenceString(_ rule: EKRecurrenceRule) -> String {
        let frequencies: [EKRecurrenceFrequency: String] = [.daily: "DAILY", .weekly: "WEEKLY", .monthly: "MONTHLY", .yearly: "YEARLY"]
        var parts = ["FREQ=\(frequencies[rule.frequency] ?? "DAILY")"]
        if rule.interval != 1 { parts.append("INTERVAL=\(rule.interval)") }
        if let end = rule.recurrenceEnd {
            if end.occurrenceCount > 0 { parts.append("COUNT=\(end.occurrenceCount)") }
            else if let date = end.endDate {
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
                formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"; parts.append("UNTIL=\(formatter.string(from: date))")
            }
        }
        if let days = rule.daysOfTheWeek, !days.isEmpty {
            let labels = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
            parts.append("BYDAY=" + days.map { ($0.weekNumber == 0 ? "" : String($0.weekNumber)) + labels[$0.dayOfTheWeek.rawValue - 1] }.joined(separator: ","))
        }
        for (key, values) in [("BYMONTHDAY", rule.daysOfTheMonth), ("BYMONTH", rule.monthsOfTheYear),
                              ("BYWEEKNO", rule.weeksOfTheYear), ("BYYEARDAY", rule.daysOfTheYear), ("BYSETPOS", rule.setPositions)] {
            if let values, !values.isEmpty { parts.append(key + "=" + values.map { $0.stringValue }.joined(separator: ",")) }
        }
        return parts.sorted().joined(separator: ";")
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
        if params["clearRecurrence"] as? Bool == true { event.recurrenceRules?.forEach(event.removeRecurrenceRule) }
        if let recurrence = params["recurrenceSpec"] as? [String: Any] {
            event.recurrenceRules?.forEach(event.removeRecurrenceRule)
            event.addRecurrenceRule(try recurrenceRule(recurrence))
        }
        if let start = event.startDate, let end = event.endDate, end <= start { throw BridgeError("Event end must be after start") }
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
