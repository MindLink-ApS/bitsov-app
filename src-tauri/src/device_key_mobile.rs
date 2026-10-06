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

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("device-key")
            .setup(|_app, api| {
                let handle =
                    api.register_android_plugin(PLUGIN_IDENTIFIER, "DeviceKeyPlugin")?;
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

    fn decode(value: Option<String>) -> Result<Vec<u8>, DeviceKeyError> {
        let value = value.ok_or(DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR))?;
        STANDARD
            .decode(value)
            .map_err(|_| DeviceKeyError::Other(PLUGIN_TRANSPORT_ERROR))
    }

    fn availability() -> Option<Availability> {
        run("availability", serde_json::json!({})).ok()
    }

    pub fn available() -> bool {
        availability().is_some_and(|status| {
            status.hardware_backed && status.biometrics_available
        })
    }

    pub fn enclave_available() -> bool {
        availability().is_some_and(|status| status.hardware_backed)
    }

    pub fn create(
        policy: Policy,
    ) -> Result<(Vec<u8>, [u8; PUBLIC_KEY_LEN]), DeviceKeyError> {
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

    pub fn sign(
        blob: &[u8],
        message: &[u8],
        reason: &str,
    ) -> Result<Vec<u8>, DeviceKeyError> {
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
}

#[cfg(target_os = "android")]
pub use android::{available, create, enclave_available, init, public_key, sign};

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
pub fn sign(
    _blob: &[u8],
    _message: &[u8],
    _reason: &str,
) -> Result<Vec<u8>, DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}

#[cfg(not(target_os = "android"))]
pub fn public_key(_blob: &[u8]) -> Result<[u8; PUBLIC_KEY_LEN], DeviceKeyError> {
    Err(DeviceKeyError::Unavailable)
}
