use super::{Keyring, ProviderError};
use secret_service::{blocking::{Collection, SecretService}, EncryptionType};
use std::collections::HashMap;
use zeroize::Zeroizing;

pub(super) struct ServiceKeyring { profile_id: String }

fn only_item<T>(items: &[T]) -> Result<&T, ProviderError> {
    if items.is_empty() { return Err(ProviderError::Missing); }
    if items.len() != 1 { return Err(ProviderError::Failed); }
    Ok(&items[0])
}

fn read_existing<T>(create: bool, lookup: impl FnOnce() -> Result<T, ProviderError>) -> Result<T, ProviderError> {
    if create { return Err(ProviderError::Failed); }
    lookup()
}

fn classify(error: secret_service::Error) -> ProviderError {
    match error {
        secret_service::Error::Unavailable | secret_service::Error::NoResult => ProviderError::Unavailable,
        secret_service::Error::Locked | secret_service::Error::Prompt | secret_service::Error::PromptDisconnected => ProviderError::Locked,
        secret_service::Error::Zbus(zbus::Error::MethodError(name, _, _)) => match name.as_str() {
            "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner"
                | "org.freedesktop.Secret.Error.NoSuchObject" => ProviderError::Unavailable,
            "org.freedesktop.Secret.Error.IsLocked" => ProviderError::Locked,
            _ => ProviderError::Failed,
        },
        secret_service::Error::Zbus(zbus::Error::InputOutput(_) | zbus::Error::Connection(_, _)) => ProviderError::Unavailable,
        secret_service::Error::ZbusFdo(zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_)) => ProviderError::Unavailable,
        _ => ProviderError::Failed,
    }
}

impl ServiceKeyring {
    pub(super) fn new(profile: &str) -> Self {
        Self { profile_id: hex::encode(blake3::derive_key("bitsov-linux-keyring-profile-v2", profile.as_bytes())) }
    }

    fn attributes(&self) -> HashMap<&str, &str> {
        HashMap::from([
            ("application", "tech.mindlink.bitsov"),
            ("xdg:schema", "tech.mindlink.bitsov.protected-storage.v2"),
            ("profile", self.profile_id.as_str()),
            ("kind", "pairing-profile-wrap-key"),
            ("version", "2"),
        ])
    }

    fn with_collection<T>(&self, action: impl FnOnce(Collection<'_>) -> Result<T, ProviderError>) -> Result<T, ProviderError> {
        let service = SecretService::connect(EncryptionType::Dh).map_err(classify)?;
        let collection = service.get_default_collection().map_err(classify)?;
        match service.get_collection_by_alias("session") {
            Ok(session) if session.collection_path == collection.collection_path => return Err(ProviderError::Unavailable),
            Ok(_) | Err(secret_service::Error::NoResult) => {}
            Err(error) => return Err(classify(error)),
        }
        collection.ensure_unlocked().map_err(classify)?;
        action(collection)
    }
}

impl Keyring for ServiceKeyring {
    fn key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
        read_existing(create, || self.with_collection(|collection| {
            let attributes = self.attributes();
            let items = collection.search_items(attributes).map_err(classify)?;
            let item = only_item(&items)?;
            item.ensure_unlocked().map_err(classify)?;
            let key = Zeroizing::new(item.get_secret().map_err(classify)?);
            if key.len() != 32 {
                return Err(ProviderError::Failed);
            }
            collection.ensure_unlocked().map_err(classify)?;
            // Retained across failed file publications; live envelopes share this item.
            Ok(key)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lookup_metadata_separates_profiles_with_a_fixed_schema() {
        let first = ServiceKeyring::new("test.profile");
        let repeated = ServiceKeyring::new("test.profile");
        let other = ServiceKeyring::new("other.profile");
        let attributes = first.attributes();
        assert_eq!(attributes.get("application"), Some(&"tech.mindlink.bitsov"));
        assert_eq!(attributes.get("xdg:schema"), Some(&"tech.mindlink.bitsov.protected-storage.v2"));
        assert_eq!(attributes.get("kind"), Some(&"pairing-profile-wrap-key"));
        assert_eq!(attributes.get("version"), Some(&"2"));
        let profile = attributes.get("profile").unwrap();
        assert_eq!(profile.len(), 64);
        assert!(profile.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!attributes.values().any(|value| *value == "test.profile"));
        assert_eq!(attributes, repeated.attributes());
        assert_ne!(attributes.get("profile"), other.attributes().get("profile"));
        assert_ne!(*profile, blake3::hash(b"test.profile").to_hex().as_str());
    }

    #[test]
    fn an_empty_successful_lookup_reports_a_missing_item() {
        let missing = only_item::<u8>(&[]).unwrap_err();
        assert!(missing.to_string().contains("missing"));
        assert!(missing.to_string().contains("restore the original item"));
        assert_ne!(missing, classify(secret_service::Error::Unavailable));
        assert_ne!(missing, classify(secret_service::Error::NoResult));
    }

    #[test]
    fn lookup_requires_exactly_one_item() {
        assert_eq!(*only_item(&[17]).unwrap(), 17);
        assert_eq!(only_item(&[17, 19]), Err(ProviderError::Failed));
    }

    #[test]
    fn native_creation_refuses_before_lookup() {
        let looked_up = std::cell::Cell::new(false);
        let result = read_existing(true, || { looked_up.set(true); Ok(17) });
        assert!(!looked_up.get());
        assert_eq!(result, Err(ProviderError::Failed));
    }

    #[test]
    fn existing_lookup_preserves_results_and_service_errors() {
        assert_eq!(read_existing(false, || Ok(17)), Ok(17));
        for error in [ProviderError::Unavailable, ProviderError::Locked, ProviderError::Failed] {
            assert_eq!(read_existing::<u8>(false, || Err(error)), Err(error));
        }
    }

    #[test]
    fn provider_errors_keep_their_refusal_state() {
        assert_eq!(classify(secret_service::Error::Unavailable), ProviderError::Unavailable);
        assert_eq!(classify(secret_service::Error::NoResult), ProviderError::Unavailable);
        assert_eq!(classify(secret_service::Error::Locked), ProviderError::Locked);
        assert_eq!(classify(secret_service::Error::Prompt), ProviderError::Locked);
        assert_eq!(classify(secret_service::Error::PromptDisconnected), ProviderError::Locked);
        assert_eq!(classify(secret_service::Error::Crypto("invalid")), ProviderError::Failed);
    }
    #[test]
    fn native_method_errors_preserve_unavailable_and_locked_states() {
        for (name, expected) in [
            ("org.freedesktop.DBus.Error.ServiceUnknown", ProviderError::Unavailable),
            ("org.freedesktop.DBus.Error.NameHasNoOwner", ProviderError::Unavailable),
            ("org.freedesktop.Secret.Error.IsLocked", ProviderError::Locked),
            ("org.freedesktop.Secret.Error.NoSuchObject", ProviderError::Unavailable),
            ("org.freedesktop.DBus.Error.AccessDenied", ProviderError::Failed),
        ] {
            let message = zbus::Message::method_call("/org/freedesktop/secrets", "OpenSession").unwrap().build(&()).unwrap();
            let error = zbus::Error::MethodError(name.try_into().unwrap(), None, message);
            assert_eq!(classify(secret_service::Error::Zbus(error)), expected, "{name}");
        }
    }

}
