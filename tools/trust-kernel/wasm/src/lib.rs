//! The WebAssembly entry points. No JavaScript glue is generated and no
//! binding tool runs: the host writes the input into linear memory, calls
//! `sbl_canonicalize`, and reads the output back. The address classifier
//! reads the same input buffer: `sbl_classify_address` answers with a number
//! alone, and `sbl_read_address` also leaves the value it read in the output
//! buffer.
//!
//! This file has no `unsafe` block. It cannot carry `forbid(unsafe_code)`
//! like the kernel does, because an exported symbol name is itself counted
//! as unsafe code by that lint.
//!
//! One call at a time: the module keeps one input and one output buffer.

use sbl_trust_kernel::{
    canonicalize_with_number_budget, classify_address, read_address, AddressClass, AddressRead, Refusal,
};
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

/// Classifies the input buffer as an address: 0 when it is not an address
/// (the reference's `isIpAddress` is false), 1 for an address that is not
/// public, 2 for a public address (`isPublicIpAddress` is true). The output
/// buffer is left as it was.
#[no_mangle]
pub extern "C" fn sbl_classify_address() -> u32 {
    let input = INPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match classify_address(&input) {
        AddressClass::NotAnAddress => 0,
        AddressClass::NotPublic => 1,
        AddressClass::Public => 2,
    }
}

/// Reads the input buffer as an address and leaves the value in the output
/// buffer, most significant byte first. Returns 0 and an empty output when
/// the input is not an address; 4 with four bytes for an IPv4 address; 6
/// with sixteen bytes for an IPv6 address; 7 with sixteen bytes for a text
/// with a dotted quad before a closing `::`, which the reference accepts and
/// no address parser reads (the bytes are then the value the reference
/// judges, not an address a parser agreed on).
#[no_mangle]
pub extern "C" fn sbl_read_address() -> u32 {
    let input = INPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut output = OUTPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match read_address(&input) {
        None => {
            *output = Vec::new();
            0
        }
        Some(AddressRead::V4(value)) => {
            *output = value.to_be_bytes().to_vec();
            4
        }
        Some(AddressRead::V6(value)) => {
            *output = value.to_be_bytes().to_vec();
            6
        }
        Some(AddressRead::V6DottedBeforeCompression(value)) => {
            *output = value.to_be_bytes().to_vec();
            7
        }
    }
}
