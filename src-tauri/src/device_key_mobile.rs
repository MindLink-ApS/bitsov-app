//! Mobile placeholder for device approvals.
//!
//! iOS Secure Enclave and Android Keystore implementations are added by the
//! platform-shell PRs. The pure remote client compiles without the macOS bridge.

#![allow(dead_code)]

use std::fmt;

pub const PUBLIC_KEY_LEN: usize = 65;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Biometry,
    NoPromptForTests,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKeyError {
    Unavailable,
    Cancelled,
    Invalid,
    BiometryUnavailable,
    Other(i32),
}

impl fmt::Display for DeviceKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("device approvals are unavailable on mobile"),
            Self::Cancelled => formatter.write_str("device key approval was cancelled"),
            Self::Invalid => formatter.write_str("device key is not valid on this device"),
            Self::BiometryUnavailable => {
                formatter.write_str("biometric approval is unavailable on this device")
            }
            Self::Other(code) => write!(formatter, "device key error (code {code})"),
        }
    }
}

impl std::error::Error for DeviceKeyError {}

pub fn available() -> bool {
    false
}

pub fn enclave_available() -> bool {
    false
}

pub fn create(_policy: Policy) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

pub fn sign(
    _blob: &[u8],
    _message: &[u8],
    _reason: &str,
) -> Result<Vec<u8>, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

pub fn public_key(_blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}
