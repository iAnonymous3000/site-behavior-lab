//! Canonical JSON for Site Behavior Lab, canon-v1, bytes in and bytes out.
//!
//! The reference is `lib/canonical-json.ts`, which takes a JavaScript value.
//! This crate takes bytes, so it follows one path through the reference, the
//! one the differential test drives: strict UTF-8, then `parseStrictJson`
//! (`lib/strict-json.ts`), then `canonicalJson`, then UTF-8. `canonicalize`
//! answers with the same bytes or refuses where that path throws, for the
//! same reason.
//!
//! That is not every way the reference is called. It is also given values
//! built in memory, and there it refuses things no JSON text can express (an
//! `undefined` array element, a NaN). This crate has no counterpart for
//! those: a caller that turned such a value into text first would lose the
//! refusal.
//!
//! Phase 0 of the language plan: nothing in the scanner, the Worker or the
//! site calls this crate.
//!
//! Only `encode.rs` is checked by Verus: see its head for what that covers.
//! It covers the last step, from a value tree to bytes, for the trees that
//! file calls admitted. The parser, the number text and the normalization
//! are ordinary Rust, held to the reference by the differential test
//! (scripts/trust-kernel-differential.mjs) and by nothing stronger.
//!
//! `canonicalize` is the only way in. The encoder and its value type are not
//! exported, because the encoder takes any admitted tree and an admitted
//! tree need not be canonical.

#![forbid(unsafe_code)]

mod encode;
mod nfc;
mod nfc_tables;
mod number;
mod parse;

use encode::{encode_admitted, Value};
pub use nfc_tables::UNICODE_VERSION;

/// The canonicalization rules this crate implements.
pub const CANONICALIZATION_VERSION: &str = "canon-v1";

/// The reference parser's nesting bound (`STRICT_JSON_MAX_NESTING_DEPTH`).
pub const MAX_NESTING_DEPTH: usize = 128;

/// Why an input has no canonical form. The first four are the reference
/// parser's reasons and the next two the reference canonicalizer's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The bytes are over the caller's budget.
    TooLarge,
    /// The text is not one JSON value.
    InvalidJson,
    /// An object names one key twice, after escapes are decoded.
    DuplicateKey,
    /// Arrays and objects nest deeper than `MAX_NESTING_DEPTH`.
    TooDeep,
    /// A number is in the grammar but too large for a double.
    NonFiniteNumber,
    /// An object key is not in Unicode Normalization Form C.
    KeyNotNfc,
    /// The bytes are not UTF-8. The reference never sees such input: a
    /// strict decoder in front of it refuses first.
    InvalidUtf8,
    /// The checked encoder refused the tree the other modules built. That
    /// would be a defect in this crate, never a property of the input.
    /// Nothing checks that it cannot happen: the encoder is checked to
    /// refuse exactly the trees that are not admitted, and that the parser,
    /// the number text and the key order here only ever build admitted
    /// trees is tested (no case of the differential test has met this
    /// refusal), not checked.
    NotAdmitted,
}

/// The canonical bytes of one JSON text.
///
/// `max_utf8_bytes` is the reference parser's optional byte budget.
pub fn canonicalize(input: &[u8], max_utf8_bytes: Option<u64>) -> Result<Vec<u8>, Refusal> {
    let text = core::str::from_utf8(input).map_err(|_| Refusal::InvalidUtf8)?;
    if let Some(max) = max_utf8_bytes {
        if input.len() as u64 > max {
            return Err(Refusal::TooLarge);
        }
    }
    let parsed = parse::parse(text)?;
    let value = to_canonical(parsed)?;
    encode_admitted(&value).ok_or(Refusal::NotAdmitted)
}

/// Mirrors the order `canonicalJson` walks a value in, so that when two
/// refusals apply the same one is reported: an object's keys are all checked
/// before any of its members is entered.
fn to_canonical(parsed: parse::Parsed) -> Result<Value, Refusal> {
    Ok(match parsed {
        parse::Parsed::Null => Value::Null,
        parse::Parsed::Bool(b) => Value::Bool(b),
        parse::Parsed::Number(x) => {
            if !x.is_finite() {
                return Err(Refusal::NonFiniteNumber);
            }
            Value::Number(number::js_number_text(x))
        }
        parse::Parsed::String(units) => Value::String(nfc::nfc(&units)),
        parse::Parsed::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(to_canonical(item)?);
            }
            Value::Array(out)
        }
        parse::Parsed::Object(members) => {
            // A BTreeMap of UTF-16 code units iterates in the order of
            // JavaScript's default sort.
            for key in members.keys() {
                if !nfc::is_nfc(key) {
                    return Err(Refusal::KeyNotNfc);
                }
            }
            let mut out = Vec::with_capacity(members.len());
            for (key, member) in members {
                out.push((key, to_canonical(member)?));
            }
            Value::Object(out)
        }
    })
}

#[cfg(test)]
mod tests;
