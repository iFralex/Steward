import XCTest
@testable import StewardLauncher

final class LocalizationTests: XCTestCase {
    func testCatalogsHaveMatchingKeysAndPlaceholders() {
        for table in ["Localizable", "InfoPlist"] {
            let english = NativeL10n.catalog(language: .en, resources: NativeL10n.sourceResources, table: table)
            let italian = NativeL10n.catalog(language: .it, resources: NativeL10n.sourceResources, table: table)
            XCTAssertFalse(english.isEmpty)
            XCTAssertEqual(Set(english.keys), Set(italian.keys))
            for (key, value) in english {
                XCTAssertFalse(italian[key]!.isEmpty, key)
                XCTAssertEqual(value.components(separatedBy: "%@").count, italian[key]!.components(separatedBy: "%@").count, key)
            }
        }
    }

    func testSavedEnglishOverridesItalianSystemLanguage() {
        XCTAssertEqual(NativeLanguage.resolve(saved: "en", preferred: "it-IT"), .en)
        XCTAssertEqual(NativeLanguage.resolve(saved: "it", preferred: "en-US"), .it)
        XCTAssertEqual(NativeLanguage.resolve(saved: nil, preferred: "it-IT"), .it)
        XCTAssertEqual(NativeLanguage.resolve(saved: "unknown", preferred: "fr-FR"), .en)
    }

    func testPermissionMessagesAndDataLabelsAreLocalized() {
        let en = NativeL10n(language: .en, resources: NativeL10n.sourceResources)
        let it = NativeL10n(language: .it, resources: NativeL10n.sourceResources)
        XCTAssertEqual(en.text("data.calendar"), "Calendar")
        XCTAssertEqual(it.text("data.calendar"), "Calendario")
        XCTAssertTrue(en.text("permissions.diskGuide", en.text("data.calendar")).contains("blocked for: Calendar"))
        XCTAssertTrue(it.text("permissions.diskGuide", it.text("data.calendar")).contains("bloccata per: Calendario"))
        XCTAssertEqual(en.text("common.cancel"), "Cancel")
        XCTAssertEqual(it.text("common.cancel"), "Annulla")
    }
}
