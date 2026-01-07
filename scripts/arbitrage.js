import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const TRADE_AMOUNT_USDC = 0.17;
const MIN_PROFIT_USDC  = 0.00001;
const SLIPPAGE_BUFFER  = 5; // %
const SCAN_INTERVAL_MS = 8000;
const DRY_RUN = false;

/* =====================================================
   DEXES
===================================================== */

const DEXES = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "ApeSwap",   address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
];

const TOKENS = [
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
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
      UNI2:{address:"0xb33eaad8d922b1083446dc23f610c2567fb5180f",decimals:18}, // separate key
      USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6},
      USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
  { symbol: "CRV",  address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 }
];

/* =====================================================
   ABIS
===================================================== */

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const ARB_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256) external"
];

/* =====================================================
   SETUP
===================================================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

const arb  = new ethers.Contract(VAULT_ADDRESS, ARB_ABI, wallet);
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);

for (const d of DEXES) {
  d.router = new ethers.Contract(d.address, ROUTER_ABI, provider);
}

let EXECUTING = false;

/* =====================================================
   HELPERS
===================================================== */

function log(msg, ok = false) {
  console.log(ok ? `\x1b[32m${msg}\x1b[0m` : msg);
}

async function vaultUSDC() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
}

async function walletMATIC() {
  return Number(ethers.formatEther(await provider.getBalance(wallet.address)));
}

function buyPaths(token) {
  return [
    [USDC, token],
    [USDC, WMATIC, token],
    [USDC, WETH, token]
  ];
}

function sellPaths(token) {
  return [
    [token, USDC],
    [token, WMATIC, USDC],
    [token, WETH, USDC]
  ];
}

/* =====================================================
   EXECUTION
===================================================== */

async function execute(best) {
  if (EXECUTING) return;
  EXECUTING = true;

  try {
    const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
    const deadline = Math.floor(Date.now() / 1000) + 60;

    await arb.executeArbitrage.staticCall(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      best.minTokenOut,
      best.minUSDCOut,
      deadline
    );

    log("🟢 Simulation PASSED", true);
    log(`📈 Buy Price : ${best.buyPrice.toFixed(6)}`);
    log(`📉 Sell Price: ${best.sellPrice.toFixed(6)}`);
    log(`💰 Expected Profit: ${best.profit.toFixed(6)} USDC`);

    if (DRY_RUN) return;

    const gas = await arb.executeArbitrage.estimateGas(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      best.minTokenOut,
      best.minUSDCOut,
      deadline
    );

    const tx = await arb.executeArbitrage(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      best.minTokenOut,
      best.minUSDCOut,
      deadline,
      { gasLimit: gas * 120n / 100n }
    );

    log(`🚀 TX SENT ${tx.hash}`, true);
    await tx.wait();

  } catch {
    log("❌ EXECUTION SKIPPED (slippage / MEV / fees)");
  } finally {
    EXECUTING = false;
  }
}

/* =====================================================
   SCANNER
===================================================== */

async function scan(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
  let best = null;

  for (const buy of DEXES) {
    for (const sell of DEXES) {
      if (buy === sell) continue;

      for (const bp of buyPaths(token.address)) {
        let bought;
        try {
          bought = (await buy.router.getAmountsOut(amountIn, bp)).at(-1);
        } catch { continue; }

        const buyPrice =
          TRADE_AMOUNT_USDC / Number(ethers.formatUnits(bought, token.decimals));

        const minTokenOut =
          bought * BigInt(100 - SLIPPAGE_BUFFER) / 100n;

        for (const sp of sellPaths(token.address)) {
          let sold;
          try {
            sold = (await sell.router.getAmountsOut(bought, sp)).at(-1);
          } catch { continue; }

          const sellUSDC = Number(ethers.formatUnits(sold, 6));
          const sellPrice =
            sellUSDC / Number(ethers.formatUnits(bought, token.decimals));

          const minUSDCOut =
            sold * BigInt(100 - SLIPPAGE_BUFFER) / 100n;

          const profit = sellUSDC - TRADE_AMOUNT_USDC;

          log(
            `${token.symbol} ${buy.name}→${sell.name} | Buy ${buyPrice.toFixed(6)} | Sell ${sellPrice.toFixed(6)} | Profit ${profit.toFixed(6)}`,
            profit > 0
          );

          if (profit > MIN_PROFIT_USDC) {
            if (!best || profit > best.profit) {
              best = {
                token,
                buy,
                sell,
                profit,
                buyPrice,
                sellPrice,
                minTokenOut,
                minUSDCOut
              };
            }
          }
        }
      }
    }
  }

  if (best) {
    log(`💰 BEST ${best.token.symbol} PROFIT ${best.profit.toFixed(6)}`, true);
    await execute(best);
  }
}

/* =====================================================
   MAIN LOOP
===================================================== */

async function main() {
  log("⏱ ARB BOT STARTED");
  while (true) {
    try {
      log(`🏦 Vault USDC : ${await vaultUSDC()}`);
      log(`⛽ Wallet MATIC: ${await walletMATIC()}`);
      for (const t of TOKENS) {
        await scan(t);
      }
    } catch (e) {
      log(`❌ ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
