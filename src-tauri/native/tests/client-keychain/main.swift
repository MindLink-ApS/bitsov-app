// Headless behavioral tests. No real Keychain access and no authentication UI.
import Foundation
import Security
import LocalAuthentication

func checkPolicy(_ query: CFDictionary, reading: Bool) {
    let q = query as! [CFString: Any]
    precondition(q[kSecClass] as? String == kSecClassGenericPassword as String)
    precondition(q[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    precondition(q[kSecAttrSynchronizable] as? Bool == false)
    precondition(q[kSecUseDataProtectionKeychain] as? Bool == true)
    precondition(q[kSecAttrAccount] as? String == "profile/app-client")
    if reading {
        precondition((q[kSecUseAuthenticationContext] as? LAContext)?.interactionNotAllowed == true)
        precondition(q[kSecReturnData] as? Bool == true)
    }
}
var database: Data?
var store = ClientKeychain(copy: { query, output in
    checkPolicy(query, reading: true)
    guard let value = database else { return errSecItemNotFound }
    output?.pointee = value as CFData
    return errSecSuccess
}, add: { query, _ in
    checkPolicy(query, reading: false)
    if database != nil { return errSecDuplicateItem }
    let q = query as! [CFString: Any]
    database = q[kSecValueData] as? Data
    return errSecSuccess
})
var fixture = [UInt8](repeating: 0x37, count: 32)
var output = [UInt8](repeating: 0, count: 32)
precondition(store.read("profile/app-client", &output) == errSecItemNotFound)
precondition(store.insert("profile/app-client", &fixture) == errSecSuccess)
precondition(store.insert("profile/app-client", &fixture) == errSecDuplicateItem)
precondition(store.read("profile/app-client", &output) == errSecSuccess)
precondition(output == fixture)
// Malformed stored data and locked/denied errors cannot be treated as absence.
database = Data(repeating: 1, count: 31)
precondition(store.read("profile/app-client", &output) == errSecDecode)
for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecMissingEntitlement] {
    store.copy = { _, _ in status }
    precondition(store.read("profile/app-client", &output) == status)
}
// The iPhone policy is compiled on the host for this probe. Rejection precedes
// hardware access, so no key or prompt is created by the test.
var blob = [UInt8](repeating: 0, count: 4096)
var length = 0
var publicKey = [UInt8](repeating: 0, count: 65)
precondition(bitsov_dk_create(0, &blob, blob.count, &length, &publicKey) == -5)
precondition(length == 0)
print("PASS: client Keychain policy, creation, lookup, duplicate and error handling; iOS rejects prompt-free device keys")

let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: temporary) }
precondition(temporary.path.withCString { bitsov_exclude_app_backup($0) } == errSecSuccess)
let resources = try temporary.resourceValues(forKeys: [.isExcludedFromBackupKey])
precondition(resources.isExcludedFromBackup == true)
print("PASS: app storage is excluded from backups before any credentials are written")
