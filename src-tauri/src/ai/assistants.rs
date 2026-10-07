//! Fixed A2 assistants. No action tools, model-selected tools, or network clients.
use super::{ProviderKind, Topic};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Assistant {
    Node,
    Wallet,
    Inbox,
}

impl Assistant {
    pub fn id(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Wallet => "wallet",
            Self::Inbox => "inbox",
        }
    }
    pub fn topics(self) -> &'static [Topic] {
        match self {
            Self::Node => &[Topic::Node, Topic::Channels, Topic::Prices],
            Self::Wallet => &[Topic::Balance, Topic::Payments, Topic::Prices],
            Self::Inbox => &[Topic::Inbox],
        }
    }
    /// Must run before auth refresh, broker access, or model discovery.
    pub fn authorize(self, topic: Topic) -> Result<(), String> {
        if self.topics().contains(&topic) {
            Ok(())
        } else {
            Err(format!(
                "The {} assistant cannot read that topic.",
                self.id()
            ))
        }
    }
    pub fn authorize_model(self, provider: ProviderKind, topic: Topic) -> Result<(), String> {
        self.authorize(topic)?;
        if provider != ProviderKind::Local {
            return Err(
                "Named assistants use rules or a local model. Remote models are off for this step."
                    .into(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_assistant_denies_every_topic_outside_its_role() {
        let topics = [
            Topic::Node,
            Topic::Channels,
            Topic::Prices,
            Topic::Balance,
            Topic::Payments,
            Topic::Inbox,
        ];
        for (assistant, allowed) in [
            (Assistant::Node, [true, true, true, false, false, false]),
            (Assistant::Wallet, [false, false, true, true, true, false]),
            (Assistant::Inbox, [false, false, false, false, false, true]),
        ] {
            for (topic, allowed) in topics.into_iter().zip(allowed) {
                assert_eq!(assistant.authorize(topic).is_ok(), allowed);
                assert_eq!(
                    assistant
                        .authorize_model(ProviderKind::Local, topic)
                        .is_ok(),
                    allowed
                );
                assert!(assistant
                    .authorize_model(ProviderKind::Shared, topic)
                    .is_err());
                assert!(assistant
                    .authorize_model(ProviderKind::Frontier, topic)
                    .is_err());
            }
        }
        for invalid in [
            "custom",
            "../wallet",
            "pay",
            "send",
            "open_channel",
            "draft_payment",
        ] {
            assert!(serde_json::from_value::<Assistant>(serde_json::json!(invalid)).is_err());
            assert!(serde_json::from_value::<Topic>(serde_json::json!(invalid)).is_err());
        }
    }
}
