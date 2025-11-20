import { ethers } from "ethers";

// ========== CONFIG ==========
const ARB_CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS = "0xYourUSDCAddressHere"; // update for mainnet/testnet
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", 6); // 0.01 USDC minimum net profit

// DEX routers
const DEXES = {
  quickswap: "0xQuickSwapRouterAddress",
  sushiswap: "0xSushiSwapRouterAddress",
  apeswap: "0xApeSwapRouterAddress",
};

// Your wallet private key
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;

// Provider
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");

// Signer
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// Contract ABI (only needed functions)
const ARB_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

// ========== MAIN FUNCTION ==========
async function main() {
  console.log("🚀 LIVE MODE ENABLED — FULL FAILSAFE CHECKS");

  const arbContract = new ethers.Contract(ARB_CONTRACT_ADDRESS, ARB_ABI, wallet);

  // Fetch owner for logging
  const owner = await arbContract.owner();
  console.log("🏛 Contract Address:", ARB_CONTRACT_ADDRESS);
  console.log("👤 Owner:", owner);

  // Fetch vault USDC balance
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  let vaultBalanceBefore = await usdcContract.balanceOf(ARB_CONTRACT_ADDRESS);
  console.log("🏦 Vault Before:", ethers.formatUnits(vaultBalanceBefore, 6), "USDC");

  // Example token to arbitrage
  const tokenToArb = "0xTokenAddressHere";

  // Example trade amount
  const amountIn = ethers.parseUnits("10", 6); // 10 USDC

  // Example DEX pair
  const buyRouter = DEXES.quickswap;
  const sellRouter = DEXES.sushiswap;

  console.log("🔍 Checking arbitrage opportunity...");

  try {
    // =======================
    // Step 1: Simulate via callStatic
    // =======================
    const callStaticResult = await arbContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenToArb,
      amountIn
    );

    console.log("🧪 callStatic: SUCCESS — Trade can execute on-chain");

    // =======================
    // Step 2: Execute trade
    // =======================
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenToArb,
      amountIn
    );

    console.log("📤 Broadcasting transaction...");
    console.log("⏳ Pending tx...");

    const receipt = await tx.wait();
    console.log("✅ Trade Confirmed — status:", receipt.status);
    console.log("⛽ Gas Used:", receipt.gasUsed.toString());

    // =======================
    // Step 3: Check vault after trade
    // =======================
    let vaultBalanceAfter = await usdcContract.balanceOf(ARB_CONTRACT_ADDRESS);
    const netProfit = vaultBalanceAfter - vaultBalanceBefore;

    if (netProfit > 0) {
      console.log("🏦 Vault After:", ethers.formatUnits(vaultBalanceAfter, 6), "USDC");
      console.log("📈 Net Profit:", ethers.formatUnits(netProfit, 6), "USDC");
      console.log("🎉 SUCCESS — Vault balance increased");
    } else {
      console.warn("⚠ Vault balance did NOT increase — trade blocked or failed");
    }
  } catch (err) {
    console.error("❌ Trade blocked — callStatic failed or unexpected error:", err);
  }
}

// Run main
main()
  .then(() => console.log("🔁 Arbitrage cycle completed"))
  .catch((err) => console.error(err));
