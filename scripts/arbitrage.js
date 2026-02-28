import { ethers } from "ethers";

/* ================= CONFIG ================= */
const RPC_POLYGON = "https://polygon-rpc.com"; // Hardcoded RPC
const WALLET_PRIVATE_KEY = "YOUR_PRIVATE_KEY_HERE"; // Replace with your key

// Hardcoded Aave Pool and Vault addresses
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");
if (!AAVE_POOL) throw new Error("AAVE_POOL missing");
if (!VAULT_ADDRESS) throw new Error("VAULT_ADDRESS missing");

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = 0.0020;
const MIN_EXPECTED_PROFIT = 0.000001; // Execute only if profit > 0
const SCAN_DELAY_MS = 4000;
const DEADLINE_SECONDS = 60;
const DRY_RUN = true;

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACTS ================= */
const vaultAbi = [
  {
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= TOKENS ================= */
const TOKENS = {
  USDT:  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK:  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE:  "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  USDC:  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  DAI:   "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WETH:  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  UNI:   "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
  FRAX:  "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",
  BUSD:  "0x9c9e5fd8bbc25984b178fdce6117defa39d2db39",
  APE:   "0xb7b31a6bc18e48888545ce79e83e06003be70930",
  CRV:   "0x172370d5cd63279efa6d502dab29171933a610af",
  SRM:   "0x6bf2eb299e51fc5df30dec81d9445dde70e3f185",
  SAND:  "0xbbba073c31bf03b8acf7c28ef0738decf3695683",
  TUSD:  "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
  WOO:   "0x1b815d120b3ef02039ee11dc2d33de7aa4a8c603",
  XSGD:  "0xdc3326e71d45186f113a2f448984ca0e8d201995",
  MV:    "0xA3c322Ad15218fBFAEd26bA7f616249f7705D945",
  VCNT:  "0x8a16d4bf8a0a716017e8d2262c4ac32927797a2f"
};
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= HELPERS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function formatUSDC(n){ return Number(ethers.formatUnits(n,6)).toFixed(6); }

/* ================= PATH GENERATION ================= */
const FALLBACK_HOPS = [WMATIC, TOKENS.WETH, TOKENS.DAI, TOKENS.USDT];
function generatePaths(base, token){
  const paths = [[base, token]]; // direct
  for (let hop of FALLBACK_HOPS) if(hop !== token) paths.push([base, hop, token]);
  return paths;
}

/* ================= FLASH SIMULATION ================= */
async function simulateFlashAmount(tokenAddr){
  // Dummy pool liquidity (real Aave calls may vary)
  let poolLiquidity = ethers.parseUnits("1000000",6); // 1M USDC
  let safeAmount = ethers.parseUnits((Number(ethers.formatUnits(poolLiquidity,6))*0.5).toFixed(6),6);
  return safeAmount;
}

/* ================= QUOTE HELPER ================= */
const routerAbi = ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"];
async function quote(routerAddr, amountIn, path){
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  try {
    const amounts = await router.getAmountsOut(amountIn,path);
    return amounts[amounts.length-1];
  } catch { return null; }
}

/* ================= CORE ARBITRAGE ================= */
async function tryArb(buyRouter, sellRouter, tokenAddr){
  const usdcAddress = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(),6);

  const flashAmount = await simulateFlashAmount(usdcAddress);

  const buyPaths = generatePaths(usdcAddress, tokenAddr);
  const sellPaths = generatePaths(tokenAddr, usdcAddress);

  let bestProfit = -Infinity;
  let bestBuyPath, bestSellPath;

  for (let bPath of buyPaths){
    for (let sPath of sellPaths){
      const buyOut = await quote(buyRouter, flashAmount, bPath);
      if(!buyOut) continue;
      const sellOut = await quote(sellRouter, buyOut, sPath);
      if(!sellOut) continue;
      const profit = Number(ethers.formatUnits(sellOut,6)) - Number(ethers.formatUnits(flashAmount,6));
      if(profit > bestProfit){
        bestProfit = profit;
        bestBuyPath = bPath;
        bestSellPath = sPath;
      }
    }
  }

  console.log("🧪 Running Flash Simulation...");
  console.log(`💰 Expected Profit: ${bestProfit.toFixed(6)} USDC`);
  console.log(`🏦 Aave Available USDC Liquidity: ${formatUSDC(flashAmount*2)}`);
  console.log(`⚙️ Optimal Flash Amount: ${formatUSDC(flashAmount)}`);

  if(bestProfit < MIN_EXPECTED_PROFIT){
    console.log("⚠️ Profit too low, skipping execution");
    return;
  }

  if(DRY_RUN){
    console.log("🔎 DRY RUN: would execute arbitrage with profit > 0");
    return;
  }

  const deadline = Math.floor(Date.now()/1000)+DEADLINE_SECONDS;
  const tx = await vault.executeArbitrage(
    buyRouter, sellRouter, flashAmount, bestBuyPath, bestSellPath, deadline
  );
  console.log("⛓ TX SENT:", tx.hash);
  await tx.wait();
  console.log("✅ Arbitrage executed");
}

/* ================= MAIN LOOP ================= */
(async()=>{
  console.log("✅ Connected to RPC:", RPC_POLYGON);
  console.log("🚀 Arbitrage bot started");

  while(true){
    try{
      for(const token of Object.values(TOKENS)){
        await tryArb(routers.QuickSwap, routers.SushiSwap, token);
        await sleep(1200);
      }
    } catch(e){
      console.log("⚠️ Scan error:", e?.message ?? e);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
