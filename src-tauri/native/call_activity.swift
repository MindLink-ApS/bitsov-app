import Foundation

#if os(macOS)
/// The system activity held while a call is live. The Rust side counts the
/// calls and calls these entry points one at a time, under its own lock.
private var callActivity: NSObjectProtocol?

/// Keep the process out of App Nap and timer coalescing while a call is live:
/// call audio is latency-critical and the owner started it. Repeated begins
/// keep the one activity.
@_cdecl("bitsov_call_activity_begin")
public func bitsovCallActivityBegin() {
    if callActivity != nil { return }
    callActivity = ProcessInfo.processInfo.beginActivity(
        options: [.userInitiated, .latencyCritical],
        reason: "Live call audio"
    )
}

/// End the activity. Without one, nothing happens.
@_cdecl("bitsov_call_activity_end")
public func bitsovCallActivityEnd() {
    guard let activity = callActivity else { return }
    callActivity = nil
    ProcessInfo.processInfo.endActivity(activity)
}
#endif
