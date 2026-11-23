// Pure checks of the pairing storage bridge with the enclave probe replaced.
// No Keychain, Secure Enclave or authentication UI is ever touched: every call
// below either fails argument validation or sees a Mac without an enclave.
var checks = 0
let sentinel: UInt8 = 0xAA
let capacity = 16384

func run(_ sealing: Int32, _ purpose: String?, _ input: [UInt8]?, outputCapacity: Int = capacity,
         probe: @escaping () -> Bool) -> (status: Int32, length: Int, untouched: Bool, probed: Bool) {
    var probed = false
    let output = UnsafeMutablePointer<UInt8>.allocate(capacity: outputCapacity)
    defer { output.deallocate() }
    output.initialize(repeating: sentinel, count: outputCapacity)
    let length = UnsafeMutablePointer<Int>.allocate(capacity: 1)
    defer { length.deallocate() }
    length.pointee = 99
    let name = purpose.map { strdup($0)! }
    defer { name.map { free($0) } }
    let bytes = input.map { input -> UnsafeMutablePointer<UInt8> in
        let copy = UnsafeMutablePointer<UInt8>.allocate(capacity: max(input.count, 1))
        copy.initialize(from: input, count: input.count)
        return copy
    }
    defer { bytes.map { $0.deallocate() } }
    let status = pairingCrypt(sealing, name.map { UnsafePointer($0) }, bytes.map { UnsafePointer($0) },
                              input?.count ?? 0, output, outputCapacity, length,
                              enclaveAvailable: { probed = true; return probe() })
    let untouched = UnsafeBufferPointer(start: output, count: outputCapacity).allSatisfy { $0 == sentinel }
    return (status, length.pointee, untouched, probed)
}

let secret = [UInt8](repeating: 0x42, count: 32)
let envelope = Array(#"{"version":1,"enclaveKey":"AAAA","ephemeralPublicKey":"BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","ciphertext":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}"#.utf8)

// sealRefusedWithoutEnclave: no enclave means -1, nothing copied, length 0.
do {
    let result = run(1, "client-ed25519-seed-v1", secret, probe: { false })
    precondition(result.status == errUnavailable, "seal without enclave: \(result.status)")
    precondition(result.length == 0, "seal without enclave reported output")
    precondition(result.untouched, "seal without enclave wrote to the output buffer")
    precondition(result.probed, "the enclave probe decides")
    checks += 4
}

// openRefusedWithoutEnclave: a well-formed envelope is refused the same way.
do {
    let result = run(0, "client-ed25519-seed-v1", envelope, probe: { false })
    precondition(result.status == errUnavailable, "open without enclave: \(result.status)")
    precondition(result.length == 0 && result.untouched, "open without enclave produced output")
    checks += 2
}

// badArgumentsStillRejectedFirst: argument errors win whatever the probe says,
// and the probe is never consulted for them.
for available in [false, true] {
    let cases: [(Int32, String?, [UInt8]?)] = [
        (1, nil, secret),
        (1, "client-ed25519-seed-v1", nil),
        (1, "client-ed25519-seed-v1", [UInt8](repeating: 1, count: 4097)),
        (0, "client-ed25519-seed-v1", [UInt8](repeating: 1, count: 16385)),
        (2, "client-ed25519-seed-v1", secret),
    ]
    for (sealing, purpose, input) in cases {
        let result = run(sealing, purpose, input, probe: { available })
        precondition(result.status == errBadArgument, "bad arguments: \(result.status)")
        precondition(!result.probed && result.untouched, "bad arguments reached the probe")
        checks += 2
    }
    // A zero-length input is rejected the same way.
    let empty = run(1, "client-ed25519-seed-v1", [], probe: { available })
    precondition(empty.status == errBadArgument && !empty.probed && empty.untouched)
    checks += 1
}

// pairingErrorMappingUnchanged: only malformed or unauthenticated envelopes
// may recommend clearing; Keychain and LocalAuthentication errors never do.
do {
    struct Missing: Codable { let value: Int }
    let decoding: Error
    do { _ = try JSONDecoder().decode(Missing.self, from: Data("{}".utf8)); fatalError("decoded") }
    catch { decoding = error }
    precondition(statusForPairingError(decoding, sealing: false) == errInvalidBlob)
    precondition(statusForPairingError(CryptoKitError.authenticationFailure, sealing: false) == errInvalidBlob)
    for error: Error in [
        NSError(domain: LAErrorDomain, code: LAError.userCancel.rawValue),
        NSError(domain: LAErrorDomain, code: LAError.authenticationFailed.rawValue),
        NSError(domain: LAErrorDomain, code: LAError.notInteractive.rawValue),
        NSError(domain: NSOSStatusErrorDomain, code: Int(errSecInteractionNotAllowed)),
        NSError(domain: NSOSStatusErrorDomain, code: Int(errSecNotAvailable)),
        NSError(domain: NSOSStatusErrorDomain, code: Int(errSecAuthFailed)),
    ] {
        precondition(statusForPairingError(error, sealing: false) == errOther, "\(error)")
        precondition(statusForPairingError(error, sealing: true) == errOther, "\(error)")
        checks += 2
    }
    precondition(statusForPairingError(decoding, sealing: true) == errOther)
    checks += 3
}

print("Completed \(checks) secure storage checks")
