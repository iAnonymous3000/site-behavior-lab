//! Unicode Normalization Form C over UTF-16 code units, as
//! String.prototype.normalize("NFC") gives it in the reference runtime.
//!
//! The algorithm is the one in Unicode Standard Annex 15: decompose, put
//! combining marks in canonical order, compose. The data it runs on is in
//! `nfc_tables.rs`, read out of the reference runtime. A lone surrogate is
//! carried through as a starter that neither decomposes nor composes, which
//! is what JavaScript does with one.

use crate::nfc_tables::{CLASS_RANK_RANGES, COMPOSITIONS, DECOMPOSITION_INDEX, DECOMPOSITION_POOL};

const S_BASE: u32 = 0xAC00;
const L_BASE: u32 = 0x1100;
const V_BASE: u32 = 0x1161;
const T_BASE: u32 = 0x11A7;
const L_COUNT: u32 = 19;
const V_COUNT: u32 = 21;
const T_COUNT: u32 = 28;
const N_COUNT: u32 = V_COUNT * T_COUNT;
const S_COUNT: u32 = L_COUNT * N_COUNT;

/// Larger than every rank, for a string that opens with a combining mark.
const NO_STARTER: u16 = 256;

pub(crate) fn is_nfc(units: &[u16]) -> bool {
    nfc(units) == units
}

pub(crate) fn nfc(units: &[u16]) -> Vec<u16> {
    // No code point below U+0300 decomposes, reorders, or is the second of
    // a composing pair, so text made only of them is already in form C.
    if units.iter().all(|&unit| unit < 0x300) {
        return units.to_vec();
    }
    let mut points = Vec::with_capacity(units.len());
    for point in code_points(units) {
        decompose(point, &mut points);
    }
    reorder(&mut points);
    let composed = compose(&points);
    let mut out = Vec::with_capacity(units.len());
    for point in composed {
        if point >= 0x10000 {
            let offset = point - 0x10000;
            out.push(0xD800 | (offset >> 10) as u16);
            out.push(0xDC00 | (offset & 0x3FF) as u16);
        } else {
            out.push(point as u16);
        }
    }
    out
}

/// Code points, with a lone surrogate standing as its own value.
fn code_points(units: &[u16]) -> Vec<u32> {
    let mut points = Vec::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        let next = units.get(index + 1).copied();
        match next {
            Some(low) if (0xD800..=0xDBFF).contains(&unit) && (0xDC00..=0xDFFF).contains(&low) => {
                points.push(0x10000 + ((u32::from(unit) - 0xD800) << 10) + (u32::from(low) - 0xDC00));
                index += 2;
            }
            _ => {
                points.push(u32::from(unit));
                index += 1;
            }
        }
    }
    points
}

fn decompose(point: u32, out: &mut Vec<u32>) {
    if (S_BASE..S_BASE + S_COUNT).contains(&point) {
        let index = point - S_BASE;
        out.push(L_BASE + index / N_COUNT);
        out.push(V_BASE + (index % N_COUNT) / T_COUNT);
        let trailing = index % T_COUNT;
        if trailing != 0 {
            out.push(T_BASE + trailing);
        }
        return;
    }
    match DECOMPOSITION_INDEX.binary_search_by_key(&point, |entry| entry.0) {
        Ok(found) => {
            let (_, offset, length) = DECOMPOSITION_INDEX[found];
            let start = usize::from(offset);
            out.extend_from_slice(&DECOMPOSITION_POOL[start..start + usize::from(length)]);
        }
        Err(_) => out.push(point),
    }
}

/// The rank of a code point's combining class: 0 for a starter.
fn class_rank(point: u32) -> u16 {
    let found = CLASS_RANK_RANGES.binary_search_by(|&(first, last, _)| {
        if point < first {
            core::cmp::Ordering::Greater
        } else if point > last {
            core::cmp::Ordering::Less
        } else {
            core::cmp::Ordering::Equal
        }
    });
    match found {
        Ok(index) => u16::from(CLASS_RANK_RANGES[index].2),
        Err(_) => 0,
    }
}

/// Canonical ordering: within a run of marks, a stable sort by class.
fn reorder(points: &mut [u32]) {
    for index in 1..points.len() {
        let rank = class_rank(points[index]);
        if rank == 0 {
            continue;
        }
        let mut at = index;
        while at > 0 && class_rank(points[at - 1]) > rank {
            points.swap(at - 1, at);
            at -= 1;
        }
    }
}

fn compose_pair(first: u32, second: u32) -> Option<u32> {
    if (L_BASE..L_BASE + L_COUNT).contains(&first) && (V_BASE..V_BASE + V_COUNT).contains(&second) {
        return Some(S_BASE + ((first - L_BASE) * V_COUNT + (second - V_BASE)) * T_COUNT);
    }
    if (S_BASE..S_BASE + S_COUNT).contains(&first)
        && (first - S_BASE) % T_COUNT == 0
        && (T_BASE + 1..T_BASE + T_COUNT).contains(&second)
    {
        return Some(first + (second - T_BASE));
    }
    COMPOSITIONS
        .binary_search_by_key(&(first, second), |entry| (entry.0, entry.1))
        .ok()
        .map(|index| COMPOSITIONS[index].2)
}

fn compose(points: &[u32]) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::with_capacity(points.len());
    let Some(&first) = points.first() else {
        return out;
    };
    out.push(first);
    let mut starter_at = 0;
    // The class of the last code point kept after the starter; 0 while the
    // starter is itself the last one kept.
    let mut last_rank = class_rank(first);
    if last_rank != 0 {
        last_rank = NO_STARTER;
    }
    for &point in &points[1..] {
        let rank = class_rank(point);
        let unblocked = last_rank < rank || last_rank == 0;
        if let (true, Some(composite)) = (unblocked, compose_pair(out[starter_at], point)) {
            out[starter_at] = composite;
            continue;
        }
        if rank == 0 {
            starter_at = out.len();
        }
        last_rank = rank;
        out.push(point);
    }
    out
}
