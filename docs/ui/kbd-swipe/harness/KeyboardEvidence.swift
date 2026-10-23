import XCTest
final class KeyboardEvidence: XCTestCase {
 func testKeyboard() throws {
  let app = XCUIApplication(bundleIdentifier: "tech.mindlink.keyboardpreview")
  app.activate()
  let web = app.webViews.firstMatch
  XCTAssertTrue(web.waitForExistence(timeout: 15))
  sleep(2)
  let field = web.secureTextFields.firstMatch.exists ? web.secureTextFields.firstMatch : web.textFields.firstMatch.exists ? web.textFields.firstMatch : web.textViews.firstMatch
  XCTAssertTrue(field.waitForExistence(timeout: 15))
  field.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
  sleep(2)
  // Only the amount field uses a decimal pad; other scenes are left untouched.
  if app.keyboards.keys["1"].exists && web.textFields.firstMatch.exists && !web.secureTextFields.firstMatch.exists {
   for digit in ["1", "2", "5", "0"] {
    field.typeText(digit)
    usleep(300_000)
   }
   // Fractional msat display and deletion back to a whole-sat amount must not jump either.
   for key in [".", "5", XCUIKeyboardKey.delete.rawValue, XCUIKeyboardKey.delete.rawValue] {
    field.typeText(key)
    usleep(300_000)
   }
   sleep(2)
  }
  let attachment = XCTAttachment(screenshot: app.screenshot())
  attachment.name = "keyboard-up"
  attachment.lifetime = .keepAlways
  add(attachment)
 }
 func testEdgeBack() throws {
  let app = XCUIApplication(bundleIdentifier: "tech.mindlink.keyboardpreview")
  app.launchArguments = ["--composer"]
  app.launch()
  let web = app.webViews.firstMatch
  XCTAssertTrue(web.waitForExistence(timeout: 15))
  let input = web.textViews.firstMatch
  XCTAssertTrue(input.waitForExistence(timeout: 15))
  input.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
  let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: 3, dy: 260))
  let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: 210, dy: 260))
  start.press(forDuration: 0.01, thenDragTo: end, withVelocity: 600, thenHoldForDuration: 0)
  XCTAssertTrue(web.staticTexts["Welcome home"].waitForExistence(timeout: 5))
  XCTAssertFalse(input.exists)
  XCTAssertFalse(app.keyboards.firstMatch.exists)
  app.terminate()
  app.launchArguments = ["--first-spend"]
  app.launch()
  let amount = app.webViews.textFields.firstMatch
  XCTAssertTrue(amount.waitForExistence(timeout: 15))
  amount.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
  start.press(forDuration: 0.01, thenDragTo: end, withVelocity: 600, thenHoldForDuration: 0)
  XCTAssertTrue(amount.exists)
  XCTAssertTrue(app.keyboards.firstMatch.exists)
 }

 func testKeyboardDismissal() throws {
  let app = XCUIApplication(bundleIdentifier: "tech.mindlink.keyboardpreview")
  app.launchArguments = ["--composer"]
  app.launch()
  let input = app.webViews.textViews.firstMatch
  XCTAssertTrue(input.waitForExistence(timeout: 15))
  input.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
  sleep(2)
  // The native checkmark in the keyboard accessory, measured in the iPhone 16 capture.
  app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: 349, dy: 488)).tap()
  sleep(2)
  XCTAssertFalse(app.keyboards.firstMatch.exists)
  XCTAssertTrue(input.exists)
  let attachment = XCTAttachment(screenshot: app.screenshot())
  attachment.name = "keyboard-hidden"
  attachment.lifetime = .keepAlways
  add(attachment)
 }

}
