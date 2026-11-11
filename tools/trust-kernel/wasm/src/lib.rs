//! The WebAssembly entry points. No JavaScript glue is generated and no
//! binding tool runs: the host writes the input into linear memory, calls
//! `sbl_canonicalize`, and reads the output back.
//!
//! This file has no `unsafe` block. It cannot carry `forbid(unsafe_code)`
//! like the kernel does, because an exported symbol name is itself counted
//! as unsafe code by that lint.
//!
//! One call at a time: the module keeps one input and one output buffer.

use sbl_trust_kernel::{canonicalize_with_number_budget, Refusal};
use std::sync::Mutex;

static INPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// Makes a zeroed input buffer of `length` bytes and says where it is. The
/// host fills it before `sbl_canonicalize`.
#[no_mangle]
pub extern "C" fn sbl_input(length: usize) -> *mut u8 {
    let mut input = INPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *input = vec![0; length];
    input.as_mut_ptr()
}

/// Canonicalizes the input buffer. Returns 0 and fills the output buffer, or
/// a refusal code and leaves the output empty.
///
/// `has_budget` is 0 when the caller gives no byte budget, which is the
/// reference called with one argument; `max_utf8_bytes` is then not read.
/// With any other `has_budget`, `max_utf8_bytes` is the reference's second
/// argument as a number, and a number the reference cannot use as a budget
/// (a fraction, NaN, an infinity, a negative, past 2^53 - 1) refuses the
/// input as too large, as the reference does. No number means "no budget".
#[no_mangle]
pub extern "C" fn sbl_canonicalize(has_budget: u32, max_utf8_bytes: f64) -> u32 {
    let input = INPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut output = OUTPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let budget = if has_budget == 0 { None } else { Some(max_utf8_bytes) };
    match canonicalize_with_number_budget(&input, budget) {
        Ok(bytes) => {
            *output = bytes;
            0
        }
        Err(refusal) => {
            *output = Vec::new();
            match refusal {
                Refusal::TooLarge => 1,
                Refusal::InvalidJson => 2,
                Refusal::DuplicateKey => 3,
                Refusal::TooDeep => 4,
                Refusal::NonFiniteNumber => 5,
                Refusal::KeyNotNfc => 6,
                Refusal::InvalidUtf8 => 7,
                Refusal::NotAdmitted => 8,
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn sbl_output() -> *const u8 {
    OUTPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ptr()
}

#[no_mangle]
pub extern "C" fn sbl_output_length() -> usize {
    OUTPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len()
}
