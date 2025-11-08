import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────────────────────────────────────
// SIMPLE COLOR UTILS (replaces chalk)
// ─────────────────────────────────────────────
const color = {
  cyan: (t) => `\x1b[36m${t}\x1b[0m`,
  green: (t) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  gray: (t) => `\x1b[90m${t}\x1b[0m`,
  magenta: (t) => `\x1b[35m${t}\x1b[0m`,
};

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

// RPC & Wallet
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY in environment");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Arbitrage Contract (hard-coded)
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43".toLowerCase();

// Routers (DEXs)
const ROUTERS = {
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  QuickSwap: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
  JetSwap: "0x6b3d817814eabc984d51896b1015c0b89e9737ca",
};

// Tokens
const TOKENS = {
  AAVE:{address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",decimals:18},
  APE:{address:"0x4d224452801aced8b2f0aebe155379bb5d594381",decimals:18},
  AXLUSDC:{address:"0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159",decimals:6},
  BETA:{address:"0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde",decimals:18},
  BONE:{address:"0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e",decimals:18},
  CRV:{address:"0x172370d5cd63279efa6d502dab29171933a610af",decimals:18},
  DAI:{address:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",decimals:18},
  DPI:{address:"0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b",decimals:18},
  FND:{address:"0x292c4eefdda27062049d44d4730d5fe774b5f4c7",decimals:18},
  FREE:{address:"0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238",decimals:18},
  KLIMA:{address:"0x4e78011ce80ee02d2c3e649fb657e45898257815",decimals:9},
  LDO:{address:"0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4",decimals:18},
  LINK:{address:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",decimals:18},
  MATICX:{address:"0xa3fa99a148fa48d14ed51d610c367c61876997f1",decimals:18},
  OS:{address:"0xd3a691c852cdb01e281545a27064741f0b7f6825",decimals:18},
  QUICK:{address:"0x831753dd7087cac61ab5644b308642cc1c33dc13",decimals:18},
  RNDR:{address:"0x6c3c7886b43d005db8c28a09e8038b87e36cf26c",decimals:18},
  SHIB:{address:"0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",decimals:18},
  SHIKIGON:{address:"0x3f0fb6e42d160a8def49fe68b8ef4d8a5b7ab119",decimals:18},
  SURE:{address:"0xf638a9594c0c780d6c8bc40fa33efb0ceabf5d57",decimals:18},
  THE7:{address:"0x045f7ffdcc8334e78316a2c1164efb2e5f3815d5",decimals:18},
  TRADE:{address:"0x82362ec182db3cf7829014bc61e9be8a2e82868a",decimals:18},
  UNI:{address:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",decimals:18},
  UNI2:{address:"0xb33eaad8d922b1083446dc23f610c2567fb5180f",decimals:18},
  USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6},
  USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
  WBTC:{address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",decimals:8},
  WETH:{address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",decimals:18},
  XSGD:{address:"0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0",decimals:6},
};

// Base currency & parameters
const USDC = TOKENS.USDC.address;
const TRADE_AMOUNT_USDC = 100n * 1_000_000n;
const MIN_PROFIT_USDC = 10_000n; // 0.01 USDC

// ─────────────────────────────────────────────
// ABIs
// ─────────────────────────────────────────────
const UNISWAP_V2_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];
const ARB_CONTRACT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function fmt(num, dec = 6) {
  return (Number(num) / 10 ** dec).toFixed(4);
}
function now() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────
// CORE LOGIC
// ─────────────────────────────────────────────
async function scanToken(symbol, token, routers, arbContract) {
  const results = [];
  const buyPaths = [
    [USDC, token.address],
    [USDC, TOKENS.WETH.address, token.address],
  ];
  const sellPaths = [
    [token.address, USDC],
    [token.address, TOKENS.WETH.address, USDC],
  ];

  for (const [buyName, buyAddr] of Object.entries(routers)) {
    const buyRouter = new ethers.Contract(buyAddr, UNISWAP_V2_ABI, provider);
    for (const [sellName, sellAddr] of Object.entries(routers)) {
      if (buyName === sellName) continue;
      const sellRouter = new ethers.Contract(sellAddr, UNISWAP_V2_ABI, provider);

      try {
        let buyOut;
        for (const path of buyPaths) {
          try {
            const out = await buyRouter.getAmountsOut(TRADE_AMOUNT_USDC, path);
            buyOut = out[out.length - 1];
            break;
          } catch {}
        }
        if (!buyOut) throw new Error("No buy route");

        let sellOut;
        for (const path of sellPaths) {
          try {
            const out = await sellRouter.getAmountsOut(buyOut, path);
            sellOut = out[out.length - 1];
            break;
          } catch {}
        }
        if (!sellOut) throw new Error("No sell route");

        const profit = sellOut - TRADE_AMOUNT_USDC;
        if (profit > 0n) {
          const profitUSD = fmt(profit, 6);
          results.push({ symbol, buyName, sellName, profitUSD });
          console.log(
            `${color.cyan(`[${symbol}]`)} 💱 ${buyName}→${sellName} | Buy: $${fmt(TRADE_AMOUNT_USDC)} → Sell: $${fmt(sellOut)} | Profit: ${color.green(`+$${profitUSD}`)}`
          );

          // Execute if above threshold
          if (profit > MIN_PROFIT_USDC) {
            console.log(color.yellow(`⚡ Executing arbitrage for ${symbol} (${buyName}→${sellName})...`));
            const tx = await arbContract.executeArbitrage(buyAddr, sellAddr, token.address, TRADE_AMOUNT_USDC, { gasLimit: 1_500_000 });
            console.log(`⛓️ TX: ${tx.hash}`);
          }
        }
      } catch (err) {
        console.log(color.gray(`[${symbol}] ⚠️ ${buyName}→${sellName}: ${err.message}`));
      }
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────
async function main() {
  const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_CONTRACT_ABI, wallet);

  console.log(`🔗 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`💰 Trade Amount: $${fmt(TRADE_AMOUNT_USDC, 6)}`);
  console.log(`📈 Min Profit: $${fmt(MIN_PROFIT_USDC, 6)}`);
  console.log(`🔧 Using Routers: ${Object.keys(ROUTERS).join(", ")}`);

  while (true) {
    console.log(`\n🕒 ${now()} ▸ Scanning tokens...`);
    for (const [symbol, token] of Object.entries(TOKENS)) {
      if (symbol === "USDC") continue;
      await scanToken(symbol, token, ROUTERS, arbContract);
    }
    console.log(color.magenta(`Cycle complete — restarting scan...\n`));
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ─────────────────────────────────────────────
// ENTRY
// ─────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
