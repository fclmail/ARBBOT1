






// scripts/arbitrage.js  
import dotenv from "dotenv";  
import { ethers } from "ethers";  

dotenv.config({ override: false });  

/* ================= ENV ================= */  

const PRIVATE_KEY =  
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;  

if (!PRIVATE_KEY) throw new Error("PK missing");  

/* ================= RPC ================= */  

const RPCS = [  
  "https://polygon-bor-rpc.publicnode.com",  
  "https://polygon.llamarpc.com",  
  "https://polygon.drpc.org",  
  "https://polygon-public.nodies.app"  
];  

let rpcIndex = 0;  
let provider;  
let wallet;  
let usdc;  
let vault;  
let routerContracts;  

/* ================= CONFIG ================= */  

const TRADE_AMOUNT = ethers.parseUnits("0.03", 6); // USDC amount per leg  
const MIN_PROFIT = ethers.parseUnits("0.00003", 6);  

const MIN_BATCH_PROFIT = ethers.parseUnits("0.008", 6);  
const SAFETY_MULTIPLIER = 190n;  
const WORKER_COUNT = 32;  

const SAFE_BATCH_TRIGGER = (MIN_BATCH_PROFIT * SAFETY_MULTIPLIER) / 100n;  

const LOOP_SLEEP_MS = 5;  
const EXECUTION_COOLDOWN_MS = 2000;  

/* ================= CONTRACT ================= */  

const CONTRACT_ADDRESS = "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";  
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";  

/* ================= ABI ================= */  

const erc20Abi = ["function balanceOf(address) view returns (uint256)"];  

const contractAbi = [  
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline)) batch",  
  "function minimumProfitUSDC() view returns (uint256)",  
  "function usdc() view returns (address)"  
];  

const routerAbi = [  
  "function getAmountsOut(uint amountIn, address[] path) view returns(uint[] amounts)"  
];  

/* ================= ROUTERS ================= */  

const routers = {  
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",  
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",  
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",  
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",  
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"  
};  

/* ================= TOKENS ================= */  

const TOKENS = {  
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",  
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",  
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",  
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",  
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",  
  QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",  
  SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",  
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",  
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",  
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",  
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",  
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"  
};  

/* ================= HELPERS ================= */  

const USDC_DECIMALS = 6n;  

function formatUSDC(u256) {  
  // u256 must be bigint/uint256  
  return ethers.formatUnits(u256, Number(USDC_DECIMALS));  
}  

function logProfit(tag, u256) {  
  console.log(`${tag}: ${formatUSDC(u256)} USDC (${u256.toString()} raw)`);  
}  

function sleep(ms) {  
  return new Promise((r) => setTimeout(r, ms));  
}  

/* ================= STATE ================= */  

let microTrades = [];  
let runningProfit = 0n;  
let isExecuting = false;  

/* ================= INIT ================= */  

function rebuildContracts() {  
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);  
  // USDC instance: provider is used for reads; vault tx uses wallet  
  usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);  
  vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);  

  routerContracts = Object.fromEntries(  
    Object.entries(routers).map(([name, addr]) => [  
      name,  
      new ethers.Contract(addr, routerAbi, provider),  
    ])  
  );  
}  

function newProvider() {  
  const url = RPCS[rpcIndex];  
  rpcIndex = (rpcIndex + 1) % RPCS.length;  

  return new ethers.JsonRpcProvider(  
    url,  
    { name: "matic", chainId: 137 },  
    { staticNetwork: true }  
  );  
}  

async function initProvider() {  
  provider = newProvider();  
  await provider.getNetwork();  
  rebuildContracts();  
}  

/* ================= BALANCE (FIX: no Number() rounding) ================= */  

async function getVaultUSDC_rawAndFormatted() {  
  const bal = await usdc.balanceOf(CONTRACT_ADDRESS);  
  return {  
    raw: bal,  
    formatted: formatUSDC(bal),  
  };  
}  

/* ================= ON-CHAIN MIN PROFIT (FIX) ================= */  

async function getOnchainMinimumProfit() {  
  const min = await vault.minimumProfitUSDC();  
  return min;  
}  

/* ================= QUOTE ================= */  

async function quote(routerAddr, amountIn, path) {  
  try {  
    const out = await routerContracts[routerAddr].getAmountsOut(amountIn, path);  
    return out.at(-1); // bigint  
  } catch {  
    return null;  
  }  
}  

/* ================= PATHS ================= */  

function buildBuyPaths(token) {  
  return [  
    [USDC_ADDRESS, token],  
    [USDC_ADDRESS, TOKENS.WETH, token],  
    [USDC_ADDRESS, TOKENS.WMATIC, token],  
    [USDC_ADDRESS, TOKENS.DAI, token],  
    [USDC_ADDRESS, TOKENS.USDT, token]  
  ];  
}  

function buildSellPaths(token) {  
  return [  
    [token, USDC_ADDRESS],  
    [token, TOKENS.WETH, USDC_ADDRESS],  
    [token, TOKENS.WMATIC, USDC_ADDRESS],  
    [token, TOKENS.DAI, USDC_ADDRESS],  
    [token, TOKENS.USDT, USDC_ADDRESS]  
  ];  
}  

/* ================= VAULT BALANCE (NO ROUNDING) ================= */  

function u6ToStr(u256) {  
  // keep as string; never Number() to avoid rounding hiding small profits  
  return ethers.formatUnits(u256, 6);  
}  

async function getVaultUSDCRaw() {  
  const bal = await usdc.balanceOf(CONTRACT_ADDRESS);  
  return bal; // bigint  
}  

/* ================= FIND TRADE ================= */  

async function findTrade(buyRouterAddr, sellRouterAddr, token) {  
  for (const bp of buildBuyPaths(token)) {  
    const buyOut = await quote(buyRouterAddr, TRADE_AMOUNT, bp);  
    if (!buyOut) continue;  

    for (const sp of buildSellPaths(token)) {  
      const sellOut = await quote(sellRouterAddr, buyOut, sp);  
      if (!sellOut) continue;  

      const profit = sellOut - TRADE_AMOUNT;  
      if (profit < MIN_PROFIT) continue;  

      return {  
        buy: buyRouterAddr,  
        sell: sellRouterAddr,  
        token,  
        amountIn: TRADE_AMOUNT,  
        buyPath: bp,  
        sellPath: sp,  
        expectedProfit: profit // will be refreshed before execution  
      };  
    }  
  }  
  return null;  
}  

/* ================= REVALIDATION =================  
   - re-quote EVERYTHING  
   - strict filter (profit >= MIN_PROFIT)  
   - update expectedProfit to refreshed profit  
*/  

async function revalidateTrades(trades) {  
  console.log("\nFULL BATCH REQUOTE START\n");  

  const valid = [];  

  for (const t of trades) {  
    const buyOut = await quote(t.buy, t.amountIn, t.buyPath);  
    if (!buyOut) continue;  

    const sellOut = await quote(t.sell, buyOut, t.sellPath);  
    if (!sellOut) continue;  

    const profit = sellOut - t.amountIn;  
    if (profit < MIN_PROFIT) continue;  

    valid.push({  
      ...t,  
      expectedProfit: profit  
    });  
  }  

  console.log(`FULL BATCH REQUOTE END. valid=${valid.length}`);  
  return valid;  
}  

/* ================= EXECUTE ================= */  

async function executeBatch(microBatch) {  
  console.log("\nBATCH THRESHOLD REACHED");  

  // On-chain min profit (for visibility)  
  const onChainMin = await vault.minimumProfitUSDC?.().catch(() => null);  
  if (onChainMin !== null) {  
    console.log(  
      `on-chain minimumProfitUSDC = ${u6ToStr(onChainMin)} (${onChainMin.toString()} raw)`  
    );  
  } else {  
    console.log("on-chain minimumProfitUSDC unavailable (function missing in ABI?)");  
  }  

  // raw vault balance before tx  
  const balBefore = await getVaultUSDCRaw();  
  console.log(`VAULT USDC BEFORE raw=${balBefore.toString()} fmt=${u6ToStr(balBefore)}`);  

  // revalidate immediately before execution  
  console.log(`REBUILT TRADES (candidate) ${microBatch.length}`);  
  const validTrades = await revalidateTrades(microBatch);  
  console.log(`VALID TRADES (post-filter) ${validTrades.length}`);  

  if (validTrades.length === 0) {
    console.log("NO VALID TRADES AFTER REQUOTE\n");
    isExecuting = false;
    return;
  }

  // conservative expected batch profit gate based on refreshed expectedProfit
  const expectedBatchProfit = validTrades.reduce(
    (acc, t) => acc + t.expectedProfit,
    0n
  );

  console.log(
    `EXPECTED BATCH PROFIT (sum refreshed) = ${formatUSDC(expectedBatchProfit)} USDC`
  );

  // Optional: keep your safety trigger behavior
  // (Only proceed if refreshed expected profit is comfortably above threshold)
  if (expectedBatchProfit < SAFE_BATCH_TRIGGER) {
    console.log(
      `BATCH PROFIT TOO LOW: expected ${formatUSDC(expectedBatchProfit)} < SAFE_BATCH_TRIGGER ${formatUSDC(
        SAFE_BATCH_TRIGGER
      )}\n`
    );
    isExecuting = false;
    return;
  }

  const fee = await provider.getFeeData();

  const deadline = Math.floor(Date.now() / 1000) + 60;

  const batchArgs = {
    buyRouters: validTrades.map((t) => t.buy),
    sellRouters: validTrades.map((t) => t.sell),
    amountsInUSDC: validTrades.map((t) => t.amountIn),
    pathsToToken: validTrades.map((t) => t.buyPath),
    pathsToUSDC: validTrades.map((t) => t.sellPath),
    deadline,
  };

  console.log(
    `SUBMITTING BATCH: trades=${validTrades.length}, deadline=${deadline}`
  );

  // (Optional) log current contract USDC before sending
  const before = await getVaultUSDC_rawAndFormatted();
  console.log(
    `VAULT USDC BEFORE: ${before.formatted} USDC (${before.raw.toString()} raw)`
  );

  try {
    const tx = await vault.executeFlashBatchArbitrage(batchArgs, {
      gasLimit: 2_000_000n, // ethers v6 accepts bigint; if you prefer number, use 2000000
      maxFeePerGas: (fee.maxFeePerGas * 12n) / 10n,
      maxPriorityFeePerGas: (fee.maxPriorityFeePerGas * 12n) / 10n,
    });

    console.log(`TX HASH: ${tx.hash}`);

    const receipt = await provider.waitForTransaction(tx.hash);
    console.log(`TX MINED: status=${receipt.status}`);

    // Wait a bit to let state settle
    await sleep(2000);

    const after = await getVaultUSDC_rawAndFormatted();
    console.log(
      `VAULT USDC AFTER: ${after.formatted} USDC (${after.raw.toString()} raw)\n`
    );
  } catch (err) {
    console.error("EXECUTION FAILED:", err?.shortMessage || err?.message || err);
  } finally {
    isExecuting = false;
  }
}









//---------------------------------------------------------


  // conservative expected batch profit gate based on refreshed expectedProfit  
  // (your contract also enforces realizedProfit >= MIN_BATCH_PROFIT internally)  
  const expectedBatchProfit = validTrades.reduce((acc, t) => acc + t.expectedProfit, 0n);  
  console.log(  
    `EXPECTED BATCH PROFIT (sum refreshed) = ${u6ToStr(expectedBatchProfit)} USDC (${expectedBatchProfit.toString()} raw)`  
  );  

  // optional extra guard (pre-tx): avoids sending if it’s not even promising  
  if (expectedBatchProfit < SAFE_BATCH_TRIGGER) {  
    console.log(  
      `SKIP BATCH: expectedBatchProfit < SAFE_BATCH_TRIGGER (${u6ToStr(  
        expectedBatchProfit  
      )} < ${u6ToStr(SAFE_BATCH_TRIGGER)})`  
    );  
    return;  
  }  

  const fee = await provider.getFeeData();  

  console.log("BUILDING EXECUTE TX...");  

  const deadline = Math.floor(Date.now() / 1000) + 60;  

  const batchParam = {  
    buyRouters: validTrades.map((t) => t.buy),  
    sellRouters: validTrades.map((t) => t.sell),  
    amountsInUSDC: validTrades.map((t) => t.amountIn),  
    pathsToToken: validTrades.map((t) => t.buyPath),  
    pathsToUSDC: validTrades.map((t) => t.sellPath),  
    deadline  
  };  

  // tx send  
  const gasLimit = 2_500_000n; // keep as bigint for safety  

  // NOTE: fee.maxFeePerGas/maxPriorityFeePerGas can be null; guard it  
  const maxFeePerGas =  
    fee.maxFeePerGas ??  
    (await provider.getFeeData()).maxFeePerGas ??  
    ethers.parseUnits("100", "gwei");  

  const maxPriorityFeePerGas =  
    fee.maxPriorityFeePerGas ??  
    (await provider.getFeeData()).maxPriorityFeePerGas ??  
    ethers.parseUnits("2", "gwei");  

  isExecuting = true;  

  try {  
    // raw vault balance before tx  
    const before = await getVaultUSDCRaw();  

    console.log(  
      `VAULT USDC BEFORE: ${u6ToStr(before)} USDC (${before.toString()} raw)`  
    );  

    const tx = await vault.executeFlashBatchArbitrage(batchParam, {  
      gasLimit: gasLimit,  
      maxFeePerGas: (maxFeePerGas * 12n) / 10n,  
      maxPriorityFeePerGas: (maxPriorityFeePerGas * 12n) / 10n  
    });  

    console.log(`TX SENT: ${tx.hash}`);  

    const receipt = await provider.waitForTransaction(tx.hash, 1);  
    console.log(  
      `TX RECEIPT status=${receipt?.status} gasUsed=${  
        receipt?.gasUsed ? receipt.gasUsed.toString() : "?"  
      }`  
    );  

    const after = await getVaultUSDCRaw();  
    console.log(  
      `VAULT USDC AFTER: ${u6ToStr(after)} USDC (${after.toString()} raw)\n`  
    );  

    if (receipt?.status !== 1n && receipt?.status !== 1) {  
      console.log("WARNING: tx failed (status != 1)");  
    } else {  
      console.log("TX SUCCESS\n");  
    }  

    // clear local profit accounting (since actual realized depends on contract)  
    await sleep(EXECUTION_COOLDOWN_MS);  
  } catch (err) {  
    console.error(  
      "EXECUTION FAILED:",  
      err?.shortMessage || err?.message || err  
    );  
  } finally {  
    isExecuting = false;  
  }  
}  

/* ================= SCANNER LOOP ================= */  

async function scanLoop() {  
  const tasks = [];  

  const routerEntries = Object.entries(routers);  

  for (const [buyName, buyAddr] of routerEntries) {  
    for (const [sellName, sellAddr] of routerEntries) {  
      if (buyName === sellName) continue;  

      for (const tokenAddr of Object.values(TOKENS)) {  
        tasks.push({ buy: buyAddr, sell: sellAddr, token: tokenAddr });  
      }  
    }  
  }  

  let i = 0;  

  async function worker(workerId) {  
    while (true) {  
      if (isExecuting) {  
        await sleep(LOOP_SLEEP_MS);  
        continue;  
      }  

      const task = tasks[i++ % tasks.length];  

      const trade = await findTrade(task.buy, task.sell, task.token);

      if (!trade) continue;

      microTrades.push(trade);
      runningProfit += trade.expectedProfit;

      console.log(
        `[W${workerId}] +1 trade token=${trade.token} buy=${trade.buy} sell=${trade.sell} expectedProfit=${formatUSDC(trade.expectedProfit)} | runningProfit=${formatUSDC(
          runningProfit
        )} (${runningProfit.toString()} raw)`
      );

      if (runningProfit >= SAFE_BATCH_TRIGGER && !isExecuting) {
        isExecuting = true;

        const batch = [...microTrades];
        microTrades = [];
        runningProfit = 0n;

        await executeBatch(batch);

        // if executeBatch threw and didn't reset isExecuting, ensure state is consistent
        isExecuting = false;
      }
    }
  }

  await Promise.all(Array.from({ length: WORKER_COUNT }, (_, idx) => worker(idx)));
}

/* ================= MAIN ================= */

(async function main() {
  await initProvider();
  console.log("INIT OK - starting scan loop...");
  await scanLoop();
})();
