// Headless behavioral tests. No real Keychain access and no authentication UI.
import Foundation
import Security
import LocalAuthentication

func checkPolicy(_ query: CFDictionary, reading: Bool) {
    let q = query as! [CFString: Any]
    precondition(q[kSecClass] as? String == kSecClassGenericPassword as String)
    if !reading {
        precondition(q[kSecAttrAccessible] == nil)
        precondition(q[kSecAttrAccessControl] != nil)
    }
    precondition(q[kSecAttrSynchronizable] as? Bool == false)
    precondition(q[kSecUseDataProtectionKeychain] as? Bool == true)
    precondition(q[kSecAttrAccount] as? String == "profile/app-client")
    if reading {
        precondition((q[kSecUseAuthenticationContext] as? LAContext)?.interactionNotAllowed == false)
        precondition(q[kSecReturnData] as? Bool == true)
    }
}
// Losing userPresence here would permit an unlocked-session read.
precondition(clientAccessControlFlags() == [.userPresence])
var accessError: Unmanaged<CFError>?
precondition(makeClientAccessControl(&accessError) != nil)
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
}, delete: { _ in errSecItemNotFound })
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
print("PASS: client Keychain policy, creation, lookup, duplicate and error handling; Apple platforms reject prompt-free device keys")

let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: temporary) }
precondition(temporary.path.withCString { bitsov_exclude_app_backup($0) } == errSecSuccess)
var refreshed = temporary
refreshed.removeAllCachedResourceValues()
let resources = try refreshed.resourceValues(forKeys: [.isExcludedFromBackupKey])
#if os(iOS)
precondition(resources.isExcludedFromBackup == true)
#endif
#if os(iOS)
print("PASS: app storage is excluded from backups before any credentials are written")
#else
print("PASS: backup exclusion API; resource flag verification requires iOS")
#endif

// Deletion must be an exact, prompt-free query with no request for key data.
database = Data(fixture)
store.copy = { _, _ in fatalError("cleanup must not read key material") }
store.delete = { query in
    let q = query as! [CFString: Any]
    precondition(q[kSecClass] as? String == kSecClassGenericPassword as String)
    precondition(["tech.mindlink.bitsov.client-ed25519.v1", "tech.mindlink.bitsov.client-ed25519.v2"].contains(q[kSecAttrService] as! String))
    precondition(q[kSecAttrAccount] as? String == "profile/app-client")
    precondition(q[kSecAttrSynchronizable] as? Bool == false)
    precondition(q[kSecUseDataProtectionKeychain] as? Bool == true)
    precondition(q[kSecUseAuthenticationUI] as? String == kSecUseAuthenticationUIFail as String)
    precondition(q[kSecReturnData] == nil && q[kSecValueData] == nil)
    // Accessibility is not part of item identity: also remove an old item
    // whose accessibility policy differs, without broadening service/account.
    precondition(q[kSecAttrAccessible] == nil)
    guard database != nil else { return errSecItemNotFound }
    database = nil
    return errSecSuccess
}
precondition(store.remove("profile/app-client") == errSecSuccess)
precondition(database == nil)
precondition(store.remove("profile/app-client") == errSecSuccess)
for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecMissingEntitlement] {
    store.delete = { _ in status }
    precondition(store.remove("profile/app-client") == status)
}
print("PASS: exact prompt-free deletion, repeat cleanup, and refusal propagation")

// Migration exercises the real store with only Security calls replaced.
for failure in [errSecSuccess, errSecUserCanceled, errSecAuthFailed,
                errSecMissingEntitlement, errSecInteractionNotAllowed] {
    var events: [String] = []
    var protected: Data?
    var legacy: Data? = Data(fixture)
    let migrating = ClientKeychain(copy: { query, result in
        let q = query as! [CFString: Any]
        let old = q[kSecAttrService] as? String == "tech.mindlink.bitsov.client-ed25519.v1"
        events.append(old ? "read-old" : "read-new")
        guard let data = old ? legacy : protected else { return errSecItemNotFound }
        if !old && failure != errSecSuccess { return failure }
        result?.pointee = data as CFData
        return errSecSuccess
    }, add: { query, _ in
        events.append("add-new")
        checkPolicy(query, reading: false)
        protected = (query as! [CFString: Any])[kSecValueData] as? Data
        return errSecSuccess
    }, delete: { query in
        precondition((query as! [CFString: Any])[kSecAttrService] as? String == "tech.mindlink.bitsov.client-ed25519.v1")
        events.append("delete-old")
        legacy = nil
        return errSecSuccess
    })
    output = [UInt8](repeating: 0, count: 32)
    precondition(migrating.read("profile/app-client", &output) == failure)
    if failure == errSecSuccess {
        precondition(output == fixture && legacy == nil)
        precondition(events == ["read-new", "read-old", "add-new", "read-new", "delete-old"])
        events = []
        precondition(migrating.read("profile/app-client", &output) == errSecSuccess)
        precondition(!events.contains("add-new") && legacy == nil)
    } else {
        precondition(output == [UInt8](repeating: 0, count: 32) && legacy != nil)
        precondition(!events.contains("delete-old"))
        events = []
        precondition(migrating.read("profile/app-client", &output) == failure)
        precondition(events == ["read-new"], "denial must not read legacy")
    }
}
for failingOperation in ["read-old", "add-new", "delete-old"] {
    var events: [String] = []
    let migrating = ClientKeychain(copy: { query, result in
        let old = (query as! [CFString: Any])[kSecAttrService] as? String == "tech.mindlink.bitsov.client-ed25519.v1"
        let event = old ? "read-old" : "read-new"
        events.append(event)
        if failingOperation == event { return errSecUserCanceled }
        if !old && events.count == 1 { return errSecItemNotFound }
        result?.pointee = Data(fixture) as CFData
        return errSecSuccess
    }, add: { _, _ in
        events.append("add-new")
        return failingOperation == "add-new" ? errSecMissingEntitlement : errSecSuccess
    }, delete: { _ in events.append("delete-old"); return errSecAuthFailed })
    output = [UInt8](repeating: 0, count: 32)
    precondition(migrating.read("profile/app-client", &output) != errSecSuccess)
    precondition(output == [UInt8](repeating: 0, count: 32))
    if failingOperation != "delete-old" { precondition(!events.contains("delete-old")) }
}
print("PASS: protected migration, readback, cleanup, cancellation and failure isolation")

var retiredServices: [String] = []
let retiring = ClientKeychain(delete: { query in
    retiredServices.append((query as! [CFString: Any])[kSecAttrService] as! String)
    return errSecSuccess
})
var retiringBlob = retiring
retiringBlob.service = "tech.mindlink.bitsov.device-key.v1"
retiringBlob.legacyService = nil
precondition(removeClientProfile("profile/app-client", seed: retiring, blob: retiringBlob) == errSecSuccess)
precondition(retiredServices == ["tech.mindlink.bitsov.device-key.v1", "tech.mindlink.bitsov.client-ed25519.v2", "tech.mindlink.bitsov.client-ed25519.v1"])
print("PASS: fresh-install cleanup retires both seed versions and device key material")

// A failed verification may be retried after process death. Never discard the
// original if the newly published bytes differ, including on that retry.
var incorrectProtected: Data?
var mismatchDeletes = 0
let mismatched = ClientKeychain(copy: { query, result in
    let old = (query as! [CFString: Any])[kSecAttrService] as? String == "tech.mindlink.bitsov.client-ed25519.v1"
    guard let data = old ? Data(fixture) : incorrectProtected else { return errSecItemNotFound }
    result?.pointee = data as CFData
    return errSecSuccess
}, add: { _, _ in incorrectProtected = Data(repeating: 9, count: 32); return errSecSuccess },
   delete: { _ in mismatchDeletes += 1; return errSecSuccess })
for _ in 0..<2 {
    output = [UInt8](repeating: 0, count: 32)
    precondition(mismatched.read("profile/app-client", &output) == errSecDecode)
    precondition(output == [UInt8](repeating: 0, count: 32) && mismatchDeletes == 0)
}
print("PASS: mismatched migration readback stays closed across retries")

// Entitlement selection is decided before any protected Keychain operation.
precondition(!clientHasDataProtectionEntitlement { _ in nil })
precondition(!clientHasDataProtectionEntitlement { name in
    name == "keychain-access-groups" ? ["EXAMPLE123.org.example.app"] : nil
})
precondition(clientHasDataProtectionEntitlement { name in
    name == "com.apple.application-identifier" ? "EXAMPLE123.org.example.app" : nil
})

let signingContext = LAContext()
let signingStore = ClientKeychain(copy: { query, result in
    let q = query as! [CFString: Any]
    precondition(q[kSecUseAuthenticationContext] as? LAContext === signingContext)
    result?.pointee = Data(fixture) as CFData
    return errSecSuccess
}, legacyService: nil)
let (readStatus, readBytes) = signingStore.readData("profile/app-client", context: signingContext)
precondition(readStatus == errSecSuccess && readBytes == Data(fixture))
for failure in [errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed] {
    var denied = signingStore
    denied.copy = { _, _ in failure }
    let (status, bytes) = denied.readData("profile/app-client", context: signingContext)
    precondition(status == failure && bytes == nil)
}
print("PASS: entitlement selection and shared authentication context for protected reads")

let publicMetadata = Data(repeating: 4, count: 65)
let metadataStore = ClientKeychain(copy: { query, output in
    let q = query as! [CFString: Any]
    precondition(q[kSecReturnData] == nil && q[kSecValueData] == nil)
    precondition(q[kSecReturnAttributes] as? Bool == true)
    precondition((q[kSecUseAuthenticationContext] as? LAContext)?.interactionNotAllowed == true)
    output?.pointee = [kSecAttrGeneric: publicMetadata] as CFDictionary
    return errSecSuccess
})
for _ in 0..<20 {
    let (status, publicKey) = metadataStore.metadata("profile/app-client")
    precondition(status == errSecSuccess && publicKey == publicMetadata)
}
print("PASS: repeated metadata lookups request attributes only and forbid authentication UI")
