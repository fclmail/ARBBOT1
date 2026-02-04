import { ethers } from "ethers";

// ================= CONFIG =================
const RPC_URL = "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Load private key from secrets / env variable
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY || PRIVATE_KEY.length !== 66 || !PRIVATE_KEY.startsWith("0x")) {
  throw new Error("Invalid or missing PRIVATE_KEY in environment variables");
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ================= CONTRACT =================
const VAULT_CONTRACT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
  "function approveRouter(address router, uint256 amount) external"
];

// ================= ROUTERS =================
const ROUTERS = {
  quickswap: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

// ================= TOKENS =================
const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
};

// ================= PATHS =================
const PATHS = {
  USDC_TO_WETH: [TOKENS.USDC, TOKENS.WETH],
  WETH_TO_USDC: [TOKENS.WETH, TOKENS.USDC]
};

const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, wallet);

// ================= HELPERS =================
async function approveRouter(router, amount) {
  try {
    console.log(`Approving ${amount} USDC for router ${router}`);
    const tx = await vaultContract.approveRouter(router, amount);
    await tx.wait();
    console.log(`Router approved: ${router}`);
  } catch (err) {
    console.error(`Approval failed for ${router}:`, err.reason || err);
  }
}

async function executeArb(buyRouter, sellRouter, amountInUSDC) {
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min
  try {
    const tx = await vaultContract.executeArbitrage(
      buyRouter,
      sellRouter,
      amountInUSDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );
    console.log(`Arbitrage tx sent: Buy ${buyRouter}, Sell ${sellRouter}`);
    const receipt = await tx.wait();
    console.log("Transaction confirmed. Hash:", receipt.transactionHash);
  } catch (err) {
    console.error("Arbitrage execution failed:", err.reason || err);
  }
}

// ================= CONTINUOUS SCAN =================
async function scanAndExecute() {
  const amountInUSDC = ethers.parseUnits("1000", 6); // $1000
  while (true) {
    for (const buyRouter of Object.values(ROUTERS)) {
      for (const sellRouter of Object.values(ROUTERS)) {
        if (buyRouter === sellRouter) continue;
        await executeArb(buyRouter, sellRouter, amountInUSDC);
        await new Promise(r => setTimeout(r, 500)); // avoid rate limit
      }
    }
    console.log("Cycle complete. Restarting scan in 5s...");
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ================= MAIN =================
async function main() {
  const approveAmount = ethers.parseUnits("1000000", 6);
  for (const router of Object.values(ROUTERS)) {
    await approveRouter(router, approveAmount);
    await new Promise(r => setTimeout(r, 500)); // avoid rate limits
  }

  console.log("Starting continuous arbitrage scan...");
  await scanAndExecute();
}

main();
