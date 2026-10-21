// Secure Enclave device key bridge for the BitSov Apple apps.
//
// ffi/build.rs compiles this file into a static library (module BitsovDeviceKey)
// and links it into the app binary. Safe Rust wrappers live in ffi/src; the ABI
// is plain C: pointers + lengths in, status code out.
//
// The key is a CryptoKit Secure Enclave P-256 signing key. Its private half
// never leaves the enclave. `dataRepresentation` is an opaque blob that is only
// usable on this device (the enclave wraps it). No keychain item is created.
//
// Status codes (keep in sync with src/device_key.rs):
//    0  ok
//   -1  Secure Enclave unavailable
//   -2  cancelled or authentication failed (user dismissed Touch ID, lockout, …)
//   -3  invalid key blob (not a key for this device's enclave)
//   -4  output buffer too small
//   -5  bad argument (null pointer, unknown policy, bad UTF-8)
//   -6  other failure (access control creation, key creation, signing)
//   -7  biometry unavailable (no Touch ID, none enrolled, or locked out)

import CryptoKit
import Foundation
import LocalAuthentication
import Security

private let okStatus: Int32 = 0
private let errUnavailable: Int32 = -1
private let errCancelled: Int32 = -2
private let errInvalidBlob: Int32 = -3
private let errBufferTooSmall: Int32 = -4
private let errBadArgument: Int32 = -5
private let errOther: Int32 = -6
private let errBiometryUnavailable: Int32 = -7

// CryptoTokenKit TKError codes surfaced by enclave operations.
private let tkErrorDomain = "CryptoTokenKit"
private let tkCanceledByUser = -4
private let tkAuthenticationFailed = -5
private let tkAuthenticationNeeded = -9

/// 1 when this Mac has a Secure Enclave CryptoKit can use, else 0.
@_cdecl("bitsov_dk_available")
public func bitsov_dk_available() -> Int32 {
    return autoreleasepool { SecureEnclave.isAvailable ? 1 : 0 }
}

/// 0 when Touch ID can approve a signature now (hardware present, a finger
/// enrolled, not locked out), else -7. Never prompts.
@_cdecl("bitsov_dk_biometry")
public func bitsov_dk_biometry() -> Int32 {
    return autoreleasepool {
        var error: NSError?
        let ok = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        return ok ? okStatus : errBiometryUnavailable
    }
}

/// Create a new enclave key.
///
/// policy 1: `.privateKeyUsage` + `.biometryCurrentSet` (Touch ID on every
///           signature; the key dies if the enrolled fingers change).
/// policy 0: `.privateKeyUsage` only. Signs without a prompt. Tests only.
///
/// Writes the device-bound blob to `out_blob` (length in `out_blob_len`) and the
/// 65-byte X9.63 uncompressed public key to `out_pub`. Creation never prompts.
@_cdecl("bitsov_dk_create")
public func bitsov_dk_create(
    _ policy: Int32,
    _ outBlob: UnsafeMutablePointer<UInt8>?,
    _ blobCap: Int,
    _ outBlobLen: UnsafeMutablePointer<Int>?,
    _ outPub: UnsafeMutablePointer<UInt8>?
) -> Int32 {
    return autoreleasepool { createKey(policy, outBlob, blobCap, outBlobLen, outPub) }
}

private func createKey(
    _ policy: Int32,
    _ outBlob: UnsafeMutablePointer<UInt8>?,
    _ blobCap: Int,
    _ outBlobLen: UnsafeMutablePointer<Int>?,
    _ outPub: UnsafeMutablePointer<UInt8>?
) -> Int32 {
    guard let outBlob = outBlob, let outBlobLen = outBlobLen, let outPub = outPub, blobCap >= 0 else {
        return errBadArgument
    }
    outBlobLen.pointee = 0
    let flags: SecAccessControlCreateFlags
    switch policy {
    case 1: flags = [.privateKeyUsage, .biometryCurrentSet]
    #if os(iOS) || BITSOV_IOS_TEST_POLICY
    case 0: return errBadArgument
    #else
    case 0: flags = [.privateKeyUsage]
    #endif
    default: return errBadArgument
    }

    guard SecureEnclave.isAvailable else { return errUnavailable }
    var cfError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &cfError
    ) else {
        cfError?.release()
        return errOther
    }

    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
        key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    } catch {
        return errOther
    }

    let blob = key.dataRepresentation
    let pub = key.publicKey.x963Representation
    guard pub.count == 65 else { return errOther }
    guard blob.count <= blobCap else { return errBufferTooSmall }

    blob.copyBytes(to: outBlob, count: blob.count)
    pub.copyBytes(to: outPub, count: 65)
    outBlobLen.pointee = blob.count
    return okStatus
}

/// Write the 65-byte public key of the key in `blob` to `out_pub`. Loading a
/// key never prompts; only signing does. -3 when the blob is not a key for
/// this device's enclave.
@_cdecl("bitsov_dk_public")
public func bitsov_dk_public(
    _ blob: UnsafePointer<UInt8>?,
    _ blobLen: Int,
    _ outPub: UnsafeMutablePointer<UInt8>?
) -> Int32 {
    return autoreleasepool {
        guard let blob = blob, let outPub = outPub, blobLen > 0 else { return errBadArgument }
        guard SecureEnclave.isAvailable else { return errUnavailable }
        guard let key = try? SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: Data(bytes: blob, count: blobLen)
        ) else { return errInvalidBlob }
        let pub = key.publicKey.x963Representation
        guard pub.count == 65 else { return errOther }
        pub.copyBytes(to: outPub, count: 65)
        return okStatus
    }
}

/// Sign `msg` (SHA-256 is applied inside CryptoKit) with the key in `blob`.
///
/// Blocking. For a biometry key this shows the system Touch ID sheet with
/// `reason` as its text and returns once the user answers. Writes the DER
/// ECDSA signature to `out_sig` (length in `out_sig_len`).
@_cdecl("bitsov_dk_sign")
public func bitsov_dk_sign(
    _ blob: UnsafePointer<UInt8>?,
    _ blobLen: Int,
    _ msg: UnsafePointer<UInt8>?,
    _ msgLen: Int,
    _ reason: UnsafePointer<CChar>?,
    _ outSig: UnsafeMutablePointer<UInt8>?,
    _ sigCap: Int,
    _ outSigLen: UnsafeMutablePointer<Int>?
) -> Int32 {
    return autoreleasepool { signMessage(blob, blobLen, msg, msgLen, reason, outSig, sigCap, outSigLen) }
}

private func signMessage(
    _ blob: UnsafePointer<UInt8>?,
    _ blobLen: Int,
    _ msg: UnsafePointer<UInt8>?,
    _ msgLen: Int,
    _ reason: UnsafePointer<CChar>?,
    _ outSig: UnsafeMutablePointer<UInt8>?,
    _ sigCap: Int,
    _ outSigLen: UnsafeMutablePointer<Int>?,
    _ context: LAContext = LAContext()
) -> Int32 {
    guard let blob = blob, let reason = reason, let outSig = outSig, let outSigLen = outSigLen,
          blobLen > 0, msgLen >= 0, sigCap >= 0 else {
        return errBadArgument
    }
    // An empty message may come with a null pointer.
    if msgLen > 0 && msg == nil { return errBadArgument }
    outSigLen.pointee = 0
    guard SecureEnclave.isAvailable else { return errUnavailable }

    guard let reasonText = String(validatingUTF8: reason), !reasonText.isEmpty else {
        return errBadArgument
    }
    let blobData = Data(bytes: blob, count: blobLen)
    let msgData = msgLen > 0 ? Data(bytes: msg!, count: msgLen) : Data()

    context.localizedReason = reasonText

    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
        key = try SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: blobData, authenticationContext: context
        )
    } catch {
        return errInvalidBlob
    }

    let signature: P256.Signing.ECDSASignature
    do {
        signature = try key.signature(for: msgData)
    } catch {
        return statusForSigningError(error)
    }

    let der = signature.derRepresentation
    guard der.count <= sigCap else { return errBufferTooSmall }
    der.copyBytes(to: outSig, count: der.count)
    outSigLen.pointee = der.count
    return okStatus
}

private func statusForSigningError(_ error: Error) -> Int32 {
    let ns = error as NSError
    if ns.domain == LAErrorDomain || error is LAError {
        // No Touch ID to ask is not the owner saying no: point to the fallback.
        switch ns.code {
        case LAError.biometryNotAvailable.rawValue,
             LAError.biometryNotEnrolled.rawValue,
             LAError.biometryLockout.rawValue:
            return errBiometryUnavailable
        default:
            return errCancelled
        }
    }
    if ns.domain == tkErrorDomain,
       [tkCanceledByUser, tkAuthenticationFailed, tkAuthenticationNeeded].contains(ns.code) {
        return errCancelled
    }
    return errOther
}

#if os(macOS)
// Shared storage policy for home records and the bootstrap launcher password.
// An authentication refusal must never select a weaker store.
private func missingEntitlement(_ status: OSStatus) -> Bool {
    status == errSecMissingEntitlement // -34018, and no other write error
}

private func writeWithFallback(_ operation: (Bool) -> OSStatus) -> OSStatus {
    let status = operation(true)
    return missingEntitlement(status) ? operation(false) : status
}

private func readWithFallback(_ operation: (Bool) -> OSStatus) -> OSStatus {
    let status = operation(true)
    return status == errSecItemNotFound || missingEntitlement(status) ? operation(false) : status
}

private func itemQuery(_ service: String, _ account: String, _ dataProtection: Bool,
                       _ adding: Bool, _ operation: ([CFString: Any]) -> OSStatus) -> OSStatus {
    var query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
        kSecAttrService: service, kSecAttrAccount: account,
        kSecUseDataProtectionKeychain: dataProtection]
    if dataProtection {
        if adding { query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
    } else {
        // Legacy has no ThisDeviceOnly accessibility class. Explicitly target
        // the local login keychain (unlocked-keychain protection and app ACL),
        // never a synchronizable item or an arbitrary search-list keychain.
        var keychain: SecKeychain?
        let path = NSHomeDirectory() + "/Library/Keychains/login.keychain-db"
        let status = SecKeychainOpen(path, &keychain)
        guard status == errSecSuccess, let keychain = keychain else { return status }
        if adding { query[kSecUseKeychain] = keychain }
        else { query[kSecMatchSearchList] = [keychain] }
    }
    return operation(query)
}

private func storeItem(_ service: String, _ account: String, _ data: Data,
                       replace: Bool = true) -> OSStatus {
    writeWithFallback { dp in
        let status = itemQuery(service, account, dp, true) { base in
            var query = base
            query[kSecValueData] = data
            return SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecDuplicateItem, replace else { return status }
        return itemQuery(service, account, dp, false) { query in
            SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        }
    }
}

private func readItem(_ service: String, _ account: String, _ dp: Bool,
                      _ data: inout Data) -> OSStatus {
    itemQuery(service, account, dp, false) { base in
        var query = base
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        if dp {
            let context = LAContext()
            context.localizedReason = "Unlock your BitSov home node"
            query[kSecUseAuthenticationContext] = context
        }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return status }
        guard let bytes = result as? Data, bytes.count <= 16384 else { return errBufferTooSmall }
        data = bytes
        return errSecSuccess
    }
}

private func deleteItems(_ service: String, _ account: String) -> OSStatus {
    // Retirement removes both exact copies. A DP refusal other than missing
    // entitlement/not-found stops the operation before touching legacy.
    for dp in [true, false] {
        let status = itemQuery(service, account, dp, false) { query in
            SecItemDelete(query as CFDictionary)
        }
        if status == errSecSuccess || status == errSecItemNotFound { continue }
        if dp && missingEntitlement(status) { continue }
        return status
    }
    return errSecSuccess
}

#endif

private let passwordPurpose = Data("bitsov.home-seed-password.wrap.v1".utf8)
private struct WrappedPassword: Codable {
    let version: Int
    let enclaveKey: Data
    let ephemeralPublicKey: Data
    let ciphertext: Data // AES-GCM combined nonce, ciphertext, tag
}

// Pairing must be readable at startup without UI, but must not survive moving
// the app directory (or a login Keychain backup) to a different Secure Enclave.
// Only the enclave-wrapped private key representation is stored in the envelope.
private let pairingPurpose = Data("bitsov.pairing.at-rest.wrap.v1".utf8)

@_cdecl("bitsov_pairing_crypt")
public func bitsov_pairing_crypt(_ sealing: Int32, _ purpose: UnsafePointer<CChar>?,
    _ input: UnsafePointer<UInt8>?, _ count: Int, _ output: UnsafeMutablePointer<UInt8>?,
    _ capacity: Int, _ length: UnsafeMutablePointer<Int>?) -> Int32 {
    guard sealing == 0 || sealing == 1, let purpose = purpose, let input = input,
          let output = output, let length = length, capacity >= 0,
          count > 0, count <= (sealing == 1 ? 4096 : 16384) else { return errBadArgument }
    length.pointee = 0
    return autoreleasepool {
        guard SecureEnclave.isAvailable else { return errUnavailable }
        let name = String(cString: purpose)
        guard !name.isEmpty, name.utf8.count <= 256 else { return errBadArgument }
        let aad = Data(name.utf8)
        let context = LAContext()
        context.interactionNotAllowed = true
        defer { context.invalidate() }
        do {
            if sealing == 1 {
                var error: Unmanaged<CFError>?
                guard let access = SecAccessControlCreateWithFlags(nil,
                    kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], &error) else {
                    error?.release()
                    return errOther
                }
                let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                    accessControl: access, authenticationContext: context)
                let ephemeral = P256.KeyAgreement.PrivateKey()
                let shared = try ephemeral.sharedSecretFromKeyAgreement(with: key.publicKey)
                let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                    salt: aad, sharedInfo: pairingPurpose, outputByteCount: 32)
                var plaintext = Data(bytes: input, count: count)
                defer { plaintext.resetBytes(in: 0..<plaintext.count) }
                let sealed = try AES.GCM.seal(plaintext, using: symmetric, authenticating: aad)
                guard let ciphertext = sealed.combined else { return errOther }
                let envelope = try JSONEncoder().encode(WrappedPassword(version: 1,
                    enclaveKey: key.dataRepresentation,
                    ephemeralPublicKey: ephemeral.publicKey.x963Representation, ciphertext: ciphertext))
                return copyOutput(envelope, output, capacity, length)
            }
            let wrapped = try JSONDecoder().decode(WrappedPassword.self, from: Data(bytes: input, count: count))
            guard wrapped.version == 1, wrapped.ephemeralPublicKey.count == 65,
                  !wrapped.enclaveKey.isEmpty, wrapped.enclaveKey.count <= 8192,
                  (29...4124).contains(wrapped.ciphertext.count) else { return errInvalidBlob }
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                dataRepresentation: wrapped.enclaveKey, authenticationContext: context)
            let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: wrapped.ephemeralPublicKey)
            let shared = try key.sharedSecretFromKeyAgreement(with: ephemeral)
            let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                salt: aad, sharedInfo: pairingPurpose, outputByteCount: 32)
            var plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: wrapped.ciphertext),
                using: symmetric, authenticating: aad)
            defer { plaintext.resetBytes(in: 0..<plaintext.count) }
            return copyOutput(plaintext, output, capacity, length)
        } catch {
            return statusForPairingError(error, sealing: sealing == 1)
        }
    }
}

private func statusForPairingError(_ error: Error, sealing: Bool) -> Int32 {
    guard !sealing else { return errOther }
    // Only malformed envelopes and cryptographic authentication/decryption
    // failures justify destructive recovery. Keychain/LA authentication errors
    // can mean a locked or temporarily unavailable key, not a foreign blob.
    if error is DecodingError { return errInvalidBlob }
    if let crypto = error as? CryptoKitError {
        switch crypto {
        case .authenticationFailure, .incorrectParameterSize:
            return errInvalidBlob
        default:
            return errOther
        }
    }
    let ns = error as NSError
    if ns.domain == NSOSStatusErrorDomain && ns.code == Int(errSecDecode) {
        return errInvalidBlob
    }
    return errOther
}

#if os(macOS)
private func passwordNode(_ service: String) -> String? {
    // Strip only for node validation/AAD. Every Keychain query keeps the full
    // service, including wrapped-envelope and old biometric-item fallbacks.
    let profile = "tech.mindlink.bitsov.remotetest."
    let service = service.hasPrefix(profile) ? String(service.dropFirst(profile.count)) : service
    let prefix = "bitsov.node."
    let suffix = ".seed-password"
    guard service.hasPrefix(prefix), service.hasSuffix(suffix) else { return nil }
    let node = String(service.dropFirst(prefix.count).dropLast(suffix.count))
    guard node.utf8.count == 64,
          node.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
    return node
}

private func wrappedService(_ service: String) -> String { service + ".wrapped-v1" }

private func passwordAgreementKey() throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet], &error) else {
        error?.release()
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(errOther))
    }
    return try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
}

// Encryption uses the enclave PUBLIC key, so Remember needs no biometric
// prompt. The only decrypt path performs ECDH with its biometric PRIVATE key.
private func wrapPassword(_ plaintext: Data, node: String,
                          key: SecureEnclave.P256.KeyAgreement.PrivateKey) throws -> Data {
    let ephemeral = P256.KeyAgreement.PrivateKey()
    let shared = try ephemeral.sharedSecretFromKeyAgreement(with: key.publicKey)
    let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
        salt: Data(node.utf8), sharedInfo: passwordPurpose, outputByteCount: 32)
    let sealed = try AES.GCM.seal(plaintext, using: symmetric, authenticating: Data(node.utf8))
    guard let ciphertext = sealed.combined else { throw CryptoKitError.incorrectParameterSize }
    return try JSONEncoder().encode(WrappedPassword(version: 1,
        enclaveKey: key.dataRepresentation,
        ephemeralPublicKey: ephemeral.publicKey.x963Representation, ciphertext: ciphertext))
}

private func unwrapPassword(_ envelope: Data, node: String) throws -> Data {
    let wrapped = try JSONDecoder().decode(WrappedPassword.self, from: envelope)
    guard wrapped.version == 1, wrapped.ephemeralPublicKey.count == 65,
          !wrapped.enclaveKey.isEmpty, wrapped.enclaveKey.count <= 8192,
          (29...4124).contains(wrapped.ciphertext.count) else {
        throw CryptoKitError.incorrectParameterSize
    }
    let context = LAContext()
    context.localizedReason = "Unlock your BitSov home node"
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
        dataRepresentation: wrapped.enclaveKey, authenticationContext: context)
    let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: wrapped.ephemeralPublicKey)
    let shared = try key.sharedSecretFromKeyAgreement(with: ephemeral)
    let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
        salt: Data(node.utf8), sharedInfo: passwordPurpose, outputByteCount: 32)
    return try AES.GCM.open(AES.GCM.SealedBox(combined: wrapped.ciphertext),
        using: symmetric, authenticating: Data(node.utf8))
}

@_cdecl("bitsov_home_store")
public func bitsov_home_store(_ service: UnsafePointer<CChar>?, _ bytes: UnsafePointer<UInt8>?,
                              _ count: Int, _ secret: Int32) -> Int32 {
    guard let service = service, let bytes = bytes, count > 0, count <= 16384,
          secret == 0 || secret == 1 else { return errBadArgument }
    return autoreleasepool {
        let name = String(cString: service)
        var plaintext = Data(bytes: bytes, count: count)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        if secret == 1 {
            guard let node = passwordNode(name), count <= 4096 else { return errBadArgument }
            do {
                let envelope = try wrapPassword(plaintext, node: node, key: passwordAgreementKey())
                let destination = wrappedService(name)
                return storeItem(destination, "BitSov", envelope)
            } catch { return statusForSigningError(error) }
        }
        // The raw password service is never writable without wrapping.
        guard passwordNode(name) == nil else { return errBadArgument }
        return storeItem(name, "BitSov", plaintext)
    }
}

@_cdecl("bitsov_home_read")
public func bitsov_home_read(_ service: UnsafePointer<CChar>?, _ output: UnsafeMutablePointer<UInt8>?,
                             _ capacity: Int, _ length: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let service = service, let output = output, let length = length,
          capacity >= 0 else { return errBadArgument }
    length.pointee = 0
    return autoreleasepool {
        let name = String(cString: service)
        var data = Data()
        defer { data.resetBytes(in: 0..<data.count) }
        if let node = passwordNode(name) {
            let status = readWithFallback { readItem(wrappedService(name), "BitSov", $0, &data) }
            if status == errSecSuccess {
                do {
                    var plaintext = try unwrapPassword(data, node: node)
                    defer { plaintext.resetBytes(in: 0..<plaintext.count) }
                    return copyOutput(plaintext, output, capacity, length)
                } catch {
                    // Invalidation/cancellation/corruption is authoritative. Never
                    // resurrect an older password after envelope decryption fails.
                    return statusForSigningError(error)
                }
            }
            if status != errSecItemNotFound { return status }
            // Old signed builds: biometric DP item only, never legacy plaintext.
            let legacy = readItem(name, "BitSov", true, &data)
            guard legacy == errSecSuccess else {
                return missingEntitlement(legacy) ? errSecItemNotFound : legacy
            }
        } else {
            let status = readWithFallback { readItem(name, "BitSov", $0, &data) }
            guard status == errSecSuccess else { return status }
        }
        return copyOutput(data, output, capacity, length)
    }
}

#endif

private func copyOutput(_ data: Data, _ output: UnsafeMutablePointer<UInt8>,
                        _ capacity: Int, _ length: UnsafeMutablePointer<Int>) -> Int32 {
    guard data.count <= capacity else { return errBufferTooSmall }
    data.copyBytes(to: output, count: data.count)
    length.pointee = data.count
    return errSecSuccess
}

#if os(macOS)
// Bootstrap launcher item uses the same exact service/account in both stores.
@_cdecl("bitsov_item_add")
public func bitsov_item_add(_ service: UnsafePointer<CChar>?, _ account: UnsafePointer<CChar>?,
                            _ bytes: UnsafePointer<UInt8>?, _ count: Int) -> Int32 {
    guard let service = service, let account = account, let bytes = bytes,
          count > 0, count <= 16384 else { return errBadArgument }
    return autoreleasepool {
        var data = Data(bytes: bytes, count: count)
        defer { data.resetBytes(in: 0..<data.count) }
        return storeItem(String(cString: service), String(cString: account), data, replace: false)
    }
}

@_cdecl("bitsov_item_read")
public func bitsov_item_read(_ service: UnsafePointer<CChar>?, _ account: UnsafePointer<CChar>?,
                             _ output: UnsafeMutablePointer<UInt8>?, _ capacity: Int,
                             _ length: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let service = service, let account = account, let output = output,
          let length = length, capacity >= 0 else { return errBadArgument }
    length.pointee = 0
    return autoreleasepool {
        var data = Data()
        defer { data.resetBytes(in: 0..<data.count) }
        let status = readWithFallback {
            readItem(String(cString: service), String(cString: account), $0, &data)
        }
        guard status == errSecSuccess else { return status }
        return copyOutput(data, output, capacity, length)
    }
}

@_cdecl("bitsov_item_delete")
public func bitsov_item_delete(_ service: UnsafePointer<CChar>?, _ account: UnsafePointer<CChar>?) -> Int32 {
    guard let service = service, let account = account else { return errBadArgument }
    return autoreleasepool { deleteItems(String(cString: service), String(cString: account)) }
}

#endif

// Onboarding only: registration authorization may sign one first-unlock
// challenge for the same key/node/client. General device signing never uses it.
private struct SetupApproval {
    let blob: Data
    let node: String
    let client: String
    let context: LAContext
    let deadline: TimeInterval
}
private let setupApprovalLock = NSLock()
private var setupApproval: SetupApproval?

@_cdecl("bitsov_dk_sign_setup")
public func bitsov_dk_sign_setup(
    _ blob: UnsafePointer<UInt8>?, _ blobLen: Int,
    _ msg: UnsafePointer<UInt8>?, _ msgLen: Int,
    _ reason: UnsafePointer<CChar>?, _ finish: Int32,
    _ outSig: UnsafeMutablePointer<UInt8>?, _ sigCap: Int,
    _ outSigLen: UnsafeMutablePointer<Int>?
) -> Int32 {
    return autoreleasepool {
        guard let blob = blob, let msg = msg, blobLen > 0, msgLen > 0,
              finish == 0 || finish == 1,
              let message = String(data: Data(bytes: msg, count: msgLen), encoding: .utf8) else { return errBadArgument }
        let fields = message.components(separatedBy: "\n")
        let names = finish == 0 ? ["node:", "client:", "public_key:", "sas_digest:"]
                               : ["node:", "client:", "epoch:", "key:", "challenge:", "box_transport:"]
        let domain = finish == 0 ? "bitsov-device-register-v2" : "bitsov-node-unlock-v1"
        guard fields.count == names.count + 1, fields[0] == domain,
              zip(fields.dropFirst(), names).allSatisfy({ $0.0.hasPrefix($0.1) && $0.0.count > $0.1.count }) else { return errBadArgument }
        let blobData = Data(bytes: blob, count: blobLen)
        setupApprovalLock.lock()
        let previous = setupApproval
        setupApproval = nil
        setupApprovalLock.unlock()
        let context: LAContext
        if finish == 1 {
            guard let prior = previous else { return errCancelled }
            guard prior.blob == blobData, prior.node == fields[1], prior.client == fields[2],
                  ProcessInfo.processInfo.systemUptime < prior.deadline else {
                prior.context.invalidate()
                return errCancelled
            }
            context = prior.context
            // Reuse must never show another prompt. The owner can explicitly
            // unlock through the ordinary flow if this context became invalid.
            context.interactionNotAllowed = true
        } else {
            previous?.context.invalidate()
            context = LAContext()
        }
        let status = signMessage(blob, blobLen, msg, msgLen, reason, outSig, sigCap, outSigLen, context)
        if finish == 0 && status == okStatus {
            setupApprovalLock.lock()
            setupApproval = SetupApproval(blob: blobData, node: fields[1], client: fields[2],
                context: context, deadline: ProcessInfo.processInfo.systemUptime + 120)
            setupApprovalLock.unlock()
        } else { context.invalidate() }
        return status
    }
}
