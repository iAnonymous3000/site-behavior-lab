//! A few fixed cases, so `cargo test` says something without Node. The
//! reference comparison is scripts/trust-kernel-differential.mjs.

use crate::encode::{encode_admitted, Value};
use crate::{
    canonicalize, canonicalize_with_number_budget, classify_address, read_address, AddressClass, AddressRead, Refusal,
};

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

fn class(text: &str) -> AddressClass {
    classify_address(text.as_bytes())
}

#[test]
fn an_address_reads_as_the_reference_reads_it() {
    use AddressClass::{NotAnAddress, NotPublic, Public};
    // Each verdict here was read from lib/ip-safety.ts by running it.
    for (text, expected) in [
        ("8.8.8.8", Public),
        ("223.255.255.255", Public),
        ("100.63.255.255", Public),
        ("100.64.0.0", NotPublic),
        ("10.0.0.1", NotPublic),
        ("0.0.0.0", NotPublic),
        ("255.255.255.255", NotPublic),
        // The registry marks these two reachable; the reference refuses them.
        ("192.0.0.9", NotPublic),
        ("192.0.0.10", NotPublic),
        // A leading zero is octal to other readers: no address here.
        ("0177.0.0.1", NotAnAddress),
        ("08.8.8.8", NotAnAddress),
        ("8.8.8.256", NotAnAddress),
        ("8.8.8", NotAnAddress),
        ("8.8.8.8.8", NotAnAddress),
        ("0x8.8.8.8", NotAnAddress),
        ("", NotAnAddress),
        ("example.test", NotAnAddress),
        ("2600::1", Public),
        ("2600::127.0.0.1", Public),
        ("::1", NotPublic),
        ("::", NotPublic),
        ("fe80::1", NotPublic),
        ("2001:db8::1", NotPublic),
        ("2002:808:808::1", NotPublic),
        ("3fff:fff::1", NotPublic),
        ("3fff:1000::1", Public),
        ("2001:3::1", Public),
        ("2001:4:112::1", Public),
        ("2001:4:113::1", NotPublic),
        ("2001:0:808:808::1", NotPublic),
        ("2001:200::1", Public),
        ("1:2:3:4:5:6:7::", NotPublic),
        ("1::2:3:4:5:6:7:8", NotAnAddress),
        (":::", NotAnAddress),
        ("2600::1::2", NotAnAddress),
        ("2600::12345", NotAnAddress),
        ("2600::g", NotAnAddress),
        ("fe80::1%en0", NotAnAddress),
    ] {
        assert_eq!(class(text), expected, "{text}");
    }
}

#[test]
fn a_verdict_follows_the_spelling_where_the_reference_makes_it() {
    use AddressClass::{NotAnAddress, NotPublic, Public};
    for (text, expected) in [
        // A mapped address takes the IPv4 rule in two spellings only.
        ("::ffff:8.8.8.8", Public),
        ("::FFFF:8.8.8.8", Public),
        ("::ffff:808:808", Public),
        ("::ffff:0808:0808", Public),
        ("::ffff:10.0.0.1", NotPublic),
        ("::ffff:a00:1", NotPublic),
        ("0:0:0:0:0:ffff:8.8.8.8", NotPublic),
        ("::0:ffff:808:808", NotPublic),
        ("0::ffff:808:808", NotPublic),
        // The three anycast addresses, in their one spelling only.
        ("2001:1::1", Public),
        ("2001:1::2", Public),
        ("2001:1::3", Public),
        ("2001:1::4", NotPublic),
        ("2001:1:0:0:0:0:0:1", NotPublic),
        ("2001:0001::1", NotPublic),
        ("2001:1::01", NotPublic),
        ("2001:1:0::1", NotPublic),
        // A dotted quad is read only where it ends the text. Before a
        // closing `::` it is no address, with any words before it.
        ("2600:8.8.8.8::", NotAnAddress),
        ("2600:127.0.0.1::", NotAnAddress),
        ("2600:0:0:0:0:1.2.3.4::", NotAnAddress),
        ("2600:0:0:0:0:0:1.2.3.4::", NotAnAddress),
        ("2001:3:1.2.3.4::", NotAnAddress),
        ("2001:4:1.18.0.0::", NotAnAddress),
        ("1.2.3.4::", NotAnAddress),
        ("[2600:8.8.8.8::]", NotAnAddress),
        ("2600::1.2.3.4::", NotAnAddress),
        ("2600:1.2.3.4::5", NotAnAddress),
        ("2600:1.2.3.4:5::", NotAnAddress),
        // The same quad ending the text is read, after a `::` or with none.
        ("2600::8.8.8.8", Public),
        ("2600:0:0:0:0:0:1.2.3.4", Public),
        ("::1.2.3.4", NotPublic),
        ("64:ff9b::8.8.8.8", NotPublic),
        ("2600:1:2:3:4:5:8.8.8.8", Public),
        // One closing dot, one opening bracket, one closing bracket.
        ("8.8.8.8.", Public),
        ("8.8.8.8..", NotAnAddress),
        ("[8.8.8.8", Public),
        ("8.8.8.8]", Public),
        ("[8.8.8.8].", Public),
        ("8.8.8.8.]", NotAnAddress),
        ("[[8.8.8.8]]", NotAnAddress),
        ("[2001:1::1]", Public),
        ("2001:1::1.", Public),
        ("2600::1.", Public),
        ("[2600::1.]", NotAnAddress),
    ] {
        assert_eq!(class(text), expected, "{text}");
    }
    // Bytes outside ASCII, valid UTF-8 or not, are no address.
    assert_eq!(classify_address("8.8.8.\u{ff18}".as_bytes()), NotAnAddress);
    assert_eq!(classify_address(b"8.8.8.8\xff"), NotAnAddress);
}

#[test]
fn a_text_is_read_as_the_value_it_names() {
    let read = |text: &str| read_address(text.as_bytes());
    assert_eq!(read("1.2.3.4"), Some(AddressRead::V4(0x0102_0304)));
    assert_eq!(read("255.255.255.255"), Some(AddressRead::V4(0xffff_ffff)));
    assert_eq!(read("::"), Some(AddressRead::V6(0)));
    assert_eq!(read("::1"), Some(AddressRead::V6(1)));
    assert_eq!(read("1::"), Some(AddressRead::V6(1 << 112)));
    assert_eq!(
        read("1:2:3:4:5:6:7:8"),
        Some(AddressRead::V6(0x0001_0002_0003_0004_0005_0006_0007_0008))
    );
    assert_eq!(
        read("2001:DB8::a:1.2.3.4"),
        Some(AddressRead::V6(0x2001_0db8_0000_0000_0000_000a_0102_0304))
    );
    assert_eq!(
        read("1:2:3:4:5:6:1.2.3.4"),
        Some(AddressRead::V6(0x0001_0002_0003_0004_0005_0006_0102_0304))
    );
    assert_eq!(read("[::ffff:8.8.8.8]"), Some(AddressRead::V6(0xffff_0808_0808)));
    // A dotted quad before a closing `::` has no value.
    assert_eq!(read("2600:5:8.8.8.8::"), None);
    assert_eq!(read("1.2.3.4::"), None);
    assert_eq!(read("2600:5::8.8.8.8"), Some(AddressRead::V6(0x2600_0005_0000_0000_0000_0000_0808_0808)));
    assert_eq!(read("1.2.3"), None);
    assert_eq!(read("2600::1::"), None);
}
