import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.03", 6);
const MIN_PROFIT = ethers.parseUnits("0.000001", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.0004", 6);

const WORKER_COUNT = 32;

/* ================= GAS ================= */

const WITHDRAW_THRESHOLD = ethers.parseUnits("0.25",6);
const WITHDRAW_PERCENT = 10n;

const MIN_POL_FOR_TX = ethers.parseEther("0.35");

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
"0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
"function balanceOf(address) view returns(uint256)",
"function approve(address,uint256)"
];

const contractAbi = [
"function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
"function minimumProfitUSDC() view returns(uint256)"
];

const routerAbi = [
"function getAmountsOut(uint,address[]) view returns(uint[])",
"function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

/* ================= ROUTERS ================= */

const routers = {
QuickSwap:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
SushiSwap:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
ApeSwap:"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= TOKENS ================= */

const TOKENS = {
WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

/* ================= STATE ================= */

let microTrades=[];
let runningProfit=0n;
let isExecuting=false;

/* ================= PROVIDER ================= */

function newProvider(){
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex+1)%RPCS.length;
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

/* ================= PATHS ================= */

function buildBuyPaths(token){
  return[
    [USDC,token],
    [USDC,TOKENS.WETH,token],
    [USDC,TOKENS.WMATIC,token],
    [USDC,TOKENS.USDT,token]
  ];
}

function buildSellPaths(token){
  return[
    [token,USDC],
    [token,TOKENS.WETH,USDC],
    [token,TOKENS.WMATIC,USDC],
    [token,TOKENS.USDT,USDC]
  ];
}

/* ================= FIND TRADE ================= */

async function findTrade(buy,sell,token){

  for(const bp of buildBuyPaths(token)){

    const buyOut=
      await routerContracts[buy].getAmountsOut(TRADE_AMOUNT,bp).catch(()=>null);

    if(!buyOut) continue;

    for(const sp of buildSellPaths(token)){

      const sellOut=
        await routerContracts[sell].getAmountsOut(buyOut.at(-1),sp).catch(()=>null);

      if(!sellOut) continue;

      const profit=sellOut.at(-1)-TRADE_AMOUNT;

      if(profit < MIN_PROFIT) continue;

      return{
        buy,
        sell,
        token,
        amountIn:TRADE_AMOUNT,
        expectedProfit:profit
      };
    }
  }

  return null;
}

/* ================= EXECUTION LOOP ================= */

async function scanLoop(){

  const tasks=[];

  for(const b of Object.values(routers)){
  for(const s of Object.values(routers)){

    if(b===s) continue;

    for(const t of Object.values(TOKENS)){

      tasks.push({buy:b,sell:s,token:t});

    }
  }}

  let i=0;

  async function worker(){

    while(true){

      const task=tasks[i++ % tasks.length];

      const trade=await findTrade(task.buy,task.sell,task.token);

      if(!trade) continue;

      microTrades.push(trade);

      runningProfit += trade.expectedProfit;

      console.log(
        `RUNNING TOTAL ${ethers.formatUnits(runningProfit,6)}`
      );

      /* ================= GROUPED MICRO AGGREGATION ================= */

      const grouped={};

      for(const t of microTrades){
        const key=`${t.buy}→${t.sell}`;

        if(!grouped[key]){
          grouped[key]={count:0,profit:0n};
        }

        grouped[key].count++;
        grouped[key].profit+=t.expectedProfit;
      }

      console.log("\nGROUPED:");

      for(const key in grouped){
        const [buy,sell]=key.split("→");

        console.log(
          `${routerName(buy)}→${routerName(sell)} | ` +
          `TRADES ${grouped[key].count} | ` +
          `TOTAL ${ethers.formatUnits(grouped[key].profit,6)}`
        );
      }
    }
  }

  await Promise.all(
    Array.from({length:WORKER_COUNT},worker)
  );
}

/* ================= ROUTER NAME HELPER ================= */

function routerName(addr){
  return Object.entries(routers)
    .find(([_,a])=>a===addr)?.[0] || addr.slice(0,6);
}

/* ================= MAIN ================= */

(async function main(){
  console.log("BOT STARTED");
  provider=newProvider();
  rebuildContracts();
  await scanLoop();
})();
