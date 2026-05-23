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
    provider = new ethers.JsonRpcProvider(rpc);
    console.log("🟢 CONNECTED RPC →", rpc);
    break;
  } catch {}
}

if (!provider) throw new Error("No RPC available");

/* ================= WALLET ================= */

const wallet =
  new ethers.Wallet(
    process.env.PRIVATE_KEY,
    provider
  );

console.log("\n🟢 WALLET:", wallet.address);

/* ================= CONTRACT ================= */

const ARB_CONTRACT =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

/* 🟢 ADDED: minimumProfit setter + getter */

const ABI = [
  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256) external",
  "function setMinimumProfitUSDC(uint256) external",
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
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

/* ================= FACTORY ADDRESSES ================= */

const FACTORIES = {
  QUICK: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  SUSHI: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
  APE: "0xcf083be4164828f00cae704ec15a36d711491284",
  DFYN: "0xe7fb3e833efe5f9c441105eb65ef8b261266423b"
};

const FACTORY_ABI = [
  "function getPair(address,address) view returns(address)"
];

const PAIR_ABI = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];

/* ================= AMM MATH ================= */

function getAmountOut(amountIn, reserveIn, reserveOut) {

  const amountInWithFee =
    amountIn * 997n;

  return (
    amountInWithFee * reserveOut
  ) / (
    reserveIn * 1000n +
    amountInWithFee
  );
}

/* ================= GET RESERVES ================= */

async function getReserves(
  factoryAddr,
  tokenA,
  tokenB
) {

  const factory =
    new ethers.Contract(
      factoryAddr,
      FACTORY_ABI,
      provider
    );

  const pairAddr =
    await factory.getPair(
      tokenA,
      tokenB
    );

  if (pairAddr === ethers.ZeroAddress)
    return null;

  const pair =
    new ethers.Contract(
      pairAddr,
      PAIR_ABI,
      provider
    );

  const [r0, r1] =
    await pair.getReserves();

  const token0 =
    await pair.token0();

  if (
    token0.toLowerCase() ===
    tokenA.toLowerCase()
  ) {

    return {
      reserveA: r0,
      reserveB: r1
    };

  } else {

    return {
      reserveA: r1,
      reserveB: r0
    };

  }
}

/* ================= SIMULATE PATH ================= */

async function simulatePath(
  factoryAddr,
  amountIn,
  path
) {

  let currentAmount =
    amountIn;

  for (
    let i = 0;
    i < path.length - 1;
    i++
  ) {

    const reserves =
      await getReserves(
        factoryAddr,
        path[i],
        path[i + 1]
      );

    if (!reserves)
      return null;

    currentAmount =
      getAmountOut(
        currentAmount,
        reserves.reserveA,
        reserves.reserveB
      );
  }

  return currentAmount;
}

/* ================= FIND BEST ================= */

async function findBest() {

  console.log(
    "\n🔍 Scanning all DEX combinations..."
  );

  const dexList =
    Object.entries(FACTORIES);

  const tokens =
    Object.values(TOKENS)
      .filter(
        t => t !== TOKENS.USDC
      );

  const hopTokens =
    [TOKENS.WETH, TOKENS.WMATIC];

  let best = null;
  let bestProfit = 0n;

  for (
    const [nameA, factoryA]
    of dexList
  ) {

    for (
      const [nameB, factoryB]
      of dexList
    ) {

      if (nameA === nameB)
        continue;

      for (const token of tokens) {

        /* ===== DYNAMIC LIQUIDITY POSITION SIZE ===== */

        const reserves =
          await getReserves(
            factoryA,
            TOKENS.USDC,
            token
          );

        if (!reserves)
          continue;

        const tradeSize =
          reserves.reserveA / 500n;

        if (tradeSize <= 0n)
          continue;

        /* ===== DIRECT PATH ===== */

        const directPath =
          [TOKENS.USDC, token];

        const tokenOut =
          await simulatePath(
            factoryA,
            tradeSize,
            directPath
          );

        if (!tokenOut)
          continue;

        const usdcBack =
          await simulatePath(
            factoryB,
            tokenOut,
            [token, TOKENS.USDC]
          );

        if (!usdcBack)
          continue;

        const profit =
          usdcBack - tradeSize;

        console.log(
          `Checked ${nameA}->${nameB} direct`,
          ethers.formatUnits(
            profit,
            6
          )
        );

        if (profit > bestProfit) {

          bestProfit = profit;

          best = {
            buy: nameA,
            sell: nameB,
            tradeSize,
            token,
            pathToToken:
              directPath,
            pathToUSDC:
              [token, TOKENS.USDC]
          };
        }

        /* ===== HOP PATHS ===== */

        for (const hop of hopTokens) {

          if (hop === token)
            continue;

          const buyPath = [
            TOKENS.USDC,
            hop,
            token
          ];

          /* 🔑 FIX:
             pathToUSDC[0]
             MUST MATCH
             pathToToken[last]
          */

          const sellPath = [
            token,
            hop,
            TOKENS.USDC
          ];

          const hopTokenOut =
            await simulatePath(
              factoryA,
              tradeSize,
              buyPath
            );

          if (!hopTokenOut)
            continue;

          const hopBack =
            await simulatePath(
              factoryB,
              hopTokenOut,
              sellPath
            );

          if (!hopBack)
            continue;

          const hopProfit =
            hopBack - tradeSize;

          console.log(
            `Checked ${nameA}->${nameB} via hop`,
            ethers.formatUnits(
              hopProfit,
              6
            )
          );

          if (
            hopProfit > bestProfit
          ) {

            bestProfit =
              hopProfit;

            best = {
              buy: nameA,
              sell: nameB,
              tradeSize,
              token,
              pathToToken:
                buyPath,
              pathToUSDC:
                sellPath
            };
          }
        }
      }
    }
  }

  return {
    best,
    bestProfit
  };
}

/* ================= EXECUTE ================= */

async function execute(best) {

  if (!best) {

    console.log(
      "No profitable route"
    );

    return;
  }

  console.log("\n🔥 BEST FOUND");

  console.log(
    "BUY:",
    best.buy
  );

  console.log(
    "SELL:",
    best.sell
  );

  console.log(
    "TRADE SIZE:",
    ethers.formatUnits(
      best.tradeSize,
      6
    )
  );

  console.log(
    "PATH TO TOKEN:",
    best.pathToToken
  );

  console.log(
    "PATH TO USDC:",
    best.pathToUSDC
  );

  /* 🟢 FIX:
     SET MINIMUM PROFIT TO 0
  */

  const currentMinimum =
    await contract.minimumProfitUSDC();

  console.log(
    "\n🟢 CURRENT MINIMUM PROFIT:",
    ethers.formatUnits(
      currentMinimum,
      6
    )
  );

  if (currentMinimum > 0n) {

    console.log(
      "🟢 SETTING MINIMUM PROFIT TO 0"
    );

    const setTx =
      await contract.setMinimumProfitUSDC(
        0
      );

    await setTx.wait();

    console.log(
      "✅ MINIMUM PROFIT UPDATED"
    );
  }

  const deadline =
    Math.floor(Date.now()/1000)
    + 60;

  const tx =
    await contract.executeAaveFlashLoanArbitrage(
      FACTORIES[best.buy],
      FACTORIES[best.sell],
      best.tradeSize,
      best.pathToToken,
      best.pathToUSDC,
      deadline
    );

  console.log(
    "TX:",
    tx.hash
  );

  await tx.wait();

  console.log(
    "✅ EXECUTED"
  );
}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log(
    "\n🚀 MULTI-DEX DEPTH BOT STARTED"
  );

  while (true) {

    const {
      best,
      bestProfit
    } =
      await findBest();

    if (bestProfit > 0n) {

      await execute(best);

    } else {

      console.log(
        "No arbitrage found"
      );
    }

    await new Promise(
      r => setTimeout(r, 5000)
    );
  }
}

main();
