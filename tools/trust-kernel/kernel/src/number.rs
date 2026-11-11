//! A finite double as JavaScript prints it (ECMA-262 Number::toString, radix
//! 10), which is what JSON.stringify writes.
//!
//! The standard asks for the fewest digits that read back as the same
//! double; among those the nearest to it; and, when two are equally near,
//! the even one. Rust's own float formatting gives the first two and then
//! rounds a tie upward, so 957340073933683.25 prints with a final 3 where
//! JavaScript prints a 2. The digits are therefore generated here, with
//! exact integer arithmetic (the free-format algorithm of Steele and White
//! as Burger and Dybvig state it), and the tie is decided as the standard
//! says.
//!
//! Nothing here is checked by Verus. The differential test holds it to V8.

use core::cmp::Ordering;

/// An unsigned integer of any size, least significant word first, with no
/// leading zero word. Only what digit generation needs.
#[derive(Clone)]
struct Big(Vec<u32>);

impl Big {
    fn from_u64(value: u64) -> Big {
        let mut big = Big(vec![value as u32, (value >> 32) as u32]);
        big.trim();
        big
    }

    fn trim(&mut self) {
        while self.0.last() == Some(&0) {
            self.0.pop();
        }
    }

    fn shift_left(&mut self, bits: u32) {
        if self.0.is_empty() {
            return;
        }
        let words = (bits / 32) as usize;
        let rest = bits % 32;
        if rest != 0 {
            let mut carry = 0u32;
            for word in self.0.iter_mut() {
                let next = *word >> (32 - rest);
                *word = (*word << rest) | carry;
                carry = next;
            }
            if carry != 0 {
                self.0.push(carry);
            }
        }
        if words != 0 {
            let mut shifted = vec![0u32; words];
            shifted.extend_from_slice(&self.0);
            self.0 = shifted;
        }
    }

    fn times_ten(&mut self) {
        let mut carry = 0u64;
        for word in self.0.iter_mut() {
            let product = u64::from(*word) * 10 + carry;
            *word = product as u32;
            carry = product >> 32;
        }
        if carry != 0 {
            self.0.push(carry as u32);
        }
    }

    fn plus(&self, other: &Big) -> Big {
        let mut out = Vec::with_capacity(self.0.len().max(other.0.len()) + 1);
        let mut carry = 0u64;
        for index in 0..self.0.len().max(other.0.len()) {
            let sum = u64::from(self.0.get(index).copied().unwrap_or(0))
                + u64::from(other.0.get(index).copied().unwrap_or(0))
                + carry;
            out.push(sum as u32);
            carry = sum >> 32;
        }
        if carry != 0 {
            out.push(carry as u32);
        }
        Big(out)
    }

    fn compare(&self, other: &Big) -> Ordering {
        if self.0.len() != other.0.len() {
            return self.0.len().cmp(&other.0.len());
        }
        for index in (0..self.0.len()).rev() {
            if self.0[index] != other.0[index] {
                return self.0[index].cmp(&other.0[index]);
            }
        }
        Ordering::Equal
    }

    /// `self -= other`, for `other` no larger than `self`.
    fn minus(&mut self, other: &Big) {
        let mut borrow = 0i64;
        for index in 0..self.0.len() {
            let difference = i64::from(self.0[index]) - i64::from(other.0.get(index).copied().unwrap_or(0)) - borrow;
            if difference < 0 {
                self.0[index] = (difference + (1i64 << 32)) as u32;
                borrow = 1;
            } else {
                self.0[index] = difference as u32;
                borrow = 0;
            }
        }
        self.trim();
    }
}

/// The digits and the decimal exponent `n` of a positive finite double: the
/// value the digits name is 0.d1d2... times ten to the `n`.
fn shortest_digits(x: f64) -> (Vec<u8>, i32) {
    let bits = x.to_bits();
    let exponent_bits = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    // x = mantissa * 2^exponent exactly.
    let (mantissa, exponent) = if exponent_bits == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1u64 << 52), exponent_bits - 1075)
    };
    // A text exactly halfway to a neighbor reads back as the double whose
    // mantissa is even, so the interval's ends belong to x only then.
    let even = mantissa & 1 == 0;
    // At a power of two the double below is half as far as the one above.
    let narrow_below = fraction == 0 && exponent_bits > 1;

    // x = r / s; the gap above is m_plus / s and the gap below m_minus / s,
    // each already halved.
    let mut r = Big::from_u64(mantissa);
    let mut s = Big::from_u64(1);
    let mut m_plus = Big::from_u64(1);
    let mut m_minus = Big::from_u64(1);
    if exponent >= 0 {
        r.shift_left(exponent as u32 + 1);
        s.shift_left(1);
        m_plus.shift_left(exponent as u32);
        m_minus.shift_left(exponent as u32);
    } else {
        r.shift_left(1);
        s.shift_left((-exponent) as u32 + 1);
    }
    if narrow_below {
        r.shift_left(1);
        s.shift_left(1);
        m_plus.shift_left(1);
    }

    // Scale so that the first digit generated is the first digit of x.
    let reaches = |sum: &Big, s: &Big| match sum.compare(s) {
        Ordering::Greater => true,
        Ordering::Equal => even,
        Ordering::Less => false,
    };
    let mut n = 0i32;
    while reaches(&r.plus(&m_plus), &s) {
        s.times_ten();
        n += 1;
    }
    loop {
        let mut next = r.plus(&m_plus);
        next.times_ten();
        if reaches(&next, &s) {
            break;
        }
        r.times_ten();
        m_plus.times_ten();
        m_minus.times_ten();
        n -= 1;
    }

    let mut digits = Vec::with_capacity(17);
    loop {
        r.times_ten();
        m_plus.times_ten();
        m_minus.times_ten();
        let mut digit = 0u8;
        while r.compare(&s) != Ordering::Less {
            r.minus(&s);
            digit += 1;
        }
        // Stopping here and keeping this digit names a number inside the
        // interval; so does stopping here and adding one to it.
        let low = match r.compare(&m_minus) {
            Ordering::Less => true,
            Ordering::Equal => even,
            Ordering::Greater => false,
        };
        let high = reaches(&r.plus(&m_plus), &s);
        if !low && !high {
            digits.push(b'0' + digit);
            continue;
        }
        let up = if low && high {
            let mut twice = r.clone();
            twice.shift_left(1);
            match twice.compare(&s) {
                Ordering::Less => false,
                Ordering::Greater => true,
                // Equally near: the even digit.
                Ordering::Equal => digit % 2 == 1,
            }
        } else {
            high
        };
        digits.push(b'0' + digit + u8::from(up));
        break;
    }
    // Adding one to a final 9 cannot happen: the shorter text ending one
    // place earlier would already have been inside the interval. Carry all
    // the same, so a wrong belief here costs a digit string, not a byte
    // outside '0'..'9'.
    let mut at = digits.len();
    while at > 0 && digits[at - 1] > b'9' {
        digits[at - 1] = b'0';
        if at == 1 {
            digits.insert(0, b'1');
            n += 1;
        } else {
            digits[at - 2] += 1;
        }
        at -= 1;
    }
    while digits.len() > 1 && digits.last() == Some(&b'0') {
        digits.pop();
    }
    (digits, n)
}

/// `x` must be finite.
pub(crate) fn js_number_text(x: f64) -> Vec<u8> {
    if x == 0.0 {
        // Both zeros print as "0".
        return b"0".to_vec();
    }
    // In the standard's words: k digits, and the value is digits * 10^(n-k).
    let (digits, n) = shortest_digits(x.abs());
    let k = digits.len() as i32;

    let mut out = Vec::with_capacity(digits.len() + 8);
    if x < 0.0 {
        out.push(b'-');
    }
    if k <= n && n <= 21 {
        out.extend_from_slice(&digits);
        out.extend(core::iter::repeat(b'0').take((n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.extend_from_slice(&digits[..n as usize]);
        out.push(b'.');
        out.extend_from_slice(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.extend_from_slice(b"0.");
        out.extend(core::iter::repeat(b'0').take((-n) as usize));
        out.extend_from_slice(&digits);
    } else {
        out.push(digits[0]);
        if k > 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..]);
        }
        out.push(b'e');
        out.push(if n - 1 < 0 { b'-' } else { b'+' });
        out.extend_from_slice((n - 1).unsigned_abs().to_string().as_bytes());
    }
    out
}
