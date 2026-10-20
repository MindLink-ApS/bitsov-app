/// Exact display amount for host messages and native dialogs. The host has no
/// renderer locale, so integers are ungrouped and fractions use integer msat.
/// Never emit decimal sats that could be mistaken for a thousands separator.
pub fn amount(msat: u64) -> String {
    if msat == 1000 {
        return "1 sat".into();
    }
    if msat.is_multiple_of(1000) {
        format!("{} sats", msat / 1000)
    } else {
        format!("{msat} msat")
    }
}
