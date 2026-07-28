import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ==========================================
// 1. SANITIZE & NORMALIZE INPUTS
// ==========================================
const sanitize = (val) => (val ? val.trim().replace(/[\r\n\t]/g, "") : "");

const RPC_URL = sanitize(process.env.RPC_URL) || "https://polygon-bor-rpc.publicnode.com";
const RAW_PAIR = sanitize(process.env.PAIR_ADDRESS) || "0x6F4acF77f837463641fd732DC167c9A383CB0d88";
const RAW_USDC = sanitize(process.env.USDC_ADDRESS) || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const RAW_ROUTER = sanitize(process.env.ROUTER_ADDRESS) || "0x8954AfA98594b868B2566200270386cE5134d010";
const RAW_PK = sanitize(process.env.PRIVATE_KEY);

if (!RAW_PK) {
  console.error("❌ Fatal Error: PRIVATE_KEY environment variable is missing!");
  process.exit(1);
}

// Convert strings to checksummed addresses to avoid ENS lookup errors ({0A} newlines)
const PAIR_ADDRESS = ethers.getAddress(RAW_PAIR);
const USDC_ADDRESS = ethers.getAddress(RAW_USDC);
const ROUTER_ADDRESS = ethers.getAddress(RAW_ROUTER);

// ==========================================
// 2. ABIs (HUMAN-READABLE FORMAT)
// ==========================================
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

// Operational flags
let isExecuting = false;

// ==========================================
// 3. MAIN REACTION & POLLING ENGINE
// ==========================================
async function runEngine() {
  console.log(`🔌 Initializing HTTPS Provider: ${RPC_URL}`);
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  try {
    const network = await provider.getNetwork();
    console.log(`✅ Connected to Polygon Mainnet (Chain ID: ${network.chainId.toString()})`);
  } catch (err) {
    console.error(`❌ Failed to connect to Polygon RPC: ${err.message}`);
    process.exit(1);
  }

  const wallet = new ethers.Wallet(RAW_PK, provider);
  console.log(`🔑 Wallet Address: ${wallet.address}`);

  // Contract Instances
  const pairContract = new ethers.Contract(PAIR_ADDRESS, PAIR_ABI, wallet);
  const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

  // Read Decimals and Initial Config
  const usdcDecimals = Number(await usdcContract.decimals());
  const initialDeposit = parseFloat(process.env.INITIAL_DEPOSIT_USDC || "0.02");
  const targetProfit = parseFloat(process.env.TARGET_NET_PROFIT_USDC || "10000.00");
  const targetThreshold = initialDeposit + targetProfit;

  console.log("\n🚀 REACTIVE HTTPS POLLING ENGINE ONLINE");
  console.log(`📍 LP Pair Contract: ${PAIR_ADDRESS}`);
  console.log(`🎯 Target Pool USDC.e Balance: $${targetThreshold.toFixed(2)}`);
  console.log("⏱️ Polling pool state every 3 seconds...\n");

  setInterval(async () => {
    if (isExecuting) return;

    try {
      const currentBlock = await provider.getBlockNumber();
      const rawBalance = await usdcContract.balanceOf(PAIR_ADDRESS);
      const formattedBalance = parseFloat(ethers.formatUnits(rawBalance, usdcDecimals));
      const netProfit = formattedBalance - initialDeposit;
      const progressPercent = ((formattedBalance / targetThreshold) * 100).toFixed(4);

      console.log(
        `[${new Date().toISOString()}] Block #${currentBlock} | Pool Balance: $${formattedBalance.toFixed(
          2
        )} USDC.e | Net Profit: +$${netProfit.toFixed(2)} (${progressPercent}%)`
      );

      // Check if Target Balance is Reached or Exceeded
      if (formattedBalance >= targetThreshold) {
        isExecuting = true;
        console.warn("\n🚨 TARGET $10,000.00 USDC.e REACHED! Triggering Liquidity Removal...");

        const lpBalance = await pairContract.balanceOf(wallet.address);
        if (lpBalance === 0n) {
          throw new Error("Wallet holds 0 LP tokens. Cannot execute removeLiquidity().");
        }

        const token0 = await pairContract.token0();
        const token1 = await pairContract.token1();

        console.log(`🔓 Approving QuickSwap Router (${ROUTER_ADDRESS}) to spend ${lpBalance.toString()} LP tokens...`);
        const approveTx = await pairContract.approve(ROUTER_ADDRESS, lpBalance);
        console.log(`⏳ Approval Tx Sent: ${approveTx.hash}`);
        await approveTx.wait();
        console.log("✅ Approval Confirmed.");

        console.log("💸 Calling removeLiquidity()...");
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

        console.log(`⏳ Liquidity Removal Tx Sent: ${removeTx.hash}`);
        const receipt = await removeTx.wait();

        console.log(`🎉 SUCCESS! Liquidity pulled in Polygon Block #${receipt.blockNumber}. Profit secured in wallet!`);
        process.exit(0);
      }
    } catch (err) {
      console.error(`⚠️ Polling Error: ${err.message}`);
    }
  }, 3000);
}

runEngine();
