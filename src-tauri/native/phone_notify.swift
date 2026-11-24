import Foundation

#if os(iOS)
import UserNotifications

/// The answer from the system, filled in on its callback queue.
private final class Accepted: @unchecked Sendable {
    var value = false
}

/// Posts one local alert now, with the system's default notification sound.
/// The notification plugin can only name a sound file on iOS, and naming no
/// file leaves the alert silent; this asks for `UNNotificationSound.default`.
/// Text only: no identifiers, actions, attachments or user info. Call it off
/// the main thread: it waits at most 5 s for the system to accept the alert.
@_cdecl("bitsov_phone_notify")
public func bitsovPhoneNotify(_ title: UnsafePointer<CChar>, _ body: UnsafePointer<CChar>) -> Bool {
    let content = UNMutableNotificationContent()
    content.title = String(cString: title)
    content.body = String(cString: body)
    content.sound = UNNotificationSound.default
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    let accepted = Accepted()
    let done = DispatchSemaphore(value: 0)
    UNUserNotificationCenter.current().add(request) { error in
        accepted.value = error == nil
        done.signal()
    }
    return done.wait(timeout: .now() + 5) == .success && accepted.value
}
#endif
