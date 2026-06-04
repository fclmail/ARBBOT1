import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override:false });

/* ================= ENV ================= */

const PRIVATE_KEY =
process.env.WALLET_PRIVATE_KEY ||
process.env.PRIVATE_KEY;

if(!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS=[
"https://polygon-bor-rpc.publicnode.com"
];

let rpcIndex=0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const BASE_TRADE = ethers.parseUnits("0.04",6);
const MIN_PROFIT = ethers.parseUnits("0.000001",6);
const GAS_COST_USDC = ethers.parseUnits("0.0003",6);

const BATCH_SIZE = 10;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
"0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi=[
"function balanceOf(address) view returns(uint256)"
];

const contractAbi=[
"function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const routerAbi=[
"function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS ================= */

const routers={
QuickSwap:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
SushiSwap:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
Dfyn:"0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
Firebird:"0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
ApeSwap:"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
Wault:"0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS={
AAVE:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",
APE:"0x4d224452801aced8b2f0aebe155379bb5d594381",
CRV:"0x172370d5cd63279efa6d502dab29171933a610af",
DAI:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
LINK:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
QUICK:"0x831753dd7087cac61ab5644b308642cc1c33dc13",
SHIB:"0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
UNI:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
WBTC:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x,6);

/* ================= PROVIDER ================= */

function newProvider(){
const url=RPCS[rpcIndex];
rpcIndex=(rpcIndex+1)%RPCS.length;
return new ethers.JsonRpcProvider(url);
}

function rebuildContracts(){

wallet=new ethers.Wallet(PRIVATE_KEY,provider);

usdc=new ethers.Contract(USDC,erc20Abi,wallet);

vault=new ethers.Contract(CONTRACT_ADDRESS,contractAbi,wallet);

routerContracts=Object.fromEntries(
Object.values(routers).map(a=>[
a,
new ethers.Contract(a,routerAbi,provider)
])
);
}

/* ================= QUOTE ================= */

async function quote(router,amount,path){

try{
const out=await routerContracts[router].getAmountsOut(amount,path);
return out.at(-1);
}catch{
return null;
}

}

/* ================= TRIANGULAR PATH BUILDER ================= */

function buildTriangularPaths(){

const tokens=Object.values(TOKENS);

let paths=[];

for(const a of tokens){

for(const b of tokens){

if(a===b) continue;

paths.push([
USDC,
a,
b,
USDC
]);

}

}

return paths;

}

/* ================= TRIANGULAR FINDER ================= */

async function findTriangular(router,path){

const baseOut1 = await quote(router,BASE_TRADE,[path[0],path[1]]);
if(!baseOut1) return null;

const baseOut2 = await quote(router,baseOut1,[path[1],path[2]]);
if(!baseOut2) return null;

const baseOut3 = await quote(router,baseOut2,[path[2],path[3]]);
if(!baseOut3) return null;

const profit = baseOut3 - BASE_TRADE;

if(profit <= 0n) return null;

console.log(
`TRI FOUND ${fmt(BASE_TRADE)} → ${fmt(baseOut3)} PROFIT ${fmt(profit)}`
);

return{
router,
amountIn:BASE_TRADE,
pathToToken:path.slice(0,3),
pathToUSDC:[path[2],USDC],
expectedProfit:profit
};

}

/* ================= EXECUTE ================= */

async function executeBatch(trades){

console.log("\n🔥 EXECUTING BATCH");

const before = await usdc.balanceOf(CONTRACT_ADDRESS);

let total=0n;
let expected=0n;

for(const t of trades){
total+=t.amountIn;
expected+=t.expectedProfit;
}

console.log(`USED CAPITAL ${fmt(total)}`);
console.log(`EXPECTED PROFIT ${fmt(expected)}`);

if(expected < GAS_COST_USDC){
console.log("❌ SKIPPED: BELOW GAS\n");
return;
}

const tx = await vault.executeFlashBatchArbitrage({
buyRouters: trades.map(t=>t.router),
sellRouters: trades.map(t=>t.router),
amountsInUSDC: trades.map(t=>t.amountIn),
pathsToToken: trades.map(t=>t.pathToToken),
pathsToUSDC: trades.map(t=>t.pathToUSDC),
deadline: Math.floor(Date.now()/1000)+30
});

await provider.waitForTransaction(tx.hash);

const after = await usdc.balanceOf(CONTRACT_ADDRESS);

const real = after>before ? after-before : 0n;

console.log(`CONTRACT BEFORE ${fmt(before)}`);
console.log(`CONTRACT AFTER  ${fmt(after)}`);
console.log(`REAL PROFIT     ${fmt(real)}\n`);

}

/* ================= MAIN ================= */

(async function main(){

console.log("🚀 BOT STARTED\n");

provider=newProvider();

rebuildContracts();

const triangularPaths = buildTriangularPaths();

let batch=[];

while(true){

for(const r of Object.values(routers)){

for(const path of triangularPaths){

const trade = await findTriangular(r,path);

if(!trade) continue;

batch.push(trade);

if(batch.length>=BATCH_SIZE){

await executeBatch(batch);

batch=[];

}

}

}

}

})();


