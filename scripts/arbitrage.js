import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// Contract ABIs
const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

const ROUTER_ABI = [
  "function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)"
];

async function main() {
  console.log("🚀 Starting Real-Time Liquidity & Profit Engine...");

  // Initialize WebSocket Provider for instant event streaming
  const provider = new ethers.WebSocketProvider(process.env.RPC_WSS_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  const pairContract = new ethers.Contract(process.env.PAIR_ADDRESS, PAIR_ABI, wallet);
  const routerContract = new ethers.Contract(process.env.ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const usdcContract = new ethers.Contract(process.env.USDC_ADDRESS, ERC20_ABI, provider);

  // Determine token decimals and pair orientation
  const usdcDecimals = await usdcContract.decimals(); // USDC.e uses 6 decimals
  const token0 = await pairContract.token0();
  const isUsdcToken0 = token0.toLowerCase() === process.env.USDC_ADDRESS.toLowerCase();

  const initialDeposit = parseFloat(process.env.INITIAL_DEPOSIT_USDC || "0.02");
  const targetProfit = parseFloat(process.env.TARGET_NET_PROFIT_USDC || "10000.00");
  const targetBalance = initialDeposit + targetProfit; // e.g., 10000.02 USDC.e

  console.log(`📍 Pool Address: ${process.env.PAIR_ADDRESS}`);
  console.log(`🎯 Initial Seed: $${initialDeposit} USDC.e | Target Pool Balance: $${targetBalance.toFixed(2)} USDC.e`);

  let isExecuting = false;

  // Real-time Event Listener for Swap Activity
  pairContract.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
    if (isExecuting) return;

    try {
      // Query exact live USDC.e reserve in the pool contract
      const poolUsdcBalance = await usdcContract.balanceOf(process.env.PAIR_ADDRESS);
      const formattedBalance = parseFloat(ethers.formatUnits(poolUsdcBalance, usdcDecimals));
      const netProfit = formattedBalance - initialDeposit;
      const progressPercent = ((formattedBalance / targetBalance) * 100).toFixed(2);

      console.log(
        `⚡ [BLOCK ${event.log.blockNumber}] Swap Detected | Pool USDC.e Balance: $${formattedBalance.toFixed(
          2
        )} | Net Profit: +$${netProfit.toFixed(2)} (${progressPercent}%)`
      );

      // Check Target Milestone
      if (formattedBalance >= targetBalance) {
        isExecuting = true;
        console.warn(`🚨 TARGET REACHED! Initiating Automated Profit Extraction...`);

        await executeLiquidityWithdrawal(pairContract, routerContract, wallet, isUsdcToken0);
        process.exit(0);
      }
    } catch (err) {
      console.error("❌ Error checking pool metrics:", err);
    }
  });
}

async function executeLiquidityWithdrawal(pairContract, routerContract, wallet, isUsdcToken0) {
  try {
    // 1. Get LP token balance owned by wallet
    const lpBalance = await pairContract.balanceOf(wallet.address);
    console.log(`📥 LP Balance Found: ${ethers.formatEther(lpBalance)} LP Tokens`);

    if (lpBalance === 0n) {
      throw new Error("Zero LP balance detected in treasury wallet!");
    }

    // 2. Identify token pairs
    const token0 = await pairContract.token0();
    const token1 = await pairContract.token1();

    // 3. Approve Router to spend LP tokens
    console.log("🔓 Approving Router to transfer LP tokens...");
    const approveTx = await pairContract.approve(process.env.ROUTER_ADDRESS, lpBalance);
    await approveTx.wait();
    console.log("✅ Approval confirmed.");

    // 4. Submit removeLiquidity transaction
    const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5-minute block deadline
    console.log("💸 Executing removeLiquidity()...");

    const withdrawTx = await routerContract.removeLiquidity(
      token0,
      token1,
      lpBalance,
      0n, // Accept market slippage
      0n,
      wallet.address,
      deadline
    );

    console.log(`⏳ Withdrawal Transaction Sent: ${withdrawTx.hash}`);
    const receipt = await withdrawTx.wait();

    console.log(`🎉 SUCCESS! Liquidity pulled in Block #${receipt.blockNumber}. Profit secured in treasury!`);
  } catch (error) {
    console.error("❌ Liquidity Withdrawal Failed:", error);
  }
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
