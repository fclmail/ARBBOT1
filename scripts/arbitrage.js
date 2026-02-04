import { ethers } from "ethers";

// ============ CONFIG ============
const RPC_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = "0xYOUR_PRIVATE_KEY";
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ============ CONTRACT ============
const VAULT_CONTRACT_ADDRESS = "0xYourVaultContractAddress";
const USDC_ADDRESS = "0xYourUSDCAddress";

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
  "function approveRouter(address router, uint256 amount) external"
];

// Routers
const ROUTERS = {
  quickswap: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

// Tokens
const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  USDC: USDC_ADDRESS
};

// Path
const PATHS = {
  USDC_TO_WETH: [TOKENS.USDC, TOKENS.WETH],
  WETH_TO_USDC: [TOKENS.WETH, TOKENS.USDC]
};

const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, wallet);

// ============ HELPERS ============
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

// ============ EXECUTE ARBITRAGE ============
async function executeArb() {
  const amountInUSDC = ethers.parseUnits("1000", 6); // $1000
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes

  // Example: QuickSwap -> SushiSwap
  const buyRouter = ROUTERS.quickswap;
  const sellRouter = ROUTERS.sushiswap;

  console.log("Executing arbitrage...");

  try {
    const tx = await vaultContract.executeArbitrage(
      buyRouter,
      sellRouter,
      amountInUSDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );
    console.log("Transaction sent. Waiting for confirmation...");
    const receipt = await tx.wait();
    console.log("Arbitrage executed successfully!");
    console.log("Tx hash:", receipt.transactionHash);
  } catch (err) {
    console.error("Arbitrage execution failed:", err.reason || err);
  }
}

// ============ MAIN ============
async function main() {
  // Approve routers first
  const approveAmount = ethers.parseUnits("1000000", 6);
  for (const router of Object.values(ROUTERS)) {
    await approveRouter(router, approveAmount);
    // small delay to avoid RPC rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  // Execute arbitrage
  await executeArb();
}

main();
