import Foundation

/// Owns only the Live call's session. Injected driver keeps the lifecycle
/// executable on a host without microphone access or an iPhone.
final class CallAudioLifecycle {
    private let setSession: (Bool) throws -> Void
    private var owned = false
    private var active = false
    private var terminated = false

    init(setSession: @escaping (Bool) throws -> Void) { self.setSession = setSession }

    func setLive(_ live: Bool) throws {
        if terminated && live { return }
        if live && active { return }
        if !live && !owned { return }
        if live {
            // A failed rollback may leave the driver dirty. Release it before
            // taking a fresh snapshot or reporting a successful activation.
            if owned { try setSession(false); owned = false }
            owned = true // A partially failed activation still needs release.
            do { try setSession(true); active = true }
            catch {
                if (try? setSession(false)) != nil { owned = false }
                throw error
            }
        } else {
            active = false
            try setSession(false)
            owned = false // Keep ownership on failure so termination can retry.
        }
    }

    func terminate() {
        terminated = true
        try? setLive(false)
    }
}

#if os(iOS)
import AVFAudio
import UIKit

/// All entry points run on main, including UIApplication's termination notice.
/// WebKit owns the actual WebRTC media; this bridge only configures its host's
/// shared session. No silent audio, background task, timers, or call signalling.
private final class CallAudioSession {
    private let session = AVAudioSession.sharedInstance()
    private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
    private var termination: NSObjectProtocol?
    lazy var lifecycle = CallAudioLifecycle { [unowned self] live in
        if live {
            self.previous = (self.session.category, self.session.mode, self.session.categoryOptions)
            try self.session.setCategory(.playAndRecord, mode: .voiceChat)
            try self.session.setActive(true)
        } else {
            try self.session.setActive(false, options: .notifyOthersOnDeactivation)
            if let previous = self.previous {
                try self.session.setCategory(previous.0, mode: previous.1, options: previous.2)
                self.previous = nil
            }
        }
    }

    init() {
        termination = NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.lifecycle.terminate() }
    }
}

private let callAudio = CallAudioSession()

@_cdecl("bitsov_call_audio_set_live")
public func bitsovCallAudioSetLive(_ live: Bool) -> Bool {
    precondition(Thread.isMainThread)
    do { try callAudio.lifecycle.setLive(live); return true }
    catch { return false }
}

@_cdecl("bitsov_call_audio_terminate")
public func bitsovCallAudioTerminate() {
    precondition(Thread.isMainThread)
    callAudio.lifecycle.terminate()
}
#endif
