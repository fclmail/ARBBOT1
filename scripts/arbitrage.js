import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override:false });

/* ================= ENV ================= */

const PRIVATE_KEY =
process.env.WALLET_PRIVATE_KEY ||
process.env.PRIVATE_KEY;

if(!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
"https://polygon-bor-rpc.publicnode.com"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const BASE_TRADE = ethers.parseUnits("0.02",6);
const MIN_PROFIT = ethers.parseUnits("0.000001",6);
const GAS_COST_USDC = ethers.parseUnits("0.00003",6);
const MIN_POL_BAL = ethers.parseEther("0.002");

const BATCH_SIZE = 3;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
"0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
"function balanceOf(address) view returns(uint256)"
];

const contractAbi = [
"function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const routerAbi = [
"function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS ================= */

const routers = {
QuickSwap:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
SushiSwap:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
Dfyn:"0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
Firebird:"0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
ApeSwap:"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
Wault:"0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS = {
WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
DAI:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
WBTC:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x,6);

/* ================= PROVIDER ================= */

function newProvider(){
const url = RPCS[rpcIndex];
rpcIndex = (rpcIndex + 1) % RPCS.length;
return new ethers.JsonRpcProvider(url);
}

function rebuildContracts(){
wallet = new ethers.Wallet(PRIVATE_KEY,provider);

usdc = new ethers.Contract(USDC, erc20Abi, wallet);
vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

routerContracts = Object.fromEntries(
Object.values(routers).map(r => [
r,
new ethers.Contract(r, routerAbi, provider)
])
);
}

/* ================= QUOTE ================= */

async function quote(router, amount, path){
try{
const out = await routerContracts[router].getAmountsOut(amount, path);
return out.at(-1);
}catch{
return null;
}
}

/* ================= PATHS ================= */

function buildBuyPaths(token){
return [
[USDC,token],
[USDC,TOKENS.WETH,token],
[USDC,TOKENS.WMATIC,token]
];
}

function buildSellPaths(token){
return [
[token,USDC],
[token,TOKENS.WETH,USDC],
[token,TOKENS.WMATIC,USDC]
];
}

/* ================= LIQUIDITY CHECK ================= */

function isDeepLiquidity(path){
return path.includes(TOKENS.WETH) || path.includes(TOKENS.WMATIC);
}

/* ================= FIXED SCALING ENGINE ================= */

function getScaledSize(amount, profit, path){

if(profit <= 0n) return null;

const ratio = Number(profit) / Number(amount);

/* base safe scaling */
let multiplier = 1.0005;

/* micro edge */
if (ratio > 0.0005) multiplier = 1.02;

/* good edge */
if (ratio > 0.001) multiplier = 1.08;

/* strong edge */
if (ratio > 0.002) multiplier = 1.25;

/* very strong */
if (ratio > 0.005) multiplier = 1.6;

/* deep liquidity boost */
if (isDeepLiquidity(path)) {
multiplier *= 1.3;
}

/* hard cap */
if (multiplier > 2.5) multiplier = 2.5;

return BigInt(Math.floor(Number(amount) * multiplier));
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, token){

for(const bp of buildBuyPaths(token)){

const baseOut = await quote(buy, BASE_TRADE, bp);
if(!baseOut) continue;

for(const sp of buildSellPaths(token)){

const sellOut = await quote(sell, baseOut, sp);
if(!sellOut) continue;

const baseProfit = sellOut - BASE_TRADE;

if(baseProfit < MIN_PROFIT) continue;

/* SCALE */
const scaled = getScaledSize(BASE_TRADE, baseProfit, bp);
if(!scaled) continue;

/* REQUOTE */
const buy2 = await quote(buy, scaled, bp);
if(!buy2) continue;

const sell2 = await quote(sell, buy2, sp);
if(!sell2) continue;

const scaledProfit = sell2 - scaled;

if(scaledProfit <= 0n) continue;

/* LOG FORMAT REQUIRED */

console.log(
`MICRO FOUND ${fmt(baseProfit)} → SCALED SIZE ${fmt(scaled)} → EXPECTED ${fmt(scaledProfit)}`
);

console.log(`FOUND TRADE | SIZE ${fmt(scaled)}\n`);

return {
buy,
sell,
amountIn: scaled,
buyPath: bp,
sellPath: sp,
expectedProfit: scaledProfit
};

}

}

return null;
}

/* ================= EXECUTE ================= */

async function executeBatch(trades){

console.log("\n🔥 EXECUTING BATCH");

const polBal = await provider.getBalance(wallet.address);
if(polBal < MIN_POL_BAL){
console.log("❌ LOW GAS BALANCE\n");
return;
}

const before = await usdc.balanceOf(CONTRACT_ADDRESS);

let total = 0n;
let expected = 0n;

for(const t of trades){
total += t.amountIn;
expected += t.expectedProfit;
}

console.log(`USED CAPITAL ${fmt(total)}`);
console.log(`EXPECTED PROFIT ${fmt(expected)}`);

if(expected <= GAS_COST_USDC){
console.log("❌ SKIPPED: BELOW GAS\n");
return;
}

const tx = await vault.executeFlashBatchArbitrage({
buyRouters: trades.map(t=>t.buy),
sellRouters: trades.map(t=>t.sell),
amountsInUSDC: trades.map(t=>t.amountIn),
pathsToToken: trades.map(t=>t.buyPath),
pathsToUSDC: trades.map(t=>t.sellPath),
deadline: Math.floor(Date.now()/1000)+30
});

await provider.waitForTransaction(tx.hash);

const after = await usdc.balanceOf(CONTRACT_ADDRESS);
const real = after > before ? after - before : 0n;

console.log(`CONTRACT BEFORE ${fmt(before)}`);
console.log(`CONTRACT AFTER  ${fmt(after)}`);
console.log(`REAL PROFIT     ${fmt(real)}\n`);
}

/* ================= MAIN LOOP ================= */

(async function main(){

console.log("🚀 BOT STARTED\n");

provider = newProvider();
rebuildContracts();

setInterval(()=>console.log("⏱ scanning..."),5000);

let batch = [];

while(true){

for(const b of Object.values(routers)){
for(const s of Object.values(routers)){
if(b===s) continue;

for(const t of Object.values(TOKENS)){

const trade = await findTrade(b,s,t);
if(!trade) continue;

batch.push(trade);

if(batch.length >= BATCH_SIZE){
await executeBatch(batch);
batch = [];
}

}

}
}

}

})();
