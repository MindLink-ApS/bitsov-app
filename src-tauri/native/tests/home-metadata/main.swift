// Headless policy tests: injected Security calls, no Keychain access or UI.
import Foundation
import Security
import LocalAuthentication

let service = "bitsov.node." + String(repeating: "ab", count: 32) + ".box-transport"
var database: Data?
var calls = 0
func policy(_ query: CFDictionary) {
    let q = query as! [CFString: Any]
    precondition(q[kSecAttrService] as? String == service)
    precondition(q[kSecAttrAccount] as? String == "BitSov")
    precondition(q[kSecAttrSynchronizable] as? Bool == false)
    precondition(q[kSecUseDataProtectionKeychain] as? Bool == true)
    precondition((q[kSecUseAuthenticationContext] as? LAContext)?.interactionNotAllowed == true)
    calls += 1
}
var store = HomeMetadata(copy: { query, output in
    policy(query)
    guard let value = database else { return errSecItemNotFound }
    output?.pointee = value as CFData
    return errSecSuccess
}, add: { query, _ in
    policy(query)
    let q = query as! [CFString: Any]
    precondition(q[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    if database != nil { return errSecDuplicateItem }
    database = q[kSecValueData] as? Data
    return errSecSuccess
}, update: { query, changes in
    policy(query)
    let c = changes as! [CFString: Any]
    precondition(c[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    database = c[kSecValueData] as? Data
    return errSecSuccess
})
var output = Data()
precondition(store.read(service, &output) == errSecItemNotFound)
precondition(store.store(service, Data([1, 2])) == errSecSuccess)
precondition(store.store(service, Data([3, 4])) == errSecSuccess)
precondition(store.read(service, &output) == errSecSuccess && output == Data([3, 4]))
let priorCalls = calls
for invalid in ["", service + "extra", "bitsov.node." + String(repeating: "AB", count: 32) + ".box-transport", service.replacingOccurrences(of: "box-transport", with: "seed-password")] {
    precondition(store.store(invalid, Data([1])) == errSecParam)
    precondition(store.read(invalid, &output) == errSecParam)
}
precondition(store.store(service, Data()) == errSecParam)
precondition(store.store(service, Data(repeating: 0, count: 16385)) == errSecParam)
precondition(calls == priorCalls)
var raw = [UInt8](repeating: 0, count: 16)
var length = 0
precondition(service.withCString { bitsov_home_store($0, &raw, raw.count, 1) } == errSecParam)
precondition(service.withCString { bitsov_home_store($0, &raw, 16385, 0) } == errSecParam)
precondition(service.withCString { bitsov_home_read($0, &raw, 16385, &length) } == errSecParam)
for size in [0, 16385] {
    database = Data(repeating: 0, count: size)
    precondition(store.read(service, &output) == errSecDecode)
}
precondition(HomeMetadata.valid("tech.mindlink.bitsov.remotetest." + service))
precondition(HomeMetadata.valid(service.replacingOccurrences(of: "box-transport", with: "unlock-binding")))
for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecMissingEntitlement] {
    store.copy = { _, _ in status }
    store.add = { _, _ in status }
    precondition(store.read(service, &output) == status)
    precondition(store.store(service, Data([1])) == status)
}
print("PASS: iOS public metadata storage, scope, update, and refusal policy")
