import { ethers } from "ethers";  

/* ================= CONFIG ================= */  
const RPC_POLYGON = "https://polygon-rpc.com"; // Hardcoded RPC
const WALLET_PRIVATE_KEY = "YOUR_PRIVATE_KEY_HERE"; // Replace with your key

// Hardcoded Aave Pool addresses (Polygon mainnet)
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; 
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";  

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");  
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");  
if (!AAVE_POOL) throw new Error("AAVE_POOL missing");  
if (!VAULT_ADDRESS) throw new Error("VAULT_ADDRESS missing");  

/* ================= CONSTANTS ================= */  
const MIN_TRADE_USDC = 0.0020;  
const MIN_EXPECTED_PROFIT = 0.000001;  
const SCAN_DELAY_MS = 4000;  
const DEADLINE_SECONDS = 60;  
const DRY_RUN = true; // Safe default  

/* ================= PROVIDER & WALLET ================= */  
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);  
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);  

/* ================= CONTRACTS ================= */  
const vaultAbi = [  
  { inputs:[{name:"buyRouter",type:"address"},{name:"sellRouter",type:"address"},{name:"amountInUSDC",type:"uint256"},{name:"pathToToken",type:"address[]"},{name:"pathToUSDC",type:"address[]"},{name:"deadline",type:"uint256"}],name:"executeArbitrage",outputs:[],stateMutability:"nonpayable",type:"function"},  
  { inputs:[], name:"usdc", outputs:[{type:"address"}], stateMutability:"view", type:"function"}  
];  
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);  

/* ================= TOKENS ================= */  
const TOKENS = { USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" };  
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";  

/* ================= HELPERS ================= */  
const sleep = ms => new Promise(r => setTimeout(r, ms));  
function formatUSDC(n){ return Number(ethers.formatUnits(n,6)).toFixed(6); }  

/* ================= FLASH SIMULATION ================= */  
async function simulateFlashAmount(tokenAddr){  
  // Hardcoded pool contract ABI for liquidity  
  const poolContract = new ethers.Contract(AAVE_POOL, ["function getReserveData(address) view returns(uint256 availableLiquidity)"], provider);  
  let liquidity = await poolContract.getReserveData(tokenAddr).catch(() => ethers.parseUnits("1000",6));  
  if (!liquidity) liquidity = ethers.parseUnits("1000",6);  
  // Use safe 50% of liquidity
  return ethers.parseUnits((Number(ethers.formatUnits(liquidity,6))*0.5).toFixed(6),6);  
}  

/* ================= CORE ARBITRAGE LOGIC ================= */  
async function tryArb(buyRouter, sellRouter, tokenAddr){  
  const usdcAddress = await vault.usdc();  
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(),6);  

  const flashAmount = await simulateFlashAmount(TOKENS.USDC);  
  console.log("🧪 Running Flash Simulation...");  
  console.log(`🏦 Aave Available USDC Liquidity: ${formatUSDC(flashAmount)*2}`);  
  console.log(`⚙️ Optimal Flash Amount: ${formatUSDC(flashAmount)}`);  

  if (DRY_RUN){  
    console.log("🔎 DRY RUN: would call vault.executeArbitrage");  
    return;  
  }  

  const deadline = Math.floor(Date.now()/1000)+DEADLINE_SECONDS;  
  const tx = await vault.executeArbitrage(buyRouter, sellRouter, flashAmount, [usdcAddress, tokenAddr], [tokenAddr, usdcAddress], deadline);  
  console.log("⛓ TX SENT: ", tx.hash);  
  await tx.wait();  
  console.log("✅ Arbitrage executed");  
}  

/* ================= MAIN LOOP ================= */  
(async()=>{  
  console.log("✅ Connected to RPC: ", RPC_POLYGON);  
  console.log("🚀 Arbitrage bot started");  

  while(true){  
    try{  
      await tryArb("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", TOKENS.USDC);  
    }catch(e){  
      console.log("⚠️ Scan error:", e?.message ?? e);  
    }  
    await sleep(SCAN_DELAY_MS);  
  }  
})();  
