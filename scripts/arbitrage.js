import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// Primary Polygon Bor HTTPS RPC Endpoint (Public Node)
const POLYGON_BOR_HTTPS = process.env.RPC_URL || "https://polygon-bor-rpc.publicnode.com";

// Smart Contract & Router Addresses
const PAIR_ADDRESS = "0x6F4acF77f837463641fd732DC167c9A383CB0d88";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e on Polygon
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0x8954AfA98594b868B2566200270386cE5134d010"; // QuickSwap Router

// ABIs
const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

const ROUTER_ABI = [
  "function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)"
];

let isExecuting = false;

async function startPolling() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("❌ Fatal Error: PRIVATE_KEY secret is missing!");
    process.exit(1);
  }

  console.log(`🔌 Initializing HTTPS Connection: ${POLYGON_BOR_HTTPS}`);
  const provider = new ethers.JsonRpcProvider(POLYGON_BOR_HTTPS);

  // Validate network connection
  try {
    const network = await provider.getNetwork();
    console.log(`✅ Connected to Polygon Mainnet (Chain ID: ${network.chainId})`);
  } catch (err) {
    console.error("❌ Failed to connect to RPC endpoint:", err.message);
    process.exit(1);
  }

  const wallet = new ethers.Wallet(pk, provider);
  const pairContract = new ethers.Contract(PAIR_ADDRESS, PAIR_ABI, wallet);
  const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

  const usdcDecimals = await usdcContract.decimals();
  const initialDeposit = parseFloat(process.env.INITIAL_DEPOSIT_USDC || "0.02");
  const targetProfit = parseFloat(process.env.TARGET_NET_PROFIT_USDC || "10000.00");
  const targetBalance = initialDeposit + targetProfit;

  console.log("🚀 REACTIVE HTTPS POLLING ENGINE ONLINE");
  console.log(`📍 Contract Address: ${PAIR_ADDRESS}`);
  console.log(`🎯 Target Pool USDC.e Balance: $${targetBalance.toFixed(2)}`);
  console.log("⏱️ Polling pool balance every 3 seconds...\n");

  // Periodic polling interval loop
  setInterval(async () => {
    if (isExecuting) return;

    try {
      const currentBlock = await provider.getBlockNumber();
      const rawBalance = await usdcContract.balanceOf(PAIR_ADDRESS);
      const formattedBalance = parseFloat(ethers.formatUnits(rawBalance, usdcDecimals));
      const netProfit = formattedBalance - initialDeposit;
      const progress = ((formattedBalance / targetBalance) * 100).toFixed(4);

      console.log(
        `[${new Date().toISOString()}] Block #${currentBlock} | Pool Balance: $${formattedBalance.toFixed(
          2
        )} USDC.e | Net Profit: +$${netProfit.toFixed(2)} (${progress}%)`
      );

      // Check condition trigger
      if (formattedBalance >= targetBalance) {
        isExecuting = true;
        console.warn("\n🚨 TARGET $10,000.00 USDC.e REACHED! Executing Liquidity Withdrawal...");

        const lpBalance = await pairContract.balanceOf(wallet.address);
        if (lpBalance === 0n) {
          throw new Error("No LP tokens found in wallet address for withdrawal.");
        }

        const token0 = await pairContract.token0();
        const token1 = await pairContract.token1();

        console.log("🔓 Approving Router to spend LP Tokens...");
        const approveTx = await pairContract.approve(ROUTER_ADDRESS, lpBalance);
        await approveTx.wait();

        console.log("💸 Executing removeLiquidity()...");
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const withdrawTx = await routerContract.removeLiquidity(
          token0,
          token1,
          lpBalance,
          0n,
          0n,
          wallet.address,
          deadline
        );

        console.log(`⏳ Tx Broadcasted: ${withdrawTx.hash}`);
        const receipt = await withdrawTx.wait();

        console.log(`🎉 SUCCESS! Liquidity removed in Polygon Block #${receipt.blockNumber}. Profit secured!`);
        process.exit(0);
      }
    } catch (err) {
      console.error(`⚠️ Polling Error: ${err.message}`);
    }
  }, 3000); // Polls every 3000ms (3 seconds)
}

startPolling();
