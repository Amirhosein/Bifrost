import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  gasReporter: {
    enabled: process.env.HARDHAT_GAS_REPORT === "true" || !!process.env.CMC_KEY,
    currency: "USD",
    coinmarketcap: process.env.CMC_KEY || undefined,
    showTimeSpent: true,
    excludeContracts: ["MetReg", "DataVer"],
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    }
  }
};

export default config;
