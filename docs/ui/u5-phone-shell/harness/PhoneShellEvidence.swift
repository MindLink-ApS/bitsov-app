import XCTest
final class PhoneShellEvidence: XCTestCase {
 func testKeyboard() throws {
  let app = XCUIApplication(bundleIdentifier: "tech.mindlink.phoneshellpreview")
  app.activate()
  let field = app.webViews.textViews.firstMatch
  XCTAssertTrue(field.waitForExistence(timeout: 15))
  field.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
  field.typeText("Draft only")
  sleep(2)
 }
}
