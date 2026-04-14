import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// -----------------------------------------------------------------------------
// Optional public-network configuration
//
// Tests always run on the in-memory `hardhat` network.
// Deployment scripts can target Sepolia (L1) + an L2 testnet.
//
// Configure via `.env` (see `.env.example`).
// -----------------------------------------------------------------------------

const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ||
  process.env.DEPLOYER_PK ||
  process.env.PRIVATE_KEY ||
  "";

const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

const networks: HardhatUserConfig["networks"] = {
  hardhat: {
    chainId: 31337,
  },
};

const sepoliaUrl = process.env.SEPOLIA_RPC_URL || process.env.L1_RPC_URL;
if (sepoliaUrl) {
  networks.sepolia = {
    url: sepoliaUrl,
    accounts,
    chainId: 11155111,
  };
}

const arbSepoliaUrl = process.env.ARBITRUM_SEPOLIA_RPC_URL;
if (arbSepoliaUrl) {
  networks.arbitrumSepolia = {
    url: arbSepoliaUrl,
    accounts,
    chainId: 421614,
  };
}

const opSepoliaUrl = process.env.OPTIMISM_SEPOLIA_RPC_URL || process.env.OP_SEPOLIA_RPC;
if (opSepoliaUrl) {
  networks.optimismSepolia = {
    url: opSepoliaUrl,
    accounts,
    chainId: 11155420,
  };
}

const baseSepoliaUrl = process.env.BASE_SEPOLIA_RPC_URL;
if (baseSepoliaUrl) {
  networks.baseSepolia = {
    url: baseSepoliaUrl,
    accounts,
    chainId: 84532,
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  mocha: {
    timeout: 120_000,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    noColors: true,
  },
  networks,
};

export default config;
