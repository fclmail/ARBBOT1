import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = 0.02;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10000;
const DEADLINE_SECONDS = 60;

/* CHANGE SIZE HERE */
const MAX_BATCH_SIZE = 100;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

const vaultAbi = [
{
name: "executeFlashBatchArbitrage",
type: "function",
inputs: [
{ name: "buyRouters", type: "address[]" },
{ name: "sellRouters", type: "address[]" },
{ name: "amountsInUSDC", type: "uint256[]" },
{ name: "pathsToToken", type: "address[][]" },
{ name: "pathsToUSDC", type: "address[][]" },
{ name: "deadline", type: "uint256" }
],
outputs: [],
stateMutability: "nonpayable"
}
];

const vault = new ethers.Contract(
VAULT_ADDRESS,
vaultAbi,
wallet
);

/* ================= USDC ================= */

const usdcAbi = [
"function balanceOf(address owner) view returns (uint256)"
];

const usdc = new ethers.Contract(
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
usdcAbi,
provider
);

/* ================= ROUTERS ================= */

const routers = {

QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"

};

const routerAbi = [
"function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* CACHE ROUTERS (FAST) */

const routerContracts = Object.fromEntries(
Object.values(routers).map(
addr => [addr, new ethers.Contract(addr, routerAbi, provider)]
)
);

/* ================= TOKENS ================= */

const TOKENS = {
USDC:"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
WBTC:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
APE:"0x4d224452801aced8b2f0aebe155379bb5d594381",
CRV:"0x172370d5cd63279efa6d502dab29171933a610af",
DAI:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
LINK:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
AAVE:"0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) =>
new Promise(r => setTimeout(r, ms));

function decodeError(err) {

return (
err?.reason ||
err?.shortMessage ||
err?.info?.error?.message ||
err?.message ||
"Unknown"
);

}

async function logBalances() {

const v =
await usdc.balanceOf(VAULT_ADDRESS);

console.log(
`${CYAN}Vault:${RESET}`,
ethers.formatUnits(v,6)
);

}

/* ================= QUOTE ================= */

async function quote(routerAddr, amountIn, path){

try{

const router =
routerContracts[routerAddr];

const amounts =
await router.getAmountsOut(
amountIn,
path
);

return amounts.at(-1);

}catch{

return null;

}

}

/* ================= PROFIT ================= */

async function recalcProfit(trade){

const buy =
await quote(
trade.buyRouter,
trade.amountIn,
trade.bestBuyPath
);

if(!buy) return 0;

const sell =
await quote(
trade.sellRouter,
buy,
trade.bestSellPath
);

if(!sell) return 0;

return Number(
ethers.formatUnits(sell,6)
) - MIN_TRADE_USDC;

}

/* ================= FIND ================= */

async function findTrade(
buyRouter,
sellRouter,
token
){

const usdc = TOKENS.USDC;

const amountIn =
ethers.parseUnits(
MIN_TRADE_USDC.toString(),
6
);

let bestBuy;
let bestBuyPath;

for(const p of [

[usdc,token],
[usdc,TOKENS.WMATIC,token],
[usdc,TOKENS.WETH,token]

]){

const out =
await quote(
buyRouter,
amountIn,
p
);

if(out && (!bestBuy || out>bestBuy)){

bestBuy = out;
bestBuyPath = p;

}

}

if(!bestBuy) return null;

let bestSell;
let bestSellPath;

for(const p of [

[token,usdc],
[token,TOKENS.WMATIC,usdc],
[token,TOKENS.WETH,usdc]

]){

const out =
await quote(
sellRouter,
bestBuy,
p
);

if(out && (!bestSell || out>bestSell)){

bestSell = out;
bestSellPath = p;

}

}

if(!bestSell) return null;

const profit =
Number(
ethers.formatUnits(bestSell,6)
) - MIN_TRADE_USDC;

if(profit < MIN_EXPECTED_PROFIT)
return null;

return {
buyRouter,
sellRouter,
amountIn,
bestBuyPath,
bestSellPath,
profit
};

}

/* ================= PARALLEL SCAN ================= */

async function scanFast(){

const tasks = [];

for(const buy of Object.values(routers))
for(const sell of Object.values(routers))
for(const token of Object.values(TOKENS)){

if(buy===sell) continue;

tasks.push(
findTrade(
buy,
sell,
token
)
);

}

const results =
await Promise.all(tasks);

return results.filter(Boolean);

}

/* ================= BATCH ================= */

async function batchArb(){

await logBalances();

console.log("Scanning...");

let trades = [];

while(
trades.length < MAX_BATCH_SIZE
){

const found =
await scanFast();

for(const t of found){

trades.push(t);

if(
trades.length >=
MAX_BATCH_SIZE
) break;

}

console.log(
"logs collected",
trades.length
);

}

console.log(
"reevaluating trades"
);

let valid=[];
let removed=0;

for(const t of trades){

const p =
await recalcProfit(t);

if(
p>=MIN_EXPECTED_PROFIT
){

valid.push({
...t,
profit:p
});

}else{

removed++;

}

}

console.log(
"trades removed",
removed
);

let expected=0;

for(const t of valid)
expected+=t.profit;

console.log(
"recalculating profit expected"
);

console.log(
"profit",
expected.toFixed(6)
);

console.log(
"minimum required",
MIN_EXPECTED_PROFIT
);

if(
expected <= MIN_EXPECTED_PROFIT
){

console.log(
"simulation failed"
);

return;

}

console.log(
"simulation passed"
);

console.log(
"preparing batch transaction"
);

const deadline =
Math.floor(Date.now()/1000)
+ DEADLINE_SECONDS;

const buyRouters =
valid.map(t=>t.buyRouter);

const sellRouters =
valid.map(t=>t.sellRouter);

const amounts =
valid.map(t=>t.amountIn);

const paths1 =
valid.map(t=>t.bestBuyPath);

const paths2 =
valid.map(t=>t.bestSellPath);

const gas =
await vault
.executeFlashBatchArbitrage
.estimateGas(
buyRouters,
sellRouters,
amounts,
paths1,
paths2,
deadline
);

const tx =
await vault
.executeFlashBatchArbitrage(
buyRouters,
sellRouters,
amounts,
paths1,
paths2,
deadline,
{ gasLimit: gas*12n/10n }
);

console.log(
"execution",
tx.hash
);

await tx.wait();

console.log(
"profits deposited to vault"
);

}

/* ================= LOOP ================= */

async function main(){

while(true){

await batchArb();

await sleep(
SCAN_INTERVAL_MS
);

}

}

main();
