import Foundation

enum NativeLanguage: String {
    case en, it

    static func resolve(saved: String?, preferred: String?) -> NativeLanguage {
        if let saved, let language = NativeLanguage(rawValue: saved) { return language }
        return preferred?.lowercased().hasPrefix("it") == true ? .it : .en
    }

    static func current() -> NativeLanguage {
        let file = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Steward/notification-lang.json")
        let saved = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["lang"] as? String
        return resolve(saved: saved, preferred: Locale.preferredLanguages.first)
    }
}

struct NativeL10n {
    let language: NativeLanguage
    private let translations: [String: String]
    private let fallback: [String: String]

    static var sourceResources: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Resources")
    }

    init(language: NativeLanguage = .current(), resources: URL? = nil) {
        self.language = language
        let packaged = Bundle.main.resourceURL
        let root = resources ?? (packaged.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("en.lproj/Localizable.strings").path) } == true ? packaged! : Self.sourceResources)
        fallback = Self.catalog(language: .en, resources: root)
        translations = Self.catalog(language: language, resources: root)
    }

    static func catalog(language: NativeLanguage, resources: URL, table: String = "Localizable") -> [String: String] {
        let file = resources.appendingPathComponent("\(language.rawValue).lproj/\(table).strings")
        guard let data = try? Data(contentsOf: file),
              let values = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String] else { return [:] }
        return values
    }

    func text(_ key: String, _ arguments: String...) -> String {
        let format = translations[key] ?? fallback[key] ?? key
        return String(format: format, arguments: arguments.map { $0 as NSString })
    }
}
