import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= RPC ================= */

const RPCS = [
  "https://polygon-bor.publicnode.com",
  "https://polygon-rpc.com"
];

let provider;

for (const rpc of RPCS) {

  try {

    provider =
      new ethers.JsonRpcProvider(rpc);

    console.log(
      "🟢 CONNECTED RPC →",
      rpc
    );

    break;

  } catch (e) {}
}

if (!provider) {
  throw new Error(
    "No RPC available"
  );
}

/* ================= WALLET ================= */

const PRIVATE_KEY =
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {

  throw new Error(
    "Missing PRIVATE_KEY"
  );
}

const wallet =
  new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

console.log(
  "\n🟢 WALLET CONNECTED →"
);

console.log(wallet.address);

/* ================= CONTRACT ================= */

const ARB_CONTRACT =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

console.log(
  "\n🟢 ARB CONTRACT →"
);

console.log(ARB_CONTRACT);

/* ================= SAFE ADDRESS ================= */

const safeAddress = (addr) =>
  ethers.getAddress(
    addr.toLowerCase()
  );

/* ================= ABI ================= */

const ABI = [

  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256) external",

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns (uint256,uint256)",

  "function minimumProfitUSDC() view returns (uint256)"
];

const contract =
  new ethers.Contract(
    ARB_CONTRACT,
    ABI,
    wallet
  );

/* ================= TOKENS ================= */

const TOKENS = {

  USDC:
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

  WMATIC:
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",

  WETH:
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",

  USDT:
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",

  DAI:
    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"
};

/* ================= ROUTERS ================= */

const QUICKSWAP = safeAddress(
  "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff"
);

const SUSHISWAP = safeAddress(
  "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"
);

const APESWAP = safeAddress(
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
);

const DFYN = safeAddress(
  "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
);

/* ================= DEX COMBINATIONS ================= */

const DEX_COMBINATIONS = [

  {
    buy: QUICKSWAP,
    sell: SUSHISWAP,
    name: "QUICKSWAP → SUSHISWAP"
  },

  {
    buy: SUSHISWAP,
    sell: QUICKSWAP,
    name: "SUSHISWAP → QUICKSWAP"
  },

  {
    buy: APESWAP,
    sell: QUICKSWAP,
    name: "APESWAP → QUICKSWAP"
  },

  {
    buy: QUICKSWAP,
    sell: APESWAP,
    name: "QUICKSWAP → APESWAP"
  },

  {
    buy: DFYN,
    sell: QUICKSWAP,
    name: "DFYN → QUICKSWAP"
  },

  {
    buy: QUICKSWAP,
    sell: DFYN,
    name: "QUICKSWAP → DFYN"
  }
];

/* ================= ROUTES ================= */

const ROUTES = [

  {
    name: "USDC ↔ WETH",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.WETH
    ],

    pathToUSDC: [
      TOKENS.WETH,
      TOKENS.USDC
    ]
  },

  {
    name: "USDC ↔ WMATIC",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.WMATIC
    ],

    pathToUSDC: [
      TOKENS.WMATIC,
      TOKENS.USDC
    ]
  },

  {
    name: "USDC ↔ USDT",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.USDT
    ],

    pathToUSDC: [
      TOKENS.USDT,
      TOKENS.USDC
    ]
  },

  {
    name: "USDC ↔ DAI",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.DAI
    ],

    pathToUSDC: [
      TOKENS.DAI,
      TOKENS.USDC
    ]
  },

  {
    name:
      "USDC → WMATIC → WETH → USDC",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.WMATIC,
      TOKENS.WETH
    ],

    pathToUSDC: [
      TOKENS.WETH,
      TOKENS.USDC
    ]
  },

  {
    name:
      "USDC → USDT → WETH → USDC",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.USDT,
      TOKENS.WETH
    ],

    pathToUSDC: [
      TOKENS.WETH,
      TOKENS.USDC
    ]
  },

  {
    name:
      "USDC → DAI → WETH → USDC",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.DAI,
      TOKENS.WETH
    ],

    pathToUSDC: [
      TOKENS.WETH,
      TOKENS.USDC
    ]
  },

  {
    name:
      "USDC → WMATIC → USDT → USDC",

    pathToToken: [
      TOKENS.USDC,
      TOKENS.WMATIC,
      TOKENS.USDT
    ],

    pathToUSDC: [
      TOKENS.USDT,
      TOKENS.USDC
    ]
  }
];

/* ================= CANDIDATE SIZES ================= */

const CANDIDATE_SIZES = [

  ethers.parseUnits("0.05", 6),
  ethers.parseUnits("0.1", 6),
  ethers.parseUnits("0.25", 6),
  ethers.parseUnits("0.5", 6),

  ethers.parseUnits("1", 6),
  ethers.parseUnits("5", 6),
  ethers.parseUnits("10", 6),
  ethers.parseUnits("25", 6),
  ethers.parseUnits("50", 6)
];

/* ================= BEST ROUTE SEARCH ================= */

async function getBestRoute() {

  console.log(
    "\n🔍 SEARCHING ROUTES..."
  );

  let bestRoute = null;

  let highestProfit = 0n;

  const minProfit =
    await contract.minimumProfitUSDC();

  console.log(
    "\n🎯 MINIMUM PROFIT REQUIRED →",
    ethers.formatUnits(
      minProfit,
      6
    ),
    "USDC"
  );

  for (const dex of DEX_COMBINATIONS) {

    console.log(
      "\n" + "=".repeat(70)
    );

    console.log(
      "🏦 DEX SCAN →",
      dex.name
    );

    for (const route of ROUTES) {

      console.log(
        "\n🧪 TESTING ROUTE →"
      );

      console.log(route.name);

      for (const size of CANDIDATE_SIZES) {

        try {

          const result =
            await contract
              .simulateArbitrageProfit(
                dex.buy,
                dex.sell,
                size,
                route.pathToToken,
                route.pathToUSDC
              );

          /* ================= FIX ================= */

          const estimatedFinalUSDC =
            result[0];

          const estimatedProfit =
            result[1];

          /* ================= LOGGING ================= */

          console.log(
            "\n📊 SIMULATION"
          );

          console.log(
            "size:",
            ethers.formatUnits(
              size,
              6
            ),
            "USDC"
          );

          console.log(
            "final:",
            ethers.formatUnits(
              estimatedFinalUSDC,
              6
            ),
            "USDC"
          );

          console.log(
            "profit:",
            ethers.formatUnits(
              estimatedProfit,
              6
            ),
            "USDC"
          );

          /* ================= BEST ROUTE ================= */

          if (
            estimatedProfit >
            highestProfit
          ) {

            highestProfit =
              estimatedProfit;

            bestRoute = {

              routerA:
                dex.buy,

              routerB:
                dex.sell,

              amount:
                size,

              estimatedProfit:
                estimatedProfit,

              estimatedFinalUSDC:
                estimatedFinalUSDC,

              pathToToken:
                route.pathToToken,

              pathToUSDC:
                route.pathToUSDC,

              route:
                route.name,

              dex:
                dex.name
            };

            console.log(
              "\n✅ NEW BEST ROUTE FOUND"
            );

            console.log(
              "🏦 DEX:",
              dex.name
            );

            console.log(
              "🛣️ ROUTE:",
              route.name
            );

            console.log(
              "💰 PROFIT:",
              ethers.formatUnits(
                estimatedProfit,
                6
              ),
              "USDC"
            );
          }

        } catch (err) {

          console.log(
            "\n❌ SIMULATION FAILED"
          );

          console.log(
            err.reason ||
            err.message
          );
        }
      }
    }
  }

  return bestRoute;
}

/* ================= EXECUTION ================= */

async function executeTrade(best) {

  if (!best) {

    console.log(
      "\n⛔ NO ROUTES FOUND"
    );

    return;
  }

  if (
    best.estimatedProfit <= 0n
  ) {

    console.log(
      "\n⛔ NO PROFITABLE ROUTES"
    );

    return;
  }

  console.log(
    "\n🏆 BEST EXECUTABLE ROUTE"
  );

  console.log(
    "\n🏦 DEX PATH →"
  );

  console.log(best.dex);

  console.log(
    "\n🛣️ ROUTE →"
  );

  console.log(best.route);

  console.log(
    "\n💵 FLASHLOAN SIZE →"
  );

  console.log(
    ethers.formatUnits(
      best.amount,
      6
    ),
    "USDC"
  );

  console.log(
    "\n💰 EXPECTED FINAL →"
  );

  console.log(
    ethers.formatUnits(
      best.estimatedFinalUSDC,
      6
    ),
    "USDC"
  );

  console.log(
    "\n🔥 EXPECTED PROFIT →"
  );

  console.log(
    ethers.formatUnits(
      best.estimatedProfit,
      6
    ),
    "USDC"
  );

  console.log(
    "\n📦 pathToToken"
  );

  console.log(
    best.pathToToken
  );

  console.log(
    "\n📦 pathToUSDC"
  );

  console.log(
    best.pathToUSDC
  );

  const deadline =
    Math.floor(
      Date.now() / 1000
    ) + 60;

  /* ================= STATICCALL ================= */

  console.log(
    "\n🔎 STATICCALL CHECK..."
  );

  try {

    await contract
      .executeAaveFlashLoanArbitrage
      .staticCall(
        best.routerA,
        best.routerB,
        best.amount,
        best.pathToToken,
        best.pathToUSDC,
        deadline
      );

    console.log(
      "✅ STATICCALL PASSED"
    );

  } catch (err) {

    console.log(
      "❌ STATICCALL FAILED"
    );

    console.log(
      err.reason ||
      err.message
    );

    return;
  }

  /* ================= GAS ESTIMATION ================= */

  console.log(
    "\n⛽ ESTIMATING GAS..."
  );

  try {

    const gasEstimate =
      await contract
        .executeAaveFlashLoanArbitrage
        .estimateGas(
          best.routerA,
          best.routerB,
          best.amount,
          best.pathToToken,
          best.pathToUSDC,
          deadline
        );

    console.log(
      "✅ GAS ESTIMATE →",
      gasEstimate.toString()
    );

  } catch (err) {

    console.log(
      "❌ GAS ESTIMATION FAILED"
    );

    console.log(
      err.reason ||
      err.message
    );

    return;
  }

  /* ================= EXECUTE ================= */

  console.log(
    "\n🚀 EXECUTING FLASH LOAN"
  );

  let tx;

  try {

    tx =
      await contract
        .executeAaveFlashLoanArbitrage(
          best.routerA,
          best.routerB,
          best.amount,
          best.pathToToken,
          best.pathToUSDC,
          deadline
        );

    console.log(
      "📡 TX SENT →",
      tx.hash
    );

  } catch (err) {

    console.log(
      "❌ TX FAILED"
    );

    console.log(
      err.reason ||
      err.message
    );

    return;
  }

  console.log(
    "\n⏳ WAITING FOR CONFIRMATION..."
  );

  const receipt =
    await tx.wait();

  console.log(
    "\n✅ FLASH LOAN CONFIRMED"
  );

  console.log(
    "📦 BLOCK →",
    receipt.blockNumber
  );

  /* ================= BALANCE ================= */

  const usdcAbi = [
    "function balanceOf(address) view returns (uint256)"
  ];

  const usdc =
    new ethers.Contract(
      TOKENS.USDC,
      usdcAbi,
      provider
    );

  const balance =
    await usdc.balanceOf(
      ARB_CONTRACT
    );

  console.log(
    "\n💰 CONTRACT BALANCE UPDATED"
  );

  console.log(
    ethers.formatUnits(
      balance,
      6
    ),
    "USDC"
  );

  console.log(
    "\n🟢 ARBITRAGE COMPLETE"
  );
}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log(
    "\n🚀 ARB BOT STARTED"
  );

  const block =
    await provider.getBlockNumber();

  console.log(
    "\n📦 BLOCK →",
    block
  );

  while (true) {

    console.log(
      "\n" + "=".repeat(80)
    );

    const best =
      await getBestRoute();

    await executeTrade(best);

    await new Promise(
      r => setTimeout(r, 8000)
    );
  }
}

main();
