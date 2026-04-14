#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_sol_types::{sol, SolValue};
use stylus_sdk::{
    abi::Bytes,
    alloy_primitives::{b256, Address, B256},
    crypto,
    prelude::*,
    stylus_proc::AbiType,
};

/// Matches the Solidity mock domain so digest parity is preserved across implementations.
const DOMAIN: B256 = b256!("08ad2cf0b8df77d429ad593e5e0d8af6f2d6a48a44da2441e036cbb5fab5d26e");

sol! {
    #[derive(AbiType)]
    struct BbsDisclosedClaims {
        uint16 reTypeCode;
        uint256 qtyKWh;
        uint64 readingTimestamp;
        bytes32 credentialIdHash;
        uint64 expiry;
    }

    struct StylusDigestInput {
        bytes32 domain;
        address to;
        uint16 reTypeCode;
        uint256 qtyKWh;
        uint64 readingTimestamp;
        bytes32 credentialIdHash;
        uint64 expiry;
        bytes32 bbsProofHash;
    }
}

sol_storage! {
    #[entrypoint]
    pub struct BbsVerifierStylus {
        address owner;
        mapping(bytes32 => bool) approvedDigests;
    }
}

#[public]
impl BbsVerifierStylus {
    #[constructor]
    pub fn constructor(&mut self, owner_: Address) -> Result<(), Vec<u8>> {
        // Zero means "deployer becomes owner".
        let owner = if owner_ == Address::ZERO {
            self.vm().msg_sender()
        } else {
            owner_
        };
        self.owner.set(owner);
        Ok(())
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    pub fn digest(&self, to: Address, claims: BbsDisclosedClaims, bbs_proof: Bytes) -> B256 {
        compute_digest(to, claims, bbs_proof.as_ref())
    }

    #[selector(name = "setDigestApproval")]
    pub fn set_digest_approval(&mut self, digest: B256, approved: bool) -> Result<(), Vec<u8>> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(b"NOT_OWNER".to_vec());
        }
        self.approvedDigests.insert(digest, approved);
        Ok(())
    }

    #[selector(name = "verifyForMint")]
    pub fn verify_for_mint(
        &self,
        to: Address,
        claims: BbsDisclosedClaims,
        bbs_proof: Bytes,
        _zk_seal: Bytes,
    ) -> bool {
        if bbs_proof.is_empty() {
            return false;
        }
        let digest = compute_digest(to, claims, bbs_proof.as_ref());
        self.approvedDigests.get(digest)
    }
}

fn compute_digest(to: Address, claims: BbsDisclosedClaims, bbs_proof: &[u8]) -> B256 {
    let input = StylusDigestInput {
        domain: DOMAIN,
        to,
        reTypeCode: claims.reTypeCode,
        qtyKWh: claims.qtyKWh,
        readingTimestamp: claims.readingTimestamp,
        credentialIdHash: claims.credentialIdHash,
        expiry: claims.expiry,
        bbsProofHash: crypto::keccak(bbs_proof),
    };
    crypto::keccak(input.abi_encode())
}

#[cfg(test)]
mod test {
    use super::*;
    use stylus_sdk::{
        alloy_primitives::{address, fixed_bytes, U256},
        testing::*,
    };

    fn sample_claims() -> BbsDisclosedClaims {
        BbsDisclosedClaims {
            reTypeCode: 1,
            qtyKWh: U256::from(100),
            readingTimestamp: 1_740_873_600,
            credentialIdHash: fixed_bytes!("a79e2014df07d21fa652e12a40f1b4241683fe329d6cacc25100cd5288859185"),
            expiry: 1_775_143_842,
        }
    }

    #[test]
    fn owner_gate_and_verify_flow() {
        let vm = TestVM::default();
        let deployer = address!("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
        let holder = address!("1111111111111111111111111111111111111111");
        vm.set_sender(deployer);

        let mut verifier = BbsVerifierStylus::from(&vm);
        verifier.constructor(Address::ZERO).unwrap();
        assert_eq!(verifier.owner(), deployer);

        let claims = sample_claims();
        let proof = Bytes::from(b"bbs-proof".to_vec());
        let digest = verifier.digest(holder, claims.clone(), proof.clone());

        // Unauthorized caller cannot approve digests.
        vm.set_sender(holder);
        assert!(verifier.set_digest_approval(digest, true).is_err());
        assert!(!verifier.verify_for_mint(holder, claims.clone(), proof.clone(), Bytes::new()));

        // Owner approves and verification succeeds.
        vm.set_sender(deployer);
        verifier.set_digest_approval(digest, true).unwrap();
        assert!(verifier.verify_for_mint(holder, claims, proof, Bytes::new()));
    }
}
