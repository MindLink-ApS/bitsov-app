import XCTest
final class DynamicTypeEvidence: XCTestCase {
 func testKeyboard() throws {
  let app = XCUIApplication(bundleIdentifier: "tech.mindlink.dynamictypepreview")
  app.activate()
  let field = app.webViews.textFields.firstMatch
  XCTAssertTrue(field.waitForExistence(timeout: 15))
  field.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
  field.typeText("1250")
  sleep(2)
 }
}
