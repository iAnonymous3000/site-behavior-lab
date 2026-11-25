//! WebAssembly entry points for the Verus-checked address classifier.
//!
//! `sbl_is_public_ipv4_value` and `sbl_is_public_ipv6_value` take address
//! values directly and invoke the Verus-checked functions in `address.rs`.
//! `sbl_input`, `sbl_output`, `sbl_output_length`, `sbl_classify_address`, and
//! `sbl_read_address` support the address differential suite.

use sbl_trust_kernel::{
    classify_address, is_public_ipv4, is_public_ipv6, read_address, AddressClass, AddressRead,
};
use std::sync::Mutex;

static INPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[no_mangle]
pub extern "C" fn sbl_input(length: usize) -> *mut u8 {
    let mut input = INPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *input = vec![0; length];
    input.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn sbl_output() -> *const u8 {
    OUTPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ptr()
}

#[no_mangle]
pub extern "C" fn sbl_output_length() -> usize {
    OUTPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len()
}

/// Classifies the input buffer as an address: 0 not an address, 1 not public, 2 public.
#[no_mangle]
pub extern "C" fn sbl_classify_address() -> u32 {
    let input = INPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match classify_address(&input) {
        AddressClass::NotAnAddress => 0,
        AddressClass::NotPublic => 1,
        AddressClass::Public => 2,
    }
}

/// Reads the input buffer as an address value into the output buffer (big-endian).
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
    }
}

/// Whether the IPv4 address value (big-endian u32) is public: 1 public, 0 not public.
#[no_mangle]
pub extern "C" fn sbl_is_public_ipv4_value(value: u32) -> u32 {
    u32::from(is_public_ipv4(value))
}

/// Whether the IPv6 address value (high/low big-endian u64 halves) is public: 1 public, 0 not public.
#[no_mangle]
pub extern "C" fn sbl_is_public_ipv6_value(high: u64, low: u64) -> u32 {
    u32::from(is_public_ipv6((u128::from(high) << 64) | u128::from(low)))
}
