import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  mocha: {
    timeout: 120_000
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    noColors: true
  },
  networks: {
    hardhat: {
      chainId: 31337
    }
    // NOTE: For real deployments to L2 testnets, add networks here.
    // Example (OP Stack):
    // optimismSepolia: {
    //   url: process.env.OP_SEPOLIA_RPC || "",
    //   accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : []
    // }
  }
};

export default config;
