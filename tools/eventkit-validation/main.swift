import AppKit
import Darwin
import EventKit
import Foundation

private enum ValidationError: Error, CustomStringConvertible {
    case failed(String)
    var description: String { if case .failed(let message) = self { return message }; return "failure" }
}

private final class Reporter {
    private(set) var failures = 0
    func pass(_ name: String, _ detail: String = "") { print("PASS \(name)\(detail.isEmpty ? "" : " | \(detail)")"); fflush(stdout) }
    func skip(_ name: String, _ detail: String) { print("SKIP \(name) | \(detail)"); fflush(stdout) }
    func fail(_ name: String, _ detail: String) { failures += 1; print("FAIL \(name) | \(detail)"); fflush(stdout) }
    func check(_ condition: Bool, _ name: String, _ detail: String = "") {
        condition ? pass(name, detail) : fail(name, detail)
    }
}

private func sourceTypeName(_ type: EKSourceType) -> String {
    switch type {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "mobileme"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "unknown-\(type.rawValue)"
    }
}

private func events(_ store: EKEventStore, from start: Date, to end: Date, calendars: [EKCalendar]? = nil) -> [EKEvent] {
    store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: calendars))
}

private func removeProbeEvents(_ store: EKEventStore, prefix: String) {
    let start = Date(timeIntervalSince1970: 1_700_000_000)
    let end = Date(timeIntervalSince1970: 1_900_000_000)
    // Split recurring series can leave a master plus detached exceptions.
    // Remove series first, then detached events, and repeat after resetting the
    // store so cached occurrences cannot survive cleanup.
    for _ in 0..<3 {
        let matches = events(store, from: start, to: end).filter { $0.title?.hasPrefix(prefix) == true }
        if matches.isEmpty { return }
        for event in matches.sorted(by: { $0.hasRecurrenceRules && !$1.hasRecurrenceRules }) {
            try? store.remove(event, span: event.hasRecurrenceRules ? .futureEvents : .thisEvent, commit: true)
        }
        store.reset()
    }
}

private func newEvent(_ store: EKEventStore, calendar: EKCalendar, title: String, start: Date, duration: TimeInterval = 3600) -> EKEvent {
    let event = EKEvent(eventStore: store)
    event.calendar = calendar
    event.title = title
    event.startDate = start
    event.endDate = start.addingTimeInterval(duration)
    return event
}

private func saveRefetch(_ store: EKEventStore, _ event: EKEvent, span: EKSpan = .thisEvent) throws -> EKEvent {
    try store.save(event, span: span, commit: true)
    guard let fetched = store.event(withIdentifier: event.calendarItemIdentifier) else {
        throw ValidationError.failed("saved event was not fetchable by calendarItemIdentifier")
    }
    return fetched
}

private func testAccountWrites(_ store: EKEventStore, prefix: String, reporter: Reporter) {
    let calendars = store.calendars(for: .event).filter(\.allowsContentModifications)
    let relevantSources = store.sources.filter { $0.sourceType == .calDAV || $0.sourceType == .exchange }
    for source in relevantSources {
        guard let calendar = calendars.first(where: { $0.source.sourceIdentifier == source.sourceIdentifier }) else {
            reporter.skip("account-write-\(sourceTypeName(source.sourceType))-\(source.title)", source.isDelegate ? "delegated source has no writable calendar" : "source has no writable calendar")
            continue
        }
        let name = "account-write-\(sourceTypeName(source.sourceType))-\(source.title)"
        let event = newEvent(store, calendar: calendar, title: "\(prefix) \(name)", start: Date().addingTimeInterval(50 * 86_400))
        do {
            let fetched = try saveRefetch(store, event)
            reporter.check(fetched.calendar.calendarIdentifier == calendar.calendarIdentifier, name)
            try store.remove(fetched, span: .thisEvent, commit: true)
        } catch { reporter.fail(name, String(describing: error)) }
    }
}

private func testReadOnly(_ store: EKEventStore, prefix: String, reporter: Reporter) {
    guard let calendar = store.calendars(for: .event).first(where: { !$0.allowsContentModifications }) else {
        reporter.skip("read-only-calendar", "none available"); return
    }
    let event = newEvent(store, calendar: calendar, title: "\(prefix) readonly", start: Date().addingTimeInterval(51 * 86_400))
    do {
        try store.save(event, span: .thisEvent, commit: true)
        reporter.fail("read-only-calendar", "save unexpectedly succeeded")
        try? store.remove(event, span: .thisEvent, commit: true)
    } catch { reporter.pass("read-only-calendar", "rejected with \(error)") }
}

private func testCalendarLifecycle(_ store: EKEventStore, prefix: String, reporter: Reporter) {
    guard let source = store.sources.first(where: { source in
        source.title == "iCloud" && store.calendars(for: .event).contains(where: { $0.source.sourceIdentifier == source.sourceIdentifier && $0.allowsContentModifications })
    }) else { reporter.skip("calendar-lifecycle", "no suitable source"); return }
    let calendar = EKCalendar(for: .event, eventStore: store)
    calendar.source = source
    calendar.title = "\(prefix) calendar"
    do {
        try store.saveCalendar(calendar, commit: true)
        let id = calendar.calendarIdentifier
        calendar.title = "\(prefix) renamed"
        try store.saveCalendar(calendar, commit: true)
        reporter.check(store.calendar(withIdentifier: id)?.title == calendar.title, "calendar-rename", "id remained \(id)")
        try store.removeCalendar(calendar, commit: true)
        reporter.check(store.calendar(withIdentifier: id) == nil, "calendar-delete")
    } catch {
        try? store.removeCalendar(calendar, commit: true)
        reporter.fail("calendar-lifecycle", String(describing: error))
    }
}

private func testMoveAndConcurrency(_ store: EKEventStore, prefix: String, reporter: Reporter) {
    let writable = store.calendars(for: .event).filter(\.allowsContentModifications)
    guard let first = writable.first(where: { $0.title == "Casa" }),
          let second = writable.first(where: { $0.calendarIdentifier != first.calendarIdentifier && $0.source.sourceIdentifier == first.source.sourceIdentifier }) else {
        reporter.skip("move-concurrency", "needs two writable calendars in one source"); return
    }
    do {
        var event = try saveRefetch(store, newEvent(store, calendar: first, title: "\(prefix) move", start: Date().addingTimeInterval(52 * 86_400)))
        let originalID = event.calendarItemIdentifier
        event.calendar = second
        event = try saveRefetch(store, event)
        reporter.check(event.calendar.calendarIdentifier == second.calendarIdentifier, "event-move", "id_changed=\(event.calendarItemIdentifier != originalID)")

        let storeB = EKEventStore()
        guard let copyA = store.event(withIdentifier: event.calendarItemIdentifier),
              let copyB = storeB.event(withIdentifier: event.calendarItemIdentifier) else {
            throw ValidationError.failed("concurrent copies unavailable")
        }
        copyA.location = "writer-A"
        copyB.notes = "writer-B"
        try store.save(copyA, span: .thisEvent, commit: true)
        try storeB.save(copyB, span: .thisEvent, commit: true)
        store.reset()
        let merged = store.event(withIdentifier: event.calendarItemIdentifier)
        reporter.check(merged?.location == "writer-A" && merged?.notes == "writer-B", "concurrent-disjoint-fields")

        guard let sameA = store.event(withIdentifier: event.calendarItemIdentifier),
              let sameB = storeB.event(withIdentifier: event.calendarItemIdentifier) else { throw ValidationError.failed("same-field copies unavailable") }
        sameA.title = "\(prefix) writer-A"
        sameB.title = "\(prefix) writer-B"
        try store.save(sameA, span: .thisEvent, commit: true)
        try storeB.save(sameB, span: .thisEvent, commit: true)
        store.reset()
        reporter.check(store.event(withIdentifier: event.calendarItemIdentifier)?.title == "\(prefix) writer-B", "concurrent-same-field", "last committed writer wins")
        if let cleanup = store.event(withIdentifier: event.calendarItemIdentifier) { try store.remove(cleanup, span: .thisEvent, commit: true) }
    } catch { reporter.fail("move-concurrency", String(describing: error)) }
}

private func romeDate(_ year: Int, _ month: Int, _ day: Int) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Europe/Rome")!
    return calendar.date(from: DateComponents(year: year, month: month, day: day))!
}

private func civil(_ date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Europe/Rome")!
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
}

private func testAllDayDST(_ store: EKEventStore, prefix: String, calendar: EKCalendar, reporter: Reporter) {
    for (label, start, end) in [
        ("dst-spring", romeDate(2027, 3, 27), romeDate(2027, 3, 30)),
        ("dst-autumn", romeDate(2027, 10, 30), romeDate(2027, 11, 2)),
    ] {
        let event = newEvent(store, calendar: calendar, title: "\(prefix) \(label)", start: start, duration: end.timeIntervalSince(start))
        event.isAllDay = true
        do {
            let fetched = try saveRefetch(store, event)
            // EventKit exposes an all-day end as the last second of the final
            // civil day; adding one second recovers the requested exclusive
            // end boundary used by the MCP contract.
            let exclusiveEnd = fetched.endDate.addingTimeInterval(1)
            reporter.check(fetched.isAllDay && civil(fetched.startDate) == civil(start) && civil(exclusiveEnd) == civil(end), "all-day-\(label)", "seconds=\(fetched.endDate.timeIntervalSince(fetched.startDate))")
            try store.remove(fetched, span: .thisEvent, commit: true)
        } catch { reporter.fail("all-day-\(label)", String(describing: error)) }
    }
}

private func testRecurrenceExceptions(_ store: EKEventStore, prefix: String, calendar: EKCalendar, reporter: Reporter) {
    let title = "\(prefix) recurrence"
    let base = romeDate(2027, 2, 1).addingTimeInterval(10 * 3600)
    let event = newEvent(store, calendar: calendar, title: title, start: base)
    event.addRecurrenceRule(EKRecurrenceRule(
        recurrenceWith: .weekly, interval: 1,
        daysOfTheWeek: [EKRecurrenceDayOfWeek(.monday), EKRecurrenceDayOfWeek(.wednesday)],
        daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil,
        daysOfTheYear: nil, setPositions: nil,
        end: EKRecurrenceEnd(occurrenceCount: 6)
    ))
    let rangeEnd = base.addingTimeInterval(40 * 86_400)
    do {
        _ = try saveRefetch(store, event, span: .futureEvents)
        var occurrences = events(store, from: base.addingTimeInterval(-60), to: rangeEnd, calendars: [calendar]).filter { $0.title == title }.sorted { $0.startDate < $1.startDate }
        reporter.check(occurrences.count == 6, "recurrence-complex-create", "occurrences=\(occurrences.count)")
        guard occurrences.count == 6 else { throw ValidationError.failed("wrong occurrence count") }

        occurrences[1].title = "\(prefix) exception"
        try store.save(occurrences[1], span: .thisEvent, commit: true)
        try store.remove(occurrences[2], span: .thisEvent, commit: true)
        let afterExceptions = events(store, from: base.addingTimeInterval(-60), to: rangeEnd, calendars: [calendar]).filter { $0.title?.hasPrefix(prefix) == true }
        reporter.check(afterExceptions.count == 5 && afterExceptions.filter({ $0.title == "\(prefix) exception" }).count == 1, "recurrence-single-update-delete")

        occurrences = afterExceptions.sorted { $0.startDate < $1.startDate }
        occurrences[2].location = "future-change"
        try store.save(occurrences[2], span: .futureEvents, commit: true)
        let afterFuture = events(store, from: base.addingTimeInterval(-60), to: rangeEnd, calendars: [calendar]).filter { $0.title?.hasPrefix(prefix) == true }
        let futureChanged = afterFuture.filter { $0.startDate >= occurrences[2].startDate && $0.location == "future-change" }
        reporter.check(!futureChanged.isEmpty, "recurrence-this-and-future", "changed=\(futureChanged.count)")
    } catch { reporter.fail("recurrence-exceptions", String(describing: error)) }
}

private func testIdenticalAmbiguity(_ store: EKEventStore, prefix: String, calendar: EKCalendar, reporter: Reporter) {
    let title = "\(prefix) identical"
    let start = Date().addingTimeInterval(53 * 86_400)
    do {
        _ = try saveRefetch(store, newEvent(store, calendar: calendar, title: title, start: start))
        _ = try saveRefetch(store, newEvent(store, calendar: calendar, title: title, start: start))
        let matches = events(store, from: start.addingTimeInterval(-60), to: start.addingTimeInterval(7200), calendars: [calendar]).filter { $0.title == title }
        reporter.check(matches.count == 2 && Set(matches.map(\.calendarItemIdentifier)).count == 2, "identical-event-ambiguity", "candidates=\(matches.count); resolver must refuse fingerprint-only mutation")
    } catch { reporter.fail("identical-event-ambiguity", String(describing: error)) }
}

@main private enum EventKitValidation {
    static func main() async {
        if let index = CommandLine.arguments.firstIndex(of: "--output"), CommandLine.arguments.indices.contains(index + 1) {
            _ = freopen(CommandLine.arguments[index + 1], "w", stdout)
            _ = freopen(CommandLine.arguments[index + 1], "a", stderr)
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let reporter = Reporter()
        let store = EKEventStore()
        do {
            guard try await store.requestFullAccessToEvents() else { throw ValidationError.failed("full access denied") }
            if let cleanupIndex = CommandLine.arguments.firstIndex(of: "--cleanup-prefix"),
               CommandLine.arguments.indices.contains(cleanupIndex + 1) {
                let cleanupPrefix = CommandLine.arguments[cleanupIndex + 1]
                removeProbeEvents(store, prefix: cleanupPrefix)
                print("CLEANUP prefix=\(cleanupPrefix)")
                exit(EXIT_SUCCESS)
            }
            let prefix = "Steward Validation \(UUID().uuidString)"
            defer { removeProbeEvents(store, prefix: prefix) }
            let calendars = store.calendars(for: .event)
            for source in store.sources {
                let sourceCalendars = calendars.filter { $0.source.sourceIdentifier == source.sourceIdentifier }
                print("SOURCE type=\(sourceTypeName(source.sourceType)) delegate=\(source.isDelegate) title=\(source.title) calendars=\(sourceCalendars.count) writable=\(sourceCalendars.filter(\.allowsContentModifications).count)")
            }
            reporter.check(calendars.map(\.calendarIdentifier).count == Set(calendars.map(\.calendarIdentifier)).count, "calendar-identifiers-unique")
            testAccountWrites(store, prefix: prefix, reporter: reporter)
            testReadOnly(store, prefix: prefix, reporter: reporter)
            testCalendarLifecycle(store, prefix: prefix, reporter: reporter)
            testMoveAndConcurrency(store, prefix: prefix, reporter: reporter)
            guard let calendar = calendars.first(where: { $0.title == "Casa" && $0.allowsContentModifications }) ?? calendars.first(where: \.allowsContentModifications) else {
                throw ValidationError.failed("no writable calendar")
            }
            testAllDayDST(store, prefix: prefix, calendar: calendar, reporter: reporter)
            testRecurrenceExceptions(store, prefix: prefix, calendar: calendar, reporter: reporter)
            testIdenticalAmbiguity(store, prefix: prefix, calendar: calendar, reporter: reporter)
            removeProbeEvents(store, prefix: prefix)
            print("RESULT failures=\(reporter.failures)")
            exit(reporter.failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE)
        } catch {
            print("FATAL \(error)")
            exit(EXIT_FAILURE)
        }
    }
}
