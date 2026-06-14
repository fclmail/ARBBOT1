import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   HIGH-SPEED POLLING ENGINE SETUP (NO REGISTRATION)
========================================================= */
const HTTP_ENDPOINT = "https://polygon.drpc.org"; // Fast, resilient public endpoint

console.log("⏳ Initializing High-Speed Provider Engine...");
const provider = new ethers.JsonRpcProvider(HTTP_ENDPOINT);

// Force the engine to query the network every 200ms instead of standard 4-second defaults
provider.pollingInterval = 200;

// Instantly test connection capability and fire up the bot
provider.getBlockNumber()
  .then((blockNum) => {
    console.log(`🟢 CONNECTED TO ENGINE → Current Polygon Block: #${blockNum}`);
    startStreamingBot();
  })
  .catch((err) => {
    console.error("❌ CONNECTION FAILURE:", err.message);
    process.exit(1);
  });

/* =========================================================
   WALLET & ARBITRAGE SMART CONTRACT CONFIGURATION
========================================================= */
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const ARB_CONTRACT = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const ABI = [
  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256) external",
  "function setMinimumProfitUSDC(uint256) external",
  "function minimumProfitUSDC() view returns(uint256)"
];

const contract = new ethers.Contract(ARB_CONTRACT, ABI, wallet);

/* =========================================================
   TOKENS & DEX LIST ROUTING CONFIGURATION
========================================================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
   AVAX:    "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b",
FET:     "0x7583feddbcefa813dc18259940f76a02710a8905",
INJ:     "0x4e8dc2149eac3f3def36b1c281ea466338249371",
RNDR:    "0x61299774020da444af134c82fa83e3810b309991",
UNI:     "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
PYUSD0:  "0x99af3eea856556646c98c8b9b2548fe815240750",
PAXG:    "0x553d3d295e0f695b9228246232edf400ed3560b5",
SXP:     "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
POLY:    "0xcb059c5573646047d6d88dddb87b745c18161d3b",
CHZ:     "0xf1938ce12400f9a761084e7a80d37e732a4da056",
SHIB:    "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec",
CRVUSD:  "0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6",
APE:     "0xB7b31a6BC18e48888545CE79e83E06003bE70930",
ZRO:     "0x6985884c4392d348587b19cb9eaaf157f13271cd",
CRV:     "0x172370d5cd63279efa6d502dab29171933a610af",
LDO:     "0xc3c7d422809852031b44ab29eec9f1eff2a58756",
APEPE:   "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a",
STG:     "0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590",
SAND:    "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",
TUSD:    "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
USDQ:    "0xb291996477504506bf5f583102b5b5ea5d1e40e0",
FRXUSD:  "0x80eede496655fb9047dd39d9f418d5483ed600df",
SUSHI:   "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a",
GRT:     "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
LPT:     "0x3962f4a0a0051dcce0be73a7e09cef5756736712",
PAX:     "0x6f3b3286fd86d8b47ec737ceb3d0d354cc657b3e",
AUSD:"0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
BAT:"0x3cef98bb43d732e2f285ee605a8158cde967d219",
TBTC:"0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
MANA:"0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
TRB:"0xe3322702bedaaed36cddab233360b939775ae5f1",
COMP:"0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
1INCH:"0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
THETA:"0xb46e0ae620efd98516f49bb00263317096c114b2",
CRO:"0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
XYO:"0xd2507e7b5794179380673870d88b22f94da6abe0",
MASK:"0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7",
EURQ:"0xd571edb2ef29df10fcd6200fd6d0ed2389983db3",
APOLUSDT:"0x6ab707aca953edaefbc4fd23ba73294241490620",
ENJ:"0x7ec26842f195c852fa843bb9f6d8b583a274a157",
ZRX:"0x5559edb74751a0ede9dea4dc23aee72cca6be3d5",
GMT:"0x714db550b574b3e927af3d93e26127d15721d4c2",
SNX:"0x50b728d8d964fd00c2d0aad81718b71311fef68a",
ANKR:"0x101a023270368c0d50bffb62780f4afd4ea79c35",
GLM:"0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
COW:"0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
BAND:"0xa8b1e0764f85f53dfe21760e8afe5446d82606ac",
AXL:"0x6e4e624106cb12e168e6533f8ec7c82263358940",
UMA:"0x3066818837c5e6ed6601bd5a91b0762877a6b731",
YFI:"0xda537104d6a5edd53c6fbba9a898708e465260b6",
ELON:"0xe0339c80ffde91f3e20494df88d4206d86024cdf",
NEXO:"0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
EURAU:"0x4933A85b5b5466Fbaf179F72D3DE273c287EC2c2",
ORDER:"0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
IOTX:"0xf6372cdb9c1d3674e83842e3800f2a62ac9f3c66",
AMP:"0x0621d647cecbfb64b79e44302c1933cb4f27054d",
CBK:"0x4EC203dD0699Fac6adAF483CDd2519BC05D2c573",
ACX:"0xf328b73b6c685831f238c30a23fc19140cb4d8fc",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const FACTORIES = {
  QUICK: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  SUSHI: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
  APE: "0xcf083be4164828f00cae704ec15a36d711491284",
  DFYN: "0xe7fb3e833efe5f9c441105eb65ef8b261266423b"
};

const ROUTERS = {
  QUICK: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SUSHI: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  APE: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  DFYN: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

const FACTORY_ABI = ["function getPair(address,address) view returns(address)"];
const PAIR_ABI = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];

/* =========================================================
   GAS & EXECUTION PROPERTIES
========================================================= */
const GAS_LIMIT = 3000000n;
const PRIORITY_GWEI = "120";
const MAX_GWEI = "300";
const MIN_PROFIT = 1n; // Tracks raw micro-USDC differences

/* =========================================================
   PRICING UTILITIES & MATHEMATICAL EQUATIONS
========================================================= */
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

async function getReserves(factoryAddr, tokenA, tokenB) {
  try {
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
    const pairAddr = await factory.getPair(tokenA, tokenB);
    if (pairAddr === ethers.ZeroAddress) return null;

    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const reserves = await pair.getReserves();
    const token0 = await pair.token0();

    if (token0.toLowerCase() === tokenA.toLowerCase()) {
      return { reserveA: reserves[0], reserveB: reserves[1] };
    } else {
      return { reserveA: reserves[1], reserveB: reserves[0] };
    }
  } catch {
    return null;
  }
}

async function simulatePath(factoryAddr, amountIn, path) {
  let currentAmount = amountIn;
  for (let i = 0; i < path.length - 1; i++) {
    const reserves = await getReserves(factoryAddr, path[i], path[i + 1]);
    if (!reserves) return null;
    currentAmount = getAmountOut(currentAmount, reserves.reserveA, reserves.reserveB);
  }
  return currentAmount;
}

/* =========================================================
   OPPORTUNITY AGGREGATOR CALCULATOR
========================================================= */
async function findBest() {
  const dexList = Object.entries(FACTORIES);
  const tokens = Object.values(TOKENS).filter(t => t !== TOKENS.USDC);
  const hopTokens = [TOKENS.WETH, TOKENS.WMATIC];

  let best = null;
  let bestProfit = 0n;

  for (const [nameA, factoryA] of dexList) {
    for (const [nameB, factoryB] of dexList) {
      if (nameA === nameB) continue;

      for (const token of tokens) {
        const reserves = await getReserves(factoryA, TOKENS.USDC, token);
        if (!reserves) continue;

        const tradeSize = reserves.reserveA / 1000n;
        if (tradeSize <= 0n) continue;

        // DIRECT MATCH SIMULATION
        const directPath = [TOKENS.USDC, token];
        const tokenOut = await simulatePath(factoryA, tradeSize, directPath);
        if (!tokenOut) continue;

        const usdcBack = await simulatePath(factoryB, tokenOut, [token, TOKENS.USDC]);
        if (!usdcBack) continue;

        const profit = usdcBack - tradeSize;
        if (profit > bestProfit) {
          bestProfit = profit;
          best = {
            buy: nameA,
            sell: nameB,
            tradeSize,
            token,
            pathToToken: directPath,
            pathToUSDC: [token, TOKENS.USDC],
            isHop: false
          };
        }

        // HOP ROUTE SIMULATION
        for (const hop of hopTokens) {
          if (hop === token) continue;

          const buyPath = [TOKENS.USDC, hop, token];
          const sellPath = [token, hop, TOKENS.USDC];

          const hopOut = await simulatePath(factoryA, tradeSize, buyPath);
          if (!hopOut) continue;

          const hopBack = await simulatePath(factoryB, hopOut, sellPath);
          if (!hopBack) continue;

          const hopProfit = hopBack - tradeSize;
          if (hopProfit > bestProfit) {
            bestProfit = hopProfit;
            best = {
              buy: nameA,
              sell: nameB,
              tradeSize,
              token,
              pathToToken: buyPath,
              pathToUSDC: sellPath,
              isHop: true
            };
          }
        }
      }
    }
  }
  return { best, bestProfit };
}

/* =========================================================
   TRANSACTION SUBMISSION HANDLER
========================================================= */
async function execute(best) {
  try {
    const minimum = await contract.minimumProfitUSDC();
    if (minimum > 0n) {
      const tx = await contract.setMinimumProfitUSDC(0);
      await tx.wait();
    }
  } catch (err) {}

  console.log("⚡ Dispatching arbitrage transaction payload to mempool...");

  try {
    const tx = await contract.executeAaveFlashLoanArbitrage(
      ROUTERS[best.buy],
      ROUTERS[best.sell],
      best.tradeSize,
      best.pathToToken,
      best.pathToUSDC,
      Math.floor(Date.now() / 1000) + 60,
      {
        gasLimit: GAS_LIMIT,
        maxPriorityFeePerGas: ethers.parseUnits(PRIORITY_GWEI, "gwei"),
        maxFeePerGas: ethers.parseUnits(MAX_GWEI, "gwei"),
        nonce: await provider.getTransactionCount(wallet.address, "pending")
      }
    );

    await tx.wait(1);
    console.log(`🟢 Transaction Confirmed! Tx Hash: ${tx.hash}`);
    console.log("📈 Net PnL realized on-chain.");
  } catch (txError) {
    console.log("❌ Transaction dropped or reverted by node mempool.");
  }
}

/* =========================================================
   MAIN BOT ENGINE STREAM EVENT LISTENER
========================================================= */
async function startStreamingBot() {
  console.log("\n🚀 MULTI-DEX STREAMING BOT STARTED");

  provider.on("block", async (blockNumber) => {
    console.log(`\n📦 NEW BLOCK MINED: #${blockNumber} | SCANNING FOR OPPORTUNITIES...`);

    try {
      const { best, bestProfit } = await findBest();

      if (bestProfit >= MIN_PROFIT) {
        console.log(`💰 PROFIT OPPORTUNITY GENERATED: ${ethers.formatUnits(bestProfit, 6)} USDC`);
        
        const tokenName = Object.keys(TOKENS).find(key => TOKENS[key] === best.token) || "UNKNOWN";
        console.log(`[DEX PATH]: ${best.buy} (USDC -> ${tokenName}) ➡️ ${best.sell} (${tokenName} -> USDC)`);
        
        await execute(best);
      } else {
        console.log("⏱️ Scan Finished. No profitable variations found in this block.");
      }
    } catch (err) {
      console.log("\n❌ STREAM EXECUTION ERROR:");
      console.log(err.reason || err.message || err);
    }
  });
}
