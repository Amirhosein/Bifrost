use std::collections::HashSet;

use sha3::{Digest, Keccak256};
use thiserror::Error;

#[derive(Clone, Debug)]
pub struct BbsDisclosedClaims {
    pub re_type_code: u16,
    pub qty_kwh: u128,
    pub reading_timestamp: u64,
    pub credential_id_hash: [u8; 32],
    pub expiry: u64,
}

pub trait NativeBbsVerifier {
    fn verify_for_mint(&self, to: [u8; 20], claims: &BbsDisclosedClaims, bbs_proof: &[u8]) -> bool;
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MintError {
    #[error("expired")]
    Expired,
    #[error("duplicate credential")]
    DuplicateCredential,
    #[error("invalid proof")]
    InvalidProof,
}

/// Reference implementation of Stylus-native mint policy semantics.
/// Integrate this into a Stylus entrypoint and token state adapter in deployment code.
pub struct GTokenBbsNative<V: NativeBbsVerifier> {
    verifier: V,
    used_credential: HashSet<[u8; 32]>,
}

impl<V: NativeBbsVerifier> GTokenBbsNative<V> {
    pub fn new(verifier: V) -> Self {
        Self {
            verifier,
            used_credential: HashSet::new(),
        }
    }

    pub fn is_credential_used(&self, credential_id_hash: [u8; 32]) -> bool {
        self.used_credential.contains(&credential_id_hash)
    }

    pub fn compute_claim_id(claims: &BbsDisclosedClaims) -> [u8; 32] {
        let mut hasher = Keccak256::new();
        hasher.update(claims.credential_id_hash);
        hasher.update(claims.re_type_code.to_be_bytes());
        hasher.update(claims.qty_kwh.to_be_bytes());
        hasher.update(claims.reading_timestamp.to_be_bytes());
        hasher.finalize().into()
    }

    pub fn mint_with_bbs_proof(
        &mut self,
        to: [u8; 20],
        now_unix: u64,
        claims: &BbsDisclosedClaims,
        bbs_proof: &[u8],
    ) -> Result<([u8; 32], u128), MintError> {
        if claims.expiry < now_unix {
            return Err(MintError::Expired);
        }
        if self.used_credential.contains(&claims.credential_id_hash) {
            return Err(MintError::DuplicateCredential);
        }
        if !self.verifier.verify_for_mint(to, claims, bbs_proof) {
            return Err(MintError::InvalidProof);
        }

        self.used_credential.insert(claims.credential_id_hash);
        let claim_id = Self::compute_claim_id(claims);
        let gt_amount = claims.qty_kwh;
        Ok((claim_id, gt_amount))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockVerifier;

    impl NativeBbsVerifier for MockVerifier {
        fn verify_for_mint(&self, _to: [u8; 20], claims: &BbsDisclosedClaims, bbs_proof: &[u8]) -> bool {
            !bbs_proof.is_empty() && claims.qty_kwh > 0
        }
    }

    fn claims(expiry: u64) -> BbsDisclosedClaims {
        BbsDisclosedClaims {
            re_type_code: 1,
            qty_kwh: 100,
            reading_timestamp: 1_740_873_600,
            credential_id_hash: [7u8; 32],
            expiry,
        }
    }

    #[test]
    fn mint_once_and_block_duplicate() {
        let mut c = GTokenBbsNative::new(MockVerifier);
        let to = [0x11u8; 20];
        let now = 1_740_800_000;
        let p = b"bbs-proof";

        let first = c.mint_with_bbs_proof(to, now, &claims(now + 1000), p).unwrap();
        assert_eq!(first.1, 100);
        assert!(c.is_credential_used([7u8; 32]));

        let second = c.mint_with_bbs_proof(to, now, &claims(now + 1000), p);
        assert_eq!(second.unwrap_err(), MintError::DuplicateCredential);
    }

    #[test]
    fn reject_expired_and_invalid() {
        let mut c = GTokenBbsNative::new(MockVerifier);
        let to = [0x11u8; 20];
        let now = 1_740_800_000;

        let expired = c.mint_with_bbs_proof(to, now, &claims(now - 1), b"bbs-proof");
        assert_eq!(expired.unwrap_err(), MintError::Expired);

        let invalid = c.mint_with_bbs_proof(to, now, &claims(now + 1000), b"");
        assert_eq!(invalid.unwrap_err(), MintError::InvalidProof);
    }
}

