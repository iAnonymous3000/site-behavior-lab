//! A few fixed cases, so `cargo test` says something without Node. The
//! reference comparison is scripts/trust-kernel-differential.mjs.

use crate::encode::{encode_admitted, Value};
use crate::{canonicalize, canonicalize_with_number_budget, Refusal};

fn canon(text: &str) -> Result<String, Refusal> {
    canonicalize(text.as_bytes(), None).map(|bytes| String::from_utf8(bytes).expect("utf-8"))
}

#[test]
fn sorts_keys_and_strips_whitespace() {
    assert_eq!(
        canon(" { \"b\" : 1 , \"a\" : { \"d\" : [ 1 , 2 ] , \"c\" : \"x\" } } ").as_deref(),
        Ok("{\"a\":{\"c\":\"x\",\"d\":[1,2]},\"b\":1}")
    );
    assert_eq!(
        canon("{\"2\":\"b\",\"10\":\"a\",\"1\":\"z\"}").as_deref(),
        Ok("{\"1\":\"z\",\"10\":\"a\",\"2\":\"b\"}")
    );
}

#[test]
fn keys_order_by_utf16_code_unit() {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+E000.
    assert_eq!(
        canon("{\"\u{e000}\":2,\"\u{1f600}\":3,\"\\ud800\":1}").as_deref(),
        Ok("{\"\\ud800\":1,\"\u{1f600}\":3,\"\u{e000}\":2}")
    );
}

#[test]
fn prints_numbers_as_javascript_does() {
    assert_eq!(
        canon("[-0,-0.0,1e21,1e-7,123456789012345680000,0.000001,1.5e300,5e-324,2e-324,1E2,0.1,-12.5e-1]").as_deref(),
        Ok("[0,0,1e+21,1e-7,123456789012345680000,0.000001,1.5e+300,5e-324,0,100,0.1,-1.25]")
    );
    // Exactly halfway between two shortest texts: JavaScript takes the even
    // digit, where Rust's own formatting rounds up.
    assert_eq!(
        canon("[957340073933683.25,-2174074861584819.25]").as_deref(),
        Ok("[957340073933683.2,-2174074861584819.2]")
    );
    assert_eq!(format!("{}", 957340073933683.25f64), "957340073933683.3");
    assert_eq!(canon("1e999"), Err(Refusal::NonFiniteNumber));
}

#[test]
fn normalizes_values_and_refuses_keys() {
    assert_eq!(canon("\"cafe\u{301}\"").as_deref(), Ok("\"caf\u{e9}\""));
    assert_eq!(canon("\"\u{1100}\u{1161}\u{11a8}\"").as_deref(), Ok("\"\u{ac01}\""));
    assert_eq!(canon("{\"e\u{301}\":1}"), Err(Refusal::KeyNotNfc));
    assert_eq!(canon("{\"caf\u{e9}\":1}").as_deref(), Ok("{\"caf\u{e9}\":1}"));
}

#[test]
fn escapes_as_json_stringify_does() {
    assert_eq!(
        canon("\"\\ud800x\\udc00\\ud83d\\ude00\\u007f\\u2028\\u0000\\/\\b\\u001f\"").as_deref(),
        Ok("\"\\ud800x\\udc00\u{1f600}\u{7f}\u{2028}\\u0000/\\b\\u001f\"")
    );
}

#[test]
fn refuses_what_the_reference_parser_refuses() {
    assert_eq!(canon("{\"a\":1,\"\\u0061\":2}"), Err(Refusal::DuplicateKey));
    assert_eq!(canon("[1,]"), Err(Refusal::InvalidJson));
    assert_eq!(canon("01"), Err(Refusal::InvalidJson));
    assert_eq!(canon(""), Err(Refusal::InvalidJson));
    assert_eq!(canon("\u{feff}1"), Err(Refusal::InvalidJson));
    let deep = format!("{}0{}", "[".repeat(129), "]".repeat(129));
    assert_eq!(canon(&deep), Err(Refusal::TooDeep));
    let fits = format!("{}0{}", "[".repeat(128), "]".repeat(128));
    assert!(canon(&fits).is_ok());
    assert_eq!(canonicalize(b"\"\xff\"", None), Err(Refusal::InvalidUtf8));
    assert_eq!(canonicalize("\"\u{e9}\"".as_bytes(), Some(3)), Err(Refusal::TooLarge));
    assert!(canonicalize("\"\u{e9}\"".as_bytes(), Some(4)).is_ok());
}

#[test]
fn normalization_tables_are_in_order_and_in_range() {
    use crate::nfc_tables::{CLASS_RANK_RANGES, COMPOSITIONS, DECOMPOSITION_INDEX, DECOMPOSITION_POOL};
    // The lookups are binary searches and slices: they are right only if
    // every table is strictly sorted and every offset stays in its pool.
    assert!(DECOMPOSITION_INDEX.windows(2).all(|pair| pair[0].0 < pair[1].0));
    assert!(DECOMPOSITION_INDEX.iter().all(
        |&(_, offset, length)| length > 0 && usize::from(offset) + usize::from(length) <= DECOMPOSITION_POOL.len()
    ));
    assert!(CLASS_RANK_RANGES
        .iter()
        .all(|&(first, last, rank)| first <= last && rank > 0));
    assert!(CLASS_RANK_RANGES.windows(2).all(|pair| pair[0].1 < pair[1].0));
    assert!(COMPOSITIONS
        .windows(2)
        .all(|pair| (pair[0].0, pair[0].1) < (pair[1].0, pair[1].1)));
    // No table entry is a surrogate or past the last code point.
    let scalar = |point: u32| point <= 0x10FFFF && !(0xD800..=0xDFFF).contains(&point);
    assert!(DECOMPOSITION_POOL.iter().all(|&point| scalar(point)));
    assert!(COMPOSITIONS
        .iter()
        .all(|&(a, b, c)| scalar(a) && scalar(b) && scalar(c)));
    assert_eq!(crate::UNICODE_VERSION, "17.0");
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn number(text: &str) -> Value {
    Value::Number(text.as_bytes().to_vec())
}

#[test]
fn the_encoder_returns_bytes_exactly_for_admitted_trees() {
    let object = |keys: &[&str]| Value::Object(keys.iter().map(|key| (units(key), Value::Null)).collect());
    // Keys must strictly increase by UTF-16 code unit.
    assert_eq!(
        encode_admitted(&object(&["a", "b"])).as_deref(),
        Some(&b"{\"a\":null,\"b\":null}"[..])
    );
    assert_eq!(encode_admitted(&object(&["b", "a"])), None);
    assert_eq!(encode_admitted(&object(&["a", "a"])), None);
    assert_eq!(encode_admitted(&object(&["a", "b", "a"])), None);
    assert_eq!(encode_admitted(&object(&["\u{e000}", "\u{1f600}"])), None);
    assert!(encode_admitted(&object(&["", "a", "aa", "b"])).is_some());
    // A number's text must be a non-empty run of number bytes, at any depth.
    assert_eq!(encode_admitted(&number("")), None);
    assert_eq!(encode_admitted(&number("1,2")), None);
    assert_eq!(encode_admitted(&number("1 ")), None);
    assert_eq!(encode_admitted(&number("E")), None);
    assert_eq!(
        encode_admitted(&Value::Array(vec![Value::Null, Value::Array(vec![number("x")])])),
        None
    );
    assert_eq!(
        encode_admitted(&Value::Object(vec![(
            units("a"),
            Value::Object(vec![(units("b"), number("]"))])
        )])),
        None
    );
    assert_eq!(
        encode_admitted(&Value::Array(vec![
            number("-1.5e+300"),
            Value::Bool(true),
            Value::Bool(false)
        ]))
        .as_deref(),
        Some(&b"[-1.5e+300,true,false]"[..])
    );
}

#[test]
fn an_admitted_tree_need_not_be_canonical() {
    // The encoder's domain is wider than canonical JSON. These trees are
    // admitted, and `canonicalize` never builds them.
    assert_eq!(encode_admitted(&number("1.0")).as_deref(), Some(&b"1.0"[..]));
    assert_eq!(encode_admitted(&number("+e.")).as_deref(), Some(&b"+e."[..]));
    assert_eq!(
        encode_admitted(&Value::String(units("e\u{301}"))).as_deref(),
        Some("\"e\u{301}\"".as_bytes())
    );
    assert_eq!(canonicalize(b"1.0", None).as_deref(), Ok(&b"1"[..]));
    assert_eq!(canonicalize(b"+e.", None), Err(Refusal::InvalidJson));
    assert_eq!(
        canonicalize("\"e\u{301}\"".as_bytes(), None).as_deref(),
        Ok("\"\u{e9}\"".as_bytes())
    );
}

#[test]
fn a_budget_the_reference_cannot_use_refuses_every_text() {
    // "\u{e9}" in quotes is four bytes of UTF-8.
    let text = "\"\u{e9}\"".as_bytes();
    let with = |budget: f64| canonicalize_with_number_budget(text, Some(budget));
    for unusable in [
        4.5,
        4.000000000000001,
        f64::NAN,
        -0.5,
        -1.0,
        f64::NEG_INFINITY,
        f64::INFINITY,
        9007199254740992.0,
        18446744073709551616.0,
        1e300,
        5e-324,
    ] {
        assert_eq!(with(unusable), Err(Refusal::TooLarge), "budget {unusable}");
    }
    for too_small in [0.0, -0.0, 3.0] {
        assert_eq!(with(too_small), Err(Refusal::TooLarge), "budget {too_small}");
    }
    for enough in [4.0, 5.0, 9007199254740991.0] {
        assert!(with(enough).is_ok(), "budget {enough}");
    }
    assert!(canonicalize_with_number_budget(text, None).is_ok());
    // Bytes that are not UTF-8 are refused as that, before any budget.
    assert_eq!(
        canonicalize_with_number_budget(b"\"\xff\"", Some(f64::NAN)),
        Err(Refusal::InvalidUtf8)
    );
    assert_eq!(
        canonicalize_with_number_budget(b"\"\xff\"", Some(0.0)),
        Err(Refusal::InvalidUtf8)
    );
    // The empty text under a budget of zero is not too large; it is not JSON.
    assert_eq!(
        canonicalize_with_number_budget(b"", Some(-0.0)),
        Err(Refusal::InvalidJson)
    );
    assert_eq!(canonicalize_with_number_budget(b"", Some(-1.0)), Err(Refusal::TooLarge));
}
