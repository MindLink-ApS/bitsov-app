/// Exact display amount for host messages and native dialogs. The host has no
/// renderer locale, so integers are ungrouped and fractions use integer msat.
/// Never emit decimal sats that could be mistaken for a thousands separator.
pub fn amount(msat: u64) -> String {
    if msat == 1000 { return "1 sat".into(); }
    if msat.is_multiple_of(1000) { format!("{} sats", msat / 1000) }
    else { format!("{msat} msat") }
}

/// Native approval prompts use the same locale-independent U+2009 grouping
/// as the renderer, retaining integer msat for every fractional sat amount.
pub fn grouped_amount(msat: u64) -> String {
    let text = amount(msat);
    let (digits, unit) = text.split_once(' ').expect("amount has a unit");
    let mut grouped = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push('\u{2009}');
        }
        grouped.push(c);
    }
    format!("{grouped} {unit}")
}
