import { ethers } from "ethers";
import WebSocket from "ws";
import dotenv from "dotenv";
dotenv.config();

// Default to Polygon Bor WSS Endpoint if RPC_WSS_URL is not explicitly set in secrets
const POLYGON_BOR_WSS = process.env.RPC_WSS_URL || "wss://polygon-bor-wss.publicnode.com";

// Smart Contract / Pair Addresses
const PAIR_ADDRESS = "0x6F4acF77f837463641fd732DC167c9A383CB0d88";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e on Polygon PoS
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0x8954AfA98594b868B2566200270386cE5134d010"; // QuickSwap Router

// Contract ABIs
const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
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

let provider;
let pairContract;
let isExecuting = false;

// Custom WebSocket connection wrapper to handle Polygon Bor disconnects & resets
function createResilientWebSocketProvider(url) {
  return new Promise((resolve) => {
    let ws;

    const connect = () => {
      console.log(`🔌 Connecting to Polygon Bor WebSocket: ${url}`);
      ws = new WebSocket(url);

      ws.on("open", () => {
        console.log("✅ Polygon Bor WebSocket connected successfully.");
        const wsProvider = new ethers.WebSocketProvider(url);
        resolve(wsProvider);
      });

      ws.on("close", (code) => {
        console.warn(`⚠️ WebSocket connection closed (Code: ${code}). Reconnecting in 3 seconds...`);
        setTimeout(startMonitoring, 3000);
      });

      ws.on("error", (err) => {
        console.error("❌ Polygon WebSocket Error:", err.message);
        ws.close();
      });
    };

    connect();
  });
}

async function startMonitoring() {
  if (isExecuting) return;

  try {
    const pk = process.env.PRIVATE_KEY;
    if (!pk) {
      throw new Error("PRIVATE_KEY secret is missing! Ensure it is set in GitHub Repository Secrets.");
    }

    provider = await createResilientWebSocketProvider(POLYGON_BOR_WSS);
    const wallet = new ethers.Wallet(pk, provider);

    pairContract = new ethers.Contract(PAIR_ADDRESS, PAIR_ABI, wallet);
    const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const usdcDecimals = await usdcContract.decimals();
    const initialDeposit = parseFloat(process.env.INITIAL_DEPOSIT_USDC || "0.02");
    const targetProfit = parseFloat(process.env.TARGET_NET_PROFIT_USDC || "10000.00");
    const targetBalance = initialDeposit + targetProfit;

    console.log(`🚀 REACTIVE EVENT-DRIVEN MULTI-HOP ENGINE ONLINE`);
    console.log(`📍 Contract Address: ${PAIR_ADDRESS}`);
    console.log(`🎯 Target Pool USDC.e Balance: $${targetBalance.toFixed(2)}`);

    // Stream real-time Swap events on Polygon Bor
    pairContract.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (isExecuting) return;

      try {
        const poolUsdcBalance = await usdcContract.balanceOf(PAIR_ADDRESS);
        const formattedBalance = parseFloat(ethers.formatUnits(poolUsdcBalance, usdcDecimals));
        const netProfit = formattedBalance - initialDeposit;
        const progress = ((formattedBalance / targetBalance) * 100).toFixed(2);

        console.log(
          `⚡ [Polygon Block ${event.log.blockNumber}] Swap Event Detected | Pool Balance: $${formattedBalance.toFixed(
            2
          )} USDC.e | Net Profit: +$${netProfit.toFixed(2)} (${progress}%)`
        );

        if (formattedBalance >= targetBalance) {
          isExecuting = true;
          console.warn("🚨 TARGET $10,000.00 USDC.e REACHED! Pulling Liquidity...");

          const lpBalance = await pairContract.balanceOf(wallet.address);
          if (lpBalance === 0n) {
            throw new Error("No LP tokens found in wallet address for withdrawal.");
          }

          const token0 = await pairContract.token0();
          const token1 = await pairContract.token1();

          console.log("🔓 Approving Router for LP Token spend...");
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
        console.error("Error processing swap event:", err);
      }
    });
  } catch (error) {
    console.error("Initialization error, retrying in 5s...", error.message);
    setTimeout(startMonitoring, 5000);
  }
}

startMonitoring();
