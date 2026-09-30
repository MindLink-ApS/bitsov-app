// Secure Enclave device key bridge for the BitSov desktop app (macOS only).
//
// build.rs compiles this file into a static library (module BitsovDeviceKey) and
// links it into the app binary. The Rust side is src/device_key.rs; it is the
// only caller. The ABI is plain C: pointers + lengths in, status code out.
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

// CryptoTokenKit TKError codes surfaced by enclave operations.
private let tkErrorDomain = "CryptoTokenKit"
private let tkCanceledByUser = -4
private let tkAuthenticationFailed = -5
private let tkAuthenticationNeeded = -9

/// 1 when this Mac has a Secure Enclave CryptoKit can use, else 0.
@_cdecl("bitsov_dk_available")
public func bitsov_dk_available() -> Int32 {
    return SecureEnclave.isAvailable ? 1 : 0
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
    guard let outBlob = outBlob, let outBlobLen = outBlobLen, let outPub = outPub, blobCap >= 0 else {
        return errBadArgument
    }
    outBlobLen.pointee = 0
    guard SecureEnclave.isAvailable else { return errUnavailable }

    let flags: SecAccessControlCreateFlags
    switch policy {
    case 1: flags = [.privateKeyUsage, .biometryCurrentSet]
    case 0: flags = [.privateKeyUsage]
    default: return errBadArgument
    }

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

    let context = LAContext()
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
    if error is LAError { return errCancelled }
    let ns = error as NSError
    if ns.domain == LAErrorDomain { return errCancelled }
    if ns.domain == tkErrorDomain,
       [tkCanceledByUser, tkAuthenticationFailed, tkAuthenticationNeeded].contains(ns.code) {
        return errCancelled
    }
    return errOther
}
