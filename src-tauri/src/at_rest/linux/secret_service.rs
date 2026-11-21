use super::{Keyring, ProviderError};
use secret_service::{blocking::{Collection, SecretService}, EncryptionType};
use std::collections::HashMap;
use zeroize::Zeroizing;

pub(super) struct ServiceKeyring { profile: String }

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
    pub(super) fn new(profile: &str) -> Self { Self { profile: profile.into() } }

    fn attributes(&self) -> HashMap<&str, &str> {
        HashMap::from([
            ("application", self.profile.as_str()),
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
        self.with_collection(|collection| {
            let attributes = self.attributes();
            let items = collection.search_items(attributes.clone()).map_err(classify)?;
            let created = if items.is_empty() && create {
                let mut key = Zeroizing::new(vec![0; 32]);
                getrandom::getrandom(&mut key).map_err(|_| ProviderError::Failed)?;
                collection.create_item("BitSov protected storage", attributes.clone(), &key, false, "application/octet-stream")
                    .map_err(classify)?;
                Some(key)
            } else { None };
            let items = collection.search_items(attributes).map_err(classify)?;
            if items.is_empty() { return Err(ProviderError::Unavailable); }
            if items.len() != 1 { return Err(ProviderError::Failed); }
            let item = &items[0];
            item.ensure_unlocked().map_err(classify)?;
            let key = Zeroizing::new(item.get_secret().map_err(classify)?);
            if key.len() != 32 || created.as_ref().is_some_and(|expected| expected.as_slice() != key.as_slice()) {
                return Err(ProviderError::Failed);
            }
            collection.ensure_unlocked().map_err(classify)?;
            // Retained across failed file publications; live envelopes share this item.
            Ok(key)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
