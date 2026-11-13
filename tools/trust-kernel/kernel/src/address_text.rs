//! Reading an address from text, and the three answers of the classifier:
//! not an address, an address that is not public, a public address.
//!
//! The reference is `lib/ip-safety.ts`: `normalizeHostname`, `isIpAddress`
//! and `isPublicIpAddress`. `classify_address` answers "not an address"
//! exactly where `isIpAddress` is false, and "public" exactly where
//! `isPublicIpAddress` is true. That agreement is TESTED, by the differential
//! test (scripts/trust-kernel-differential.mjs), and by nothing stronger.
//! This file is ordinary Rust and the checker does not read it.
//!
//! What is checked is `address.rs`, which speaks about address VALUES. This
//! file turns a text into a value and hands it over, so a public answer is
//! always the checked classifier's answer for the value read here. Whether
//! the value read is the one the text names is this file's work and is
//! tested, not checked.
//!
//! The reference does not always judge a value. In these places its verdict
//! follows the SPELLING, and this file reproduces each one, because the
//! kernel has to agree with the reference:
//!
//! 1. An IPv4-mapped address gets the IPv4 rule only when it is spelled
//!    `::ffff:` and then a dotted quad or two words. Spelled any other way
//!    (`0:0:0:0:0:ffff:8.8.8.8`, `::0:ffff:808:808`) the reference reads a
//!    first word of zero and refuses it, also when the IPv4 address it
//!    carries is public.
//! 2. 2001:1::1, 2001:1::2 and 2001:1::3 are public only when spelled exactly
//!    so. `2001:1:0:0:0:0:0:1` and `2001:0001::1` are the same address and
//!    the reference refuses them.
//! 3. `normalizeHostname` takes away one closing dot, then one opening `[`
//!    and one closing `]`, each on its own: `8.8.8.8]` and `[8.8.8.8` read as
//!    8.8.8.8, and `2600::1.` as 2600::1.
//!
//! In 1 and 2 the spelling can only turn a public value into a refusal;
//! `is_public_ipv6_as_spelled` in `address.rs` is checked to allow nothing
//! else. In 3 the reference calls a text an address that a stricter reader
//! would not; the kernel repeats that and does not correct it.
//!
//! A dotted quad stands for the last 32 bits, so it is read only where it
//! ends the text. A quad before a closing `::`, as in `2600:8.8.8.8::`, is no
//! address here or in the reference, and the differential test drives that
//! form and holds both sides to that answer.

use crate::address::{is_public_ipv4, is_public_ipv6_as_spelled};

/// The classifier's answer for one text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressClass {
    /// The reference's `isIpAddress` is false.
    NotAnAddress,
    /// `isIpAddress` is true and `isPublicIpAddress` is false.
    NotPublic,
    /// `isPublicIpAddress` is true.
    Public,
}

/// The value a text was read as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressRead {
    /// Four decimal octets.
    V4(u32),
    /// Eight words of sixteen bits, the last two of them perhaps written as
    /// a dotted quad.
    V6(u128),
}

/// An IPv6 text as read: the value and the two facts about its spelling that
/// the reference's verdict follows.
struct Ipv6Text {
    value: u128,
    spelled_as_mapped: bool,
    spelled_as_anycast: bool,
}

/// `normalizeHostname`, on bytes: lower case, one closing dot gone, then one
/// opening `[` and one closing `]` gone.
///
/// A byte outside ASCII ends the reading at once with "not an address". The
/// reference lowers case with the JavaScript runtime's Unicode data, and no
/// character outside ASCII lowers to a digit, a letter `a` to `f`, a colon, a
/// dot or a bracket, so such a text is no address there either. That claim
/// about the runtime is held by the differential test over every code point.
/// Bytes that are not UTF-8 never reach the reference at all.
fn normalize(input: &[u8]) -> Option<Vec<u8>> {
    let mut text: Vec<u8> = Vec::with_capacity(input.len());
    for &byte in input {
        if byte >= 0x80 {
            return None;
        }
        text.push(byte.to_ascii_lowercase());
    }
    if text.last() == Some(&b'.') {
        text.pop();
    }
    let start = if text.first() == Some(&b'[') { 1 } else { 0 };
    let mut end = text.len();
    if end > start && text[end - 1] == b']' {
        end -= 1;
    }
    Some(text[start..end].to_vec())
}

/// `isIpv4Address`, and the value: exactly four parts between dots, each one
/// to three decimal digits with no leading zero, each at most 255. A part
/// with a leading zero is octal to other readers, so the reference calls the
/// text no address and leaves it to a resolver; so does this.
fn read_ipv4(text: &[u8]) -> Option<u32> {
    let mut value: u32 = 0;
    let mut parts = 0;
    for part in text.split(|&byte| byte == b'.') {
        parts += 1;
        // Four digits with no leading zero are already past 255.
        if parts > 4 || part.is_empty() || part.len() > 3 {
            return None;
        }
        if part.len() > 1 && part[0] == b'0' {
            return None;
        }
        let mut octet: u32 = 0;
        for &byte in part {
            if !byte.is_ascii_digit() {
                return None;
            }
            octet = octet * 10 + u32::from(byte - b'0');
        }
        if octet > 255 {
            return None;
        }
        value = (value << 8) | octet;
    }
    if parts == 4 {
        Some(value)
    } else {
        None
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// One to four hexadecimal digits as a word, or nothing.
fn read_word(part: &[u8]) -> Option<u16> {
    if part.is_empty() || part.len() > 4 {
        return None;
    }
    let mut word: u16 = 0;
    for &byte in part {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => return None,
        };
        word = (word << 4) | u16::from(digit);
    }
    Some(word)
}

/// The pieces of a text around each `::`, found from the left without
/// overlap, as JavaScript's `split("::")` finds them: `:::` is an empty piece
/// and then `:`.
fn split_on_double_colon(text: &[u8]) -> Vec<&[u8]> {
    let mut pieces = Vec::new();
    let mut from = 0;
    let mut at = 0;
    while at + 1 < text.len() {
        if text[at] == b':' && text[at + 1] == b':' {
            pieces.push(&text[from..at]);
            at += 2;
            from = at;
        } else {
            at += 1;
        }
    }
    pieces.push(&text[from..]);
    pieces
}

/// The reference's two patterns in `mappedIpv4FromIpv6`: `::ffff:` and then
/// a dotted quad that `isIpv4Address` accepts, or two words of one to four
/// hexadecimal digits.
fn is_spelled_as_mapped(text: &[u8]) -> bool {
    let Some(rest) = text.strip_prefix(b"::ffff:") else {
        return false;
    };
    if read_ipv4(rest).is_some() {
        return true;
    }
    let mut words = rest.split(|&byte| byte == b':');
    match (words.next(), words.next(), words.next()) {
        (Some(high), Some(low), None) => read_word(high).is_some() && read_word(low).is_some(),
        _ => false,
    }
}

/// `isIpv6Address`, in its order, and the value. The text is already
/// normalized, so its letters are lower case.
fn read_ipv6(text: &[u8]) -> Option<Ipv6Text> {
    if !text.contains(&b':') || text.iter().any(|&byte| !(is_lower_hex(byte) || byte == b':' || byte == b'.')) {
        return None;
    }
    let pieces = split_on_double_colon(text);
    if pieces.len() > 2 {
        return None;
    }
    let compressed = pieces.len() == 2;
    let colon = |byte: &u8| *byte == b':';
    let left: Vec<&[u8]> = if pieces[0].is_empty() { Vec::new() } else { pieces[0].split(colon).collect() };
    let right: Vec<&[u8]> =
        if compressed && !pieces[1].is_empty() { pieces[1].split(colon).collect() } else { Vec::new() };

    let total = left.len() + right.len();
    let mut left_words: Vec<u16> = Vec::new();
    let mut right_words: Vec<u16> = Vec::new();
    let mut word_count = 0;
    for (index, part) in left.iter().chain(right.iter()).enumerate() {
        let on_left = index < left.len();
        if part.is_empty() {
            return None;
        }
        if part.contains(&b'.') {
            // A dotted quad counts as two words and has to end the text.
            // The parts of both sides are one list here, as in the
            // reference, and with nothing after a `::` the last part of the
            // list stands before it, so being last in the list is not
            // enough: there is no `::`, or the quad is on its right.
            if index != total - 1 || (compressed && on_left) {
                return None;
            }
            let quad = read_ipv4(part)?;
            word_count += 2;
            let words = if on_left { &mut left_words } else { &mut right_words };
            words.push((quad >> 16) as u16);
            words.push(quad as u16);
            continue;
        }
        let word = read_word(part)?;
        word_count += 1;
        if on_left {
            left_words.push(word);
        } else {
            right_words.push(word);
        }
    }
    if compressed {
        if word_count >= 8 {
            return None;
        }
    } else if word_count != 8 {
        return None;
    }

    let mut words = [0u16; 8];
    words[..left_words.len()].copy_from_slice(&left_words);
    words[8 - right_words.len()..].copy_from_slice(&right_words);
    let mut value: u128 = 0;
    for word in words {
        value = (value << 16) | u128::from(word);
    }
    Some(Ipv6Text {
        value,
        spelled_as_mapped: is_spelled_as_mapped(text),
        spelled_as_anycast: text == b"2001:1::1" || text == b"2001:1::2" || text == b"2001:1::3",
    })
}

/// The value a text is read as, or nothing where the reference's
/// `isIpAddress` is false. The differential test compares this with a
/// second reader (the JavaScript runtime's URL parser), because the checked
/// statements are about this value.
pub fn read_address(input: &[u8]) -> Option<AddressRead> {
    let text = normalize(input)?;
    if let Some(value) = read_ipv4(&text) {
        return Some(AddressRead::V4(value));
    }
    read_ipv6(&text).map(|read| AddressRead::V6(read.value))
}

/// The classifier: one of three answers for any bytes.
pub fn classify_address(input: &[u8]) -> AddressClass {
    let Some(text) = normalize(input) else {
        return AddressClass::NotAnAddress;
    };
    let public = if let Some(value) = read_ipv4(&text) {
        is_public_ipv4(value)
    } else if let Some(read) = read_ipv6(&text) {
        is_public_ipv6_as_spelled(read.value, read.spelled_as_mapped, read.spelled_as_anycast)
    } else {
        return AddressClass::NotAnAddress;
    };
    if public {
        AddressClass::Public
    } else {
        AddressClass::NotPublic
    }
}
