// arb-dropin-esm.js
// Drop-in arbitrage bot (ethers v6, ES Modules, checksum-safe)

import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ================= ENV =================
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

if (!PRIVATE_KEY || !PRIVATE_KEY_REGEX.test(PRIVATE_KEY)) {
  throw new Error("Invalid or missing PRIVATE_KEY in environment variables");
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ================= CONTRACT =================
const VAULT_CONTRACT_ADDRESS = ethers.getAddress("0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1");
const USDC_ADDRESS = ethers.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function minimumProfitUSDC() view returns (uint256)",
  "function routerAllowance(address router) view returns (uint256)",
  "function approveRouter(address router, uint256 amount) external",
  "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external"
];

const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, wallet);

// ================= ROUTERS (CHECKSUM SAFE) =================
const RAW_ROUTERS = {
  quickswap: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

const ROUTERS = Object.fromEntries(
  Object.entries(RAW_ROUTERS).map(([name, addr]) => [
    name,
    ethers.getAddress(addr.toLowerCase())
  ])
);

// ================= TOKENS =================
const TOKENS = {
  USDC: USDC_ADDRESS,
  WETH: ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619")
};

// ================= PATHS =================
const PATHS = {
  USDC_TO_WETH: [TOKENS.USDC, TOKENS.WETH],
  WETH_TO_USDC: [TOKENS.WETH, TOKENS.USDC]
};

// ================= CONFIG =================
const AMOUNT_USDC = ethers.parseUnits("1000", 6);
const APPROVE_AMOUNT = ethers.parseUnits("1000000", 6);

// ================= HELPERS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ================= SAFETY CHECKS =================
async function assertOwnership() {
  const owner = await vaultContract.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Wallet is not contract owner.\nOwner: ${owner}\nWallet: ${wallet.address}`
    );
  }
  console.log("✔ Wallet is contract owner");
}

// ================= APPROVAL =================
async function ensureRouterApproval(router) {
  const allowance = await vaultContract.routerAllowance(router);
  if (allowance >= AMOUNT_USDC) return;

  console.log(`Approving router ${router}...`);
  const tx = await vaultContract.approveRouter(router, APPROVE_AMOUNT);
  await tx.wait();
  console.log(`✔ Approved ${router}`);
}

// ================= ARBITRAGE =================
async function tryArb(buyRouter, sellRouter) {
  const deadline = Math.floor(Date.now() / 1000) + 300;

  try {
    // Static call to simulate profit, avoid revert
    await vaultContract.executeArbitrage.staticCall(
      buyRouter,
      sellRouter,
      AMOUNT_USDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );

    // Send transaction if profitable
    const tx = await vaultContract.executeArbitrage(
      buyRouter,
      sellRouter,
      AMOUNT_USDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );
    console.log(`🚀 Arbitrage sent: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ Arbitrage confirmed`);
  } catch (err) {
    // Skip unprofitable paths silently
  }
}

// ================= SCANNER LOOP =================
async function scanLoop() {
  const routers = Object.values(ROUTERS);
  while (true) {
    for (const buy of routers) {
      for (const sell of routers) {
        if (buy === sell) continue;
        await tryArb(buy, sell);
        await sleep(400);
      }
    }
    await sleep(3000);
  }
}

// ================= MAIN =================
async function main() {
  console.log("Starting arbitrage bot…");

  await assertOwnership();

  // Pre-approve routers
  for (const router of Object.values(ROUTERS)) {
    await ensureRouterApproval(router);
    await sleep(300);
  }

  const minProfit = await vaultContract.minimumProfitUSDC();
  console.log(`Minimum profit enforced: ${ethers.formatUnits(minProfit, 6)} USDC`);

  await scanLoop();
}

// ================= SHUTDOWN =================
process.on("SIGINT", () => {
  console.log("Graceful shutdown");
  process.exit(0);
});

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
