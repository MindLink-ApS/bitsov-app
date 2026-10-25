//! Compile-time payment policy; shared by every host dispatch path.

use crate::act::ActionError;

pub const IOS_STORE: bool = cfg!(ios_store);

pub fn require_individual(individual: bool) -> Result<(), ActionError> {
    check(IOS_STORE, individual)
}

fn check(store: bool, individual: bool) -> Result<(), ActionError> {
    if store && !individual {
        return Err(ActionError::new("ios_store_person_only",
            "This iOS build supports payments between two individuals only. Nothing was paid."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn store_refuses_group_and_content_payments_but_preserves_individual_payments() {
        assert_eq!(super::check(true, false).unwrap_err().code, "ios_store_person_only");
        assert!(super::check(true, true).is_ok());
        assert!(super::check(false, false).is_ok());
        assert!(super::check(false, true).is_ok());
    }
}

#[cfg(all(test, ios_store))]
mod ios_store_tests {
    use crate::{act, porch};

    #[test]
    fn production_dispatch_builders_refuse_content_rooms_and_meetings() {
        let peer = "a".repeat(64);
        assert!(act::compose_body(&peer, false, "hello").is_ok());
        assert_eq!(act::compose_body("12345678-1234-4234-8234-123456789abc", true, "hello").unwrap_err().code, "ios_store_person_only");
        for room in [r#"{"room":{}}"#, r#"  {"room":null,"text":"hello"}"#] {
            assert_eq!(act::compose_body(&peer, false, room).unwrap_err().code, "ios_store_person_only");
        }
        assert_eq!(act::room_quote("room", &peer, 1000, &[], &[], &[], act::RoutingFeePolicy::default()).unwrap_err().code, "ios_store_person_only");
        assert_eq!(porch::porch_path("/index.md").unwrap_err().code, "ios_store_person_only");
        assert_eq!(porch::porch_path("/front-door.json").unwrap_err().code, "ios_store_person_only");
        for kind in 400..=403 {
            assert!(act::call_body(&peer, kind, r#"{"v":1,"call_id":"test"}"#).is_ok());
            assert_eq!(act::call_body(&peer, kind, r#"{"meeting":{"id":"test"}}"#).unwrap_err().code, "ios_store_person_only");
        }
    }
}
