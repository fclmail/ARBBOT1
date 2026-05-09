import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override:false });

/* =========================================================
   ENV
========================================================= */

const PRIVATE_KEY =
process.env.WALLET_PRIVATE_KEY ||
process.env.PRIVATE_KEY;

if(!PRIVATE_KEY)
throw new Error("PRIVATE KEY MISSING");

/* =========================================================
   RPC
========================================================= */

const RPCS=[

"https://polygon-bor-rpc.publicnode.com",

"https://polygon.llamarpc.com",

"https://rpc.ankr.com/polygon",

"https://1rpc.io/matic"

];

let rpcIndex=0;

let provider;
let wallet;
let vault;
let usdc;

let routerContracts={};

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
"0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

/* =========================================================
   TOKENS
========================================================= */

const TOKENS={

USDC:
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

USDT:
"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",

DAI:
"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"

};

const USDC=TOKENS.USDC;

/* =========================================================
   ROUTERS
========================================================= */

const routers={

QuickSwap:
"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",

SushiSwap:
"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",

Dfyn:
"0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",

ApeSwap:
"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"

};

/* =========================================================
   DYNAMIC FLASH SIZES
========================================================= */

const FLASH_SIZES=[

ethers.parseUnits("1000",6),

ethers.parseUnits("2500",6),

ethers.parseUnits("5000",6),

ethers.parseUnits("10000",6),

ethers.parseUnits("25000",6),

ethers.parseUnits("50000",6)

];

/* =========================================================
   FILTERS
========================================================= */

const MIN_PROFIT =
ethers.parseUnits("0.15",6);

const MIN_BATCH_PROFIT =
ethers.parseUnits("1.00",6);

const WORKER_COUNT = 32;

/* =========================================================
   ABI
========================================================= */

const erc20Abi=[

"function balanceOf(address) view returns(uint256)"

];

const contractAbi=[

"function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",

"function minimumProfitUSDC() view returns(uint256)"

];

const routerAbi=[

"function getAmountsOut(uint,address[]) view returns(uint[])"

];

/* =========================================================
   HELPERS
========================================================= */

const fmt=x=>
ethers.formatUnits(x,6);

const sleep=ms=>
new Promise(r=>setTimeout(r,ms));

function now(){

return Math.floor(Date.now()/1000);

}

/* =========================================================
   STATE
========================================================= */

let scans=0;

let lastHeartbeat=Date.now();

let queuedTrades=[];

let runningProfit=0n;

let isExecuting=false;

/* =========================================================
   PROVIDER
========================================================= */

function newProvider(){

const url=RPCS[rpcIndex];

rpcIndex=(rpcIndex+1)%RPCS.length;

return new ethers.JsonRpcProvider(url);

}

function rebuildContracts(){

wallet=
new ethers.Wallet(
PRIVATE_KEY,
provider
);

vault=
new ethers.Contract(
CONTRACT_ADDRESS,
contractAbi,
wallet
);

usdc=
new ethers.Contract(
USDC,
erc20Abi,
wallet
);

routerContracts=
Object.fromEntries(

Object.values(routers).map(r=>[

r,

new ethers.Contract(
r,
routerAbi,
provider
)

])

);

}

async function initProvider(){

provider=newProvider();

await provider.getNetwork();

rebuildContracts();

const min=
await vault.minimumProfitUSDC();

console.log(
`ONCHAIN MIN ${fmt(min)} USDC\n`
);

}

/* =========================================================
   STABLE PATHS
========================================================= */

function buildPaths(){

return[

[
USDC,
TOKENS.DAI,
USDC
],

[
USDC,
TOKENS.USDT,
USDC
],

[
USDC,
TOKENS.DAI,
TOKENS.USDT,
USDC
],

[
USDC,
TOKENS.USDT,
TOKENS.DAI,
USDC
]

];

}

/* =========================================================
   QUOTE
========================================================= */

async function quote(

router,
amount,
path

){

try{

const out=
await routerContracts[router]
.getAmountsOut(
amount,
path
);

return out.at(-1);

}catch{

return null;

}

}

/* =========================================================
   CROSS ROUTER SIMULATION
========================================================= */

async function simulateCrossRouter(

buyRouter,
sellRouter,
size,
buyPath,
sellPath

){

try{

const buyOut=
await quote(
buyRouter,
size,
buyPath
);

if(!buyOut)
return null;

const sellOut=
await quote(
sellRouter,
buyOut,
sellPath
);

if(!sellOut)
return null;

const profit=
sellOut-size;

if(profit<=0n)
return null;

return{

size,

buyOut,

sellOut,

profit

};

}catch{

return null;

}

}

/* =========================================================
   FIND BEST SIZE
========================================================= */

async function findBestTrade(

buyRouter,
sellRouter,
buyPath,
sellPath

){

const results=
await Promise.all(

FLASH_SIZES.map(size=>

simulateCrossRouter(

buyRouter,

sellRouter,

size,

buyPath,

sellPath

)

)

);

let best=null;

for(const sim of results){

if(!sim)
continue;

if(sim.profit<MIN_PROFIT)
continue;

if(
!best ||
sim.profit>best.profit
){

best=sim;

}

}

if(!best)
return null;

console.log(
`FOUND ${fmt(best.profit)}`
);

console.log(
`SIZE ${fmt(best.size)}`
);

return{

buyRouter,

sellRouter,

buyPath,

sellPath,

amountIn:best.size,

expectedProfit:best.profit

};

}

/* =========================================================
   REVALIDATE
========================================================= */

async function revalidateTrade(t){

const sim=
await simulateCrossRouter(

t.buyRouter,

t.sellRouter,

t.amountIn,

t.buyPath,

t.sellPath

);

if(!sim)
return null;

if(sim.profit<MIN_PROFIT)
return null;

t.expectedProfit=
sim.profit;

return t;

}

/* =========================================================
   EXECUTE
========================================================= */

async function executeTrade(t){

isExecuting=true;

try{

console.log(
"\nFLASH LOAN EXECUTION\n"
);

console.log(
`BUY ROUTER`
);

console.log(
t.buyRouter
);

console.log(
`\nSELL ROUTER`
);

console.log(
t.sellRouter
);

console.log(
`\nSIZE`
);

console.log(
fmt(t.amountIn)
);

console.log(
`\nEXPECTED`
);

console.log(
`${fmt(t.expectedProfit)} USDC`
);

console.log(
`\nBUY PATH`
);

console.log(
t.buyPath.join(" -> ")
);

console.log(
`\nSELL PATH`
);

console.log(
t.sellPath.join(" -> ")
);

const tx=
await vault
.executeBestFlashLoanArbitrage(

t.buyRouter,

t.sellRouter,

FLASH_SIZES,

t.buyPath,

t.sellPath,

now()+30

);

console.log(
`\nTX SENT`
);

console.log(
tx.hash
);

const receipt=
await tx.wait();

console.log(
`\nCONFIRMED`
);

console.log(
`BLOCK ${receipt.blockNumber}`
);

console.log(
`\nNET EXPECTED`
);

console.log(
`${fmt(t.expectedProfit)} USDC\n`
);

}catch(err){

console.log(
"\nEXECUTION FAILED\n"
);

console.log(
err.reason ||
err.shortMessage ||
err.message
);

}

isExecuting=false;

}

/* =========================================================
   SCAN LOOP
========================================================= */

async function scanLoop(){

const tasks=[];

for(const buyRouter of Object.values(routers)){

for(const sellRouter of Object.values(routers)){

if(
buyRouter===sellRouter
)
continue;

for(const buyPath of buildPaths()){

const token=
buyPath[
buyPath.length-2
];

const sellPath=[

token,

USDC

];

tasks.push({

buyRouter,

sellRouter,

buyPath,

sellPath

});

}

}

}

let i=0;

async function worker(){

while(true){

try{

if(isExecuting){

await sleep(15);

continue;

}

scans++;

if(
Date.now()-lastHeartbeat
>5000
){

console.log(
`\nHEARTBEAT`
);

console.log(
`SCANS ${scans}`
);

console.log(
`QUEUED ${queuedTrades.length}`
);

console.log(
`RUNNING ${fmt(runningProfit)}\n`
);

lastHeartbeat=
Date.now();

}

const task=
tasks[
i++ % tasks.length
];

const trade=
await findBestTrade(

task.buyRouter,

task.sellRouter,

task.buyPath,

task.sellPath

);

if(!trade){

await sleep(5);

continue;

}

queuedTrades.push(trade);

runningProfit+=
trade.expectedProfit;

console.log(
`MICRO FOUND ${fmt(trade.expectedProfit)}`
);

console.log(
`SCALED SIZE ${fmt(trade.amountIn)}`
);

console.log(
`RUNNING ${fmt(runningProfit)}\n`
);

if(

!isExecuting &&

runningProfit >=
MIN_BATCH_PROFIT

){

const best=
queuedTrades.sort(

(a,b)=>

Number(
b.expectedProfit-
a.expectedProfit
)

)[0];

queuedTrades=[];

runningProfit=0n;

const valid=
await revalidateTrade(
best
);

if(valid){

await executeTrade(
valid
);

}

}

}catch{

await sleep(50);

}

}

}

await Promise.all(

Array.from(
{length:WORKER_COUNT},
worker
)

);

}

/* =========================================================
   MAIN
========================================================= */

(async function main(){

console.log(
"\nPURE STABLECOIN CROSS-ROUTER FLASH BOT STARTED\n"
);

await initProvider();

const pol=
await provider.getBalance(
wallet.address
);

console.log(
`POL ${ethers.formatEther(pol)}\n`
);

console.log(
"SCANNING CROSS-ROUTER STABLECOIN PATHS...\n"
);

await scanLoop();

})();
