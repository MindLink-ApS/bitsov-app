import Foundation

/// Where a Live call's audio plays. Raw values cross the C bridge.
enum CallAudioOutput: Int32 {
    case inactive = 0   // no Live call: routes are never changed
    case earpiece = 1   // the default for a call
    case speaker = 2
    case external = 3   // a headset, Bluetooth or car route: never overridden
}

/// Owns only the Live call's session. Injected driver keeps the lifecycle
/// executable on a host without microphone access or an iPhone.
final class CallAudioLifecycle {
    private let setSession: (Bool) throws -> Void
    private let overrideSpeaker: (Bool) throws -> Void
    private let output: () -> CallAudioOutput
    private var owned = false
    private var active = false
    private var terminated = false
    private var speakerOverride = false

    init(setSession: @escaping (Bool) throws -> Void,
         overrideSpeaker: @escaping (Bool) throws -> Void = { _ in },
         output: @escaping () -> CallAudioOutput = { .earpiece }) {
        self.setSession = setSession
        self.overrideSpeaker = overrideSpeaker
        self.output = output
    }

    /// The current output while Live, otherwise `.inactive`.
    var route: CallAudioOutput { active && !terminated ? output() : .inactive }

    /// Speaker on or off for the Live call only. A connected headset, Bluetooth
    /// or car route is left alone. Returns the resulting output.
    func setSpeaker(_ on: Bool) throws -> CallAudioOutput {
        guard active, !terminated else { return .inactive }
        if output() == .external { return .external }
        try overrideSpeaker(on)
        speakerOverride = on
        return output()
    }

    /// The earpiece is the default; any speaker override ends with the call.
    private func resetRoute() {
        guard speakerOverride else { return }
        if (try? overrideSpeaker(false)) != nil { speakerOverride = false }
    }

    func setLive(_ live: Bool) throws {
        if terminated && live { return }
        if live && active { return }
        if !live && !owned { return }
        if live {
            // A failed rollback may leave the driver dirty. Release it before
            // taking a fresh snapshot or reporting a successful activation.
            resetRoute()
            if owned { try setSession(false); owned = false }
            owned = true // A partially failed activation still needs release.
            do { try setSession(true); active = true }
            catch {
                if (try? setSession(false)) != nil { owned = false }
                throw error
            }
        } else {
            active = false
            resetRoute()
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
    lazy var lifecycle = CallAudioLifecycle(setSession: { [unowned self] live in
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
    }, overrideSpeaker: { [unowned self] on in
        try self.session.overrideOutputAudioPort(on ? .speaker : .none)
    }, output: { [unowned self] in
        switch self.session.currentRoute.outputs.first?.portType {
        case .builtInReceiver?: return .earpiece
        case .builtInSpeaker?: return .speaker
        case nil: return .earpiece
        default: return .external
        }
    })

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

/// Returns the resulting `CallAudioOutput` raw value, or -1 if the override failed.
@_cdecl("bitsov_call_audio_set_speaker")
public func bitsovCallAudioSetSpeaker(_ on: Bool) -> Int32 {
    precondition(Thread.isMainThread)
    do { return try callAudio.lifecycle.setSpeaker(on).rawValue }
    catch { return -1 }
}

@_cdecl("bitsov_call_audio_route")
public func bitsovCallAudioRoute() -> Int32 {
    precondition(Thread.isMainThread)
    return callAudio.lifecycle.route.rawValue
}

@_cdecl("bitsov_call_audio_terminate")
public func bitsovCallAudioTerminate() {
    precondition(Thread.isMainThread)
    callAudio.lifecycle.terminate()
}
#endif
