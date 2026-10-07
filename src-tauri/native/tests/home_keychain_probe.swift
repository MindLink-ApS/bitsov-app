// Standalone no-window unit probe. Concatenate device_key.swift + this file in
// /tmp, then swiftc that file. Never calls SecItem*, LAContext.evaluatePolicy,
// or the production biometric-key factory. No app binary is linked or launched.

private func checkStoragePolicy() {
    for initial: OSStatus in [0, -34018, -25300, -25299, -25293, -25308, -128, -50] {
        var writes: [Bool] = []
        let result = writeWithFallback { dp in
            writes.append(dp)
            return dp ? initial : -999
        }
        assert(writes == (initial == -34018 ? [true, false] : [true]))
        assert(result == (initial == -34018 ? -999 : initial))
        var reads: [Bool] = []
        let readResult = readWithFallback { dp in
            reads.append(dp)
            return dp ? initial : -998
        }
        let searchLegacy = initial == -34018 || initial == -25300
        assert(reads == (searchLegacy ? [true, false] : [true]))
        assert(readResult == (searchLegacy ? -998 : initial))
    }
    let node = String(repeating: "ab", count: 32)
    assert(passwordNode("bitsov.node.\(node).seed-password") == node)
    for name in ["bitsov.node.X.seed-password", "bitsov.node.\(node).box-transport",
                 "bitsov.node.\(node).seed-password.extra"] {
        assert(passwordNode(name) == nil)
    }
}

private func rejects(_ operation: () throws -> Data) {
    do {
        var unexpected = try operation()
        unexpected.resetBytes(in: 0..<unexpected.count)
        fatalError("invalid envelope was accepted")
    } catch { /* expected */ }
}

private func checkAgreementRoundTrip() throws {
    guard SecureEnclave.isAvailable else { fatalError("Secure Enclave unavailable") }
    // ONLY the probe uses a key without biometry. Production always uses
    // passwordAgreementKey(), with privateKeyUsage + biometryCurrentSet.
    let access = SecAccessControlCreateWithFlags(nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], nil)!
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    let node = String(repeating: "ab", count: 32)
    var password = Data("synthetic probe password — ø".utf8)
    defer { password.resetBytes(in: 0..<password.count) }
    let envelope = try wrapPassword(password, node: node, key: key)
    assert(envelope.range(of: password) == nil)
    var opened = try unwrapPassword(envelope, node: node)
    defer { opened.resetBytes(in: 0..<opened.count) }
    assert(opened == password)
    let again = try wrapPassword(password, node: node, key: key)
    assert(again != envelope, "fresh ephemeral key and GCM nonce required")
    rejects { try unwrapPassword(envelope, node: String(repeating: "cd", count: 32)) }
    let decoded = try JSONDecoder().decode(WrappedPassword.self, from: envelope)
    var corrupt = decoded.ciphertext
    corrupt[corrupt.count - 1] ^= 1
    let tampered = WrappedPassword(version: 1, enclaveKey: decoded.enclaveKey,
        ephemeralPublicKey: decoded.ephemeralPublicKey, ciphertext: corrupt)
    rejects { try unwrapPassword(JSONEncoder().encode(tampered), node: node) }
    let badVersion = WrappedPassword(version: 2, enclaveKey: decoded.enclaveKey,
        ephemeralPublicKey: decoded.ephemeralPublicKey, ciphertext: decoded.ciphertext)
    rejects { try unwrapPassword(JSONEncoder().encode(badVersion), node: node) }
    let invalidKey = WrappedPassword(version: 1, enclaveKey: Data([0]),
        ephemeralPublicKey: decoded.ephemeralPublicKey, ciphertext: decoded.ciphertext)
    rejects { try unwrapPassword(JSONEncoder().encode(invalidKey), node: node) }
    rejects { try unwrapPassword(Data("not an envelope".utf8), node: node) }
    var maximum = Data(repeating: 65, count: 4096)
    defer { maximum.resetBytes(in: 0..<maximum.count) }
    var maximumOpened = try unwrapPassword(wrapPassword(maximum, node: node, key: key), node: node)
    defer { maximumOpened.resetBytes(in: 0..<maximumOpened.count) }
    assert(maximumOpened == maximum)
}

checkStoragePolicy()
try checkAgreementRoundTrip()
print("PASS: fallback status matrix, node validation, Secure Enclave ECDH round trip, fresh envelopes, wrong node, tampering, bad version/blob/encoding, maximum password; no biometry or Keychain UI")
