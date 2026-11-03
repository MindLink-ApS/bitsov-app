import Foundation

enum Failure: Error { case unavailable }
var changes: [Bool] = []
let lifecycle = CallAudioLifecycle { changes.append($0) }
try lifecycle.setLive(false)
assert(changes.isEmpty, "Idle must not touch the shared audio session")
try lifecycle.setLive(true)
try lifecycle.setLive(true)
assert(changes == [true], "Live activates once")
try lifecycle.setLive(false)
try lifecycle.setLive(false)
assert(changes == [true, false], "End releases once")
try lifecycle.setLive(true)
lifecycle.terminate()
try lifecycle.setLive(true)
assert(changes == [true, false, true, false], "Termination releases and rejects late activation")

var failed: [Bool] = []
let unavailable = CallAudioLifecycle { live in
    failed.append(live)
    if live { throw Failure.unavailable }
}
do { try unavailable.setLive(true); assertionFailure("Activation should fail") } catch {}
assert(failed == [true, false], "Partial activation is rolled back on error")
try unavailable.setLive(false)
assert(failed == [true, false], "Failed activation leaves no session")

var attempts = 0
let retry = CallAudioLifecycle { live in
    if !live { attempts += 1; if attempts == 1 { throw Failure.unavailable } }
}
try retry.setLive(true)
do { try retry.setLive(false); assertionFailure("Deactivation should fail") } catch {}
retry.terminate()
assert(attempts == 2, "Failed deactivation remains owned for termination cleanup")

var idleChanges = 0
let idle = CallAudioLifecycle { _ in idleChanges += 1 }
idle.terminate()
try idle.setLive(true)
assert(idleChanges == 0, "Idle termination and late commands must not acquire audio")

var partial: [Bool] = []
let rollbackFailure = CallAudioLifecycle { live in
    partial.append(live)
    if partial.count <= 2 { throw Failure.unavailable }
}
do { try rollbackFailure.setLive(true); assertionFailure("Activation should fail") } catch {}
try rollbackFailure.setLive(true)
assert(partial == [true, false, false, true], "A failed rollback is cleaned before a fresh activation")
try rollbackFailure.setLive(false)
assert(partial == [true, false, false, true, false])

// Speaker / earpiece: only during a Live call, earpiece by default, reset when
// the call ends, and never over a headset, Bluetooth or car route.
var port = CallAudioOutput.earpiece
var overrides: [Bool] = []
let routed = CallAudioLifecycle(setSession: { _ in }, overrideSpeaker: { on in
    overrides.append(on); port = on ? .speaker : .earpiece
}, output: { port })
assert(routed.route == .inactive)
let idleRoute = try routed.setSpeaker(true)
assert(idleRoute == .inactive && overrides.isEmpty, "No route change outside a Live call")
try routed.setLive(true)
assert(routed.route == .earpiece, "A call starts on the earpiece")
let onSpeaker = try routed.setSpeaker(true)
assert(onSpeaker == .speaker && routed.route == .speaker)
let offSpeaker = try routed.setSpeaker(false)
assert(offSpeaker == .earpiece)
_ = try routed.setSpeaker(true)
try routed.setLive(false)
assert(overrides == [true, false, true, false] && port == .earpiece, "Ending the call resets the speaker")
assert(routed.route == .inactive)
try routed.setLive(true)
port = .external
let headset = try routed.setSpeaker(true)
assert(headset == .external, "A headset or Bluetooth route is left alone")
assert(overrides.count == 4 && routed.route == .external)
try routed.setLive(false)
assert(overrides.count == 4, "No reset is needed when nothing was overridden")
port = .earpiece
try routed.setLive(true)
_ = try routed.setSpeaker(true)
routed.terminate()
assert(overrides.last == false && routed.route == .inactive, "Termination also resets the speaker")
let late = try routed.setSpeaker(true)
assert(late == .inactive, "No route change after termination")

let refusing = CallAudioLifecycle(setSession: { _ in }, overrideSpeaker: { _ in throw Failure.unavailable })
try refusing.setLive(true)
do { _ = try refusing.setSpeaker(true); assertionFailure("Override failure is reported") } catch {}
try refusing.setLive(false)

print("call audio lifecycle: 9 scenarios passed")
