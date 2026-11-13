//! The address classifier on values: which IPv4 and IPv6 addresses count as
//! public, with a machine-checked argument (Verus) that the executable
//! functions return exactly what a written specification says.
//!
//! The reference is `lib/ip-safety.ts`. This file follows it and replaces
//! nothing: nothing in the scanner, the Worker or the site calls this crate,
//! and the live boundary is still `lib/ip-safety.ts`.
//!
//! Everything in this file is inside `verus!`. An ordinary `cargo build`
//! erases the specifications and the lemmas and compiles the executable
//! functions as they stand, so the functions Verus checks are the functions
//! that ship. An address here is a VALUE: an IPv4 address is a `u32` and an
//! IPv6 address is a `u128`, most significant bits first. No text is read in
//! this file. One number per address means a block of addresses is one range
//! of numbers and the statements below speak about every value of the type
//! with no side condition, which eight separate words would not give.
//!
//! What Verus checks here, for every value and with no bound:
//!
//! - `is_public_ipv4(v)`, for every 32-bit `v`: it returns true exactly when
//!   `v` lies in none of the sixteen ranges of the table `ipv4_in_table`;
//! - `is_public_ipv6(v)`, for every 128-bit `v`: it returns true exactly when
//!   `ipv6_public(v)` holds, the rule written below as prefixes with their
//!   lengths;
//! - `is_public_ipv6_as_spelled`: the two facts about spelling that the text
//!   layer passes in can only turn a public answer into a refusal, never the
//!   other way;
//! - each line of the IPv4 table is the block its comment names, and each
//!   IPv6 prefix starts on a boundary of its own length
//!   (`theorem_ipv4_table_lines_are_the_named_blocks`,
//!   `theorem_ipv6_prefixes_are_aligned`);
//! - the executable functions overflow no integer.
//!
//! The specification is not the code's branches. The code compares octets
//! and 16-bit words, as the reference does. The specification is a table of
//! address ranges and a rule over prefixes, and Verus accepts that the two
//! agree. The specification is the first part of this file, up to the
//! heading "Checked statements about the specification itself"; the runner
//! (scripts/trust-kernel-verus.mjs) pins that text and the statements by
//! digest and by wording.
//!
//! What this does not say. That the table and the rule are what the IANA
//! registries list is a human reading, dated in the comments below, and
//! nothing here checks it. The statements trust Verus, Z3, vstd, the
//! compiler and the specification. Reading a text into a value is
//! `address_text.rs`, ordinary Rust, which Verus does not read: it is held to
//! the reference by the differential test and by nothing stronger.
//!
//! One place where the table follows the reference and not the registry: the
//! registry marks 192.0.0.9 and 192.0.0.10 as reachable from anywhere, and
//! the reference refuses all of 192.0.0.0/24. The kernel has to agree with
//! the reference, so the table has no exception for the two, and
//! `theorem_two_reachable_addresses_are_refused` states it. That is the open
//! finding OPEN-IP4.1 of `lib/fv-ipv4-classifier.test.ts`, left open here too.

use vstd::prelude::*;

verus! {

// ---------------------------------------------------------------------------
// The specification. Only this part says what "public" means.
// ---------------------------------------------------------------------------

/// Two to the power `n`.
pub open spec fn two_to(n: nat) -> int
    decreases n,
{
    if n == 0 {
        1
    } else {
        2 * two_to((n - 1) as nat)
    }
}

/// The IPv4 address written `a.b.c.d`, as a number.
pub open spec fn quad(a: int, b: int, c: int, d: int) -> int {
    ((a * 256 + b) * 256 + c) * 256 + d
}

/// From the address `low` to the address `high`, both included.
pub open spec fn within(v: int, low: int, high: int) -> bool {
    low <= v <= high
}

/// The table of IPv4 addresses that are not public: sixteen ranges, each
/// from its lowest address to its highest. They are the sixteen blocks of
/// `NON_PUBLIC_BLOCKS` in `lib/fv-ipv4-classifier.test.ts`, in its order.
/// The maintainer compared that table with the IANA IPv4 Special-Purpose
/// Address Registry on 2026-11-12. "Registry" below is that registry;
/// "address space registry" is the IANA IPv4 Address Space Registry.
///
/// The second to last range holds the last one. Both stay, as two lines of
/// the registry.
pub open spec fn ipv4_in_table(v: u32) -> bool {
    let v = v as int;
    // 0.0.0.0/8, this network. RFC 791, section 3.2; registry.
    within(v, quad(0, 0, 0, 0), quad(0, 255, 255, 255))
    // 10.0.0.0/8, private use. RFC 1918; registry.
     || within(v, quad(10, 0, 0, 0), quad(10, 255, 255, 255))
    // 100.64.0.0/10, shared address space. RFC 6598; registry.
     || within(v, quad(100, 64, 0, 0), quad(100, 127, 255, 255))
    // 127.0.0.0/8, loopback. RFC 1122, section 3.2.1.3; registry.
     || within(v, quad(127, 0, 0, 0), quad(127, 255, 255, 255))
    // 169.254.0.0/16, link local. RFC 3927; registry.
     || within(v, quad(169, 254, 0, 0), quad(169, 254, 255, 255))
    // 172.16.0.0/12, private use. RFC 1918; registry.
     || within(v, quad(172, 16, 0, 0), quad(172, 31, 255, 255))
    // 192.0.0.0/24, IETF protocol assignments. RFC 6890, section 2.1;
    // registry. The whole block, 192.0.0.9 and 192.0.0.10 included: see the
    // head of this file.
     || within(v, quad(192, 0, 0, 0), quad(192, 0, 0, 255))
    // 192.0.2.0/24, documentation, TEST-NET-1. RFC 5737; registry.
     || within(v, quad(192, 0, 2, 0), quad(192, 0, 2, 255))
    // 192.88.99.0/24, deprecated 6to4 relay anycast. RFC 7526; registry.
     || within(v, quad(192, 88, 99, 0), quad(192, 88, 99, 255))
    // 192.168.0.0/16, private use. RFC 1918; registry.
     || within(v, quad(192, 168, 0, 0), quad(192, 168, 255, 255))
    // 198.18.0.0/15, benchmarking. RFC 2544; registry.
     || within(v, quad(198, 18, 0, 0), quad(198, 19, 255, 255))
    // 198.51.100.0/24, documentation, TEST-NET-2. RFC 5737; registry.
     || within(v, quad(198, 51, 100, 0), quad(198, 51, 100, 255))
    // 203.0.113.0/24, documentation, TEST-NET-3. RFC 5737; registry.
     || within(v, quad(203, 0, 113, 0), quad(203, 0, 113, 255))
    // 224.0.0.0/4, multicast. RFC 5771; address space registry.
     || within(v, quad(224, 0, 0, 0), quad(239, 255, 255, 255))
    // 240.0.0.0/4, reserved. RFC 1112, section 4; registry.
     || within(v, quad(240, 0, 0, 0), quad(255, 255, 255, 255))
    // 255.255.255.255/32, the all-ones address of RFC 919, section 7, and
    // RFC 8190; registry.
     || within(v, quad(255, 255, 255, 255), quad(255, 255, 255, 255))
}

/// An IPv4 address is public exactly when it lies in no range of the table.
pub open spec fn ipv4_public(v: u32) -> bool {
    !ipv4_in_table(v)
}

/// The IPv6 block `prefix/len`: the two to the power (128 - len) addresses
/// from `prefix` up. With `len` 128 it is the one address `prefix`.
pub open spec fn block6(v: u128, prefix: u128, len: nat) -> bool {
    prefix <= v && v - prefix < two_to((128 - len) as nat)
}

/// ::ffff:0:0/96, an IPv4 address carried in an IPv6 one. RFC 4291, section
/// 2.5.5.2. Reference: `mappedIpv4FromIpv6`.
pub open spec fn ipv4_mapped(v: u128) -> bool {
    block6(v, 0x0000_0000_0000_0000_0000_ffff_0000_0000, 96)
}

/// The last 32 bits of an IPv6 address: for a mapped address, the IPv4
/// address it carries.
pub open spec fn last_32_bits(v: u128) -> u32 {
    (v % 0x1_0000_0000) as u32
}

/// The three single addresses inside 2001:1::/32 that the reference allows.
/// Reference: `isGloballyReachableProtocolAssignment`, whose comment names
/// them from the IANA IPv6 Special-Purpose Address Registry.
pub open spec fn protocol_anycast(v: u128) -> bool {
    // 2001:1::1/128, Port Control Protocol anycast. RFC 7723.
    block6(v, 0x2001_0001_0000_0000_0000_0000_0000_0001, 128)
    // 2001:1::2/128, Traversal Using Relays around NAT anycast. RFC 8155.
     || block6(v, 0x2001_0001_0000_0000_0000_0000_0000_0002, 128)
    // 2001:1::3/128, DNS-SD service registration anycast. RFC 9665.
     || block6(v, 0x2001_0001_0000_0000_0000_0000_0000_0003, 128)
}

/// The assignments inside 2001::/23 that the reference allows: the only
/// ones, by its comment, that the IANA IPv6 Special-Purpose Address Registry
/// marks as reachable from anywhere. Reference:
/// `isGloballyReachableProtocolAssignment`.
pub open spec fn reachable_protocol_assignment(v: u128) -> bool {
    protocol_anycast(v)
    // 2001:3::/32, Automatic Multicast Tunneling. RFC 7450.
     || block6(v, 0x2001_0003_0000_0000_0000_0000_0000_0000, 32)
    // 2001:4:112::/48, the AS112-v6 redirection service. RFC 7535.
     || block6(v, 0x2001_0004_0112_0000_0000_0000_0000_0000, 48)
}

/// The rule for IPv6, as the reference's `isPublicIpv6` has it. The lines
/// were taken from the reference's code and comments on 2026-11-12. The RFC
/// beside a line is where its block is defined, as the author of this file
/// knows it; the reference's comments name only RFC 9665. The IANA
/// registries were not read again for this file, so no line here has been
/// compared with them.
pub open spec fn ipv6_public(v: u128) -> bool {
    if ipv4_mapped(v) {
        // An IPv4-mapped address takes the IPv4 rule of the address it
        // carries.
        ipv4_public(last_32_bits(v))
    } else {
        // 2000::/3 only: the unicast block IANA assigns routable space from
        // (RFC 4291, section 2.4; IANA IPv6 Address Space Registry). All
        // other space is refused, named in a registry or not.
        block6(v, 0x2000_0000_0000_0000_0000_0000_0000_0000, 3)
        // Inside 2001::/23, IETF protocol assignments (RFC 2928), only the
        // listed assignments.
         && (block6(v, 0x2001_0000_0000_0000_0000_0000_0000_0000, 23) ==> reachable_protocol_assignment(v))
        // 2001:db8::/32, documentation. RFC 3849.
         && !block6(v, 0x2001_0db8_0000_0000_0000_0000_0000_0000, 32)
        // 2002::/16, 6to4. RFC 3056.
         && !block6(v, 0x2002_0000_0000_0000_0000_0000_0000_0000, 16)
        // 3fff::/20, documentation. RFC 9637.
         && !block6(v, 0x3fff_0000_0000_0000_0000_0000_0000_0000, 20)
    }
}

/// What it means for a line of the IPv4 table to be the block `low/len`:
/// `low` starts a block of that length and `high` is the block's last
/// address.
pub open spec fn is_ipv4_block(low: int, high: int, len: nat) -> bool {
    low % two_to((32 - len) as nat) == 0 && high == low + two_to((32 - len) as nat) - 1
}

/// What it means for an IPv6 prefix to start on a boundary of its length.
pub open spec fn is_ipv6_prefix(prefix: u128, len: nat) -> bool {
    prefix as int % two_to((128 - len) as nat) == 0
}

// ---------------------------------------------------------------------------
// Checked statements about the specification itself.
// ---------------------------------------------------------------------------

/// The powers of two the statements below use, as numbers.
proof fn lemma_powers_of_two()
    ensures
        two_to(0) == 1,
        two_to(8) == 0x100,
        two_to(16) == 0x1_0000,
        two_to(17) == 0x2_0000,
        two_to(20) == 0x10_0000,
        two_to(22) == 0x40_0000,
        two_to(24) == 0x100_0000,
        two_to(28) == 0x1000_0000,
        two_to(32) == 0x1_0000_0000,
        two_to(80) == 0x1_0000_0000_0000_0000_0000,
        two_to(96) == 0x1_0000_0000_0000_0000_0000_0000,
        two_to(105) == 0x200_0000_0000_0000_0000_0000_0000,
        two_to(108) == 0x1000_0000_0000_0000_0000_0000_0000,
        two_to(112) == 0x1_0000_0000_0000_0000_0000_0000_0000,
        two_to(125) == 0x2000_0000_0000_0000_0000_0000_0000_0000,
{
    // Eight doublings at a time, each step from the one before it, so no
    // single step asks the solver to unfold far.
    reveal_with_fuel(two_to, 9);
    assert(two_to(8) == 0x100);
    assert(two_to(16) == 0x1_0000);
    assert(two_to(17) == 0x2_0000);
    assert(two_to(20) == 0x10_0000);
    assert(two_to(22) == 0x40_0000);
    assert(two_to(24) == 0x100_0000);
    assert(two_to(28) == 0x1000_0000);
    assert(two_to(32) == 0x1_0000_0000);
    assert(two_to(40) == 0x100_0000_0000);
    assert(two_to(48) == 0x1_0000_0000_0000);
    assert(two_to(56) == 0x100_0000_0000_0000);
    assert(two_to(64) == 0x1_0000_0000_0000_0000);
    assert(two_to(72) == 0x100_0000_0000_0000_0000);
    assert(two_to(80) == 0x1_0000_0000_0000_0000_0000);
    assert(two_to(88) == 0x100_0000_0000_0000_0000_0000);
    assert(two_to(96) == 0x1_0000_0000_0000_0000_0000_0000);
    assert(two_to(104) == 0x100_0000_0000_0000_0000_0000_0000);
    assert(two_to(105) == 0x200_0000_0000_0000_0000_0000_0000);
    assert(two_to(108) == 0x1000_0000_0000_0000_0000_0000_0000);
    assert(two_to(112) == 0x1_0000_0000_0000_0000_0000_0000_0000);
    assert(two_to(120) == 0x100_0000_0000_0000_0000_0000_0000_0000);
    assert(two_to(125) == 0x2000_0000_0000_0000_0000_0000_0000_0000);
}

/// Each line of the IPv4 table is the block its comment names.
pub proof fn theorem_ipv4_table_lines_are_the_named_blocks()
    ensures
        is_ipv4_block(quad(0, 0, 0, 0), quad(0, 255, 255, 255), 8),
        is_ipv4_block(quad(10, 0, 0, 0), quad(10, 255, 255, 255), 8),
        is_ipv4_block(quad(100, 64, 0, 0), quad(100, 127, 255, 255), 10),
        is_ipv4_block(quad(127, 0, 0, 0), quad(127, 255, 255, 255), 8),
        is_ipv4_block(quad(169, 254, 0, 0), quad(169, 254, 255, 255), 16),
        is_ipv4_block(quad(172, 16, 0, 0), quad(172, 31, 255, 255), 12),
        is_ipv4_block(quad(192, 0, 0, 0), quad(192, 0, 0, 255), 24),
        is_ipv4_block(quad(192, 0, 2, 0), quad(192, 0, 2, 255), 24),
        is_ipv4_block(quad(192, 88, 99, 0), quad(192, 88, 99, 255), 24),
        is_ipv4_block(quad(192, 168, 0, 0), quad(192, 168, 255, 255), 16),
        is_ipv4_block(quad(198, 18, 0, 0), quad(198, 19, 255, 255), 15),
        is_ipv4_block(quad(198, 51, 100, 0), quad(198, 51, 100, 255), 24),
        is_ipv4_block(quad(203, 0, 113, 0), quad(203, 0, 113, 255), 24),
        is_ipv4_block(quad(224, 0, 0, 0), quad(239, 255, 255, 255), 4),
        is_ipv4_block(quad(240, 0, 0, 0), quad(255, 255, 255, 255), 4),
        is_ipv4_block(quad(255, 255, 255, 255), quad(255, 255, 255, 255), 32),
{
    lemma_powers_of_two();
}

/// Each IPv6 prefix of the rule starts on a boundary of its own length, so
/// `block6` of it is the block that the prefix and length name.
pub proof fn theorem_ipv6_prefixes_are_aligned()
    ensures
        is_ipv6_prefix(0x0000_0000_0000_0000_0000_ffff_0000_0000, 96),
        is_ipv6_prefix(0x2000_0000_0000_0000_0000_0000_0000_0000, 3),
        is_ipv6_prefix(0x2001_0000_0000_0000_0000_0000_0000_0000, 23),
        is_ipv6_prefix(0x2001_0001_0000_0000_0000_0000_0000_0001, 128),
        is_ipv6_prefix(0x2001_0001_0000_0000_0000_0000_0000_0002, 128),
        is_ipv6_prefix(0x2001_0001_0000_0000_0000_0000_0000_0003, 128),
        is_ipv6_prefix(0x2001_0003_0000_0000_0000_0000_0000_0000, 32),
        is_ipv6_prefix(0x2001_0004_0112_0000_0000_0000_0000_0000, 48),
        is_ipv6_prefix(0x2001_0db8_0000_0000_0000_0000_0000_0000, 32),
        is_ipv6_prefix(0x2002_0000_0000_0000_0000_0000_0000_0000, 16),
        is_ipv6_prefix(0x3fff_0000_0000_0000_0000_0000_0000_0000, 20),
{
    lemma_powers_of_two();
}

/// The table refuses 192.0.0.9 and 192.0.0.10, which the registry marks as
/// reachable from anywhere. This is the reference's verdict, kept on
/// purpose and not a claim that it is the right one.
pub proof fn theorem_two_reachable_addresses_are_refused()
    ensures
        !ipv4_public(0xc000_0009),
        !ipv4_public(0xc000_000a),
        0xc000_0009 == quad(192, 0, 0, 9),
        0xc000_000a == quad(192, 0, 0, 10),
{
}

/// The specification refuses neither everything nor nothing: four addresses
/// that are public by it and four that are not.
pub proof fn theorem_the_specification_parts_addresses()
    ensures
        // 8.8.8.8 and 223.255.255.255 are public; 10.0.0.1 and 127.0.0.1 are not.
        ipv4_public(0x0808_0808),
        ipv4_public(0xdfff_ffff),
        !ipv4_public(0x0a00_0001),
        !ipv4_public(0x7f00_0001),
        // 2600::1 and ::ffff:8.8.8.8 are public; ::1 and ::ffff:127.0.0.1 are not.
        ipv6_public(0x2600_0000_0000_0000_0000_0000_0000_0001),
        ipv6_public(0x0000_0000_0000_0000_0000_ffff_0808_0808),
        !ipv6_public(0x0000_0000_0000_0000_0000_0000_0000_0001),
        !ipv6_public(0x0000_0000_0000_0000_0000_ffff_7f00_0001),
{
    lemma_powers_of_two();
}

// ---------------------------------------------------------------------------
// The executable classifier, written as the reference writes it.
// ---------------------------------------------------------------------------

/// The executable IPv4 classifier's branches, as one condition on the first
/// three octets. Not part of the specification: it is the code restated, so
/// that one argument can tie all of it to the table.
spec fn refused_by_octets(a: int, b: int, c: int) -> bool {
    (a == 0 || a == 10 || a == 127 || a >= 224)
     || (a == 100 && b >= 64 && b <= 127)
     || (a == 169 && b == 254)
     || (a == 172 && b >= 16 && b <= 31)
     || (a == 192 && b == 168)
     || (a == 192 && b == 0 && c == 0)
     || (a == 192 && b == 0 && c == 2)
     || (a == 192 && b == 88 && c == 99)
     || (a == 198 && (b == 18 || b == 19))
     || (a == 198 && b == 51 && c == 100)
     || (a == 203 && b == 0 && c == 113)
}

/// An address is in the table exactly when its first three octets meet one
/// of the branches.
proof fn lemma_table_by_octets(v: u32, a: int, b: int, c: int, d: int)
    requires
        v as int == quad(a, b, c, d),
        0 <= a < 256,
        0 <= b < 256,
        0 <= c < 256,
        0 <= d < 256,
    ensures
        ipv4_in_table(v) == refused_by_octets(a, b, c),
{
}

/// Whether an IPv4 address is public. The branches are the reference's
/// `isPublicIpv4`, line for line, on the first three octets.
pub fn is_public_ipv4(v: u32) -> (r: bool)
    ensures
        r == ipv4_public(v),
{
    let a = (v >> 24) as u8;
    let b = (v >> 16) as u8;
    let c = (v >> 8) as u8;
    proof {
        let d = v & 0xff;
        assert(v == ((((v >> 24) as u8) as u32 * 256 + ((v >> 16) as u8) as u32) * 256 + ((v >> 8) as u8) as u32) * 256
            + (v & 0xff) && (v & 0xff) < 256) by (bit_vector);
        lemma_table_by_octets(v, a as int, b as int, c as int, d as int);
    }
    if a == 0 || a == 10 || a == 127 || a >= 224 {
        return false;
    }
    if a == 100 && b >= 64 && b <= 127 {
        return false;
    }
    if a == 169 && b == 254 {
        return false;
    }
    if a == 172 && b >= 16 && b <= 31 {
        return false;
    }
    if a == 192 && b == 168 {
        return false;
    }
    if a == 192 && b == 0 && c == 0 {
        return false;
    }
    if a == 192 && b == 0 && c == 2 {
        return false;
    }
    if a == 192 && b == 88 && c == 99 {
        return false;
    }
    if a == 198 && (b == 18 || b == 19) {
        return false;
    }
    if a == 198 && b == 51 && c == 100 {
        return false;
    }
    if a == 203 && b == 0 && c == 113 {
        return false;
    }
    true
}

/// Whether an IPv6 address is IPv4-mapped: its first 96 bits are eighty
/// zeros and sixteen ones.
pub fn is_ipv4_mapped(v: u128) -> (r: bool)
    ensures
        r == ipv4_mapped(v),
{
    proof {
        lemma_powers_of_two();
        assert((v >> 32) == 0xffff <==> 0x0000_0000_0000_0000_0000_ffff_0000_0000 <= v && v
            < 0x0000_0000_0000_0000_0001_0000_0000_0000) by (bit_vector);
    }
    (v >> 32) == 0xffff
}

/// Whether an IPv6 address is one of the three single addresses inside
/// 2001:1::/32 that the reference allows.
pub fn is_protocol_anycast(v: u128) -> (r: bool)
    ensures
        r == protocol_anycast(v),
{
    proof {
        lemma_powers_of_two();
    }
    v == 0x2001_0001_0000_0000_0000_0000_0000_0001 || v == 0x2001_0001_0000_0000_0000_0000_0000_0002 || v
        == 0x2001_0001_0000_0000_0000_0000_0000_0003
}

/// Whether an IPv6 address is public. The branches are the reference's
/// `isPublicIpv6` and `isGloballyReachableProtocolAssignment`, on the first
/// three 16-bit words. Where the reference compares a text with
/// `2001:1::1`, this compares the value with that address.
pub fn is_public_ipv6(v: u128) -> (r: bool)
    ensures
        r == ipv6_public(v),
{
    if is_ipv4_mapped(v) {
        proof {
            assert(v as u32 == v % 0x1_0000_0000) by (bit_vector);
        }
        return is_public_ipv4(v as u32);
    }
    let first = (v >> 112) as u16;
    let second = (v >> 96) as u16;
    let third = (v >> 80) as u16;
    proof {
        lemma_powers_of_two();
        let rest = v & 0xffff_ffff_ffff_ffff_ffff;
        assert(v == ((((v >> 112) as u16) as u128 * 0x1_0000 + ((v >> 96) as u16) as u128) * 0x1_0000
            + ((v >> 80) as u16) as u128) * 0x1_0000_0000_0000_0000_0000 + (v & 0xffff_ffff_ffff_ffff_ffff)
            && (v & 0xffff_ffff_ffff_ffff_ffff) < 0x1_0000_0000_0000_0000_0000) by (bit_vector);
        assert(v == ((first as int * 0x1_0000 + second as int) * 0x1_0000 + third as int) * 0x1_0000_0000_0000_0000_0000
            + rest as int);
        assert((second & 0xf000) == 0 <==> second < 0x1000) by (bit_vector);
    }
    if first < 0x2000 || first > 0x3fff {
        return false;
    }
    if first == 0x2001 && second <= 0x01ff {
        if second == 0x0001 {
            return is_protocol_anycast(v);
        }
        if second == 0x0003 {
            return true;
        }
        if second == 0x0004 {
            return third == 0x0112;
        }
        return false;
    }
    if first == 0x2001 && second == 0x0db8 {
        return false;
    }
    if first == 0x2002 {
        return false;
    }
    if first == 0x3fff && (second & 0xf000) == 0 {
        return false;
    }
    true
}

/// The verdict for an IPv6 address as a text spelled it. The reference
/// reads two things from the spelling and not from the value: it applies the
/// IPv4 rule to a mapped address only when the text is `::ffff:` and then a
/// dotted quad or two words, and it allows the three addresses of
/// `protocol_anycast` only when the text is exactly `2001:1::1`, `2001:1::2`
/// or `2001:1::3`. Any other spelling of those addresses it refuses.
/// `address_text.rs` reads the two facts from the text and passes them in.
///
/// Whatever the two facts are, the answer is public only for a value that
/// `ipv6_public` calls public. Verus does not check that the text layer
/// passes the right facts or the right value.
pub fn is_public_ipv6_as_spelled(v: u128, spelled_as_mapped: bool, spelled_as_anycast: bool) -> (r: bool)
    ensures
        r == (ipv6_public(v) && (ipv4_mapped(v) ==> spelled_as_mapped) && (protocol_anycast(v) ==> spelled_as_anycast)),
        r ==> ipv6_public(v),
{
    if is_ipv4_mapped(v) && !spelled_as_mapped {
        return false;
    }
    if is_protocol_anycast(v) && !spelled_as_anycast {
        return false;
    }
    is_public_ipv6(v)
}

} // verus!
