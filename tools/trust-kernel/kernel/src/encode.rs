//! The encoder: a value tree to its bytes, with a machine-checked argument
//! (Verus) that two different admitted trees never share bytes.
//!
//! Everything in this file is inside `verus!`. An ordinary `cargo build`
//! erases the specifications and the lemmas and compiles the executable
//! functions as they stand, so the functions Verus checks are the functions
//! that ship. What Verus checks here, for every input and with no bound:
//!
//! - `encode_admitted` returns bytes exactly when `admitted` accepts the
//!   value's tree, and those bytes are exactly `encode` of that tree;
//! - `theorem_encoding_is_injective`: two trees whose number texts are number
//!   tokens, with equal `encode` bytes, are the same tree. Every admitted
//!   tree is such a tree (`theorem_admitted_numbers_are_tokens`), so two
//!   admitted trees never share bytes
//!   (`theorem_admitted_trees_never_share_bytes`);
//! - `theorem_admitted_object_has_no_key_twice`: in an admitted object each
//!   key is less than every later key, so the keys of every object the
//!   encoder writes strictly increase and none is there twice;
//! - the executable functions index nothing out of range and overflow no
//!   integer.
//!
//! Injectivity does not depend on the key order. The argument reads an object
//! as an ordered list of members; it holds for keys in any order, repeated
//! keys included. The key order is a separate statement, the third above.
//!
//! "Admitted" is the domain of these statements and it is wider than
//! "canonical". An admitted tree may hold a string that is not normalized
//! and a number text that is not the shortest one, or not a number at all
//! (`1.0`, `01`, `+e.`). `encode` is a written specification, trusted as the
//! meaning of "the bytes of a tree".
//!
//! What Verus does not check: that `encode` is JSON, or that it is what
//! `lib/canonical-json.ts` writes (the differential test holds that); how a
//! tree is built from input bytes (parsing, number text, normalization, all
//! in the other modules), and so that the trees `canonicalize` builds are
//! always admitted; memory exhaustion; stack depth.

use vstd::prelude::*;

verus! {

/// A value tree as the encoder takes it. A number is carried as its finished
/// text, and a string as UTF-16 code units, lone surrogates included, because
/// that is what a JavaScript string is and the reference orders keys by
/// those units. Nothing in the type makes a value canonical, or admitted.
pub enum Value {
    Null,
    Bool(bool),
    Number(Vec<u8>),
    String(Vec<u16>),
    Array(Vec<Value>),
    Object(Vec<(Vec<u16>, Value)>),
}

/// The mathematical tree an executable `Value` stands for. Only the
/// specifications name it, so an ordinary build sees it unused.
#[allow(dead_code)]
pub enum Tree {
    Null,
    Bool(bool),
    Number(Seq<u8>),
    String(Seq<u16>),
    Array(Seq<Tree>),
    Object(Seq<(Seq<u16>, Tree)>),
}

pub open spec fn tree_of(v: Value) -> Tree
    decreases v,
{
    match v {
        Value::Null => Tree::Null,
        Value::Bool(b) => Tree::Bool(b),
        Value::Number(n) => Tree::Number(n@),
        Value::String(s) => Tree::String(s@),
        Value::Array(a) => Tree::Array(
            Seq::new(
                a@.len(),
                |i: int|
                    if 0 <= i < a@.len() {
                        tree_of(a@[i])
                    } else {
                        Tree::Null
                    },
            ),
        ),
        Value::Object(m) => Tree::Object(
            Seq::new(
                m@.len(),
                |i: int|
                    if 0 <= i < m@.len() {
                        (m@[i].0@, tree_of(m@[i].1))
                    } else {
                        (Seq::empty(), Tree::Null)
                    },
            ),
        ),
    }
}

// ---------------------------------------------------------------------------
// The encoding, as mathematics.
// ---------------------------------------------------------------------------

/// The bytes a number's text may hold: digits, minus, plus, point, `e`.
pub open spec fn is_number_byte(b: u8) -> bool {
    (0x30 <= b && b <= 0x39) || b == 0x2d || b == 0x2b || b == 0x2e || b == 0x65
}

pub open spec fn number_token(t: Seq<u8>) -> bool {
    t.len() > 0 && forall|i: int| 0 <= i < t.len() ==> is_number_byte(#[trigger] t[i])
}

pub open spec fn is_high(u: u16) -> bool {
    0xD800 <= u && u <= 0xDBFF
}

pub open spec fn is_low(u: u16) -> bool {
    0xDC00 <= u && u <= 0xDFFF
}

/// One lower-case hexadecimal digit. Read only for n below 16.
pub open spec fn hex_digit(n: u16) -> u8 {
    if n < 10 {
        (0x30 + n) as u8
    } else {
        (0x57 + n) as u8
    }
}

pub open spec fn escape_u(u: u16) -> Seq<u8> {
    seq![
        0x5cu8,
        0x75u8,
        hex_digit(u >> 12),
        hex_digit((u >> 8) & 0xf),
        hex_digit((u >> 4) & 0xf),
        hex_digit(u & 0xf),
    ]
}

/// One code unit that is not the first half of a surrogate pair, as
/// JSON.stringify writes it: the short escapes, `\u00xx` for the other
/// controls, `\udxxx` for a lone surrogate, and UTF-8 for the rest.
pub open spec fn unit_bytes(u: u16) -> Seq<u8> {
    if u == 0x22 {
        seq![0x5cu8, 0x22u8]
    } else if u == 0x5c {
        seq![0x5cu8, 0x5cu8]
    } else if u == 0x08 {
        seq![0x5cu8, 0x62u8]
    } else if u == 0x09 {
        seq![0x5cu8, 0x74u8]
    } else if u == 0x0a {
        seq![0x5cu8, 0x6eu8]
    } else if u == 0x0c {
        seq![0x5cu8, 0x66u8]
    } else if u == 0x0d {
        seq![0x5cu8, 0x72u8]
    } else if u < 0x20 || (0xD800 <= u && u <= 0xDFFF) {
        escape_u(u)
    } else if u < 0x80 {
        seq![u as u8]
    } else if u < 0x800 {
        seq![(0xC0u16 | (u >> 6)) as u8, (0x80u16 | (u & 0x3F)) as u8]
    } else {
        seq![
            (0xE0u16 | (u >> 12)) as u8,
            (0x80u16 | ((u >> 6) & 0x3F)) as u8,
            (0x80u16 | (u & 0x3F)) as u8,
        ]
    }
}

/// The plane number of a surrogate pair's code point: 1 to 16.
pub open spec fn pair_plane(hi: u16) -> u16 {
    (((hi >> 6) & 0xF) + 1) as u16
}

/// A surrogate pair as the four UTF-8 bytes of its code point.
pub open spec fn pair_bytes(hi: u16, lo: u16) -> Seq<u8> {
    let w = pair_plane(hi);
    seq![
        (0xF0u16 | (w >> 2)) as u8,
        (0x80u16 | ((w & 0x3) << 4) | ((hi >> 2) & 0xF)) as u8,
        (0x80u16 | ((hi & 0x3) << 4) | ((lo >> 6) & 0xF)) as u8,
        (0x80u16 | (lo & 0x3F)) as u8,
    ]
}

/// How many code units the first token of a non-empty string takes.
pub open spec fn head_len(s: Seq<u16>) -> int {
    if s.len() >= 2 && is_high(s[0]) && is_low(s[1]) {
        2
    } else {
        1
    }
}

pub open spec fn head_bytes(s: Seq<u16>) -> Seq<u8> {
    if head_len(s) == 2 {
        pair_bytes(s[0], s[1])
    } else {
        unit_bytes(s[0])
    }
}

/// A string's content between its quotes.
pub open spec fn string_bytes(s: Seq<u16>) -> Seq<u8>
    decreases s.len(),
{
    if s.len() == 0 {
        Seq::empty()
    } else {
        head_bytes(s) + string_bytes(s.subrange(head_len(s), s.len() as int))
    }
}

pub open spec fn encode(t: Tree) -> Seq<u8>
    decreases t, 0nat,
{
    match t {
        Tree::Null => seq![0x6eu8, 0x75u8, 0x6cu8, 0x6cu8],
        Tree::Bool(b) => if b {
            seq![0x74u8, 0x72u8, 0x75u8, 0x65u8]
        } else {
            seq![0x66u8, 0x61u8, 0x6cu8, 0x73u8, 0x65u8]
        },
        Tree::Number(n) => n,
        Tree::String(s) => seq![0x22u8] + string_bytes(s) + seq![0x22u8],
        Tree::Array(a) => seq![0x5bu8] + items_from(a, 0) + seq![0x5du8],
        Tree::Object(m) => seq![0x7bu8] + members_from(m, 0) + seq![0x7du8],
    }
}

/// A comma before every item but the first.
pub open spec fn separator(i: int) -> Seq<u8> {
    if i > 0 {
        seq![0x2cu8]
    } else {
        Seq::empty()
    }
}

/// The items of an array from index i on, commas included.
pub open spec fn items_from(a: Seq<Tree>, i: int) -> Seq<u8>
    decreases a, a.len() - i,
{
    if i < 0 || i >= a.len() {
        Seq::empty()
    } else {
        separator(i) + encode(a[i]) + items_from(a, i + 1)
    }
}

pub open spec fn member_bytes(key: Seq<u16>, value: Tree) -> Seq<u8>
    decreases value, 1nat,
{
    seq![0x22u8] + string_bytes(key) + seq![0x22u8, 0x3au8] + encode(value)
}

/// The members of an object from index i on, commas included.
pub open spec fn members_from(m: Seq<(Seq<u16>, Tree)>, i: int) -> Seq<u8>
    decreases m, m.len() - i,
{
    if i < 0 || i >= m.len() {
        Seq::empty()
    } else {
        separator(i) + member_bytes(m[i].0, m[i].1) + members_from(m, i + 1)
    }
}

// ---------------------------------------------------------------------------
// The admitted domain.
// ---------------------------------------------------------------------------

/// Where two keys first differ, or where the shorter one ends.
pub open spec fn parts_at(a: Seq<u16>, b: Seq<u16>, k: int) -> bool {
    (k == a.len() && k < b.len()) || (k < a.len() && k < b.len() && a[k] < b[k])
}

/// Key order: by UTF-16 code unit, a proper prefix first. This is the order
/// of JavaScript's default sort, which the reference sorts keys with.
pub open spec fn key_less(a: Seq<u16>, b: Seq<u16>) -> bool {
    exists|k: int|
        0 <= k && k <= a.len() && k <= b.len() && (forall|j: int| 0 <= j < k ==> a[j] == b[j])
            && #[trigger] parts_at(a, b, k)
}

/// The trees the encoder accepts: every number's text is a non-empty run of
/// number bytes, and every object's keys strictly increase. The first clause
/// is what injectivity uses (`numbers_are_tokens`); the second is what
/// `theorem_admitted_object_has_no_key_twice` uses.
pub open spec fn admitted(t: Tree) -> bool
    decreases t,
{
    match t {
        Tree::Null => true,
        Tree::Bool(_) => true,
        Tree::Number(n) => number_token(n),
        Tree::String(_) => true,
        Tree::Array(a) => forall|i: int| 0 <= i < a.len() ==> admitted(#[trigger] a[i]),
        Tree::Object(m) => (forall|i: int| 0 <= i < m.len() ==> admitted((#[trigger] m[i]).1)) && (
        forall|i: int| 0 < i < m.len() ==> key_less(m[i - 1].0, (#[trigger] m[i]).0)),
    }
}

/// The part of `admitted` that injectivity rests on: every number's text,
/// at every depth, is a non-empty run of number bytes. Nothing is asked of
/// strings or of keys.
pub open spec fn numbers_are_tokens(t: Tree) -> bool
    decreases t,
{
    match t {
        Tree::Null => true,
        Tree::Bool(_) => true,
        Tree::Number(n) => number_token(n),
        Tree::String(_) => true,
        Tree::Array(a) => forall|i: int| 0 <= i < a.len() ==> numbers_are_tokens(#[trigger] a[i]),
        Tree::Object(m) => forall|i: int|
            0 <= i < m.len() ==> numbers_are_tokens((#[trigger] m[i]).1),
    }
}

/// What may follow a value: nothing, or a byte no number holds. Inside an
/// array or an object that byte is a comma or the closing bracket.
pub open spec fn delimited(r: Seq<u8>) -> bool {
    r.len() == 0 || !is_number_byte(r[0])
}

// ---------------------------------------------------------------------------
// Injectivity.
// ---------------------------------------------------------------------------

proof fn lemma_cancel_prefix(p: Seq<u8>, x: Seq<u8>, y: Seq<u8>)
    requires
        p + x == p + y,
    ensures
        x == y,
{
    assert(x =~= (p + x).subrange(p.len() as int, (p + x).len() as int));
    assert(y =~= (p + y).subrange(p.len() as int, (p + y).len() as int));
}

/// Two texts of equal length at the front of one sequence are one text.
proof fn lemma_same_front(p: Seq<u8>, x: Seq<u8>, q: Seq<u8>, y: Seq<u8>)
    requires
        p + x == q + y,
        p.len() == q.len(),
    ensures
        p == q,
        x == y,
{
    let w = p + x;
    assert(p =~= w.subrange(0, p.len() as int));
    assert(q =~= (q + y).subrange(0, q.len() as int));
    assert(x =~= w.subrange(p.len() as int, w.len() as int));
    assert(y =~= (q + y).subrange(q.len() as int, w.len() as int));
}

proof fn lemma_hex_digit_injective(n: u16, m: u16)
    requires
        n < 16,
        m < 16,
        hex_digit(n) == hex_digit(m),
    ensures
        n == m,
{
}

proof fn lemma_escape_u_injective(u: u16, v: u16)
    requires
        escape_u(u) == escape_u(v),
    ensures
        u == v,
{
    let a = escape_u(u);
    let b = escape_u(v);
    assert(a[2] == b[2] && a[3] == b[3] && a[4] == b[4] && a[5] == b[5]);
    assert((u >> 12) < 16 && ((u >> 8) & 0xf) < 16 && ((u >> 4) & 0xf) < 16 && (u & 0xf) < 16)
        by (bit_vector);
    assert((v >> 12) < 16 && ((v >> 8) & 0xf) < 16 && ((v >> 4) & 0xf) < 16 && (v & 0xf) < 16)
        by (bit_vector);
    lemma_hex_digit_injective(u >> 12, v >> 12);
    lemma_hex_digit_injective((u >> 8) & 0xf, (v >> 8) & 0xf);
    lemma_hex_digit_injective((u >> 4) & 0xf, (v >> 4) & 0xf);
    lemma_hex_digit_injective(u & 0xf, v & 0xf);
    assert(u == v) by (bit_vector)
        requires
            u >> 12 == v >> 12,
            (u >> 8) & 0xf == (v >> 8) & 0xf,
            (u >> 4) & 0xf == (v >> 4) & 0xf,
            u & 0xf == v & 0xf,
    ;
}

/// The length of a string token, read from its first two bytes.
pub open spec fn token_len(b0: u8, b1: u8) -> int {
    if b0 == 0x5c {
        if b1 == 0x75 {
            6
        } else {
            2
        }
    } else if b0 < 0x80 {
        1
    } else if b0 < 0xE0 {
        2
    } else if b0 < 0xF0 {
        3
    } else {
        4
    }
}

/// The shape of one code unit's bytes: never a bare quote first, and a
/// length the first two bytes decide.
proof fn lemma_unit_shape(u: u16)
    ensures
        unit_bytes(u).len() >= 1,
        unit_bytes(u).len() != 4,
        unit_bytes(u)[0] != 0x22,
        unit_bytes(u)[0] == 0x5c ==> unit_bytes(u).len() >= 2 && unit_bytes(u).len() == token_len(
            0x5c,
            unit_bytes(u)[1],
        ),
        unit_bytes(u)[0] != 0x5c ==> unit_bytes(u).len() == token_len(unit_bytes(u)[0], 0),
        u >= 0x80 && !(0xD800 <= u && u <= 0xDFFF) ==> unit_bytes(u)[0] >= 0xC2,
{
    if u >= 0x80 && u < 0x800 {
        assert(0xC2 <= (0xC0u16 | (u >> 6)) && (0xC0u16 | (u >> 6)) <= 0xDF) by (bit_vector)
            requires
                u >= 0x80 && u < 0x800,
        ;
    } else if u >= 0x800 {
        assert(0xE0 <= (0xE0u16 | (u >> 12)) && (0xE0u16 | (u >> 12)) <= 0xEF) by (bit_vector);
    }
}

proof fn lemma_pair_shape(hi: u16, lo: u16)
    requires
        is_high(hi),
        is_low(lo),
    ensures
        pair_bytes(hi, lo).len() == 4,
        0xF0 <= pair_bytes(hi, lo)[0],
        pair_bytes(hi, lo)[0] <= 0xF4,
{
    assert(((hi >> 6) & 0xF) <= 15) by (bit_vector);
    let w = pair_plane(hi);
    assert(1 <= w && w <= 16);
    assert(0xF0 <= (0xF0u16 | (w >> 2)) && (0xF0u16 | (w >> 2)) <= 0xF4) by (bit_vector)
        requires
            1 <= w && w <= 16,
    ;
}

/// The second byte of each short escape, which names its code unit.
proof fn lemma_short_escape(u: u16)
    requires
        unit_bytes(u).len() == 2,
        unit_bytes(u)[0] == 0x5c,
    ensures
        u == 0x22 || u == 0x5c || u == 0x08 || u == 0x09 || u == 0x0a || u == 0x0c || u == 0x0d,
        u == 0x22 ==> unit_bytes(u)[1] == 0x22,
        u == 0x5c ==> unit_bytes(u)[1] == 0x5c,
        u == 0x08 ==> unit_bytes(u)[1] == 0x62,
        u == 0x09 ==> unit_bytes(u)[1] == 0x74,
        u == 0x0a ==> unit_bytes(u)[1] == 0x6e,
        u == 0x0c ==> unit_bytes(u)[1] == 0x66,
        u == 0x0d ==> unit_bytes(u)[1] == 0x72,
{
    lemma_unit_shape(u);
}

proof fn lemma_unit_injective(u: u16, v: u16)
    requires
        unit_bytes(u) == unit_bytes(v),
    ensures
        u == v,
{
    let a = unit_bytes(u);
    let b = unit_bytes(v);
    lemma_unit_shape(u);
    lemma_unit_shape(v);
    assert(a[0] == b[0]);
    if a.len() == 6 {
        assert(a[1] == b[1]);
        assert(a == escape_u(u));
        assert(b == escape_u(v));
        lemma_escape_u_injective(u, v);
        assert(u == v);
    } else if a[0] == 0x5c {
        assert(a[1] == b[1]);
        assert(a.len() == 2 && b.len() == 2);
        lemma_short_escape(u);
        lemma_short_escape(v);
    } else if a.len() == 1 {
    } else if a.len() == 2 {
        assert(a[1] == b[1]);
        assert(u == v) by (bit_vector)
            requires
                u >= 0x80 && u < 0x800,
                v >= 0x80 && v < 0x800,
                (0xC0u16 | (u >> 6)) as u8 == (0xC0u16 | (v >> 6)) as u8,
                (0x80u16 | (u & 0x3F)) as u8 == (0x80u16 | (v & 0x3F)) as u8,
        ;
    } else {
        assert(a.len() == 3);
        assert(a[1] == b[1] && a[2] == b[2]);
        assert(u == v) by (bit_vector)
            requires
                u >= 0x800,
                v >= 0x800,
                (0xE0u16 | (u >> 12)) as u8 == (0xE0u16 | (v >> 12)) as u8,
                (0x80u16 | ((u >> 6) & 0x3F)) as u8 == (0x80u16 | ((v >> 6) & 0x3F)) as u8,
                (0x80u16 | (u & 0x3F)) as u8 == (0x80u16 | (v & 0x3F)) as u8,
        ;
    }
}

proof fn lemma_pair_injective(hi: u16, lo: u16, hi2: u16, lo2: u16)
    requires
        is_high(hi),
        is_low(lo),
        is_high(hi2),
        is_low(lo2),
        pair_bytes(hi, lo) == pair_bytes(hi2, lo2),
    ensures
        hi == hi2,
        lo == lo2,
{
    let a = pair_bytes(hi, lo);
    let b = pair_bytes(hi2, lo2);
    assert(a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3]);
    let w = pair_plane(hi);
    let w2 = pair_plane(hi2);
    assert(((hi >> 6) & 0xF) <= 15) by (bit_vector);
    assert(((hi2 >> 6) & 0xF) <= 15) by (bit_vector);
    assert(w == w2 && hi & 0x3F == hi2 & 0x3F && lo == lo2) by (bit_vector)
        requires
            1 <= w && w <= 16,
            1 <= w2 && w2 <= 16,
            0xD800 <= hi && hi <= 0xDBFF,
            0xD800 <= hi2 && hi2 <= 0xDBFF,
            0xDC00 <= lo && lo <= 0xDFFF,
            0xDC00 <= lo2 && lo2 <= 0xDFFF,
            (0xF0u16 | (w >> 2)) as u8 == (0xF0u16 | (w2 >> 2)) as u8,
            (0x80u16 | ((w & 0x3) << 4) | ((hi >> 2) & 0xF)) as u8 == (0x80u16 | ((w2 & 0x3) << 4)
                | ((hi2 >> 2) & 0xF)) as u8,
            (0x80u16 | ((hi & 0x3) << 4) | ((lo >> 6) & 0xF)) as u8 == (0x80u16 | ((hi2 & 0x3)
                << 4) | ((lo2 >> 6) & 0xF)) as u8,
            (0x80u16 | (lo & 0x3F)) as u8 == (0x80u16 | (lo2 & 0x3F)) as u8,
    ;
    assert((hi >> 6) & 0xF == (hi2 >> 6) & 0xF);
    assert(hi == hi2) by (bit_vector)
        requires
            0xD800 <= hi && hi <= 0xDBFF,
            0xD800 <= hi2 && hi2 <= 0xDBFF,
            (hi >> 6) & 0xF == (hi2 >> 6) & 0xF,
            hi & 0x3F == hi2 & 0x3F,
    ;
}

/// The first token of a non-empty string: never a bare quote first, and a
/// length the first two bytes decide.
proof fn lemma_head_shape(s: Seq<u16>)
    requires
        s.len() > 0,
    ensures
        head_bytes(s).len() >= 1,
        head_bytes(s)[0] != 0x22,
        head_bytes(s)[0] == 0x5c ==> head_bytes(s).len() >= 2 && head_bytes(s).len() == token_len(
            0x5c,
            head_bytes(s)[1],
        ),
        head_bytes(s)[0] != 0x5c ==> head_bytes(s).len() == token_len(head_bytes(s)[0], 0),
        (head_bytes(s).len() == 4) == (head_len(s) == 2),
{
    if head_len(s) == 2 {
        lemma_pair_shape(s[0], s[1]);
    } else {
        lemma_unit_shape(s[0]);
    }
}

/// Two strings whose first tokens sit at the front of one byte sequence
/// start with the same code units.
proof fn lemma_head_injective(s1: Seq<u16>, x1: Seq<u8>, s2: Seq<u16>, x2: Seq<u8>)
    requires
        s1.len() > 0,
        s2.len() > 0,
        head_bytes(s1) + x1 == head_bytes(s2) + x2,
    ensures
        head_len(s1) == head_len(s2),
        s1.subrange(0, head_len(s1)) == s2.subrange(0, head_len(s2)),
        x1 == x2,
{
    let t1 = head_bytes(s1);
    let t2 = head_bytes(s2);
    let w = t1 + x1;
    lemma_head_shape(s1);
    lemma_head_shape(s2);
    assert(w == t2 + x2);
    assert(t1[0] == w[0]);
    assert(t2[0] == (t2 + x2)[0]);
    if w[0] == 0x5c {
        assert(t1[1] == w[1]);
        assert(t2[1] == (t2 + x2)[1]);
    }
    assert(t1.len() == t2.len());
    lemma_same_front(t1, x1, t2, x2);
    if head_len(s1) == 2 {
        lemma_pair_injective(s1[0], s1[1], s2[0], s2[1]);
    } else {
        lemma_unit_injective(s1[0], s2[0]);
    }
    assert(s1.subrange(0, head_len(s1)) =~= s2.subrange(0, head_len(s2)));
}

/// The first token of a non-empty string split off from the rest.
proof fn lemma_string_step(s: Seq<u16>, x: Seq<u8>)
    requires
        s.len() > 0,
    ensures
        string_bytes(s) + x == head_bytes(s) + (string_bytes(
            s.subrange(head_len(s), s.len() as int),
        ) + x),
        (string_bytes(s) + x)[0] != 0x22,
{
    lemma_head_shape(s);
    assert(string_bytes(s) + x =~= head_bytes(s) + (string_bytes(
        s.subrange(head_len(s), s.len() as int),
    ) + x));
}

/// A string's bytes, followed by text that starts with a quote, decide the
/// string and that text.
proof fn lemma_string_injective(s1: Seq<u16>, x1: Seq<u8>, s2: Seq<u16>, x2: Seq<u8>)
    requires
        x1.len() > 0,
        x1[0] == 0x22,
        x2.len() > 0,
        x2[0] == 0x22,
        string_bytes(s1) + x1 == string_bytes(s2) + x2,
    ensures
        s1 == s2,
        x1 == x2,
    decreases s1.len(),
{
    if s1.len() == 0 {
        assert(string_bytes(s1) + x1 =~= x1);
        if s2.len() > 0 {
            lemma_string_step(s2, x2);
            assert(false);
        }
        assert(string_bytes(s2) + x2 =~= x2);
        assert(s1 =~= s2);
    } else {
        lemma_string_step(s1, x1);
        if s2.len() == 0 {
            assert(string_bytes(s2) + x2 =~= x2);
            assert(false);
        }
        lemma_string_step(s2, x2);
        let n1 = head_len(s1);
        let n2 = head_len(s2);
        let rest1 = s1.subrange(n1, s1.len() as int);
        let rest2 = s2.subrange(n2, s2.len() as int);
        lemma_head_injective(s1, string_bytes(rest1) + x1, s2, string_bytes(rest2) + x2);
        lemma_string_injective(rest1, x1, rest2, x2);
        assert(s1 =~= s1.subrange(0, n1) + rest1);
        assert(s2 =~= s2.subrange(0, n2) + rest2);
    }
}

/// A number's text is cut off by the first byte that no number holds.
proof fn lemma_number_injective(n1: Seq<u8>, r1: Seq<u8>, n2: Seq<u8>, r2: Seq<u8>)
    requires
        number_token(n1),
        number_token(n2),
        delimited(r1),
        delimited(r2),
        n1 + r1 == n2 + r2,
    ensures
        n1 == n2,
        r1 == r2,
{
    let w = n1 + r1;
    assert(w.len() == n2.len() + r2.len());
    if n1.len() < n2.len() {
        assert(w[n1.len() as int] == r1[0]);
        assert((n2 + r2)[n1.len() as int] == n2[n1.len() as int]);
        assert(false);
    }
    if n2.len() < n1.len() {
        assert((n2 + r2)[n2.len() as int] == r2[0]);
        assert(w[n2.len() as int] == n1[n2.len() as int]);
        assert(false);
    }
    lemma_same_front(n1, r1, n2, r2);
}

/// The first byte of a tree's encoding names its kind.
proof fn lemma_first_byte(t: Tree)
    requires
        numbers_are_tokens(t),
    ensures
        encode(t).len() >= 1,
        t is Null ==> encode(t)[0] == 0x6e,
        t is Bool ==> encode(t)[0] == 0x74 || encode(t)[0] == 0x66,
        t is Bool ==> (encode(t)[0] == 0x74) == t->Bool_0,
        t is Number ==> is_number_byte(encode(t)[0]),
        t is String ==> encode(t)[0] == 0x22,
        t is Array ==> encode(t)[0] == 0x5b,
        t is Object ==> encode(t)[0] == 0x7b,
{
    match t {
        Tree::Number(n) => {
            assert(is_number_byte(n[0]));
        },
        _ => {},
    }
}

// Each lemma from here to the main one does one small step on sequences, so
// that no single query to the solver carries the whole argument. The runner
// (scripts/trust-kernel-verus.mjs) checks the file under a resource limit
// well below the checker's default and fails when a step outgrows it.

proof fn lemma_first_of_concat(p: Seq<u8>, x: Seq<u8>)
    requires
        p.len() > 0,
    ensures
        (p + x).len() > 0,
        (p + x)[0] == p[0],
{
}

proof fn lemma_subrange_head<A>(s: Seq<A>, i: int)
    requires
        0 <= i < s.len(),
    ensures
        s.subrange(i, s.len() as int) == seq![s[i]] + s.subrange(i + 1, s.len() as int),
{
    assert(s.subrange(i, s.len() as int) =~= seq![s[i]] + s.subrange(i + 1, s.len() as int));
}

proof fn lemma_string_frame(s: Seq<u16>, r: Seq<u8>)
    ensures
        encode(Tree::String(s)) + r == seq![0x22u8] + (string_bytes(s) + (seq![0x22u8] + r)),
{
    assert(encode(Tree::String(s)) + r =~= seq![0x22u8] + (string_bytes(s) + (seq![0x22u8] + r)));
}

proof fn lemma_array_frame(a: Seq<Tree>, r: Seq<u8>)
    ensures
        encode(Tree::Array(a)) + r == seq![0x5bu8] + (items_from(a, 0) + (seq![0x5du8] + r)),
{
    assert(encode(Tree::Array(a)) + r =~= seq![0x5bu8] + (items_from(a, 0) + (seq![0x5du8] + r)));
}

proof fn lemma_object_frame(m: Seq<(Seq<u16>, Tree)>, r: Seq<u8>)
    ensures
        encode(Tree::Object(m)) + r == seq![0x7bu8] + (members_from(m, 0) + (seq![0x7du8] + r)),
{
    assert(encode(Tree::Object(m)) + r =~= seq![0x7bu8] + (members_from(m, 0) + (seq![0x7du8] + r)));
}

proof fn lemma_member_frame(key: Seq<u16>, value: Tree, x: Seq<u8>)
    ensures
        member_bytes(key, value) + x == seq![0x22u8] + (string_bytes(key) + (seq![0x22u8] + (seq![
            0x3au8,
        ] + (encode(value) + x)))),
{
    assert(member_bytes(key, value) + x =~= seq![0x22u8] + (string_bytes(key) + (seq![0x22u8] + (
    seq![0x3au8] + (encode(value) + x)))));
}

/// The items from index i on, followed by text that starts with the closing
/// bracket: one item split off, and what follows it starts with a comma or
/// with that bracket.
proof fn lemma_items_step(a: Seq<Tree>, i: int, x: Seq<u8>)
    requires
        0 <= i < a.len(),
        x.len() > 0,
        x[0] == 0x5d,
    ensures
        items_from(a, i) + x == separator(i) + (encode(a[i]) + (items_from(a, i + 1) + x)),
        delimited(items_from(a, i + 1) + x),
{
    let y = items_from(a, i + 1) + x;
    assert(items_from(a, i) + x =~= separator(i) + (encode(a[i]) + y));
    if i + 1 < a.len() {
        assert(y[0] == separator(i + 1)[0]);
    } else {
        assert(y =~= x);
    }
}

/// Whether the items from index i on are at their end is read from the
/// first byte.
proof fn lemma_items_head(a: Seq<Tree>, i: int, x: Seq<u8>)
    requires
        0 <= i <= a.len(),
        x.len() > 0,
        x[0] == 0x5d,
        forall|k: int| 0 <= k < a.len() ==> numbers_are_tokens(#[trigger] a[k]),
    ensures
        (items_from(a, i) + x).len() > 0,
        ((items_from(a, i) + x)[0] == 0x5d) == (i == a.len()),
        i == a.len() ==> items_from(a, i) + x == x,
{
    let w = items_from(a, i) + x;
    if i == a.len() {
        assert(w =~= x);
    } else if i > 0 {
        assert(w[0] == separator(i)[0]);
    } else {
        lemma_first_byte(a[i]);
        assert(w[0] == encode(a[i])[0]);
    }
}

proof fn lemma_members_step(m: Seq<(Seq<u16>, Tree)>, i: int, x: Seq<u8>)
    requires
        0 <= i < m.len(),
        x.len() > 0,
        x[0] == 0x7d,
    ensures
        members_from(m, i) + x == separator(i) + (member_bytes(m[i].0, m[i].1) + (members_from(
            m,
            i + 1,
        ) + x)),
        delimited(members_from(m, i + 1) + x),
{
    let y = members_from(m, i + 1) + x;
    assert(members_from(m, i) + x =~= separator(i) + (member_bytes(m[i].0, m[i].1) + y));
    if i + 1 < m.len() {
        assert(y[0] == separator(i + 1)[0]);
    } else {
        assert(y =~= x);
    }
}

proof fn lemma_members_head(m: Seq<(Seq<u16>, Tree)>, i: int, x: Seq<u8>)
    requires
        0 <= i <= m.len(),
        x.len() > 0,
        x[0] == 0x7d,
    ensures
        (members_from(m, i) + x).len() > 0,
        ((members_from(m, i) + x)[0] == 0x7d) == (i == m.len()),
        i == m.len() ==> members_from(m, i) + x == x,
{
    let w = members_from(m, i) + x;
    if i == m.len() {
        assert(w =~= x);
    } else if i > 0 {
        assert(w[0] == separator(i)[0]);
    } else {
        assert(w[0] == member_bytes(m[i].0, m[i].1)[0]);
    }
}

/// The main lemma. The bytes of a tree whose number texts are number tokens,
/// followed by nothing or by a delimiter, decide the tree and where it ends.
/// The order of an object's keys is not among the hypotheses: the argument
/// reads an object as a list of members and never uses how the keys compare.
proof fn lemma_encode_injective(t1: Tree, r1: Seq<u8>, t2: Tree, r2: Seq<u8>)
    requires
        numbers_are_tokens(t1),
        numbers_are_tokens(t2),
        delimited(r1),
        delimited(r2),
        encode(t1) + r1 == encode(t2) + r2,
    ensures
        t1 == t2,
        r1 == r2,
    decreases t1, 0nat,
{
    lemma_first_byte(t1);
    lemma_first_byte(t2);
    lemma_first_of_concat(encode(t1), r1);
    lemma_first_of_concat(encode(t2), r2);
    match t1 {
        Tree::Null => {
            assert(t2 is Null);
            lemma_cancel_prefix(encode(t1), r1, r2);
        },
        Tree::Bool(b1) => {
            assert(t2 is Bool);
            assert(t1 == t2);
            lemma_cancel_prefix(encode(t1), r1, r2);
        },
        Tree::Number(n1) => {
            assert(t2 is Number);
            lemma_number_injective(n1, r1, t2->Number_0, r2);
        },
        Tree::String(s1) => {
            assert(t2 is String);
            let s2 = t2->String_0;
            let q = seq![0x22u8];
            lemma_string_frame(s1, r1);
            lemma_string_frame(s2, r2);
            lemma_cancel_prefix(q, string_bytes(s1) + (q + r1), string_bytes(s2) + (q + r2));
            lemma_string_injective(s1, q + r1, s2, q + r2);
            lemma_cancel_prefix(q, r1, r2);
        },
        Tree::Array(a1) => {
            assert(t2 is Array);
            let a2 = t2->Array_0;
            let open = seq![0x5bu8];
            let close = seq![0x5du8];
            lemma_array_frame(a1, r1);
            lemma_array_frame(a2, r2);
            lemma_cancel_prefix(
                open,
                items_from(a1, 0) + (close + r1),
                items_from(a2, 0) + (close + r2),
            );
            lemma_items_injective(a1, 0, close + r1, a2, 0, close + r2);
            lemma_cancel_prefix(close, r1, r2);
            assert(a1 =~= a1.subrange(0, a1.len() as int));
            assert(a2 =~= a2.subrange(0, a2.len() as int));
        },
        Tree::Object(m1) => {
            assert(t2 is Object);
            let m2 = t2->Object_0;
            let open = seq![0x7bu8];
            let close = seq![0x7du8];
            lemma_object_frame(m1, r1);
            lemma_object_frame(m2, r2);
            lemma_cancel_prefix(
                open,
                members_from(m1, 0) + (close + r1),
                members_from(m2, 0) + (close + r2),
            );
            lemma_members_injective(m1, 0, close + r1, m2, 0, close + r2);
            lemma_cancel_prefix(close, r1, r2);
            assert(m1 =~= m1.subrange(0, m1.len() as int));
            assert(m2 =~= m2.subrange(0, m2.len() as int));
        },
    }
}

proof fn lemma_items_injective(
    a1: Seq<Tree>,
    i1: int,
    x1: Seq<u8>,
    a2: Seq<Tree>,
    i2: int,
    x2: Seq<u8>,
)
    requires
        0 <= i1 <= a1.len(),
        0 <= i2 <= a2.len(),
        (i1 == 0) == (i2 == 0),
        forall|k: int| 0 <= k < a1.len() ==> numbers_are_tokens(#[trigger] a1[k]),
        forall|k: int| 0 <= k < a2.len() ==> numbers_are_tokens(#[trigger] a2[k]),
        x1.len() > 0,
        x1[0] == 0x5d,
        x2.len() > 0,
        x2[0] == 0x5d,
        items_from(a1, i1) + x1 == items_from(a2, i2) + x2,
    ensures
        a1.subrange(i1, a1.len() as int) == a2.subrange(i2, a2.len() as int),
        x1 == x2,
    decreases a1, a1.len() - i1,
{
    lemma_items_head(a1, i1, x1);
    lemma_items_head(a2, i2, x2);
    if i1 == a1.len() {
        assert(a1.subrange(i1, a1.len() as int) =~= a2.subrange(i2, a2.len() as int));
    } else {
        let y1 = items_from(a1, i1 + 1) + x1;
        let y2 = items_from(a2, i2 + 1) + x2;
        lemma_items_step(a1, i1, x1);
        lemma_items_step(a2, i2, x2);
        lemma_cancel_prefix(separator(i1), encode(a1[i1]) + y1, encode(a2[i2]) + y2);
        lemma_encode_injective(a1[i1], y1, a2[i2], y2);
        lemma_items_injective(a1, i1 + 1, x1, a2, i2 + 1, x2);
        lemma_subrange_head(a1, i1);
        lemma_subrange_head(a2, i2);
    }
}

/// One member's bytes decide its key and its value.
proof fn lemma_member_injective(
    k1: Seq<u16>,
    v1: Tree,
    x1: Seq<u8>,
    k2: Seq<u16>,
    v2: Tree,
    x2: Seq<u8>,
)
    requires
        numbers_are_tokens(v1),
        numbers_are_tokens(v2),
        delimited(x1),
        delimited(x2),
        member_bytes(k1, v1) + x1 == member_bytes(k2, v2) + x2,
    ensures
        k1 == k2,
        v1 == v2,
        x1 == x2,
    decreases v1, 1nat,
{
    let quote = seq![0x22u8];
    let colon = seq![0x3au8];
    let after1 = colon + (encode(v1) + x1);
    let after2 = colon + (encode(v2) + x2);
    lemma_member_frame(k1, v1, x1);
    lemma_member_frame(k2, v2, x2);
    lemma_cancel_prefix(
        quote,
        string_bytes(k1) + (quote + after1),
        string_bytes(k2) + (quote + after2),
    );
    lemma_string_injective(k1, quote + after1, k2, quote + after2);
    lemma_cancel_prefix(quote, after1, after2);
    lemma_cancel_prefix(colon, encode(v1) + x1, encode(v2) + x2);
    lemma_encode_injective(v1, x1, v2, x2);
}

proof fn lemma_members_injective(
    m1: Seq<(Seq<u16>, Tree)>,
    i1: int,
    x1: Seq<u8>,
    m2: Seq<(Seq<u16>, Tree)>,
    i2: int,
    x2: Seq<u8>,
)
    requires
        0 <= i1 <= m1.len(),
        0 <= i2 <= m2.len(),
        (i1 == 0) == (i2 == 0),
        forall|k: int| 0 <= k < m1.len() ==> numbers_are_tokens((#[trigger] m1[k]).1),
        forall|k: int| 0 <= k < m2.len() ==> numbers_are_tokens((#[trigger] m2[k]).1),
        x1.len() > 0,
        x1[0] == 0x7d,
        x2.len() > 0,
        x2[0] == 0x7d,
        members_from(m1, i1) + x1 == members_from(m2, i2) + x2,
    ensures
        m1.subrange(i1, m1.len() as int) == m2.subrange(i2, m2.len() as int),
        x1 == x2,
    decreases m1, m1.len() - i1,
{
    lemma_members_head(m1, i1, x1);
    lemma_members_head(m2, i2, x2);
    if i1 == m1.len() {
        assert(m1.subrange(i1, m1.len() as int) =~= m2.subrange(i2, m2.len() as int));
    } else {
        let y1 = members_from(m1, i1 + 1) + x1;
        let y2 = members_from(m2, i2 + 1) + x2;
        lemma_members_step(m1, i1, x1);
        lemma_members_step(m2, i2, x2);
        lemma_cancel_prefix(
            separator(i1),
            member_bytes(m1[i1].0, m1[i1].1) + y1,
            member_bytes(m2[i2].0, m2[i2].1) + y2,
        );
        lemma_member_injective(m1[i1].0, m1[i1].1, y1, m2[i2].0, m2[i2].1, y2);
        lemma_members_injective(m1, i1 + 1, x1, m2, i2 + 1, x2);
        assert(m1[i1] == m2[i2]);
        lemma_subrange_head(m1, i1);
        lemma_subrange_head(m2, i2);
    }
}

/// Two trees whose number texts are number tokens, with the same bytes, are
/// the same tree. This is the whole of what injectivity needs: it holds for
/// an object whose keys are in any order, repeated keys included, because an
/// object here is a list of members.
pub proof fn theorem_encoding_is_injective(t1: Tree, t2: Tree)
    requires
        numbers_are_tokens(t1),
        numbers_are_tokens(t2),
        encode(t1) == encode(t2),
    ensures
        t1 == t2,
{
    let none = Seq::<u8>::empty();
    assert(encode(t1) + none =~= encode(t2) + none);
    lemma_encode_injective(t1, none, t2, none);
}

/// Every admitted tree is in the domain of the theorem above.
pub proof fn theorem_admitted_numbers_are_tokens(t: Tree)
    requires
        admitted(t),
    ensures
        numbers_are_tokens(t),
    decreases t,
{
    match t {
        Tree::Array(a) => {
            assert forall|i: int| 0 <= i < a.len() implies numbers_are_tokens(#[trigger] a[i]) by {
                theorem_admitted_numbers_are_tokens(a[i]);
            }
        },
        Tree::Object(m) => {
            assert forall|i: int| 0 <= i < m.len() implies numbers_are_tokens(
                (#[trigger] m[i]).1,
            ) by {
                theorem_admitted_numbers_are_tokens(m[i].1);
            }
        },
        _ => {},
    }
}

/// Two admitted trees with the same bytes are the same tree.
pub proof fn theorem_admitted_trees_never_share_bytes(t1: Tree, t2: Tree)
    requires
        admitted(t1),
        admitted(t2),
        encode(t1) == encode(t2),
    ensures
        t1 == t2,
{
    theorem_admitted_numbers_are_tokens(t1);
    theorem_admitted_numbers_are_tokens(t2);
    theorem_encoding_is_injective(t1, t2);
}

// ---------------------------------------------------------------------------
// What the key order gives. Injectivity above does not depend on it; these
// three statements are where the key order clause of `admitted` is used.
// ---------------------------------------------------------------------------

/// No key is less than itself.
pub proof fn theorem_key_order_is_strict(a: Seq<u16>)
    ensures
        !key_less(a, a),
{
    if key_less(a, a) {
        let k = choose|k: int|
            0 <= k && k <= a.len() && k <= a.len() && (forall|j: int| 0 <= j < k ==> a[j] == a[j])
                && #[trigger] parts_at(a, a, k);
        assert(false);
    }
}

pub proof fn theorem_key_order_is_transitive(a: Seq<u16>, b: Seq<u16>, c: Seq<u16>)
    requires
        key_less(a, b),
        key_less(b, c),
    ensures
        key_less(a, c),
{
    let k1 = choose|k: int|
        0 <= k && k <= a.len() && k <= b.len() && (forall|j: int| 0 <= j < k ==> a[j] == b[j])
            && #[trigger] parts_at(a, b, k);
    let k2 = choose|k: int|
        0 <= k && k <= b.len() && k <= c.len() && (forall|j: int| 0 <= j < k ==> b[j] == c[j])
            && #[trigger] parts_at(b, c, k);
    let k = if k1 <= k2 {
        k1
    } else {
        k2
    };
    assert(forall|j: int| 0 <= j < k ==> a[j] == c[j]);
    assert(parts_at(a, c, k));
}

/// In an admitted object every key is less than every key after it, so no
/// key is there twice. With the postcondition of `encode_admitted`, the keys
/// of every object the encoder writes strictly increase.
pub proof fn theorem_admitted_object_has_no_key_twice(m: Seq<(Seq<u16>, Tree)>, i: int, j: int)
    requires
        admitted(Tree::Object(m)),
        0 <= i < j < m.len(),
    ensures
        key_less(m[i].0, m[j].0),
        m[i].0 != m[j].0,
    decreases j - i,
{
    let object = Tree::Object(m);
    assert(object->Object_0 == m);
    assert(forall|x: int| 0 < x < m.len() ==> key_less(m[x - 1].0, (#[trigger] m[x]).0));
    assert(key_less(m[j - 1].0, m[j].0));
    if i + 1 < j {
        theorem_admitted_object_has_no_key_twice(m, i, j - 1);
        theorem_key_order_is_transitive(m[i].0, m[j - 1].0, m[j].0);
    }
    theorem_key_order_is_strict(m[i].0);
}

// ---------------------------------------------------------------------------
// The executable encoder.
// ---------------------------------------------------------------------------

fn hex_digit_exec(n: u16) -> (d: u8)
    requires
        n < 16,
    ensures
        d == hex_digit(n),
{
    if n < 10 {
        (0x30 + n) as u8
    } else {
        (0x57 + n) as u8
    }
}

fn push_escape_u(out: &mut Vec<u8>, u: u16)
    ensures
        final(out)@ == old(out)@ + escape_u(u),
{
    assert((u >> 12) < 16 && ((u >> 8) & 0xf) < 16 && ((u >> 4) & 0xf) < 16 && (u & 0xf) < 16)
        by (bit_vector);
    out.push(0x5c);
    out.push(0x75);
    out.push(hex_digit_exec(u >> 12));
    out.push(hex_digit_exec((u >> 8) & 0xf));
    out.push(hex_digit_exec((u >> 4) & 0xf));
    out.push(hex_digit_exec(u & 0xf));
    assert(out@ =~= old(out)@ + escape_u(u));
}

fn push_two(out: &mut Vec<u8>, a: u8, b: u8)
    ensures
        final(out)@ == old(out)@ + seq![a, b],
{
    out.push(a);
    out.push(b);
    assert(out@ =~= old(out)@ + seq![a, b]);
}

fn push_unit(out: &mut Vec<u8>, u: u16)
    ensures
        final(out)@ == old(out)@ + unit_bytes(u),
{
    if u == 0x22 {
        push_two(out, 0x5c, 0x22);
    } else if u == 0x5c {
        push_two(out, 0x5c, 0x5c);
    } else if u == 0x08 {
        push_two(out, 0x5c, 0x62);
    } else if u == 0x09 {
        push_two(out, 0x5c, 0x74);
    } else if u == 0x0a {
        push_two(out, 0x5c, 0x6e);
    } else if u == 0x0c {
        push_two(out, 0x5c, 0x66);
    } else if u == 0x0d {
        push_two(out, 0x5c, 0x72);
    } else if u < 0x20 || (0xD800 <= u && u <= 0xDFFF) {
        push_escape_u(out, u);
    } else if u < 0x80 {
        out.push(u as u8);
        assert(out@ =~= old(out)@ + seq![u as u8]);
    } else if u < 0x800 {
        push_two(out, (0xC0u16 | (u >> 6)) as u8, (0x80u16 | (u & 0x3F)) as u8);
    } else {
        out.push((0xE0u16 | (u >> 12)) as u8);
        out.push((0x80u16 | ((u >> 6) & 0x3F)) as u8);
        out.push((0x80u16 | (u & 0x3F)) as u8);
        assert(out@ =~= old(out)@ + unit_bytes(u));
    }
}

fn push_pair(out: &mut Vec<u8>, hi: u16, lo: u16)
    requires
        is_high(hi),
        is_low(lo),
    ensures
        final(out)@ == old(out)@ + pair_bytes(hi, lo),
{
    assert(((hi >> 6) & 0xF) <= 15) by (bit_vector);
    let w: u16 = ((hi >> 6) & 0xF) + 1;
    assert(w == pair_plane(hi));
    out.push((0xF0u16 | (w >> 2)) as u8);
    out.push((0x80u16 | ((w & 0x3) << 4) | ((hi >> 2) & 0xF)) as u8);
    out.push((0x80u16 | ((hi & 0x3) << 4) | ((lo >> 6) & 0xF)) as u8);
    out.push((0x80u16 | (lo & 0x3F)) as u8);
    assert(out@ =~= old(out)@ + pair_bytes(hi, lo));
}

fn push_string(out: &mut Vec<u8>, s: &Vec<u16>)
    ensures
        final(out)@ == old(out)@ + string_bytes(s@),
{
    let ghost base = out@;
    let n = s.len();
    let mut i: usize = 0;
    assert(s@.subrange(0, n as int) =~= s@);
    while i < n
        invariant
            n == s@.len(),
            i <= n,
            out@ + string_bytes(s@.subrange(i as int, n as int)) == base + string_bytes(s@),
        decreases n - i,
    {
        let ghost tail = s@.subrange(i as int, n as int);
        let ghost before = out@;
        let u = s[i];
        assert(tail[0] == u);
        if 0xD800 <= u && u <= 0xDBFF && i + 1 < n && 0xDC00 <= s[i + 1] && s[i + 1] <= 0xDFFF {
            let lo = s[i + 1];
            assert(tail[1] == lo);
            assert(head_len(tail) == 2);
            push_pair(out, u, lo);
            assert(tail.subrange(2, tail.len() as int) =~= s@.subrange(i + 2, n as int));
            assert(before + (head_bytes(tail) + string_bytes(s@.subrange(i + 2, n as int)))
                =~= out@ + string_bytes(s@.subrange(i + 2, n as int)));
            i += 2;
        } else {
            assert(head_len(tail) == 1);
            push_unit(out, u);
            assert(tail.subrange(1, tail.len() as int) =~= s@.subrange(i + 1, n as int));
            assert(before + (head_bytes(tail) + string_bytes(s@.subrange(i + 1, n as int)))
                =~= out@ + string_bytes(s@.subrange(i + 1, n as int)));
            i += 1;
        }
    }
    assert(string_bytes(s@.subrange(n as int, n as int)) =~= Seq::<u8>::empty());
    assert(out@ =~= out@ + string_bytes(s@.subrange(n as int, n as int)));
}

fn push_bytes(out: &mut Vec<u8>, bytes: &Vec<u8>)
    ensures
        final(out)@ == old(out)@ + bytes@,
{
    let n = bytes.len();
    let mut i: usize = 0;
    while i < n
        invariant
            n == bytes@.len(),
            i <= n,
            out@ == old(out)@ + bytes@.subrange(0, i as int),
        decreases n - i,
    {
        out.push(bytes[i]);
        assert(out@ =~= old(out)@ + bytes@.subrange(0, i + 1));
        i += 1;
    }
    assert(bytes@.subrange(0, n as int) =~= bytes@);
}

/// One more item written: what is left to write is one item shorter.
proof fn lemma_item_pushed(before: Seq<u8>, a: Seq<Tree>, i: int, now: Seq<u8>)
    requires
        0 <= i < a.len(),
        now == before + separator(i) + encode(a[i]),
    ensures
        now + items_from(a, i + 1) == before + items_from(a, i),
{
    assert(now + items_from(a, i + 1) =~= before + items_from(a, i));
}

proof fn lemma_member_pushed(before: Seq<u8>, m: Seq<(Seq<u16>, Tree)>, i: int, now: Seq<u8>)
    requires
        0 <= i < m.len(),
        now == before + separator(i) + seq![0x22u8] + string_bytes(m[i].0) + seq![0x22u8] + seq![
            0x3au8,
        ] + encode(m[i].1),
    ensures
        now + members_from(m, i + 1) == before + members_from(m, i),
{
    assert(seq![0x22u8, 0x3au8] =~= seq![0x22u8] + seq![0x3au8]);
    assert(now =~= before + separator(i) + member_bytes(m[i].0, m[i].1));
    assert(now + members_from(m, i + 1) =~= before + members_from(m, i));
}

proof fn lemma_string_pushed(base: Seq<u8>, s: Seq<u16>, now: Seq<u8>)
    requires
        now == (base.push(0x22u8) + string_bytes(s)).push(0x22u8),
    ensures
        now == base + encode(Tree::String(s)),
{
    assert(now =~= base + encode(Tree::String(s)));
}

proof fn lemma_array_pushed(base: Seq<u8>, a: Seq<Tree>, now: Seq<u8>)
    requires
        now == (base.push(0x5bu8) + items_from(a, 0)).push(0x5du8),
    ensures
        now == base + encode(Tree::Array(a)),
{
    assert(now =~= base + encode(Tree::Array(a)));
}

proof fn lemma_object_pushed(base: Seq<u8>, m: Seq<(Seq<u16>, Tree)>, now: Seq<u8>)
    requires
        now == (base.push(0x7bu8) + members_from(m, 0)).push(0x7du8),
    ensures
        now == base + encode(Tree::Object(m)),
{
    assert(now =~= base + encode(Tree::Object(m)));
}

fn push_value(out: &mut Vec<u8>, v: &Value)
    ensures
        final(out)@ == old(out)@ + encode(tree_of(*v)),
    decreases v,
{
    let ghost base = out@;
    match v {
        Value::Null => {
            out.push(0x6e);
            out.push(0x75);
            out.push(0x6c);
            out.push(0x6c);
            assert(out@ =~= base + encode(tree_of(*v)));
        },
        Value::Bool(b) => {
            if *b {
                out.push(0x74);
                out.push(0x72);
                out.push(0x75);
                out.push(0x65);
            } else {
                out.push(0x66);
                out.push(0x61);
                out.push(0x6c);
                out.push(0x73);
                out.push(0x65);
            }
            assert(out@ =~= base + encode(tree_of(*v)));
        },
        Value::Number(n) => {
            push_bytes(out, n);
        },
        Value::String(s) => {
            out.push(0x22);
            push_string(out, s);
            out.push(0x22);
            proof {
                lemma_string_pushed(base, s@, out@);
            }
        },
        Value::Array(a) => {
            out.push(0x5b);
            push_items(out, a);
            out.push(0x5d);
            proof {
                lemma_array_pushed(base, tree_of(*v)->Array_0, out@);
            }
        },
        Value::Object(m) => {
            out.push(0x7b);
            push_members(out, m);
            out.push(0x7d);
            proof {
                lemma_object_pushed(base, tree_of(*v)->Object_0, out@);
            }
        },
    }
}

/// The items of an array, commas included, without the brackets.
fn push_items(out: &mut Vec<u8>, a: &Vec<Value>)
    ensures
        final(out)@ == old(out)@ + items_from(tree_of(Value::Array(*a))->Array_0, 0),
    decreases a,
{
    let ghost items = tree_of(Value::Array(*a))->Array_0;
    let ghost target = out@ + items_from(items, 0);
    let n = a.len();
    let mut i: usize = 0;
    while i < n
        invariant
            n == a@.len(),
            i <= n,
            items == tree_of(Value::Array(*a))->Array_0,
            items.len() == n,
            out@ + items_from(items, i as int) == target,
        decreases n - i,
    {
        let ghost before = out@;
        if i > 0 {
            out.push(0x2c);
        }
        assert(out@ =~= before + separator(i as int));
        proof {
            vstd::std_specs::vec::axiom_vec_index_decreases(*a, i as int);
            assert(items[i as int] == tree_of(a@[i as int]));
        }
        push_value(out, &a[i]);
        proof {
            lemma_item_pushed(before, items, i as int, out@);
        }
        i += 1;
    }
    assert(out@ =~= out@ + items_from(items, n as int));
}

/// The members of an object, commas included, without the braces.
fn push_members(out: &mut Vec<u8>, m: &Vec<(Vec<u16>, Value)>)
    ensures
        final(out)@ == old(out)@ + members_from(tree_of(Value::Object(*m))->Object_0, 0),
    decreases m,
{
    let ghost members = tree_of(Value::Object(*m))->Object_0;
    let ghost target = out@ + members_from(members, 0);
    let n = m.len();
    let mut i: usize = 0;
    while i < n
        invariant
            n == m@.len(),
            i <= n,
            members == tree_of(Value::Object(*m))->Object_0,
            members.len() == n,
            out@ + members_from(members, i as int) == target,
        decreases n - i,
    {
        let ghost before = out@;
        if i > 0 {
            out.push(0x2c);
        }
        assert(out@ =~= before + separator(i as int));
        out.push(0x22);
        push_string(out, &m[i].0);
        out.push(0x22);
        out.push(0x3a);
        proof {
            vstd::std_specs::vec::axiom_vec_index_decreases(*m, i as int);
            assert(members[i as int] == (m@[i as int].0@, tree_of(m@[i as int].1)));
            assert(out@ =~= before + separator(i as int) + seq![0x22u8] + string_bytes(
                members[i as int].0,
            ) + seq![0x22u8] + seq![0x3au8]);
        }
        push_value(out, &m[i].1);
        proof {
            lemma_member_pushed(before, members, i as int, out@);
        }
        i += 1;
    }
    assert(out@ =~= out@ + members_from(members, n as int));
}

// ---------------------------------------------------------------------------
// The executable check of the admitted domain.
// ---------------------------------------------------------------------------

fn is_number_byte_exec(b: u8) -> (r: bool)
    ensures
        r == is_number_byte(b),
{
    (0x30 <= b && b <= 0x39) || b == 0x2d || b == 0x2b || b == 0x2e || b == 0x65
}

fn number_token_exec(t: &Vec<u8>) -> (r: bool)
    ensures
        r == number_token(t@),
{
    let n = t.len();
    if n == 0 {
        return false;
    }
    let mut i: usize = 0;
    while i < n
        invariant
            n == t@.len(),
            i <= n,
            forall|j: int| 0 <= j < i ==> is_number_byte(#[trigger] t@[j]),
        decreases n - i,
    {
        if !is_number_byte_exec(t[i]) {
            assert(!is_number_byte(t@[i as int]));
            return false;
        }
        i += 1;
    }
    true
}

fn key_less_exec(a: &Vec<u16>, b: &Vec<u16>) -> (r: bool)
    ensures
        r == key_less(a@, b@),
{
    let n = a.len();
    let m = b.len();
    let mut i: usize = 0;
    while i < n && i < m
        invariant
            n == a@.len(),
            m == b@.len(),
            i <= n,
            i <= m,
            forall|j: int| 0 <= j < i ==> a@[j] == b@[j],
        decreases n - i,
    {
        if a[i] != b[i] {
            if a[i] < b[i] {
                assert(parts_at(a@, b@, i as int));
                return true;
            }
            // The keys first differ here and this one is the greater, so
            // no place parts them the other way.
            assert forall|k: int|
                0 <= k && k <= a@.len() && k <= b@.len() && (forall|j: int|
                    0 <= j < k ==> a@[j] == b@[j]) implies !#[trigger] parts_at(a@, b@, k) by {
                if k > i {
                    assert(a@[i as int] == b@[i as int]);
                }
            }
            return false;
        }
        i += 1;
    }
    if n < m {
        assert(parts_at(a@, b@, i as int));
        return true;
    }
    // The second key is the first one or a prefix of it.
    assert forall|k: int|
        0 <= k && k <= a@.len() && k <= b@.len() && (forall|j: int|
            0 <= j < k ==> a@[j] == b@[j]) implies !#[trigger] parts_at(a@, b@, k) by {}
    false
}

fn admitted_exec(v: &Value) -> (ok: bool)
    ensures
        ok == admitted(tree_of(*v)),
    decreases v,
{
    match v {
        Value::Null => true,
        Value::Bool(_) => true,
        Value::Number(n) => number_token_exec(n),
        Value::String(_) => true,
        Value::Array(a) => {
            let ghost items = tree_of(*v)->Array_0;
            let n = a.len();
            let mut i: usize = 0;
            while i < n
                invariant
                    n == a@.len(),
                    i <= n,
                    *v == Value::Array(*a),
                    items == tree_of(*v)->Array_0,
                    items.len() == n,
                    forall|j: int| 0 <= j < i ==> admitted(#[trigger] items[j]),
                decreases n - i,
            {
                proof {
                    assert(v->Array_0 == *a);
                    vstd::std_specs::vec::axiom_vec_index_decreases(*a, i as int);
                    assert(items[i as int] == tree_of(a@[i as int]));
                }
                if !admitted_exec(&a[i]) {
                    assert(!admitted(items[i as int]));
                    return false;
                }
                i += 1;
            }
            true
        },
        Value::Object(m) => {
            let ghost members = tree_of(*v)->Object_0;
            let n = m.len();
            let mut i: usize = 0;
            while i < n
                invariant
                    n == m@.len(),
                    i <= n,
                    *v == Value::Object(*m),
                    members == tree_of(*v)->Object_0,
                    members.len() == n,
                    forall|j: int| 0 <= j < i ==> admitted((#[trigger] members[j]).1),
                    forall|j: int| 0 < j < i ==> key_less(members[j - 1].0, (#[trigger] members[j]).0),
                decreases n - i,
            {
                proof {
                    assert(v->Object_0 == *m);
                    vstd::std_specs::vec::axiom_vec_index_decreases(*m, i as int);
                    assert(members[i as int] == (m@[i as int].0@, tree_of(m@[i as int].1)));
                    if i > 0 {
                        assert(members[i - 1] == (m@[i - 1].0@, tree_of(m@[i - 1].1)));
                    }
                }
                if i > 0 && !key_less_exec(&m[i - 1].0, &m[i].0) {
                    assert(!key_less(members[i - 1].0, members[i as int].0));
                    return false;
                }
                if !admitted_exec(&m[i].1) {
                    assert(!admitted(members[i as int].1));
                    return false;
                }
                i += 1;
            }
            true
        },
    }
}

/// The bytes of a value whose tree is admitted, and nothing for any other
/// value: it returns bytes exactly when the tree is admitted. With
/// `theorem_admitted_trees_never_share_bytes`: whenever this returns the
/// same bytes for two values, the two values are the same tree.
///
/// "Admitted" is not "canonical". A caller inside this crate can build a
/// value whose strings are not normalized or whose number texts are not the
/// shortest (`1.0`), or are no number at all (`+e.`), and get bytes for it.
/// Only `canonicalize` in lib.rs builds the values this is called with, and
/// that those are canonical is tested, not checked here.
pub fn encode_admitted(v: &Value) -> (r: Option<Vec<u8>>)
    ensures
        match r {
            Some(bytes) => admitted(tree_of(*v)) && bytes@ == encode(tree_of(*v)),
            None => !admitted(tree_of(*v)),
        },
{
    if !admitted_exec(v) {
        return None;
    }
    let mut out: Vec<u8> = Vec::new();
    push_value(&mut out, v);
    assert(out@ =~= Seq::<u8>::empty() + encode(tree_of(*v)));
    Some(out)
}

} // verus!
