//! Android Keystore device approvals and fail-closed stubs for other mobile builds.

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

#[cfg(target_os = "android")]
mod android {
    use super::{DeviceKeyError, Policy, PUBLIC_KEY_LEN};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde::{Deserialize, Serialize};
    use std::{io, sync::OnceLock};
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Wry,
    };
    use zeroize::Zeroizing;

    const PLUGIN_IDENTIFIER: &str = "tech.mindlink.bitsov";
    const PLUGIN_TRANSPORT_ERROR: i32 = -100;

    static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Availability {
        hardware_backed: bool,
        biometrics_available: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CommandResponse {
        error_code: Option<i32>,
        blob: Option<String>,
        public_key: Option<String>,
        signature: Option<String>,
        // Zeroizing covers only our copy. Known limit: Tauri's run_mobile_plugin
        // passes the payload as JSON through buffers we do not own, and the
        // Kotlin side's Base64 String is immutable, so those copies are not wiped.
        value: Option<Zeroizing<String>>,
        found: Option<bool>,
    }

    #[derive(Serialize)]
    struct CreatePayload<'a> {
        policy: &'a str,
    }

    #[derive(Serialize)]
    struct BlobPayload {
        blob: String,
    }

    #[derive(Serialize)]
    struct SignPayload<'a> {
        blob: String,
        message: String,
        reason: &'a str,
    }

    #[derive(Serialize)]
    struct StoreItemPayload<'a> {
        blob: Option<String>,
        node: &'a str,
        suffix: &'a str,
        value: Zeroizing<String>,
        secret: bool,
        reenroll: bool,
    }

    #[derive(Serialize)]
    struct ReadItemPayload<'a> {
        blob: Option<String>,
        node: &'a str,
        suffix: &'a str,
        secret: bool,
    }

    #[derive(Serialize)]
    struct HasItemPayload<'a> {
        node: &'a str,
        suffix: &'a str,
    }

    #[derive(Serialize)]
    struct SealPayload<'a> {
        purpose: &'a str,
        value: Zeroizing<String>,
    }

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("device-key")
            .setup(|_app, api| {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "DeviceKeyPlugin")?;
                HANDLE.set(handle).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "Android device-key plugin was registered twice",
                    )
                })?;
                Ok(())
            })
            .build()
    }

    fn handle() -> Result<&'static PluginHandle<Wry>, DeviceKeyError> {
        HANDLE.get().ok_or(DeviceKeyError::Unavailable)
    }

    fn run<T: for<'de> Deserialize<'de>>(
        command: &str,
        payload: impl Serialize,
    ) -> Result<T, DeviceKeyError> {
        handle()?
            .run_mobile_plugin(command, payload)
            .map_err(|_| DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR))
    }

    fn response_error(code: i32) -> DeviceKeyError {
        match code {
            -1 => DeviceKeyError::Unavailable,
            -2 => DeviceKeyError::Cancelled,
            -3 => DeviceKeyError::Invalid,
            -7 => DeviceKeyError::BiometryUnavailable,
            other => DeviceKeyError::Other(other),
        }
    }

    fn checked(response: CommandResponse) -> Result<CommandResponse, DeviceKeyError> {
        match response.error_code {
            Some(code) => Err(response_error(code)),
            None => Ok(response),
        }
    }

    fn decode(value: Option<impl AsRef<[u8]>>) -> Result<Vec<u8>, DeviceKeyError> {
        let value = value.ok_or(DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR))?;
        STANDARD
            .decode(value)
            .map_err(|_| DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR))
    }

    fn availability() -> Option<Availability> {
        run("availability", serde_json::json!({})).ok()
    }

    pub fn available() -> bool {
        availability().is_some_and(|status| status.hardware_backed && status.biometrics_available)
    }

    pub fn enclave_available() -> bool {
        availability().is_some_and(|status| status.hardware_backed)
    }

    pub fn create(policy: Policy) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
        let policy = match policy {
            Policy::Biometry => "biometry",
            Policy::NoPromptForTests => return Err(DeviceKeyError::Unavailable),
        };
        let response: CommandResponse = run("create", CreatePayload { policy })?;
        let response = checked(response)?;
        let blob = decode(response.blob)?;
        let public = decode(response.public_key)?;
        let public: [u8; PUBLIC_KEY_LEN] = public
            .try_into()
            .map_err(|_| DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR))?;
        if public[0] != 0x04 {
            return Err(DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR));
        }
        Ok((blob, public))
    }

    pub fn public_key(blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
        if blob.is_empty() {
            return Err(DeviceKeyError::Invalid);
        }
        let response: CommandResponse = run(
            "publicKey",
            BlobPayload {
                blob: STANDARD.encode(blob),
            },
        )?;
        let public = decode(checked(response)?.public_key)?;
        let public: [u8; PUBLIC_KEY_LEN] =
            public.try_into().map_err(|_| DeviceKeyError::Invalid)?;
        if public[0] != 0x04 {
            return Err(DeviceKeyError::Invalid);
        }
        Ok(public)
    }

    pub fn sign(blob: &[u8], message: &[u8], reason: &str) -> Result<Vec<u8>, DeviceKeyError> {
        if blob.is_empty() {
            return Err(DeviceKeyError::Invalid);
        }
        let response: CommandResponse = run(
            "sign",
            SignPayload {
                blob: STANDARD.encode(blob),
                message: STANDARD.encode(message),
                reason,
            },
        )?;
        let signature = decode(checked(response)?.signature)?;
        if signature.first() != Some(&0x30) || signature.len() > 72 {
            return Err(DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR));
        }
        Ok(signature)
    }

    /// Store an exact node-scoped home-node record in the Android app sandbox.
    /// Secret records require the device-key blob and are encrypted with its
    /// biometric-bound companion key by the native plugin. `reenroll` lets the
    /// plugin replace that companion key only if Keystore reports it
    /// permanently invalidated; it is set only from the owner's explicit
    /// "Remember on this phone" choice.
    pub fn store_home_item(
        device_blob: Option<&[u8]>,
        node: &str,
        suffix: &str,
        value: &[u8],
        secret: bool,
        reenroll: bool,
    ) -> Result<(), DeviceKeyError> {
        if secret != (suffix == "seed-password") {
            return Err(DeviceKeyError::Invalid);
        }
        if secret && device_blob.map_or(true, |blob| blob.is_empty()) {
            return Err(DeviceKeyError::Invalid);
        }
        if reenroll && !secret {
            return Err(DeviceKeyError::Invalid);
        }
        let response: CommandResponse = run(
            "storeHomeItem",
            StoreItemPayload {
                blob: device_blob.map(|blob| STANDARD.encode(blob)),
                node,
                suffix,
                value: Zeroizing::new(STANDARD.encode(value)),
                secret,
                reenroll,
            },
        )?;
        checked(response).map(|_| ())
    }

    /// Read an exact node-scoped home-node record. Missing records are not
    /// invented; secret reads require biometric approval in the native plugin.
    pub fn read_home_item(
        device_blob: Option<&[u8]>,
        node: &str,
        suffix: &str,
        secret: bool,
    ) -> Result<Option<Vec<u8>>, DeviceKeyError> {
        if secret != (suffix == "seed-password") {
            return Err(DeviceKeyError::Invalid);
        }
        if secret && device_blob.map_or(true, |blob| blob.is_empty()) {
            return Err(DeviceKeyError::Invalid);
        }
        let response: CommandResponse = run(
            "readHomeItem",
            ReadItemPayload {
                blob: device_blob.map(|blob| STANDARD.encode(blob)),
                node,
                suffix,
                secret,
            },
        )?;
        let response = checked(response)?;
        if response.found != Some(true) {
            return Ok(None);
        }
        decode(response.value).map(Some)
    }

    /// Whether an exact remembered-password record exists. Existence only: the
    /// plugin neither returns nor decrypts it, so no biometric prompt appears.
    pub fn has_home_item(node: &str, suffix: &str) -> Result<bool, DeviceKeyError> {
        if suffix != "seed-password" {
            return Err(DeviceKeyError::Invalid);
        }
        let response: CommandResponse = run("hasHomeItem", HasItemPayload { node, suffix })?;
        checked(response)?
            .found
            .ok_or(DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR))
    }

    /// Encrypt `value` under the app's non-exportable at-rest key, with
    /// `purpose` as associated data. No prompt: see `atRestKeySpec`.
    pub fn seal(purpose: &str, value: &[u8]) -> Result<Vec<u8>, DeviceKeyError> {
        let response: CommandResponse = run(
            "seal",
            SealPayload {
                purpose,
                value: Zeroizing::new(STANDARD.encode(value)),
            },
        )?;
        decode(checked(response)?.value)
    }

    /// Open a `seal` result. A missing key or wrong purpose is `Invalid`.
    pub fn unseal(purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, DeviceKeyError> {
        let response: CommandResponse = run(
            "unseal",
            SealPayload {
                purpose,
                value: Zeroizing::new(STANDARD.encode(sealed)),
            },
        )?;
        decode(checked(response)?.value).map(Zeroizing::new)
    }

    /// The Android Keystore behind `bitsov_app::at_rest`.
    pub struct KeystoreSealer;

    impl bitsov_app::at_rest::Sealer for KeystoreSealer {
        fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
            seal(purpose, plaintext).map_err(|error| error.to_string())
        }

        fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            unseal(purpose, sealed).map_err(|error| error.to_string())
        }
    }
}

#[cfg(target_os = "android")]
pub use android::{
    available, create, enclave_available, has_home_item, init, public_key, read_home_item, sign,
    store_home_item, KeystoreSealer,
};

#[cfg(not(target_os = "android"))]
pub fn available() -> bool {
    false
}

#[cfg(not(target_os = "android"))]
pub fn enclave_available() -> bool {
    false
}

#[cfg(not(target_os = "android"))]
pub fn create(_policy: Policy) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "android"))]
pub fn sign(_blob: &[u8], _message: &[u8], _reason: &str) -> Result<Vec<u8>, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "android"))]
pub fn public_key(_blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "android"))]
pub fn store_home_item(
    _device_blob: Option<&[u8]>,
    _node: &str,
    _suffix: &str,
    _value: &[u8],
    _secret: bool,
    _reenroll: bool,
) -> Result<(), DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "android"))]
pub fn has_home_item(_node: &str, _suffix: &str) -> Result<bool, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "android"))]
pub fn read_home_item(
    _device_blob: Option<&[u8]>,
    _node: &str,
    _suffix: &str,
    _secret: bool,
) -> Result<Option<Vec<u8>>, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}
