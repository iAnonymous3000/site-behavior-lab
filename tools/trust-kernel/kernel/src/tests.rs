//! Unit tests for the address classifier and text reader.

use crate::{classify_address, read_address, AddressClass, AddressRead};

fn class(text: &str) -> AddressClass {
    classify_address(text.as_bytes())
}

#[test]
fn an_address_reads_as_the_reference_reads_it() {
    use AddressClass::{NotAnAddress, NotPublic, Public};
    for (text, expected) in [
        ("8.8.8.8", Public),
        ("223.255.255.255", Public),
        ("100.63.255.255", Public),
        ("100.64.0.0", NotPublic),
        ("10.0.0.1", NotPublic),
        ("0.0.0.0", NotPublic),
        ("255.255.255.255", NotPublic),
        ("192.0.0.9", NotPublic),
        ("192.0.0.10", NotPublic),
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
        ("::ffff:8.8.8.8", Public),
        ("::FFFF:8.8.8.8", Public),
        ("::ffff:808:808", Public),
        ("::ffff:0808:0808", Public),
        ("::ffff:10.0.0.1", NotPublic),
        ("::ffff:a00:1", NotPublic),
        ("0:0:0:0:0:ffff:8.8.8.8", NotPublic),
        ("::0:ffff:808:808", NotPublic),
        ("0::ffff:808:808", NotPublic),
        ("2001:1::1", Public),
        ("2001:1::2", Public),
        ("2001:1::3", Public),
        ("2001:1::4", NotPublic),
        ("2001:1:0:0:0:0:0:1", NotPublic),
        ("2001:0001::1", NotPublic),
        ("2001:1::01", NotPublic),
        ("2001:1:0::1", NotPublic),
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
        ("2600::8.8.8.8", Public),
        ("2600:0:0:0:0:0:1.2.3.4", Public),
        ("::1.2.3.4", NotPublic),
        ("64:ff9b::8.8.8.8", NotPublic),
        ("2600:1:2:3:4:5:8.8.8.8", Public),
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
    assert_eq!(read("2600:5:8.8.8.8::"), None);
    assert_eq!(read("1.2.3.4::"), None);
    assert_eq!(read("2600:5::8.8.8.8"), Some(AddressRead::V6(0x2600_0005_0000_0000_0000_0000_0808_0808)));
    assert_eq!(read("1.2.3"), None);
    assert_eq!(read("2600::1::"), None);
}
