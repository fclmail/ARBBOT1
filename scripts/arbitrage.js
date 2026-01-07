// scripts/arbitrage.js  
// Prerequisites: Node.js v18+, ethers, dotenv  
// This script preserves your existing arbJS features and adds:  
// - wallet USDC and native MATIC balances display  
// - total profit display per executed arb (green when profitable)  
// - enhanced debug logging for successful and failed executions  

import { ethers } from "ethers";  
import "dotenv/config";  

/* ================= CONFIG ================= */  

const RPC = "https://polygon-bor-rpc.publicnode.com";  
const provider = new ethers.JsonRpcProvider(RPC);  

const PRIVATE_KEY = process.env.PRIVATE_KEY;  
if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY in .env");  

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);  

const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";  
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";  

const TRADE_USDC = 0.03;  
const JS_MIN_PROFIT = 0.00002; // in USDC (6 decimals)  
const SLIPPAGE_BPS = 200;  
const INTERVAL = 8000;  

/* ================= DEXES ================= */  

const DEXES = [  
  { name: "QuickSwap", addr: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },  
  { name: "SushiSwap", addr: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },  
  { name: "ApeSwap",   addr: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }  
];  

/* ================= TOKENS ================= */  

const TOKENS = [  
  { sym:"CRV",  addr:"0x172370d5cd63279efa6d502dab29171933a610af", dec:18 },
  { sym:"APE",      addr:"0x4d224452801aced8b2f0aebe155379bb5d594381", dec:18 },
  { sym:"AXLUSDC",  addr:"0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", dec:6  },
  { sym:"BETA",     addr:"0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde", dec:18 },
  { sym:"BONE",     addr:"0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e", dec:18 },
  { sym:"CRV",      addr:"0x172370d5cd63279efa6d502dab29171933a610af", dec:18 },
  { sym:"DAI",      addr:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", dec:18 },
  { sym:"DPI",      addr:"0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b", dec:18 },
  { sym:"FND",      addr:"0x292c4eefdda27062049d44d4730d5fe774b5f4c7", dec:18 },
  { sym:"FREE",     addr:"0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238", dec:18 },
  { sym:"KLIMA",    addr:"0x4e78011ce80ee02d2c3e649fb657e45898257815", dec:9  },
  { sym:"LDO",      addr:"0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4", dec:18 },
  { sym:"LINK",     addr:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec:18 },
  { sym:"MATICX",   addr:"0xa3fa99a148fa48d14ed51d610c367c61876997f1", dec:18 },
  { sym:"OS",       addr:"0xd3a691c852cdb01e281545a27064741f0b7f6825", dec:18 },
  { sym:"QUICK",    addr:"0x831753dd7087cac61ab5644b308642cc1c33dc13", dec:18 },
  { sym:"RNDR",     addr:"0x6c3c7886b43d005db8c28a09e8038b87e36cf26c", dec:18 },
  { sym:"SHIB",     addr:"0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0", dec:18 },
  { sym:"SHIKIGON", addr:"0x3f0fb6e42d160a8def49fe68b8ef4d8a5b7ab119", dec:18 },
  { sym:"SURE",     addr:"0xf638a9594c0c780d6c8bc40fa33efb0ceabf5d57", dec:18 },
  { sym:"THE7",     addr:"0x045f7ffdcc8334e78316a2c1164efb2e5f3815d5", dec:18 },
  { sym:"TRADE",    addr:"0x82362ec182db3cf7829014bc61e9be8a2e82868a", dec:18 },
  { sym:"UNI",      addr:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", dec:18 },
  { sym:"UNI2",     addr:"0xb33eaad8d922b1083446dc23f610c2567fb5180f", dec:18 },
  { sym:"USDC",     addr:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174", dec:6  },
  { sym:"USDT",     addr:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f", dec:6  },
  { sym:"WBTC",     addr:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", dec:8  },
  { sym:"WETH",     addr:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", dec:18 },
  { sym:"LINK", addr:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec:18 },  
  { sym:"AAVE", addr:"0x7FcC5A7dA2c3f6b5E0b3b9a6b1b7a8e8d8c8a4f", dec:18 } // replace with real token if needed  
];  

/* ================= ABIS ================= */  

const ROUTER_ABI = [  
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"  
];  

const ERC20_ABI = [  
  "function balanceOf(address) view returns (uint256)",  
  "function approve(address spender, uint256 amount) external returns (bool)",  
  "function allowance(address owner, address spender) external view returns (uint256)"  
];  

const VAULT_ABI = [  
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256) external"  
];  

/* ================= SETUP ================= */  

const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);  
const usdc  = new ethers.Contract(USDC, ERC20_ABI, wallet);  

for (const d of DEXES) {  
  d.router = new ethers.Contract(d.addr, ROUTER_ABI, provider);  
}  

/* ================= HELPERS ================= */  

const toUSDC = v => Number(ethers.formatUnits(v, 6));  
const toToken = (v, dec) => Number(ethers.formatUnits(v, dec));  
const usdcAmount = amount => ethers.utils.parseUnits(amount.toFixed(6), 6);  
const applySlip = v => {  
  // v is a uint256 amount for token or usdc; apply slippage as (value * (10000 - SLIPPAGE_BPS)) / 10000  
  // use bigint arithmetic to avoid precision issues  
  const num = BigInt(v);  
  const scaled = (num * BigInt(10000 - SLIPPAGE_BPS)) / BigInt(10000);  
  return scaled;  
};  

let EXECUTING = false;  

/* ================= DISPLAY HELPERS ================= */  

async function displayBalances() {  
  // Wallet native balance (MATIC on Polygon)  
  const nativeBal = await provider.getBalance(wallet.address);  
  const nativeEth = ethers.formatEther(nativeBal);  

  // Wallet USDC balance (on vault's address) - i.e., wallet's USDC balance, not vault  
  const walletUSDCBalRaw = await usdc.balanceOf(wallet.address);  
  const walletUSDCBal = toUSDC(walletUSDCBalRaw);  

  // Vault USDC balance (already in logs, but display again)  
  const vaultUSDCBalRaw = await usdc.balanceOf(VAULT);  
  const vaultUSDCBal = toUSDC(vaultUSDCBalRaw);  

  console.log(`💠 Wallet MATIC balance: ${Math.max(parseFloat(nativeEth), 0).toFixed(6)} MATIC`);  
  console.log(`💠 Wallet USDC balance: ${walletUSDCBal.toFixed(6)} USDC`);  
  console.log(`💠 Vault USDC balance: ${vaultUSDCBal.toFixed(6)} USDC`);  
}  

/* ================= SCAN ================= */  

async function scan() {  
  if (EXECUTING) return;  
  try {  
    // Display wallet balances at the start of each cycle  
    await displayBalances();  

    // Vault USDC available for trades  
    const vaultBalRaw = await usdc.balanceOf(VAULT);  
    const vaultBal = toUSDC(vaultBalRaw);  
    console.log(`🔎 Vault available USDC: ${vaultBal.toFixed(6)} USDC`);  

    for (const t of TOKENS) {  
      for (const buy of DEXES) {  
        for (const sell of DEXES) {  
          if (buy.addr === sell.addr) continue;  

          // BUY LEG: USDC -> token  
          let buyOut;  
          try {  
            buyOut = await buy.router.getAmountsOut(usdcAmount(TRADE_USDC), [USDC, t.addr]);  
          } catch (e) {  
            console.error(`⚠️ BUY GET AMOUNTS OUT FAILED for ${t.sym} ${buy.name} seeking ${t.addr} from USDC:`, e?.message ?? e);  
            continue;  
          }  

          const tokenRaw = buyOut[buyOut.length - 1];  
          const tokenVal = toToken(tokenRaw, t.dec);  

          // Basic guard: ensure token amount makes sense  
          if (tokenVal < 1e-6) {  
            console.log(`ℹ️ SKIP: ${t.sym} token received too small: ${tokenVal}`);  
            continue;  
          }  

          // SELL LEG: token -> USDC  
          let sellOut;  
          try {  
            sellOut = await sell.router.getAmountsOut(tokenRaw, [t.addr, USDC]);  
          } catch (e) {  
            console.error(`⚠️ SELL GET AMOUNTS OUT FAILED for ${t.sym} ${sell.name} seeking ${USDC}:`, e?.message ?? e);  
            continue;  
          }  

          const usdcOutRaw = sellOut[sellOut.length - 1];  
          const usdcOut = toUSDC(usdcOutRaw);  

          const potentialProfit = usdcOut - TRADE_USDC;  
          // Display detailed per-trade sim results  
          console.log(  
            `[SIM] ${t.sym} ${buy.name}→${sell.name} | buy:${tokenVal.toFixed(6)} sell:${usdcOut.toFixed(6)} profit:${potentialProfit.toFixed(6)} | vault:${vaultBal.toFixed(4)}`  
          );  

          // Check profitability against minimum  
          if (potentialProfit < JS_MIN_PROFIT) {  
            continue;  
          }  

          // Optional: ensure vault has enough USDC for the trade  
          const vaultBalNow = toUSDC(await usdc.balanceOf(VAULT));  
          if (vaultBalNow < TRADE_USDC) {  
            console.log(`⚠️ SKIP: Vault insufficient USDC. Needed ${TRADE_USDC}, have ${vaultBalNow}`);  
            continue;  
          }  

          // Optional: ensure USDC allowance from vault to Router if needed (depends on vault logic)  
          // For safety, ensure vault has access to take USDC if that's how executeArbitrage works.  
          // You may uncomment below if your vault relies on pulling USDC from itself or allowance setup.  
          // try { /* allowance checks / approves here if required */ } catch (e) { /* proceed */ }  

          // Ready to execute arbitrage  
          console.log(`🚀 EXECUTING: ${t.sym} ${buy.name}→${sell.name} with ${TRADE_USDC} USDC`);  
          const deadline = Math.floor(Date.now() / 1000) + 120;  

          try {  
            const tx = await vault.executeArbitrage(  
              buy.addr,  
              sell.addr,  
              t.addr,  
              usdcAmount(TRADE_USDC),  
              usdcAmount(tokenRaw) /* minTokenOut: token, using raw tokenOut as a baseline may be adjusted */,  
              usdcAmount(usdcOut) /* minUSDCOut: target USDC amount, approximated */,  
              deadline  
            );  
            console.log(`✅ TX SENT: ${tx.hash}`);  
            const receipt = await tx.wait();  
            console.log(`✅ TX CONFIRMED in block ${receipt.blockNumber}`);  

            // After execution, recompute wallet balances and profit  
            // Profit in vault is tracked on-chain; display wallet balances and total profit delta if possible  
            const walletUSDCBalRaw = await usdc.balanceOf(wallet.address);  
            const walletUSDCBal = toUSDC(walletUSDCBalRaw);  

            const vaultBalPostRaw = await usdc.balanceOf(VAULT);  
            const vaultBalPost = toUSDC(vaultBalPostRaw);  

            // Optional: compute total profit delta if you track an initial baseline  
            // For simplicity, show current wallet USDC and vault balance  
            console.log(`💠 Wallet USDC balance: ${walletUSDCBal.toFixed(6)} USDC`);  
            console.log(`💠 Vault USDC balance (after): ${vaultBalPost.toFixed(6)} USDC`);  

            // Colorize profit display if positive
            const profitDelta = usdcOut - TRADE_USDC; // simplistic delta from simulation
            const profitColor = profitDelta >= 0 ? "\x1b[32m" : "\x1b[31m";
            const profitReset = "\x1b[0m";

            console.log(`💹 Profit delta: ${profitColor}${profitDelta.toFixed(6)} USDC${profitReset}`);
            // If profitable, display in green and log success
            if (profitDelta >= 0) {
              console.log("✅ ARBITRAGE POTENTIAL PROFITABLE. EXECUTING RESULT LOGGED ABOVE.");
            }

            // After successful execution, you could optionally withdraw profits from vault
            // This requires a contract function like withdrawUSDC(address to, uint256 amount).
            // If you’ve added such a function, you can call it here with proper checks.

            // Break after first profitable opportunity found in this cycle
            // so we don't flood the network with multiple txs in one sweep.
            EXECUTING = false;
            return;
          } catch (txErr) {
            EXECUTING = false;
            const errMsg = txErr?.reason ?? txErr?.message ?? String(txErr);
            console.error("❌ EXEC FAIL:", errMsg);
            // Continue scanning other opportunities
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ SCAN ERROR:", err?.message ?? String(err));
  }
}

console.log("🚀 Arb bot live with enhanced logging and wallet balance display");
setInterval(scan, INTERVAL);






// End of file: keep watching on interval for new opportunities
// No further actions needed here. The bot continues to run, performing balance displays
// and logs for each scan cycle as configured above.
