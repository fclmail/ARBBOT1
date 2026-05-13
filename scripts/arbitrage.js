import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   RPC FAILOVER
========================================================= */

const RPCS = [
  process.env.RPC_1 || "https://polygon-bor-rpc.publicnode.com",
  process.env.RPC_2 || "https://polygon-rpc.com",
  process.env.RPC_3 || "https://rpc-mainnet.matic.quiknode.pro"
];

let rpcIndex = 0;

function createProvider() {
  return new ethers.JsonRpcProvider(
    RPCS[rpcIndex]
  );
}

let provider = createProvider();

/* =========================================================
   WALLET
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

const wallet =
  new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const arbAbi = [
  "function owner() view returns(address)",

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external"
];

const arb =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    arbAbi,
    wallet
  );

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = {
  USDC:
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

  WETH:
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
};

const USDC = TOKENS.USDC;
const WETH = TOKENS.WETH;

/* =========================================================
   DEX ROUTERS
========================================================= */

const QUICKSWAP_ROUTER =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHISWAP_ROUTER =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* =========================================================
   LP PAIRS
========================================================= */

const QUICKSWAP_PAIR =
  "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670d";

const SUSHISWAP_PAIR =
  "0x34965ba0ac2451A34a0471F04CCa3F990b8dea27";

/* =========================================================
   ABI
========================================================= */

const pairAbi = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

/* =========================================================
   SETTINGS
========================================================= */

const LOOP_DELAY = 5000;

const MIN_TRADE_SIZE =
  100n * 10n ** 6n;

const MAX_TRADE_SIZE =
  250000n * 10n ** 6n;

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmt6(x) {
  return Number(
    ethers.formatUnits(x, 6)
  ).toFixed(2);
}

async function rotateRPC() {

  rpcIndex++;

  if (rpcIndex >= RPCS.length) {
    rpcIndex = 0;
  }

  console.log(
    `⚠️ ROTATING RPC -> ${RPCS[rpcIndex]}`
  );

  provider = createProvider();
}

/* =========================================================
   RESERVES
========================================================= */

async function getReserves(pairAddress) {

  try {

    const pair =
      new ethers.Contract(
        pairAddress,
        pairAbi,
        provider
      );

    const [r0, r1] =
      await pair.getReserves();

    const token0 =
      await pair.token0();

    const token1 =
      await pair.token1();

    return {
      r0: BigInt(r0),
      r1: BigInt(r1),
      token0,
      token1
    };

  } catch (e) {

    console.log(
      "⚠️ RESERVE ERROR:",
      e.message
    );

    await rotateRPC();

    return null;
  }
}

/* =========================================================
   NORMALIZED PRICE
========================================================= */

function computePrice(
  reserveUSDC,
  reserveWETH
) {

  const usdc =
    Number(
      ethers.formatUnits(
        reserveUSDC,
        6
      )
    );

  const weth =
    Number(
      ethers.formatUnits(
        reserveWETH,
        18
      )
    );

  if (weth === 0) {
    return 0;
  }

  return usdc / weth;
}

/* =========================================================
   SCORE
========================================================= */

function computeScore(
  spread,
  liquidity
) {

  if (spread <= 0) {
    return 0;
  }

  return Math.floor(
    spread * (liquidity / 1_000_000)
  );
}

/* =========================================================
   BALANCE
========================================================= */

async function getVaultBalance() {

  const usdc =
    new ethers.Contract(
      USDC,
      erc20Abi,
      provider
    );

  return await usdc.balanceOf(
    CONTRACT_ADDRESS
  );
}

/* =========================================================
   CONFIDENCE
========================================================= */

function confidenceAllocation(
  confidence,
  vaultBalance
) {

  let allocation =
    (vaultBalance * BigInt(confidence))
    / 100n;

  if (allocation > MAX_TRADE_SIZE) {
    allocation = MAX_TRADE_SIZE;
  }

  return allocation;
}

/* =========================================================
   STATIC CHECK
========================================================= */

async function staticSimulation(
  amount
) {

  try {

    const result =
      await arb.simulateArbitrageProfit(
        QUICKSWAP_ROUTER,
        SUSHISWAP_ROUTER,
        amount,
        [USDC, WETH],
        [WETH, USDC]
      );

    return {
      success: true,
      finalAmount: result[0],
      profit: result[1]
    };

  } catch (e) {

    console.log(
      "\n❌ STATIC ERROR:",
      e.message
    );

    return {
      success: false,
      finalAmount: 0n,
      profit: 0n
    };
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(signal) {

  console.log(
    "\n🔥 EXECUTING FLASH LOAN"
  );

  const before =
    await getVaultBalance();

  const feeData =
    await provider.getFeeData();

  const tx =
    await arb.executeBestFlashLoanArbitrage(
      QUICKSWAP_ROUTER,
      SUSHISWAP_ROUTER,
      [signal.amount],
      [USDC, WETH],
      [WETH, USDC],
      Math.floor(Date.now() / 1000) + 120,
      {
        gasLimit: 4000000,
        maxFeePerGas:
          feeData.maxFeePerGas,
        maxPriorityFeePerGas:
          feeData.maxPriorityFeePerGas
      }
    );

  console.log(
    "\n📡 TX:"
  );

  console.log(tx.hash);

  const receipt =
    await tx.wait();

  const after =
    await getVaultBalance();

  const pnl =
    after - before;

  console.log(
    "\n✅ BLOCK:"
  );

  console.log(
    receipt.blockNumber
  );

  console.log(
    "\n🏦 VAULT_BEFORE:"
  );

  console.log(
    fmt6(before)
  );

  console.log(
    "\n🏦 VAULT_AFTER:"
  );

  console.log(
    fmt6(after)
  );

  console.log(
    "\n📈 NET_PROFIT:"
  );

  console.log(
    `${fmt6(pnl)} USDC`
  );

  console.log(
    "\n🏆 PROFITS ACCUMULATED"
  );
}

/* =========================================================
   CORE ENGINE
========================================================= */

async function runEngine() {

  console.log(
    "\n🚀 VAULT ENGINE STARTED"
  );

  console.log(
    "\n🔎 RESERVE_SCAN"
  );

  console.log(
    "\nPAIR_A:"
  );

  console.log(
    QUICKSWAP_PAIR
  );

  console.log(
    "\nPAIR_B:"
  );

  console.log(
    SUSHISWAP_PAIR
  );

  const pairA =
    await getReserves(
      QUICKSWAP_PAIR
    );

  const pairB =
    await getReserves(
      SUSHISWAP_PAIR
    );

  if (!pairA || !pairB) {
    return;
  }

  const priceA =
    computePrice(
      pairA.r0,
      pairA.r1
    );

  const priceB =
    computePrice(
      pairB.r0,
      pairB.r1
    );

  const spread =
    Math.abs(
      priceA - priceB
    );

  console.log(
    `\nDEXA_PRICE: ${priceA.toFixed(2)}`
  );

  console.log(
    `DEXB_PRICE: ${priceB.toFixed(2)}`
  );

  console.log(
    `\nSPREAD: ${spread.toFixed(2)}`
  );

  const liquidity =
    Number(
      pairA.r0 +
      pairA.r1 +
      pairB.r0 +
      pairB.r1
    );

  const score =
    computeScore(
      spread,
      liquidity
    );

  console.log(
    `\n📊 PROFIT_SCORE: ${score}`
  );

  if (score <= 0) {

    console.log(
      "\n❌ NO EDGE"
    );

    return;
  }

  const confidence =
    score > 800 ? 80 :
    score > 500 ? 50 :
    score > 200 ? 25 :
    10;

  console.log(
    `\n🎯 CONFIDENCE: ${confidence}%`
  );

  const vault =
    await getVaultBalance();

  let allocation =
    confidenceAllocation(
      confidence,
      vault
    );

  if (allocation < MIN_TRADE_SIZE) {

    allocation =
      MIN_TRADE_SIZE;
  }

  console.log(
    `\n💰 ALLOCATION: ${fmt6(allocation)} USDC`
  );

  console.log(
    "\n🧪 STATIC SIMULATION"
  );

  const sim =
    await staticSimulation(
      allocation
    );

  console.log(
    `\nSIMULATED_PROFIT: ${fmt6(sim.profit)}`
  );

  if (
    !sim.success ||
    sim.profit <= 0n
  ) {

    console.log(
      "\n❌ STATIC FAILED"
    );

    return;
  }

  console.log(
    "\n✅ STATIC PASSED"
  );

  await execute({
    amount: allocation
  });
}

/* =========================================================
   MAIN
========================================================= */

async function main() {

  const owner =
    await arb.owner();

  console.log(
    "\n👤 OWNER:"
  );

  console.log(owner);

  console.log(
    "\n👤 WALLET:"
  );

  console.log(wallet.address);

  while (true) {

    try {

      await runEngine();

    } catch (e) {

      console.log(
        "\n⚠️ ENGINE ERROR:"
      );

      console.log(
        e.message
      );

      await rotateRPC();
    }

    await sleep(
      LOOP_DELAY
    );
  }
}

main().catch(console.error);
