//! A few fixed cases, so `cargo test` says something without Node. The
//! reference comparison is scripts/trust-kernel-differential.mjs.

use crate::{canonicalize, Refusal};

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
