import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing private key");

const DRY_RUN = false;
const MIN_TRADE_USDC = 0.05;
const MIN_EXPECTED_PROFIT = 0.00001;
const SLIPPAGE_PCT = 0.05;

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m"
};
const fmt = (n,d=6)=>Number(n).toFixed(d);

// ----------------- RPC LOCK -----------------
const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon-public.nodies.app",
  "https://polygon.drpc.org"
];

// Ping test RPCs before fallback provider
async function getValidProviders() {
  const valid = [];
  for(const url of RPCS){
    try{
      const p = new ethers.JsonRpcProvider(url,137);
      const n = await p.getNetwork();
      if(n.chainId===137) valid.push({provider:p,weight:1});
    }catch{}
  }
  if(valid.length===0) throw new Error("No valid Polygon RPCs");
  return valid;
}

const providers = await getValidProviders();
const provider = new ethers.FallbackProvider(providers,1);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- VAULT -----------------
const VAULT_ADDRESS="0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";
const vaultAbi=["function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns(address)",
  "function approveRouter(address router,address token) external"];
const vault = new ethers.Contract(VAULT_ADDRESS,vaultAbi,wallet);

const erc20Abi=["function balanceOf(address) view returns(uint256)","function decimals() view returns(uint8)","function allowance(address owner,address spender) view returns(uint256)","function approve(address spender,uint256 amount) external returns(bool)"];

const tokens={AAVE:{address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",decimals:18},
              LINK:{address:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",decimals:18}};

const routers={QuickSwap:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
               SushiSwap:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"};

const BASES=["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"];

// ----------------- HELPERS -----------------
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function vaultBalance(){
  const usdc=new ethers.Contract(await vault.USDC(),erc20Abi,provider);
  const raw=await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw,6));
}

async function quote(routerAddr,token,amountUSDC){
  const router=new ethers.Contract(routerAddr,["function getAmountsOut(uint,address[]) view returns(uint[])"],provider);
  const amt=ethers.parseUnits(amountUSDC.toString(),6);
  for(const base of BASES){
    try{
      const out=await router.getAmountsOut(amt,[base,token.address]);
      if(Number(out[1])>0) return Number(ethers.formatUnits(out[1],token.decimals));
    }catch{}
  }
  return null;
}

async function ensureApprovals(){
  for(const token of Object.values(tokens)){
    const t=new ethers.Contract(token.address,erc20Abi,wallet);
    for(const r of Object.values(routers)){
      const allowance=await t.allowance(VAULT_ADDRESS,r);
      if(allowance<ethers.parseUnits("1000000",token.decimals)){
        const tx=await vault.approveRouter(r,token.address);
        await tx.wait();
      }
    }
  }
}

// ----------------- EXECUTE -----------------
async function executeTrade(buyRouter,sellRouter,token,amountUSDC){
  const before=await vaultBalance();
  console.log(`${colors.cyan}🏦 Vault Before: ${fmt(before)} USDC${colors.reset}`);

  const buyOut=await quote(buyRouter,token,amountUSDC);
  const sellOut=await quote(sellRouter,token,amountUSDC);
  if(!buyOut||!sellOut) return;

  const buyPrice=amountUSDC/buyOut;
  const sellPrice=amountUSDC/sellOut;
  const profit=(sellPrice-buyPrice)*(1-SLIPPAGE_PCT/100);

  if(profit<MIN_EXPECTED_PROFIT) return;

  console.log(`${colors.green}💰 Expected Profit: ${fmt(profit)} USDC${colors.reset}`);
  console.log(`${colors.cyan}📈 Buy: ${fmt(buyPrice)}, Sell: ${fmt(sellPrice)}${colors.reset}`);

  if(DRY_RUN) return;

  const tx=await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    token.address,
    ethers.parseUnits(amountUSDC.toString(),6),
    Math.floor(buyOut*0.9995),
    Math.floor(sellOut*0.9995),
    Math.floor(Date.now()/1000)+120
  );
  console.log(`${colors.green}🔁 TX SENT: ${tx.hash}${colors.reset}`);
  console.log("⏳ Waiting for confirmation...");
  await tx.wait();

  const after=await vaultBalance();
  console.log(`${colors.green}✅ Vault After: ${fmt(after)} USDC`);
  console.log(`REAL PROFIT: ${fmt(after-before)} USDC${colors.reset}`);
}

// ----------------- SCAN -----------------
async function scan(){
  for(const token of Object.values(tokens)){
    for(const b of Object.values(routers)){
      for(const s of Object.values(routers)){
        if(b!==s) await executeTrade(b,s,token,MIN_TRADE_USDC);
      }
    }
  }
}

// ----------------- MAIN -----------------
(async()=>{
  console.log(`${colors.cyan}🚀 Arb bot running${colors.reset}`);
  await ensureApprovals();
  while(true){
    await scan();
    await sleep(8000);
  }
})();
