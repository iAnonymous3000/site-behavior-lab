//! The address-classification trust kernel of Site Behavior Lab.
//!
//! `address.rs` is checked by Verus: for every 32-bit IPv4 and every 128-bit
//! IPv6 address VALUE, the executable classifier returns what the written IANA
//! table and prefix rule say. `address_text.rs` reads text into a value and is
//! held to `lib/ip-safety.ts` by the address differential script.

#![forbid(unsafe_code)]

mod address;
mod address_text;

pub use address::{is_public_ipv4, is_public_ipv6};
pub use address_text::{classify_address, read_address, AddressClass, AddressRead};

#[cfg(test)]
mod tests;
