
import dotenv from "dotenv";
import { ethers } from "ethers";
import os from "os";

/* ================= ENV ================= */

dotenv.config();

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL;

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

/* ================= CONFIG ================= */

const WORKERS = 32;
const MAX_BATCH_SIZE = 100;
const MIN_TRADE_USDC = 0.05;
const MIN_PROFIT = 0.000001;

const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT =
  "0xf2F8e22D4A8F0a546fe0c42FfFC2cdCc6F9c827f";

const ABI = [
{
"name":"executeFlashBatchArbitrage",
"type":"function",
"inputs":[
{"name":"buyRouters","type":"address[]"},
{"name":"sellRouters","type":"address[]"},
{"name":"amountsInUSDC","type":"uint256[]"},
{"name":"pathsToToken","type":"address[][]"},
{"name":"pathsToUSDC","type":"address[][]"},
{"name":"deadline","type":"uint256"}
]
}
];

const contract = new ethers.Contract(CONTRACT, ABI, wallet);

/* ================= USDC ================= */

const USDC =
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const usdc = new ethers.Contract(
USDC,
["function balanceOf(address) view returns(uint256)"],
provider
);

/* ================= ROUTERS ================= */

const routers = {
QuickSwap:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
SushiSwap:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
Dfyn:"0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
Firebird:"0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
ApeSwap:"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
Wault:"0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi=[
"function getAmountsOut(uint amountIn,address[] calldata path) view returns(uint[] memory)"
];

const routerContracts=Object.fromEntries(
Object.values(routers).map(r=>[r,new ethers.Contract(r,routerAbi,provider)])
);

/* ================= TOKENS ================= */

const TOKENS={
USDC:"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
WBTC:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
APE:"0x4d224452801aced8b2f0aebe155379bb5d594381",
CRV:"0x172370d5cd63279efa6d502dab29171933a610af",
DAI:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
LINK:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
FRAX:"0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89",
MAI:"0xa3Fa99A148fA48D14Ed51d610c367C61876997F1",
BUSD:"0xdAb529f40e671A1D4BF91361c21bf9F0C9712Ab7",
TUSD:"0x2e1AD108fF1D8C782fcBbB89AAd783aC49586756",
UNI:"0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
SUSHI:"0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a",
QUICK:"0x831753DD7087CaC61aB5644b308642cc1c33Dc13",
BAL:"0x9a71012B13CA4d3D0Cdc72A177DF3Ef03b0E76A3",
stMATIC:"0x3A58a54C066FdC0F2D55FC9C89F0415C92eBf3C4",
wstETH:"0x03b54A6e9a984069379FAe1a4Fc4dBaE93b3bccd",
AAVE:"0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= PATHS ================= */

function buyPaths(token){
return[
[USDC,token],
[USDC,TOKENS.WMATIC,token],
[USDC,TOKENS.WETH,token],
[USDC,TOKENS.USDT,token],
[USDC,TOKENS.DAI,token]
];
}

function sellPaths(token){
return[
[token,USDC],
[token,TOKENS.WMATIC,USDC],
[token,TOKENS.WETH,USDC],
[token,TOKENS.USDT,USDC],
[token,TOKENS.DAI,USDC]
];
}

/* ================= QUOTE ================= */

async function quote(router,amount,path){

try{

const r=routerContracts[router];
const amounts=await r.getAmountsOut(amount,path);
return amounts.at(-1);

}catch{

return null;

}

}

/* ================= SCAN ================= */

let scanned=0;

async function scanOpportunity(buy,sell,token){

const amountIn=ethers.parseUnits(MIN_TRADE_USDC.toString(),6);

let bestBuyOut,bestBuyPath;

for(const p of buyPaths(token)){

const out=await quote(buy,amountIn,p);

scanned++;

if(out && (!bestBuyOut || out>bestBuyOut)){

bestBuyOut=out;
bestBuyPath=p;

}

}

if(!bestBuyOut) return null;

let bestSellOut,bestSellPath;

for(const p of sellPaths(token)){

const out=await quote(sell,bestBuyOut,p);

if(out && (!bestSellOut || out>bestSellOut)){

bestSellOut=out;
bestSellPath=p;

}

}

if(!bestSellOut) return null;

const profit=
Number(ethers.formatUnits(bestSellOut,6))-MIN_TRADE_USDC;

if(profit<MIN_PROFIT) return null;

return{
buyRouter:buy,
sellRouter:sell,
amountIn,
bestBuyPath,
bestSellPath,
profit
};

}

/* ================= BALANCE ================= */

async function balances(){

const vaultBal=
await usdc.balanceOf(CONTRACT);

const matic=
await provider.getBalance(wallet.address);

console.log(`Vault USDC Balance: ${ethers.formatUnits(vaultBal,6)}`);
console.log(`Wallet MATIC Balance: ${ethers.formatEther(matic)}`);

}

/* ================= BATCH ================= */

async function runBatch(){

console.log("Launching parallel scanners...\n");

console.log(`Workers started: ${WORKERS}`);
console.log(`Target batch size: ${MAX_BATCH_SIZE}`);
console.log(`Minimum profit per trade: ${MIN_PROFIT}\n`);

console.log("Scanning opportunities...\n");

let trades=[];
let totalProfit=0;

let sec=0;

setInterval(()=>{

sec++;

console.log(`[${sec} sec] scanned ${scanned.toLocaleString()} opportunities`);

},1000);

while(trades.length<100){

const tasks=[];

for(const buy of Object.values(routers))
for(const sell of Object.values(routers))
for(const token of Object.values(TOKENS)){

if(buy===sell) continue;

tasks.push(scanOpportunity(buy,sell,token));

}

const results=
await Promise.all(tasks);

for(const r of results){

if(r){

trades.push(r);
totalProfit+=r.profit;

if(trades.length>=100) break;

}

}

}

console.log(`\n${trades.length} trades collected`);
console.log(`Total profit: ${totalProfit.toFixed(5)} USDC\n`);

const buyRouters=trades.map(t=>t.buyRouter);
const sellRouters=trades.map(t=>t.sellRouter);
const amounts=trades.map(t=>t.amountIn);
const pathsBuy=trades.map(t=>t.bestBuyPath);
const pathsSell=trades.map(t=>t.bestSellPath);

const deadline=
Math.floor(Date.now()/1000)+DEADLINE_SECONDS;

await contract.executeFlashBatchArbitrage.staticCall(
buyRouters,
sellRouters,
amounts,
pathsBuy,
pathsSell,
deadline
);

console.log("Simulation pass");

const gas=
await contract.executeFlashBatchArbitrage.estimateGas(
buyRouters,
sellRouters,
amounts,
pathsBuy,
pathsSell,
deadline
);

console.log(`Gas: ${gas}\n`);

console.log("Executing flash arbitrage");

const tx=
await contract.executeFlashBatchArbitrage(
buyRouters,
sellRouters,
amounts,
pathsBuy,
pathsSell,
deadline,
{gasLimit:gas*120n/100n}
);

console.log(tx.hash);

await tx.wait();

console.log("\nProfit deposited to vault\n");

await balances();

}

/* ================= MAIN ================= */

runBatch();
