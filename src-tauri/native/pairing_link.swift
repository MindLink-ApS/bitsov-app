// Tao forwards warm URLs, but drops the initial scene's connection options.
// Install before UIApplicationMain. Preserve every original delegate callback;
// only pairing URLs reach the private Rust take-once inbox, never an event bus.
import UIKit
import ObjectiveC.runtime

typealias PairingReceiver = @convention(c) (UnsafePointer<UInt8>?, Int) -> Void
private var pairingReceiver: PairingReceiver?
private var launchObserver: NSObjectProtocol?
private var installedScenes = Set<ObjectIdentifier>()

private func receivePairingURLs(_ contexts: Set<UIOpenURLContext>) {
    for context in contexts {
        let link = context.url.absoluteString
        guard link.hasPrefix("bitsov://pair/") else { continue }
        let bytes = Array(link.utf8)
        bytes.withUnsafeBufferPointer { pairingReceiver?($0.baseAddress, $0.count) }
    }
}

private func hookScene(_ cls: AnyClass) {
    guard installedScenes.insert(ObjectIdentifier(cls)).inserted else { return }
    let cold = NSSelectorFromString("scene:willConnectToSession:options:")
    if let method = class_getInstanceMethod(cls, cold) {
        typealias Original = @convention(c) (AnyObject, Selector, UIScene, UISceneSession, UIScene.ConnectionOptions) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
        let block: @convention(block) (AnyObject, UIScene, UISceneSession, UIScene.ConnectionOptions) -> Void = { object, scene, session, options in
            // Queue before Tao creates the webview: its first take can see it.
            receivePairingURLs(options.urlContexts)
            original(object, cold, scene, session, options)
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }
    let warm = NSSelectorFromString("scene:openURLContexts:")
    if let method = class_getInstanceMethod(cls, warm) {
        typealias Original = @convention(c) (AnyObject, Selector, UIScene, NSSet) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
        let block: @convention(block) (AnyObject, UIScene, NSSet) -> Void = { object, scene, contexts in
            if let urls = contexts as? Set<UIOpenURLContext> { receivePairingURLs(urls) }
            // Rust receipts deduplicate Tao's later RunEvent::Opened delivery.
            original(object, warm, scene, contexts)
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }
}

private func hookApplicationDelegate() {
    guard let delegate = UIApplication.shared.delegate else { return }
    let selector = NSSelectorFromString("application:configurationForConnectingSceneSession:options:")
    guard let method = class_getInstanceMethod(type(of: delegate), selector) else { return }
    typealias Original = @convention(c) (AnyObject, Selector, UIApplication, UISceneSession, UIScene.ConnectionOptions) -> UISceneConfiguration
    let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
    let block: @convention(block) (AnyObject, UIApplication, UISceneSession, UIScene.ConnectionOptions) -> UISceneConfiguration = { object, app, session, options in
        let config = original(object, selector, app, session, options)
        // Tao registers its scene class lazily in this callback. Hook that
        // actual class before UIKit instantiates it, without hard-coding names.
        if let cls = config.delegateClass { hookScene(cls) }
        return config
    }
    method_setImplementation(method, imp_implementationWithBlock(block))
}

@_cdecl("bitsov_pairing_link_install")
func bitsovPairingLinkInstall(_ receiver: @escaping PairingReceiver) {
    guard launchObserver == nil else { return }
    pairingReceiver = receiver
    launchObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didFinishLaunchingNotification, object: nil, queue: nil
    ) { _ in hookApplicationDelegate() }
}
