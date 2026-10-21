import AppKit
import EventKit

@MainActor
final class PermissionOnboarding {
    private let calendar: CalendarEventKitBridge
    private let window: () -> NSWindow?
    private var l10n: NativeL10n
    private var running = false
    private var started = false
    private var attemptedCalendarState: String?
    private var previousCalendarFullAccess = false
    private var reminders = PermissionReminder()

    init(calendar: CalendarEventKitBridge, window: @escaping () -> NSWindow?, language: String) {
        self.calendar = calendar
        self.window = window
        l10n = NativeL10n(language: NativeLanguage(rawValue: language) ?? .en)
    }

    func start() {
        started = true
        check()
    }

    func activated() {
        l10n = NativeL10n()
        if started { check() }
    }

    func check(manual: Bool = false) {
        guard !running, NSApp.isActive, let window = window(), window.attachedSheet == nil else { return }
        running = true
        Task { @MainActor in
            defer { running = false }
            var messages: [String] = []
            var presented = false
            var status = EKEventStore.authorizationStatus(for: .event)
            if (status == .notDetermined || status == .writeOnly) && (manual || attemptedCalendarState != String(describing: status)) {
                attemptedCalendarState = String(describing: status)
                do {
                    _ = try await calendar.requestAccess()
                } catch {
                    messages.append(l10n.text("permissions.calendarError", error.localizedDescription))
                }
                status = EKEventStore.authorizationStatus(for: .event)
            }
            if status == .fullAccess {
                if !previousCalendarFullAccess { await calendar.refreshAccess() }
                attemptedCalendarState = nil
            }
            previousCalendarFullAccess = status == .fullAccess
            let calendarState = status == .fullAccess ? nil : String(describing: status)
            if reminders.shouldPresent("calendar", state: calendarState, manual: manual) {
                let restricted = status == .restricted
                let detail = l10n.text(restricted ? "permissions.calendarRestricted" : "permissions.calendarGuide")
                presented = true
                if await guide(title: l10n.text("permissions.calendarTitle"), detail: ([detail] + messages).joined(separator: "\n\n"), pane: restricted ? nil : "Privacy_Calendars", window: window) { return }
            }
            // Run actual I/O off the UI thread; never inspect mail/event contents.
            let probes = await Task.detached {
                ProtectedDataProbe.defaults().map { ($0.name, $0.check()) }
            }.value
            let denied = probes.filter { $0.1 == .denied }.map { $0.0 }
            let unavailable = probes.filter { $0.1 == .unavailable }.map { $0.0 }
            let diskState = denied.isEmpty ? nil : denied.joined(separator: ", ")
            if reminders.shouldPresent("disk", state: diskState, manual: manual) {
                presented = true
                let detail = l10n.text("permissions.diskGuide", denied.map { l10n.text($0) }.joined(separator: ", "))
                if await guide(title: l10n.text("permissions.diskTitle"), detail: detail, pane: "Privacy_AllFiles", window: window, revealApp: true) { return }
            }
            if manual && !presented {
                messages.append(l10n.text(status == .fullAccess ? "permissions.calendarGranted" : "permissions.calendarNotGranted"))
                let readable = probes.filter { $0.1 == .readable }.map { l10n.text($0.0) }
                messages.append(l10n.text("permissions.readable", readable.isEmpty ? l10n.text("permissions.none") : readable.joined(separator: ", ")))
                if !unavailable.isEmpty {
                    messages.append(l10n.text("permissions.unavailable", unavailable.map { l10n.text($0) }.joined(separator: ", ")))
                }
                _ = await guide(title: l10n.text("permissions.statusTitle"), detail: messages.joined(separator: "\n\n"), pane: unavailable.isEmpty ? nil : "Privacy_AllFiles", window: window)
            }
        }
    }

    private func guide(title: String, detail: String, pane: String?, window: NSWindow, revealApp: Bool = false) async -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        if pane != nil {
            alert.addButton(withTitle: l10n.text("common.settings"))
            alert.addButton(withTitle: l10n.text("common.notNow"))
        } else { alert.addButton(withTitle: l10n.text("common.ok")) }
        let response = await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        if response == .alertFirstButtonReturn, let pane {
            if revealApp { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"), NSWorkspace.shared.open(url) { return true }
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app"))
            return true
        }
        return false
    }
}
