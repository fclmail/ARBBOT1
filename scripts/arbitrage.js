import { ethers } from "ethers";

// --- CONFIG ---
const RPC_URL = "https://polygon-rpc.com"; // Polygon mainnet RPC
const provider = new ethers.JsonRpcProvider(RPC_URL);

const WALLET_PRIVATE_KEY = "YOUR_PRIVATE_KEY"; // Use .env in prod
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// Example tokens and DEX routers
const TOKENS = [
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "CRV", address: "0x172370d5cd63279efa6d502dab29171933a610af" },
];

const ROUTERS = {
  QuickSwap: "0xa5e0829caecd8ffdd4de3c43696c57f7d7a678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607",
  Dfyn: "0xa8b607aa09b6a2641cf6f90f643e76d3f6e6ff73",
};

// Your arbitrage contract
const ARB_CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const ARB_CONTRACT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amount) external returns (uint256 profit)"
];

const arbContract = new ethers.Contract(ARB_CONTRACT_ADDRESS, ARB_CONTRACT_ABI, wallet);

// --- UTILS ---
function checksum(address) {
  try {
    return ethers.getAddress(address);
  } catch (e) {
    console.warn(`❌ Invalid address: ${address}`);
    return null;
  }
}

// --- MAIN DRY-RUN FUNCTION ---
async function dryRunArbitrage() {
  console.log("🚀 Starting dry-run arbitrage scan on Polygon...");

  for (const token of TOKENS) {
    const tokenAddress = checksum(token.address);
    if (!tokenAddress) continue; // skip if invalid

    for (const buyName of Object.keys(ROUTERS)) {
      const buyRouter = checksum(ROUTERS[buyName]);
      if (!buyRouter) continue;

      for (const sellName of Object.keys(ROUTERS)) {
        if (buyName === sellName) continue; // skip same router

        const sellRouter = checksum(ROUTERS[sellName]);
        if (!sellRouter) continue;

        try {
          // --- DRY-RUN using callStatic ---
          const simulatedProfit = await arbContract.callStatic.executeArbitrage(
            buyRouter,
            sellRouter,
            tokenAddress,
            ethers.parseUnits("1", 18) // Example: 1 token
          );

          // Skip if no profit or unrealistic
          if (!simulatedProfit || simulatedProfit <= 0) continue;

          console.log(`✅ ${token.symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${ethers.formatUnits(simulatedProfit, 18)} USDC`);

        } catch (err) {
          console.warn(`⚠️ Skipped ${token.symbol} ${buyName}->${sellName}: ${err.reason || err.message}`);
        }
      }
    }
  }

  console.log("🔍 Dry-run complete.");
}

// --- RUN ---
dryRunArbitrage();
