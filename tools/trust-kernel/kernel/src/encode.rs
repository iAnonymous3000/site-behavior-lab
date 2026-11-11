//! The encoder: a canonical value tree to its bytes.
//!
//! `encode_admitted` writes a tree only after checking that every number's
//! text is a non-empty run of number bytes and that every object's keys
//! strictly increase, so a tree built wrongly by another module is refused
//! here and not written.

/// A canonical value. A number is carried as its finished text, and a string
/// as UTF-16 code units, lone surrogates included, because that is what a
/// JavaScript string is and the reference orders keys by those units.
pub enum Value {
    Null,
    Bool(bool),
    Number(Vec<u8>),
    String(Vec<u16>),
    Array(Vec<Value>),
    Object(Vec<(Vec<u16>, Value)>),
}

fn hex_digit_exec(n: u16) -> u8 {
    if n < 10 {
        (0x30 + n) as u8
    } else {
        (0x57 + n) as u8
    }
}

fn push_escape_u(out: &mut Vec<u8>, u: u16) {
    out.push(0x5c);
    out.push(0x75);
    out.push(hex_digit_exec(u >> 12));
    out.push(hex_digit_exec((u >> 8) & 0xf));
    out.push(hex_digit_exec((u >> 4) & 0xf));
    out.push(hex_digit_exec(u & 0xf));
}

fn push_two(out: &mut Vec<u8>, a: u8, b: u8) {
    out.push(a);
    out.push(b);
}

/// One code unit that is not the first half of a surrogate pair, as
/// JSON.stringify writes it: the short escapes, `\u00xx` for the other
/// controls, `\udxxx` for a lone surrogate, and UTF-8 for the rest.
fn push_unit(out: &mut Vec<u8>, u: u16) {
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
    } else if u < 0x800 {
        push_two(out, (0xC0u16 | (u >> 6)) as u8, (0x80u16 | (u & 0x3F)) as u8);
    } else {
        out.push((0xE0u16 | (u >> 12)) as u8);
        out.push((0x80u16 | ((u >> 6) & 0x3F)) as u8);
        out.push((0x80u16 | (u & 0x3F)) as u8);
    }
}

/// A surrogate pair as the four UTF-8 bytes of its code point.
fn push_pair(out: &mut Vec<u8>, hi: u16, lo: u16) {
    let w: u16 = ((hi >> 6) & 0xF) + 1;
    out.push((0xF0u16 | (w >> 2)) as u8);
    out.push((0x80u16 | ((w & 0x3) << 4) | ((hi >> 2) & 0xF)) as u8);
    out.push((0x80u16 | ((hi & 0x3) << 4) | ((lo >> 6) & 0xF)) as u8);
    out.push((0x80u16 | (lo & 0x3F)) as u8);
}

fn push_string(out: &mut Vec<u8>, s: &Vec<u16>) {
    let n = s.len();
    let mut i: usize = 0;
    while i < n {
        let u = s[i];
        if 0xD800 <= u && u <= 0xDBFF && i + 1 < n && 0xDC00 <= s[i + 1] && s[i + 1] <= 0xDFFF {
            let lo = s[i + 1];
            push_pair(out, u, lo);
            i += 2;
        } else {
            push_unit(out, u);
            i += 1;
        }
    }
}

fn push_bytes(out: &mut Vec<u8>, bytes: &Vec<u8>) {
    let n = bytes.len();
    let mut i: usize = 0;
    while i < n {
        out.push(bytes[i]);
        i += 1;
    }
}

fn push_value(out: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Null => {
            out.push(0x6e);
            out.push(0x75);
            out.push(0x6c);
            out.push(0x6c);
        }
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
        }
        Value::Number(n) => {
            push_bytes(out, n);
        }
        Value::String(s) => {
            out.push(0x22);
            push_string(out, s);
            out.push(0x22);
        }
        Value::Array(a) => {
            out.push(0x5b);
            let n = a.len();
            let mut i: usize = 0;
            while i < n {
                if i > 0 {
                    out.push(0x2c);
                }
                push_value(out, &a[i]);
                i += 1;
            }
            out.push(0x5d);
        }
        Value::Object(m) => {
            out.push(0x7b);
            let n = m.len();
            let mut i: usize = 0;
            while i < n {
                if i > 0 {
                    out.push(0x2c);
                }
                out.push(0x22);
                push_string(out, &m[i].0);
                out.push(0x22);
                out.push(0x3a);
                push_value(out, &m[i].1);
                i += 1;
            }
            out.push(0x7d);
        }
    }
}

/// The bytes a number's text may hold: digits, minus, plus, point, `e`.
fn is_number_byte_exec(b: u8) -> bool {
    (0x30 <= b && b <= 0x39) || b == 0x2d || b == 0x2b || b == 0x2e || b == 0x65
}

fn number_token_exec(t: &Vec<u8>) -> bool {
    let n = t.len();
    if n == 0 {
        return false;
    }
    let mut i: usize = 0;
    while i < n {
        if !is_number_byte_exec(t[i]) {
            return false;
        }
        i += 1;
    }
    true
}

/// Key order: by UTF-16 code unit, a proper prefix first. This is the order
/// of JavaScript's default sort, which the reference sorts keys with.
fn key_less_exec(a: &Vec<u16>, b: &Vec<u16>) -> bool {
    let n = a.len();
    let m = b.len();
    let mut i: usize = 0;
    while i < n && i < m {
        if a[i] != b[i] {
            if a[i] < b[i] {
                return true;
            }
            return false;
        }
        i += 1;
    }
    if n < m {
        return true;
    }
    false
}

fn admitted_exec(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(_) => true,
        Value::Number(n) => number_token_exec(n),
        Value::String(_) => true,
        Value::Array(a) => {
            let n = a.len();
            let mut i: usize = 0;
            while i < n {
                if !admitted_exec(&a[i]) {
                    return false;
                }
                i += 1;
            }
            true
        }
        Value::Object(m) => {
            let n = m.len();
            let mut i: usize = 0;
            while i < n {
                if i > 0 && !key_less_exec(&m[i - 1].0, &m[i].0) {
                    return false;
                }
                if !admitted_exec(&m[i].1) {
                    return false;
                }
                i += 1;
            }
            true
        }
    }
}

/// The bytes of a canonical value, or nothing when the value is outside the
/// admitted domain.
pub fn encode_admitted(v: &Value) -> Option<Vec<u8>> {
    if !admitted_exec(v) {
        return None;
    }
    let mut out: Vec<u8> = Vec::new();
    push_value(&mut out, v);
    Some(out)
}
