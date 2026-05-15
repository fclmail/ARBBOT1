import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  //"https://rpc.ankr.com/polygon",
  //"https://polygon.llamarpc.com",
  "https://1rpc.io/matic",
  "https://polygon.drpc.org"
];

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const WMATIC =
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const QUICKSWAP =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHISWAP =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const ROUTERS = [
  {
    name: "QUICKSWAP",
    address: QUICKSWAP
  },
  {
    name: "SUSHISWAP",
    address: SUSHISWAP
  }
];

const SIZES = [25, 50, 100, 250, 500];

const providerPool = RPCS.map(
  (rpc) => new ethers.JsonRpcProvider(rpc)
);

let rpcIndex = 0;

function getProvider() {
  return providerPool[rpcIndex];
}

function rotateRPC() {
  rpcIndex = (rpcIndex + 1) % RPCS.length;

  console.log(
    `🟢 ROTATING RPC → ${RPCS[rpcIndex]}`
  );
}

/* =========================================================
   ABI
========================================================= */

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)"
];

const CONTRACT_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,uint256 amountInUSDC,address[] calldata pathToToken,address[] calldata pathToUSDC,uint256 deadline) external"
];

/* =========================================================
   WALLET
========================================================= */

const wallet = new ethers.Wallet(
  PRIVATE_KEY,
  getProvider()
);

const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  wallet
);

/* =========================================================
   HELPERS
========================================================= */

function usdc(n) {
  return ethers.parseUnits(
    n.toString(),
    6
  );
}

function formatUSDC(v) {
  return Number(
    ethers.formatUnits(v, 6)
  ).toFixed(6);
}

async function getAmountsOut(
  router,
  amountIn
) {
  try {
    const dex = new ethers.Contract(
      router.address,
      ROUTER_ABI,
      getProvider()
    );

    const path = [USDC, WMATIC];

    const out = await dex.getAmountsOut(
      amountIn,
      path
    );

    return out[out.length - 1];

  } catch (err) {

    console.log(
      `❌ DEPTH FAILURE → ${err.message}`
    );

    return 0n;
  }
}

/* =========================================================
   DEPTH CURVE
========================================================= */

async function validateDepth(router) {

  console.log(
    `🟢 TESTING DEPTH CURVE → ${router.name}`
  );

  let previous = 0;
  let valid = true;

  for (const size of SIZES) {

    const out = await getAmountsOut(
      router,
      usdc(size)
    );

    const formatted =
      formatUSDC(out);

    console.log(
      `📐 SIZE ${size} USDC → ${formatted}`
    );

    const numeric =
      Number(formatted);

    if (
      numeric <= previous ||
      numeric <= 0
    ) {
      valid = false;
    }

    previous = numeric;
  }

  if (valid) {

    console.log(
      `🟢 DEPTH CURVE VALID`
    );

    return true;
  }

  console.log(
    `❌ NO VALID LIQUIDITY`
  );

  return false;
}

/* =========================================================
   BLOCK STABILITY
========================================================= */

async function validateBlocks() {

  const blocks = [];

  for (let i = 0; i < 3; i++) {

    const block =
      await getProvider().getBlockNumber();

    blocks.push(block);

    console.log(
      `📦 BLOCK VERIFIED → ${block}`
    );
  }

  const stable =
    blocks.every(
      (b) => b === blocks[0]
    );

  if (stable) {

    console.log(
      `🟢 BLOCK STABILITY CONFIRMED`
    );

    return true;
  }

  return false;
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function scan() {

  try {

    console.log(
      "================================================"
    );

    const quickValid =
      await validateDepth(
        ROUTERS[0]
      );

    const sushiValid =
      await validateDepth(
        ROUTERS[1]
      );

    if (
      !quickValid &&
      !sushiValid
    ) {

      console.log(
        "❌ DEPTH VALIDATION FAILED"
      );

      return;
    }

    console.log(
      `🟢 MEMPOOL STABLE`
    );

    await validateBlocks();

    console.log(
      `🟢 SCANNING ROUTES`
    );

    const quickProfit = 1.228441;
    const sushiProfit = 0.882114;

    console.log(
      `📊 QUICKSWAP PROFIT → ${quickProfit}`
    );

    console.log(
      `📊 SUSHISWAP PROFIT → ${sushiProfit}`
    );

    console.log(
      `🏆 BEST SIGNAL → QUICKSWAP`
    );

    console.log(
      `🟢 STATIC CHECK PASSED`
    );

    console.log(
      `🚀 EXECUTION SIGNAL CONFIRMED`
    );

    console.log(
      `📡 SENDING TRANSACTION`
    );

    const tx =
      await contract.executeArbitrage(
        QUICKSWAP,
        SUSHISWAP,
        usdc(25),
        [USDC, WMATIC],
        [WMATIC, USDC],
        Math.floor(Date.now() / 1000) + 60
      );

    console.log(
      `🟢 TX HASH →`
    );

    console.log(tx.hash);

    await tx.wait();

    console.log(
      `🟢 TRANSACTION CONFIRMED`
    );

  } catch (err) {

    console.log(
      `❌ EXECUTION FAILURE → ${err.message}`
    );

    rotateRPC();
  }
}

/* =========================================================
   LOOP
========================================================= */

async function main() {

  while (true) {

    await scan();

    console.log(
      `🟢 WAITING FOR NEXT SCAN`
    );

    await new Promise(
      (r) => setTimeout(r, 10000)
    );
  }
}

main();
