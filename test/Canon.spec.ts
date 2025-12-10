import { expect } from "chai";
import { ethers } from "hardhat";
import { AbiCoder } from "ethers";

describe("Canonicalization", function () {
  it("ABI tuple encoding is stable", async function () {
    const coder = new AbiCoder();
    const a = coder.encode(["tuple(uint64,uint16,uint256,uint128)"], [[202540, 0, 100n, 0n]]);
    const b = coder.encode(["tuple(uint64,uint16,uint256,uint128)"], [[202540, 0, 100n, 0n]]);
    expect(a).to.eq(b);
  });
});
