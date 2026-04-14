# Stylus Native Path Scaffold

This folder contains a Rust-native scaffold for the BBS+ L2 mint policy used by the
project’s Stylus comparison track.

- `gtoken_bbs_native/` implements policy semantics (expiry, duplicate credential
  guard, claim ID derivation, mint amount mapping) in Rust.
- The EVM-side integration benchmark in this repo uses
  `MockBbsStylusNativeVerifier` + `GTokenL2BbsSnark` for deterministic parity tests.

To convert this scaffold into a deployable Stylus contract, wire the same core policy
methods into a Stylus SDK entrypoint and connect a production BBS+ verifier.

