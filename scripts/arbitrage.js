import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ==========================================
// 1. SANITIZE & NORMALIZE INPUTS
// ==========================================
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

// Polygon Mainnet Known Contracts
const PZZC_TOKEN = toSafeChecksumAddress(process.env.TOKEN_ADDRESS, "0x6F4acF77f837463641fd732DC167c9A383CB0d88");
const USDC_ADDRESS = toSafeChecksumAddress(process.env.USDC_ADDRESS, "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"); // USDC.e
const FACTORY_ADDRESS = toSafeChecksumAddress(process.env.FACTORY_ADDRESS, "0x5757371414417b8C6CAad45bAeF915270E361571"); // QuickSwap V2 Factory
const ROUTER_ADDRESS = toSafeChecksumAddress(process.env.ROUTER_ADDRESS, "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"); // QuickSwap V2 Router

// ==========================================
// 2. HUMAN-READABLE ABIs
// ==========================================
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
];

const ROUTER_ABI = [
  "function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)"
];

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
  console.log(`🏭 Querying QuickSwap Factory: ${FACTORY_ADDRESS}`);

  // Fetch true LP Pair contract from QuickSwap Factory
  const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
  let pairAddress;

  try {
    console.log(`🔎 Looking up LP pair for PZZC (${PZZC_TOKEN}) and USDC.e (${USDC_ADDRESS})...`);
    pairAddress = await factoryContract.getPair(PZZC_TOKEN, USDC_ADDRESS);

    if (!pairAddress || pairAddress === ethers.ZeroAddress) {
      console.error(`❌ [FACTORY ERROR]: QuickSwap returned address(0). No LP pair exists for this token pair!`);
      process.exit(1);
    }

    pairAddress = ethers.getAddress(pairAddress);
    console.log(`✅ Found LP Pair Address: ${pairAddress}`);
  } catch (err) {
    console.error(`❌ [FACTORY ERROR]: ${err.message}`);
    console.error(`💡 Verify that FACTORY_ADDRESS (${FACTORY_ADDRESS}) is correct and deployed on Chain ID 137.`);
    process.exit(1);
  }

  // Contract Instances
  const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, wallet);
  const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

  const usdcDecimals = Number(await usdcContract.decimals());
  const initialDeposit = parseFloat(process.env.INITIAL_DEPOSIT_USDC || "0.02");
  const targetProfit = parseFloat(process.env.TARGET_NET_PROFIT_USDC || "10000.00");
  const targetThreshold = initialDeposit + targetProfit;

  // Determine token positions in the pool
  const token0 = await pairContract.token0();
  const token1 = await pairContract.token1();
  const isToken0Usdc = token0.toLowerCase() === USDC_ADDRESS.toLowerCase();

  console.log(`📍 Token Contract (PZZC): ${PZZC_TOKEN}`);
  console.log(`📍 LP Pair Contract:     ${pairAddress}`);
  console.log(`📍 Router Contract:      ${ROUTER_ADDRESS}`);
  console.log(`🎯 Target Pool Balance:  $${targetThreshold.toFixed(2)} USDC.e`);
  console.log(`================================================================================\n`);
  console.log(`🚀 CONTINUOUS SCANNING ENGINE ACTIVE (Polling every 3 seconds)\n`);

  const checkBalance = async () => {
    if (isExecuting) return;

    try {
      pollCount++;
      const currentBlock = await provider.getBlockNumber();
      
      const [reserve0, reserve1] = await pairContract.getReserves();
      const usdcReserve = isToken0Usdc ? reserve0 : reserve1;
      
      const formattedBalance = parseFloat(ethers.formatUnits(usdcReserve, usdcDecimals));
      const netProfit = formattedBalance - initialDeposit;
      const progressPercent = ((formattedBalance / targetThreshold) * 100).toFixed(4);

      console.log(
        `[${new Date().toISOString()}] [#${pollCount.toString().padStart(5, "0")}] Block #${currentBlock} | Pool Reserve: $${formattedBalance.toFixed(
          4
        )} USDC.e | Net Profit: +$${netProfit.toFixed(2)} (${progressPercent}%)`
      );

      if (formattedBalance >= targetThreshold) {
        isExecuting = true;
        console.warn(`\n--------------------------------------------------------------------------------`);
        console.warn(`🚨 TARGET REACHED! Current Reserve: $${formattedBalance.toFixed(2)} >= Threshold: $${targetThreshold.toFixed(2)}`);
        console.warn(`🚨 Initiating Automatic Liquidity Withdrawal...`);
        console.warn(`--------------------------------------------------------------------------------\n`);

        const lpBalance = await pairContract.balanceOf(wallet.address);
        if (lpBalance === 0n) {
          throw new Error("Wallet holds 0 LP tokens in pair. Cannot execute removeLiquidity().");
        }

        console.log(`🔓 Approving Router (${ROUTER_ADDRESS}) to spend ${lpBalance.toString()} LP tokens...`);
        const approveTx = await pairContract.approve(ROUTER_ADDRESS, lpBalance);
        console.log(`⏳ Approval Transaction Sent: ${approveTx.hash}`);
        await approveTx.wait();
        console.log(`✅ Router Approved!`);

        console.log(`💸 Executing removeLiquidity()...`);
        const deadline = Math.floor(Date.now() / 1000) + 300;
        
        const removeTx = await routerContract.removeLiquidity(
          token0,
          token1,
          lpBalance,
          0n,
          0n,
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

  await checkBalance();
  const pollInterval = setInterval(checkBalance, 3000);
  const keepAlive = setInterval(() => {}, 100000);

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
