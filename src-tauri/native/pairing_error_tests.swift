// Pure error-classification tests: no Keychain, Secure Enclave, or UI calls.
@main
struct PairingErrorTests {
    static func main() {
        let temporary: [Error] = [
            NSError(domain: NSOSStatusErrorDomain, code: Int(errSecInteractionNotAllowed)),
            NSError(domain: NSOSStatusErrorDomain, code: Int(errSecNotAvailable)),
            NSError(domain: NSOSStatusErrorDomain, code: Int(errSecAuthFailed)),
            NSError(domain: NSOSStatusErrorDomain, code: Int(errSecUserCanceled)),
            NSError(domain: LAErrorDomain, code: LAError.authenticationFailed.rawValue),
            NSError(domain: tkErrorDomain, code: tkAuthenticationFailed),
            NSError(domain: "unknown", code: Int(errSecDecode)),
            CryptoKitError.underlyingCoreCryptoError(error: -1),
        ]
        for error in temporary {
            precondition(statusForPairingError(error, sealing: false) == errOther,
                         "temporary error must permit retry: \(error)")
        }
        let invalid: [Error] = [
            CryptoKitError.authenticationFailure,
            CryptoKitError.incorrectParameterSize,
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad envelope")),
            NSError(domain: NSOSStatusErrorDomain, code: Int(errSecDecode)),
        ]
        for error in invalid {
            precondition(statusForPairingError(error, sealing: false) == errInvalidBlob,
                         "invalid envelope must be identified: \(error)")
            precondition(statusForPairingError(error, sealing: true) == errOther,
                         "seal failures must never condemn an existing blob")
        }
    }
}
