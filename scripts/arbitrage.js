import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ==========================================
// 1. SANITIZE & NORMALIZE INPUTS
// ==========================================
// Strips non-printable characters, newlines (\n / {0A}), and converts to lowercase before checksumming
const toSafeChecksumAddress = (rawAddress, fallbackAddress) => {
  const cleaned = rawAddress
    ? rawAddress.trim().replace(/[\r\n\t]/g, "").toLowerCase()
    : fallbackAddress.toLowerCase();
  return ethers.getAddress(cleaned);
};

const sanitizeString = (str) => (str ? str.trim().replace(/[\r\n\t]/g, "") : "");

const RPC_URL = sanitizeString(process.env.RPC_URL) || "https://polygon-bor-rpc.publicnode.com";
const RAW_PK = sanitizeString(process.env.PRIVATE_KEY);

if (!RAW_PK) {
  console.error("❌ [FATAL ERROR]: PRIVATE_KEY environment variable is missing!");
  process.exit(1);
}

// Convert inputs safely to EIP-55 Checksum Addresses
const PAIR_ADDRESS = toSafeChecksumAddress(process.env.PAIR_ADDRESS, "0x6F4acF77f837463641fd732DC167c9A383CB0d88");
const USDC_ADDRESS = toSafeChecksumAddress(process.env.USDC_ADDRESS, "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
// Official Polygon Mainnet QuickSwap V2 Router: 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff
const ROUTER_ADDRESS = toSafeChecksumAddress(process.env.ROUTER_ADDRESS, "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff");

// ==========================================
// 2. ABIs (HUMAN-READABLE)
// ==========================================
const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
];

const ROUTER_ABI = [
  "function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)"
];

// Re-entrancy Lock & Counter
let isExecuting = false;
let pollCount = 0;

// ==========================================
// 3. MAIN CONTINUOUS ENGINE
// ==========================================
async function runEngine() {
  console.log(`\n================================================================================`);
  console.log(`🔌 Initializing HTTPS Provider: ${RPC_URL}`);
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  try {
    const network = await provider.getNetwork();
    console.log(`✅ Connected to Polygon Mainnet (Chain ID: ${network.chainId.toString()})`);
  } catch (err) {
    console.error(`❌ [ERROR]: Failed to connect to Polygon RPC: ${err.message}`);
    process.exit(1);
  }

  const wallet = new ethers.Wallet(RAW_PK, provider);
  console.log(`🔑 Monitoring Wallet Address: ${wallet.address}`);

  // Contract Instances
  const pairContract = new ethers.Contract(PAIR_ADDRESS, PAIR_ABI, wallet);
  const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

  const usdcDecimals = Number(await usdcContract.decimals());
  const initialDeposit = parseFloat(process.env.INITIAL_DEPOSIT_USDC || "0.02");
  const targetProfit = parseFloat(process.env.TARGET_NET_PROFIT_USDC || "10000.00");
  const targetThreshold = initialDeposit + targetProfit;

  console.log(`📍 LP Pair Contract: ${PAIR_ADDRESS}`);
  console.log(`📍 Router Contract:  ${ROUTER_ADDRESS}`);
  console.log(`🎯 Target Pool Balance: $${targetThreshold.toFixed(2)} USDC.e`);
  console.log(`================================================================================\n`);
  console.log(`🚀 CONTINUOUS SCANNING ENGINE ACTIVE (Polling every 3 seconds)\n`);

  // Function to inspect pool balance
  const checkBalance = async () => {
    if (isExecuting) return;

    try {
      pollCount++;
      const currentBlock = await provider.getBlockNumber();
      const rawBalance = await usdcContract.balanceOf(PAIR_ADDRESS);
      const formattedBalance = parseFloat(ethers.formatUnits(rawBalance, usdcDecimals));
      const netProfit = formattedBalance - initialDeposit;
      const progressPercent = ((formattedBalance / targetThreshold) * 100).toFixed(4);

      console.log(
        `[${new Date().toISOString()}] [#${pollCount.toString().padStart(5, "0")}] Block #${currentBlock} | Pool Reserve: $${formattedBalance.toFixed(
          4
        )} USDC.e | Net Profit: +$${netProfit.toFixed(2)} (${progressPercent}%)`
      );

      // Check Execution Trigger
      if (formattedBalance >= targetThreshold) {
        isExecuting = true;
        console.warn(`\n--------------------------------------------------------------------------------`);
        console.warn(`🚨 TARGET REACHED! Current Balance: $${formattedBalance.toFixed(2)} >= Threshold: $${targetThreshold.toFixed(2)}`);
        console.warn(`🚨 Initiating Automatic Liquidity Withdrawal...`);
        console.warn(`--------------------------------------------------------------------------------\n`);

        const lpBalance = await pairContract.balanceOf(wallet.address);
        if (lpBalance === 0n) {
          throw new Error("Wallet holds 0 LP tokens. Cannot execute removeLiquidity().");
        }

        const token0 = await pairContract.token0();
        const token1 = await pairContract.token1();

        console.log(`🔓 Approving Router (${ROUTER_ADDRESS}) to spend ${lpBalance.toString()} LP tokens...`);
        const approveTx = await pairContract.approve(ROUTER_ADDRESS, lpBalance);
        console.log(`⏳ Approval Transaction Sent: ${approveTx.hash}`);
        await approveTx.wait();
        console.log(`✅ Router Approved!`);

        console.log(`💸 Executing removeLiquidity()...`);
        const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minute deadline
        
        const removeTx = await routerContract.removeLiquidity(
          token0,
          token1,
          lpBalance,
          0n, // Accept min amountA
          0n, // Accept min amountB
          wallet.address,
          deadline
        );

        console.log(`⏳ Liquidity Removal Sent: ${removeTx.hash}`);
        const receipt = await removeTx.wait();

        console.log(`\n🎉 SUCCESS! Liquidity removed in Polygon Block #${receipt.blockNumber}.`);
        console.log(`🎉 Funds withdrawn to wallet: ${wallet.address}`);
        process.exit(0);
      }
    } catch (err) {
      console.error(`⚠️  [SCAN WARN]: ${err.message}`);
    }
  };

  // Perform initial check immediately
  await checkBalance();

  // Polling Interval (Runs every 3 seconds)
  const pollInterval = setInterval(checkBalance, 3000);

  // Keep process alive explicitly
  const keepAlive = setInterval(() => {}, 100000);

  // Graceful shutdown handlers
  process.on("SIGINT", () => {
    clearInterval(pollInterval);
    clearInterval(keepAlive);
    console.log("\n🛑 Engine stopped by user.");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(pollInterval);
    clearInterval(keepAlive);
    console.log("\n🛑 Engine stopped by system.");
    process.exit(0);
  });
}

runEngine();
