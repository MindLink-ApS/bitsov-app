//! Platform-neutral rules for owner-only private storage objects.
//!
//! The Windows private-file layer reads facts from an open handle and asks
//! these functions whether the object may be used. Nothing here touches the
//! filesystem, so every rule is unit-tested on all platforms.

#![forbid(unsafe_code)]

use std::fmt;

/// What a private object must be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectKind {
    File,
    Dir,
}

/// The access-control entry types the policy distinguishes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AceType {
    Allow,
    Deny,
    Other(u8),
}

/// ACE header flags (winnt.h).
pub const OBJECT_INHERIT_ACE: u8 = 0x01;
pub const CONTAINER_INHERIT_ACE: u8 = 0x02;
pub const NO_PROPAGATE_INHERIT_ACE: u8 = 0x04;
pub const INHERIT_ONLY_ACE: u8 = 0x08;
pub const INHERITED_ACE: u8 = 0x10;

/// One entry of an object's DACL, reduced to what the policy needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AceFacts {
    pub ace_type: AceType,
    pub flags: u8,
    /// The entry names the current user's SID.
    pub for_user: bool,
}

/// Owner and DACL of an open object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecurityFacts {
    pub owner_is_user: bool,
    /// False for a NULL DACL, which grants everyone full access.
    pub dacl_present: bool,
    pub dacl_protected: bool,
    pub aces: Vec<AceFacts>,
}

/// Identity facts of an open object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObjectFacts {
    pub is_dir: bool,
    pub is_reparse: bool,
    /// Number of names for the object. Only checked for files.
    pub links: u32,
}

/// Why an object or process was refused. Messages name no paths or SIDs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Reparse,
    WrongKind,
    Linked,
    ForeignOwner,
    NullDacl,
    EmptyDacl,
    UnprotectedDacl,
    InheritedAce,
    DenyAce,
    ForeignAce,
    UnexpectedAceType,
    UnexpectedAceFlags,
    ExtraAce,
    Elevated,
    TokenQueryFailed,
    InvalidSid,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Reparse => "private storage refuses a link or reparse point",
            Self::WrongKind => "private storage found the wrong kind of object",
            Self::Linked => "private storage refuses a file with more than one name",
            Self::ForeignOwner => "private storage is owned by another account",
            Self::NullDacl => "private storage has no access list",
            Self::EmptyDacl => "private storage has an empty access list",
            Self::UnprotectedDacl => "private storage inherits access from its folder",
            Self::InheritedAce => "private storage has an inherited access entry",
            Self::DenyAce => "private storage has an unexpected deny entry",
            Self::ForeignAce => "private storage grants access to another account",
            Self::UnexpectedAceType => "private storage has an unexpected access entry",
            Self::UnexpectedAceFlags => "private storage has unexpected access entry flags",
            Self::ExtraAce => "private storage has more than one access entry",
            Self::Elevated => {
                "BitSov does not run as administrator. Start it normally, without \"Run as administrator\"."
            }
            Self::TokenQueryFailed => "BitSov cannot confirm it is running without administrator rights",
            Self::InvalidSid => "private storage cannot identify the current account",
        })
    }
}

impl std::error::Error for Refusal {}

/// Flags on the single entry of a private object of `kind`.
pub fn expected_ace_flags(kind: ObjectKind) -> u8 {
    match kind {
        ObjectKind::File => 0,
        ObjectKind::Dir => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
    }
}

/// Kind, reparse and link-count rules. A reparse point is refused first so a
/// link is never reported as merely the wrong kind.
pub fn check_object(kind: ObjectKind, facts: &ObjectFacts) -> Result<(), Refusal> {
    if facts.is_reparse {
        return Err(Refusal::Reparse);
    }
    if facts.is_dir != (kind == ObjectKind::Dir) {
        return Err(Refusal::WrongKind);
    }
    if kind == ObjectKind::File && facts.links != 1 {
        return Err(Refusal::Linked);
    }
    Ok(())
}

/// Owner-only rule: owner is the user, the DACL is present, protected, and
/// holds exactly one non-inherited allow entry for the user.
pub fn check_security(kind: ObjectKind, facts: &SecurityFacts) -> Result<(), Refusal> {
    if !facts.owner_is_user {
        return Err(Refusal::ForeignOwner);
    }
    if !facts.dacl_present {
        return Err(Refusal::NullDacl);
    }
    if facts.aces.is_empty() {
        return Err(Refusal::EmptyDacl);
    }
    if !facts.dacl_protected {
        return Err(Refusal::UnprotectedDacl);
    }
    for ace in &facts.aces {
        if ace.flags & INHERITED_ACE != 0 {
            return Err(Refusal::InheritedAce);
        }
        match ace.ace_type {
            AceType::Allow => {}
            AceType::Deny => return Err(Refusal::DenyAce),
            AceType::Other(_) => return Err(Refusal::UnexpectedAceType),
        }
        if !ace.for_user {
            return Err(Refusal::ForeignAce);
        }
        if ace.flags != expected_ace_flags(kind) {
            return Err(Refusal::UnexpectedAceFlags);
        }
    }
    if facts.aces.len() != 1 {
        return Err(Refusal::ExtraAce);
    }
    Ok(())
}

/// Elevated processes, and processes whose elevation cannot be read, refuse.
/// `query` is the token's elevation flag, or `Err` when the query failed.
pub fn elevation_policy(query: Result<bool, ()>) -> Result<(), Refusal> {
    match query {
        Ok(false) => Ok(()),
        Ok(true) => Err(Refusal::Elevated),
        Err(()) => Err(Refusal::TokenQueryFailed),
    }
}

/// A string SID as produced by the OS: `S-1-` then dash-separated decimals.
pub fn valid_sid_string(sid: &str) -> bool {
    let Some(rest) = sid.strip_prefix("S-1-") else {
        return false;
    };
    sid.len() <= 184
        && rest.split('-').all(|part| {
            !part.is_empty() && part.len() <= 10 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

/// The protected security descriptor every private object is created with:
/// owner = user, one allow entry (full access) for the user, nothing inherited.
pub fn private_sddl(user_sid: &str, kind: ObjectKind) -> Result<String, Refusal> {
    if !valid_sid_string(user_sid) {
        return Err(Refusal::InvalidSid);
    }
    let flags = match kind {
        ObjectKind::File => "",
        ObjectKind::Dir => "OICI",
    };
    Ok(format!("O:{user_sid}D:P(A;{flags};FA;;;{user_sid})"))
}

/// Current-user DPAPI without any UI. `CRYPTPROTECT_LOCAL_MACHINE` (0x4) is
/// never set: machine scope would let any local account open the secret.
pub const DPAPI_FLAGS: u32 = 0x1;
pub const DPAPI_LOCAL_MACHINE: u32 = 0x4;
pub const DPAPI_UI_FORBIDDEN: u32 = 0x1;

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";

    fn user_ace(kind: ObjectKind) -> AceFacts {
        AceFacts {
            ace_type: AceType::Allow,
            flags: expected_ace_flags(kind),
            for_user: true,
        }
    }

    fn good(kind: ObjectKind) -> SecurityFacts {
        SecurityFacts {
            owner_is_user: true,
            dacl_present: true,
            dacl_protected: true,
            aces: vec![user_ace(kind)],
        }
    }

    fn file() -> ObjectFacts {
        ObjectFacts {
            is_dir: false,
            is_reparse: false,
            links: 1,
        }
    }

    fn dir() -> ObjectFacts {
        ObjectFacts {
            is_dir: true,
            is_reparse: false,
            links: 1,
        }
    }

    #[test]
    fn only_a_single_protected_user_entry_passes() {
        for kind in [ObjectKind::File, ObjectKind::Dir] {
            assert_eq!(check_security(kind, &good(kind)), Ok(()));
        }
    }

    #[test]
    fn every_widened_or_foreign_acl_is_refused() {
        for kind in [ObjectKind::File, ObjectKind::Dir] {
            let refused = |change: &dyn Fn(&mut SecurityFacts), why: Refusal| {
                let mut facts = good(kind);
                change(&mut facts);
                assert_eq!(check_security(kind, &facts), Err(why), "{kind:?} {why:?}");
            };
            refused(&|f| f.owner_is_user = false, Refusal::ForeignOwner);
            refused(
                &|f| {
                    f.dacl_present = false;
                    f.aces.clear();
                },
                Refusal::NullDacl,
            );
            refused(&|f| f.aces.clear(), Refusal::EmptyDacl);
            refused(&|f| f.dacl_protected = false, Refusal::UnprotectedDacl);
            refused(
                &|f| {
                    f.aces.push(AceFacts {
                        ace_type: AceType::Allow,
                        flags: 0,
                        for_user: false,
                    })
                },
                Refusal::ForeignAce,
            );
            refused(
                &|f| {
                    f.aces.insert(
                        0,
                        AceFacts {
                            ace_type: AceType::Deny,
                            flags: 0,
                            for_user: false,
                        },
                    )
                },
                Refusal::DenyAce,
            );
            // Even the user's own entry is refused when it was inherited.
            refused(&|f| f.aces[0].flags |= INHERITED_ACE, Refusal::InheritedAce);
            refused(
                &|f| {
                    f.aces.push(AceFacts {
                        flags: expected_ace_flags(kind) | INHERITED_ACE,
                        ..user_ace(kind)
                    })
                },
                Refusal::InheritedAce,
            );
            refused(
                &|f| f.aces[0].ace_type = AceType::Other(0x11),
                Refusal::UnexpectedAceType,
            );
            refused(
                &|f| f.aces[0].flags |= INHERIT_ONLY_ACE,
                Refusal::UnexpectedAceFlags,
            );
            refused(
                &|f| f.aces[0].flags |= NO_PROPAGATE_INHERIT_ACE,
                Refusal::UnexpectedAceFlags,
            );
            refused(&|f| f.aces.push(user_ace(kind)), Refusal::ExtraAce);
        }
        // A file entry must not carry inheritance flags, and a folder entry must.
        let mut facts = good(ObjectKind::File);
        facts.aces[0].flags = expected_ace_flags(ObjectKind::Dir);
        assert_eq!(
            check_security(ObjectKind::File, &facts),
            Err(Refusal::UnexpectedAceFlags)
        );
        let mut facts = good(ObjectKind::Dir);
        facts.aces[0].flags = 0;
        assert_eq!(
            check_security(ObjectKind::Dir, &facts),
            Err(Refusal::UnexpectedAceFlags)
        );
    }

    #[test]
    fn objects_must_be_plain_single_name_and_the_right_kind() {
        assert_eq!(check_object(ObjectKind::File, &file()), Ok(()));
        assert_eq!(check_object(ObjectKind::Dir, &dir()), Ok(()));
        assert_eq!(
            check_object(ObjectKind::File, &dir()),
            Err(Refusal::WrongKind)
        );
        assert_eq!(
            check_object(ObjectKind::Dir, &file()),
            Err(Refusal::WrongKind)
        );
        for links in [0, 2, 7] {
            assert_eq!(
                check_object(ObjectKind::File, &ObjectFacts { links, ..file() }),
                Err(Refusal::Linked)
            );
        }
        // Folder link counts are not meaningful on NTFS; only files are checked.
        assert_eq!(
            check_object(ObjectKind::Dir, &ObjectFacts { links: 3, ..dir() }),
            Ok(())
        );
        for (kind, facts) in [
            (ObjectKind::File, file()),
            (ObjectKind::Dir, dir()),
            (ObjectKind::File, dir()),
        ] {
            let reparse = ObjectFacts {
                is_reparse: true,
                ..facts
            };
            assert_eq!(check_object(kind, &reparse), Err(Refusal::Reparse));
        }
    }

    #[test]
    fn elevated_or_unknown_tokens_refuse() {
        assert_eq!(elevation_policy(Ok(false)), Ok(()));
        assert_eq!(elevation_policy(Ok(true)), Err(Refusal::Elevated));
        assert_eq!(elevation_policy(Err(())), Err(Refusal::TokenQueryFailed));
        assert!(Refusal::Elevated.to_string().contains("administrator"));
    }

    #[test]
    fn descriptors_are_exact_and_protected() {
        assert_eq!(
            private_sddl(SID, ObjectKind::Dir).unwrap(),
            format!("O:{SID}D:P(A;OICI;FA;;;{SID})")
        );
        assert_eq!(
            private_sddl(SID, ObjectKind::File).unwrap(),
            format!("O:{SID}D:P(A;;FA;;;{SID})")
        );
    }

    #[test]
    fn only_plain_sid_strings_reach_a_descriptor() {
        assert!(valid_sid_string(SID));
        assert!(valid_sid_string("S-1-5-18"));
        for bad in [
            "",
            "S-1",
            "S-1-",
            "S-1-5-",
            "S-1-5--1",
            "s-1-5-18",
            "S-1-5-18)(A;;FA;;;WD",
            "S-1-5-18;",
            "WD",
            "S-1-5-18 ",
            "S-1-x-18",
            "S-2-5-18",
        ] {
            assert!(!valid_sid_string(bad), "{bad:?}");
            assert_eq!(
                private_sddl(bad, ObjectKind::File),
                Err(Refusal::InvalidSid),
                "{bad:?}"
            );
        }
        assert!(!valid_sid_string(&format!("S-1-5-{}", "1".repeat(200))));
    }

    #[test]
    fn dpapi_is_current_user_without_ui() {
        assert_eq!(DPAPI_FLAGS & DPAPI_LOCAL_MACHINE, 0);
        assert_eq!(DPAPI_FLAGS, DPAPI_UI_FORBIDDEN);
    }
}
