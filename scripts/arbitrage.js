import dotenv from "dotenv";
dotenv.config({ override: false });

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { ethers } from "ethers";

/* ================= ENV ================= */

const RPC =
(
process.env.RPC_POLYGON ||
process.env.POLYGON_RPC ||
process.env.RPC_URL ||
""
).trim();

const PRIVATE_KEY =
(
process.env.WALLET_PRIVATE_KEY ||
process.env.PRIVATE_KEY ||
process.env.KEY ||
process.env.PK ||
""
).trim();

if (!RPC) throw new Error("Missing RPC");
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

/* ================= CONFIG ================= */

const VAULT_ADDRESS =
"0xC1888f15C47e79E45342Dea9249622476A83563f";

const WORKERS = 16;
const BATCH_SIZE = 20;
const TARGET_COLLECT = 10000;

const MIN_TRADE_USDC = 0.02;          // ✅ RESTORED
const MIN_PROFIT_THRESHOLD = 0.000001;

const DEADLINE_SECONDS = 60;
const SCAN_DELAY = 10000;

/* ================= ADDRESSES ================= */

const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDT  = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const WETH  = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
const WMATIC= "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const DAI   = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";

const TOKEN_LIST = [

USDC,
USDT,
WETH,
WMATIC,
DAI,

"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", // LINK
"0x172370d5cd63279efa6d502dab29171933a610af", // CRV
"0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89", // FRAX
"0xa3Fa99A148fA48D14Ed51d610c367C61876997F1", // MAI
"0xdAb529f40e671A1D4BF91361c21bf9F0C9712Ab7", // BUSD
"0x2e1AD108fF1D8C782fcBbB89AAd783aC49586756", // TUSD
"0xb33EaAd8d922B1083446DC23f610c2567fB5180f", // UNI
"0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a", // SUSHI
"0x831753DD7087CaC61aB5644b308642cc1c33Dc13", // QUICK
"0x9a71012B13CA4d3D0Cdc72A177DF3Ef03b0E76A3", // BAL
"0x3A58a54C066FdC0F2D55FC9C89F0415C92eBf3C4", // stMATIC
"0x03b54A6e9a984069379FAe1a4Fc4dBaE93b3bccd", // wstETH
"0xd6df932a45c0f255f85145f286ea0b292b21c90b", // AAVE
"0x4d224452801aced8b2f0aebe155379bb5d594381"  // APE

];

/* ================= DEX ================= */

const DEXES = [

"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
"0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"

];

/* ================= PROVIDER ================= */

const provider =
new ethers.JsonRpcProvider(RPC);

const wallet =
new ethers.Wallet(
PRIVATE_KEY,
provider
);

/* ================= CONTRACT ================= */

const vaultAbi = [
"function executeFlashBatchArbitrage(tuple(address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch) external"
];

const vault =
new ethers.Contract(
VAULT_ADDRESS,
vaultAbi,
wallet
);

/* ================= WORKER ================= */

if (!isMainThread) {

const provider =
new ethers.JsonRpcProvider(workerData.RPC);

const routerAbi = [
"function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

async function quote(router, amountIn, path) {

try {

const r =
new ethers.Contract(
router,
routerAbi,
provider
);

const out =
await r.getAmountsOut(amountIn, path);

return out.at(-1);

} catch {

return null;

}

}

async function scan() {

const {
workerId,
TOKEN_LIST,
DEXES,
RPC,
WORKERS,
MIN_TRADE_USDC,
MIN_PROFIT_THRESHOLD
} = workerData;

let trades = [];

const amountIn =
ethers.parseUnits(
MIN_TRADE_USDC.toString(),
6
);

const MIN_PROFIT =
ethers.parseUnits(
MIN_PROFIT_THRESHOLD.toString(),
6
);

const HOPS = [

[],
[WETH],
[WMATIC],
[USDT],
[DAI]

];

for (
let t = workerId + 1;
t < TOKEN_LIST.length;
t += WORKERS
) {

const token = TOKEN_LIST[t];

for (const buy of DEXES)
for (const sell of DEXES) {

if (buy === sell) continue;

for (const hop of HOPS) {

const buyPath =
[USDC, ...hop, token];

const sellPath =
[token, ...hop.slice().reverse(), USDC];

const buyOut =
await quote(buy, amountIn, buyPath);

if (!buyOut) continue;

const sellOut =
await quote(sell, buyOut, sellPath);

if (!sellOut) continue;

const profitBig =
sellOut - amountIn;

if (profitBig <= MIN_PROFIT)
continue;

const profit =
Number(
ethers.formatUnits(
profitBig,
6
)
);

trades.push({

buyRouter: buy,
sellRouter: sell,
amountIn,
pathToToken: buyPath,
pathToUSDC: sellPath,
profit

});

}

}

}

parentPort.postMessage(trades);

}

scan();

}

/* ================= MAIN ================= */

if (isMainThread) {

let BUFFER = [];
let TOTAL_PROFIT = 0;

function runWorkers() {

return new Promise(resolve => {

let results = [];
let done = 0;

for (let i=0;i<WORKERS;i++) {

const w =
new Worker(
new URL(import.meta.url),
{
workerData:{
workerId:i,
TOKEN_LIST,
DEXES,
RPC,
WORKERS,
MIN_TRADE_USDC,
MIN_PROFIT_THRESHOLD
}
}
);

w.on("message",d=>{
if(d?.length)
results.push(...d);
});

w.on("exit",()=>{

done++;

if(done===WORKERS)
resolve(results);

});

}

});

}

async function sendBatch(trades){

const batch={

buyRouters:
trades.map(t=>t.buyRouter),

sellRouters:
trades.map(t=>t.sellRouter),

amountsInUSDC:
trades.map(t=>t.amountIn),

pathsToToken:
trades.map(t=>t.pathToToken),

pathsToUSDC:
trades.map(t=>t.pathToUSDC),

deadline:
Math.floor(Date.now()/1000)
+ DEADLINE_SECONDS

};

const tx =
await vault.executeFlashBatchArbitrage(batch);

console.log("execution",tx.hash);

await tx.wait();

console.log("profits deposited to vault");

}

async function main(){

while(true){

const trades =
await runWorkers();

BUFFER.push(...trades);

for(const t of trades)
TOTAL_PROFIT += t.profit;

console.log("Collected",BUFFER.length);

if(BUFFER.length >= BATCH_SIZE){

const batch =
BUFFER.slice(0,BATCH_SIZE);

await sendBatch(batch);

BUFFER =
BUFFER.slice(BATCH_SIZE);

}

await new Promise(
r=>setTimeout(r,SCAN_DELAY)
);

}

}

main();

}
