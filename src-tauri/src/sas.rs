//! SAS v1 interoperability with the node. Secrets are never serialized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoiseBinding {
    pub handshake_hash: [u8; 32],
    pub box_public_key: [u8; 32],
    pub client_static: [u8; 32],
}
pub fn digest(
    binding: &NoiseBinding,
    device: &[u8; 65],
    nonce: &[u8; 16],
    claim: &[u8; 32],
) -> blake3::Hash {
    let mut h = blake3::Hasher::new();
    for bytes in [
        b"bitsov-sas-v1".as_slice(),
        &binding.handshake_hash,
        &binding.box_public_key,
        &binding.client_static,
        device,
        nonce,
        claim,
    ] {
        h.update(bytes);
    }
    h.finalize()
}
pub fn digest_v2(
    binding: &NoiseBinding,
    device: &[u8; 65],
    nonce: &[u8; 16],
    ticket: &[u8; 32],
) -> blake3::Hash {
    let mut h = blake3::Hasher::new();
    for bytes in [
        b"bitsov-sas-v2".as_slice(),
        &binding.handshake_hash,
        &binding.box_public_key,
        &binding.client_static,
        device,
        nonce,
        ticket,
    ] {
        h.update(bytes);
    }
    h.finalize()
}
/// First 44 bits, most significant bit first, four BIP-39 English word indices.
pub fn words(digest: &blake3::Hash) -> [&'static str; 4] {
    let mut first = [0; 8];
    first[..6].copy_from_slice(&digest.as_bytes()[..6]);
    let bits = u64::from_be_bytes(first);
    let list = bip39::Language::English.word_list();
    std::array::from_fn(|i| list[((bits >> (64 - 11 * (i + 1))) & 2047) as usize])
}
/// The physical sticker/console code is entered locally, never sent to the box.
/// Accept case and printed separators; validate before spending a setup attempt.
pub fn claim_commitment(input: &str) -> Result<[u8; 32], &'static str> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let code = zeroize::Zeroizing::new(
        input
            .bytes()
            .filter(|b| *b == b'-' || b.is_ascii_whitespace() || b.is_ascii_alphanumeric())
            .filter(|b| *b != b'-' && !b.is_ascii_whitespace())
            .map(|b| b.to_ascii_uppercase())
            .collect::<Vec<_>>(),
    );
    if input
        .bytes()
        .any(|b| !(b.is_ascii_alphanumeric() || b == b'-' || b.is_ascii_whitespace()))
        || code.len() != 18
        || code.iter().any(|b| !ALPHABET.contains(b))
    {
        return Err("Enter the 18-character claim code shown at your node's owner console with `konsensus claim-code --show`, or on a BitSov box's sticker.");
    }
    let checksum = blake3::hash(&code[..16]);
    let hash = checksum.as_bytes();
    if code[16] != ALPHABET[(hash[0] >> 3) as usize]
        || code[17] != ALPHABET[(((hash[0] & 7) << 2) | (hash[1] >> 6)) as usize]
    {
        return Err("The claim-code checksum did not match. Check the physical code.");
    }
    let mut h = blake3::Hasher::new();
    h.update(b"bitsov-claim-code-v1");
    h.update(&code);
    Ok(*h.finalize().as_bytes())
}

pub fn registration_message(
    node: &str,
    client: &str,
    public: &str,
    digest: &blake3::Hash,
) -> String {
    format!("bitsov-device-register-v2\nnode:{node}\nclient:{client}\npublic_key:{public}\nsas_digest:{}", digest.to_hex())
}

#[cfg(test)]
mod tests {
    use super::*;
    // Frozen node tests copied from .node-ref/sas.rs (N3).
    #[test]
    fn word_indices_are_big_endian_and_use_only_44_bits() {
        assert_eq!(words(&blake3::Hash::from([0; 32])), ["abandon"; 4]);
        assert_eq!(words(&blake3::Hash::from([255; 32])), ["zoo"; 4]);
        let mut bytes = [0; 32];
        bytes[5] = 15;
        bytes[6..].fill(255);
        assert_eq!(words(&blake3::Hash::from(bytes)), ["abandon"; 4]);
    }
    #[test]
    fn sas_vector_and_all_fields_bound() {
        let binding = NoiseBinding {
            handshake_hash: std::array::from_fn(|i| i as u8),
            box_public_key: [0x22; 32],
            client_static: [0x33; 32],
        };
        let mut device = [0x44; 65];
        device[0] = 4;
        let nonce = [0x55; 16];
        let claim = [0x66; 32];
        let result = digest(&binding, &device, &nonce, &claim);
        // Frozen vector, cross-checkable using the exact concatenation in the protocol doc.
        assert_eq!(
            result.to_hex().as_str(),
            "960be0e8e070d1089b55da2113669f8530ee396eb36cd0fa04e82cb9ae346f35"
        );
        assert_eq!(words(&result), ["noodle", "gallery", "demand", "science"]);
        let mut b = binding;
        b.handshake_hash[0] ^= 1;
        assert_ne!(digest(&b, &device, &nonce, &claim), result);
        b = binding;
        b.box_public_key[0] ^= 1;
        assert_ne!(digest(&b, &device, &nonce, &claim), result);
        b = binding;
        b.client_static[0] ^= 1;
        assert_ne!(digest(&b, &device, &nonce, &claim), result);
        device[64] ^= 1;
        assert_ne!(digest(&binding, &device, &nonce, &claim), result);
        device[64] ^= 1;
        assert_ne!(digest(&binding, &device, &[0x56; 16], &claim), result);
        assert_ne!(digest(&binding, &device, &nonce, &[0x67; 32]), result);
        assert_eq!(digest(&binding, &device, &nonce, &claim), result);
    }
}

#[cfg(test)]
mod claim_tests {
    use super::*;
    #[test]
    fn malformed_claim_code_refusal_names_the_owner_console_and_box_sticker() {
        for input in ["", "AAAAAAAAAAAAAAAA00", "AAAAAAAAAAAAAAAA!!", "éAAAAAAAAAAAAAAAAAA"] {
            let message = claim_commitment(input).unwrap_err();
            assert!(message.contains("18-character claim code"));
            assert!(message.contains("your node's owner console"));
            assert!(message.contains("konsensus claim-code --show"));
            assert!(message.contains("BitSov box's sticker"));
        }
    }

    #[test]
    fn physical_code_checksum_rejects_typo_and_normalizes_printed_separators() {
        // Node ClaimCode::checksum, copied to generate a deterministic physical-code fixture.
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let mut code = [b'A'; 18];
        let h = blake3::hash(&code[..16]);
        code[16] = ALPHABET[(h.as_bytes()[0] >> 3) as usize];
        code[17] = ALPHABET[(((h.as_bytes()[0] & 7) << 2) | (h.as_bytes()[1] >> 6)) as usize];
        let text = std::str::from_utf8(&code).unwrap();
        let expected = claim_commitment(text).unwrap();
        assert_eq!(
            claim_commitment(&format!(
                " {}-{} ",
                &text[..9].to_lowercase(),
                &text[9..].to_lowercase()
            ))
            .unwrap(),
            expected
        );
        code[17] = if code[17] == b'A' { b'B' } else { b'A' };
        assert!(claim_commitment(std::str::from_utf8(&code).unwrap()).is_err());
        for invalid in [
            "",
            "AAAAAAAAAAAAAAAA00",
            "AAAAAAAAAAAAAAAA!!",
            "éAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(claim_commitment(invalid).is_err());
        }
    }
    #[test]
    fn proof_domain_and_digest_are_exactly_node_v2() {
        assert_eq!(
            registration_message("fp", "client", "04ab", &blake3::Hash::from([0x55; 32])),
            format!(
                "bitsov-device-register-v2\nnode:fp\nclient:client\npublic_key:04ab\nsas_digest:{}",
                "55".repeat(32)
            )
        );
    }
}

#[cfg(test)]
mod second_device_vectors {
    use super::*;
    #[test]
    fn t1_sas_v2_fields_and_domain() {
        let binding = NoiseBinding {
            handshake_hash: std::array::from_fn(|i| i as u8),
            box_public_key: [0x22; 32],
            client_static: [0x33; 32],
        };
        let mut device = [0x44; 65];
        device[0] = 4;
        let nonce = [0x55; 16];
        let ticket = [0x77; 32];
        let result = digest_v2(&binding, &device, &nonce, &ticket);
        assert_ne!(result, digest(&binding, &device, &nonce, &ticket));
        for i in 0..6 {
            let mut b = binding;
            let mut d = device;
            let mut n = nonce;
            let mut t = ticket;
            match i {
                0 => b.handshake_hash[0] ^= 1,
                1 => b.box_public_key[0] ^= 1,
                2 => b.client_static[0] ^= 1,
                3 => d[1] ^= 1,
                4 => n[0] ^= 1,
                _ => t[0] ^= 1,
            }
            assert_ne!(result, digest_v2(&b, &d, &n, &t));
        }
        assert_eq!(
            result.to_hex().as_str(),
            "93398e09883acf7401e66410f924dd8d726e625c816d260f963ca5f8a7250a5e"
        );
        assert_eq!(words(&result), ["nasty", "small", "list", "away"]);
    }
}
