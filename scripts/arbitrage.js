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
const TARGET_COLLECT = 10;

const MIN_PROFIT_THRESHOLD = 0.000001;
const DEADLINE_SECONDS = 60;
const SCAN_DELAY = 5000;

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
DAI
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
WORKERS
} = workerData;

let trades = [];

const amountIn =
ethers.parseUnits("0.02",6);

const MIN_PROFIT =
ethers.parseUnits(
MIN_PROFIT_THRESHOLD.toString(),
6
);

/* FULL HOPS */

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

/* J1 profit */

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

async function logBalances() {

const erc20Abi =
["function balanceOf(address) view returns (uint256)"];

const usdc =
new ethers.Contract(
USDC,
erc20Abi,
provider
);

const vaultUSDC =
await usdc.balanceOf(
VAULT_ADDRESS
);

const walletMatic =
await provider.getBalance(
wallet.address
);

console.log(
"Vault USDC:",
ethers.formatUnits(vaultUSDC,6)
);

console.log(
"Wallet MATIC:",
ethers.formatEther(walletMatic)
);

}

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
WORKERS
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

console.log("==========");

await logBalances();

console.log("Scanning with",WORKERS,"workers");

const trades =
await runWorkers();

BUFFER.push(...trades);

for(const t of trades)
TOTAL_PROFIT += t.profit;

console.log(
"Collected",
BUFFER.length
);

console.log(
"Estimated profit",
TOTAL_PROFIT.toFixed(6),
"USDC"
);

/* ✅ ONLY EXECUTE WHEN FULL */

if(BUFFER.length >= BATCH_SIZE){

console.log(
"BATCH FULL → EXECUTING"
);

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
