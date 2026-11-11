//! The reference parser's grammar and bounds (`lib/strict-json.ts`), in the
//! order it checks them, so the first refusal it meets is the first met here.
//!
//! The reference scans UTF-16 code units. Every byte the grammar looks at is
//! ASCII, and the input is already valid UTF-8, so scanning bytes meets the
//! same tokens in the same order.

use crate::{Refusal, MAX_NESTING_DEPTH};
use std::collections::BTreeMap;

pub(crate) enum Parsed {
    Null,
    Bool(bool),
    /// The double JSON.parse would make, infinities included.
    Number(f64),
    /// UTF-16 code units, as a JavaScript string holds them.
    String(Vec<u16>),
    Array(Vec<Parsed>),
    /// Keyed and ordered by UTF-16 code units.
    Object(BTreeMap<Vec<u16>, Parsed>),
}

pub(crate) fn parse(text: &str) -> Result<Parsed, Refusal> {
    let mut scanner = Scanner {
        text,
        bytes: text.as_bytes(),
        index: 0,
    };
    let value = scanner.value(0)?;
    scanner.whitespace();
    if scanner.index != scanner.bytes.len() {
        return Err(Refusal::InvalidJson);
    }
    Ok(value)
}

struct Scanner<'a> {
    text: &'a str,
    bytes: &'a [u8],
    index: usize,
}

impl Scanner<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.index).copied()
    }

    fn whitespace(&mut self) {
        while let Some(b) = self.peek() {
            if b != 0x09 && b != 0x0a && b != 0x0d && b != 0x20 {
                break;
            }
            self.index += 1;
        }
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn require(&mut self, expected: u8) -> Result<(), Refusal> {
        if self.consume(expected) {
            Ok(())
        } else {
            Err(Refusal::InvalidJson)
        }
    }

    fn value(&mut self, depth: usize) -> Result<Parsed, Refusal> {
        self.whitespace();
        match self.peek() {
            Some(b'{') => {
                if depth >= MAX_NESTING_DEPTH {
                    return Err(Refusal::TooDeep);
                }
                self.object(depth + 1)
            }
            Some(b'[') => {
                if depth >= MAX_NESTING_DEPTH {
                    return Err(Refusal::TooDeep);
                }
                self.array(depth + 1)
            }
            Some(b'"') => Ok(Parsed::String(self.string()?)),
            Some(b't') => self.literal("true", Parsed::Bool(true)),
            Some(b'f') => self.literal("false", Parsed::Bool(false)),
            Some(b'n') => self.literal("null", Parsed::Null),
            _ => self.number(),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Parsed, Refusal> {
        self.index += 1;
        self.whitespace();
        let mut members = BTreeMap::new();
        if self.consume(b'}') {
            return Ok(Parsed::Object(members));
        }
        loop {
            self.whitespace();
            if self.peek() != Some(b'"') {
                return Err(Refusal::InvalidJson);
            }
            let key = self.string()?;
            // The reference refuses a repeated key as soon as it has read
            // the key, before the colon and the value.
            if members.contains_key(&key) {
                return Err(Refusal::DuplicateKey);
            }
            self.whitespace();
            self.require(b':')?;
            let value = self.value(depth)?;
            members.insert(key, value);
            self.whitespace();
            if self.consume(b'}') {
                return Ok(Parsed::Object(members));
            }
            self.require(b',')?;
        }
    }

    fn array(&mut self, depth: usize) -> Result<Parsed, Refusal> {
        self.index += 1;
        self.whitespace();
        let mut items = Vec::new();
        if self.consume(b']') {
            return Ok(Parsed::Array(items));
        }
        loop {
            items.push(self.value(depth)?);
            self.whitespace();
            if self.consume(b']') {
                return Ok(Parsed::Array(items));
            }
            self.require(b',')?;
        }
    }

    fn string(&mut self) -> Result<Vec<u16>, Refusal> {
        let mut units = Vec::new();
        self.index += 1;
        loop {
            let Some(b) = self.peek() else {
                return Err(Refusal::InvalidJson);
            };
            if b == b'"' {
                self.index += 1;
                return Ok(units);
            }
            if b < 0x20 {
                return Err(Refusal::InvalidJson);
            }
            if b == b'\\' {
                self.index += 1;
                let Some(escape) = self.peek() else {
                    return Err(Refusal::InvalidJson);
                };
                self.index += 1;
                let unit = match escape {
                    b'"' => 0x22,
                    b'\\' => 0x5c,
                    b'/' => 0x2f,
                    b'b' => 0x08,
                    b'f' => 0x0c,
                    b'n' => 0x0a,
                    b'r' => 0x0d,
                    b't' => 0x09,
                    b'u' => self.four_hex()?,
                    _ => return Err(Refusal::InvalidJson),
                };
                units.push(unit);
                continue;
            }
            if b < 0x80 {
                units.push(u16::from(b));
                self.index += 1;
                continue;
            }
            // A character past ASCII. The input is valid UTF-8 and the index
            // only ever stops at a character's first byte.
            let Some(ch) = self.text.get(self.index..).and_then(|rest| rest.chars().next()) else {
                return Err(Refusal::InvalidJson);
            };
            let mut pair = [0u16; 2];
            units.extend_from_slice(ch.encode_utf16(&mut pair));
            self.index += ch.len_utf8();
        }
    }

    fn four_hex(&mut self) -> Result<u16, Refusal> {
        let mut unit: u16 = 0;
        for _ in 0..4 {
            let digit = match self.peek() {
                Some(b @ b'0'..=b'9') => b - b'0',
                Some(b @ b'a'..=b'f') => b - b'a' + 10,
                Some(b @ b'A'..=b'F') => b - b'A' + 10,
                _ => return Err(Refusal::InvalidJson),
            };
            unit = (unit << 4) | u16::from(digit);
            self.index += 1;
        }
        Ok(unit)
    }

    fn literal(&mut self, expected: &str, value: Parsed) -> Result<Parsed, Refusal> {
        let end = self.index + expected.len();
        if self.bytes.get(self.index..end) != Some(expected.as_bytes()) {
            return Err(Refusal::InvalidJson);
        }
        self.index = end;
        Ok(value)
    }

    fn digit_at(&self, cursor: usize) -> bool {
        matches!(self.bytes.get(cursor), Some(b'0'..=b'9'))
    }

    fn number(&mut self) -> Result<Parsed, Refusal> {
        let start = self.index;
        let mut cursor = start;
        if self.bytes.get(cursor) == Some(&b'-') {
            cursor += 1;
        }
        if self.bytes.get(cursor) == Some(&b'0') {
            cursor += 1;
        } else {
            if !matches!(self.bytes.get(cursor), Some(b'1'..=b'9')) {
                return Err(Refusal::InvalidJson);
            }
            cursor += 1;
            while self.digit_at(cursor) {
                cursor += 1;
            }
        }
        if self.bytes.get(cursor) == Some(&b'.') {
            cursor += 1;
            if !self.digit_at(cursor) {
                return Err(Refusal::InvalidJson);
            }
            while self.digit_at(cursor) {
                cursor += 1;
            }
        }
        if matches!(self.bytes.get(cursor), Some(b'e' | b'E')) {
            cursor += 1;
            if matches!(self.bytes.get(cursor), Some(b'+' | b'-')) {
                cursor += 1;
            }
            if !self.digit_at(cursor) {
                return Err(Refusal::InvalidJson);
            }
            while self.digit_at(cursor) {
                cursor += 1;
            }
        }
        self.index = cursor;
        // JSON.parse gives the double nearest the decimal text, ties to
        // even, and an infinity past the largest double. Rust's parser is
        // specified the same way, and every JSON number is in its grammar.
        let token = self.text.get(start..cursor).ok_or(Refusal::InvalidJson)?;
        let value: f64 = token.parse().map_err(|_| Refusal::InvalidJson)?;
        Ok(Parsed::Number(value))
    }
}
