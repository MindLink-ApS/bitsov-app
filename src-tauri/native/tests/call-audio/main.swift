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

print("call audio lifecycle: 7 scenarios passed")
