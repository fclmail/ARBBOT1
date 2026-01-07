/* ============================================================  
   ArbJS - Full example with explicit logs, fixes, and execution  
   - Includes: precise SIM results, profit display, execution path,  
     and robust error handling for debugging.  
   - Assumes: Polygon-like environment with USDC, tokens, vault, routers.  
   ============================================================ */  

// 1) CONFIGURATION AND GLOBALS (edit these for your environment)  
const INTERVAL = 15000; // 15 seconds  
const SLIPPAGE_BPS = 20; // baseline slippage basis points  
const JS_MIN_PROFIT = 0.01; // minimum profit in USDC to execute  
const TRADE_USDC = 0.5; // amount of USDC to use per trade (example)  

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // example: USDC on Ethereum; replace with Polygon USDC address if needed  
const VAULT = "0xYourVaultContractAddress"; // replace with your vault contract address  
const wallet = { address: "0xYourWalletAddress", privateKey: "0xYOUR_PRIVATE_KEY" }; // replace with your wallet  

// Minimal scaffolding: DEX definitions (names, addresses, and mock router ABIs)  
const TOKENS = [  
  { sym: "CRV", addr: "0x172370d5cd63279efa6d502dab29171933a610af", dec: 18 },  
  { sym: "LINK", addr: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec: 18 },  
  { sym: "AXLUSDC", addr: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", dec: 6 } // example  
];  

// Simple router ABI for getAmountsOut  
const ROUTER_ABI = [  
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"  
];  

// ERC20 ABI (balance, approve, allowance)  
const ERC20_ABI = [  
  "function balanceOf(address) view returns (uint256)",  
  "function approve(address spender, uint256 amount) external returns (bool)",  
  "function allowance(address owner, address spender) external view returns (uint256)"  
];  

// Vault ABI - assume executeArbitrage signature from the earlier snippet  
const VAULT_ABI = [  
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256) external"  
];  

// 2) PREP: set up contracts (pseudo placeholders; replace with real ethers.js setup)  
const ethers = require("ethers"); // ensure ethers is available  
const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com"); // example; switch to your network  
const signer = new ethers.Wallet(wallet.privateKey, provider);  

const VAULT_CONTRACT = new ethers.Contract(VAULT, VAULT_ABI, signer);  
const USDC_CONTRACT = new ethers.Contract(USDC, ERC20_ABI, signer);  

// DEX routers (placeholders; replace with real routers)  
const DEXES = [  
  { name: "ApeSwap", addr: "0xApeSwapRouter", router: new ethers.Contract("0xApeSwapRouter", ROUTER_ABI, provider) },  
  { name: "SushiSwap", addr: "0xSushiRouter", router: new ethers.Contract("0xSushiRouter", ROUTER_ABI, provider) },  
  { name: "QuickSwap", addr: "0xQuickRouter", router: new ethers.Contract("0xQuickRouter", ROUTER_ABI, provider) }  
];  

// LOG helpers  
function toUSDC(v) {  
  try {  
    return Number(ethers.utils.formatUnits(v, 6));  
  } catch (e) {  
    return NaN;  
  }  
}  
function toToken(v, dec) {  
  try {  
    return Number(ethers.utils.formatUnits(v, dec));  
  } catch (e) {  
    return NaN;  
  }  
}  
function usdcAmount(amount) {  
  // safe wrapper: ensure finite number  
  const a = Number(amount);  
  if (!Number.isFinite(a)) throw new Error("Invalid USDC amount");  
  return ethers.utils.parseUnits(a.toFixed(6), 6);  
}  

// Robust conversion for tokenRaw or usdcOut that might be BigNumber  
function safeParseAmount(value, dec) {  
  try {  
    const v = Number(value);  
    if (!Number.isFinite(v)) throw new Error("Non-finite value");  
    return ethers.utils.parseUnits(v.toFixed(6), dec);  
  } catch (e) {  
    console.error("⚠️ Failed to parse amount:", value, "error:", e?.message ?? e);  
    throw e;  
  }  
}  

// Basic guard for TRADE_USDC  
if (typeof TRADE_USDC !== "number" || !isFinite(TRADE_USDC) || TRADE_USDC <= 0) {  
  console.error("⚠️ Invalid TRADE_USDC configuration. Set a finite positive number. Exiting.");  
  process.exit(1);  
}  

// 3) STATE: internal tracking  
let EXECUTING = false;  

// 4) HELPERS: display balances  
async function displayBalances() {  
  try {  
    const nativeBal = await provider.getBalance(wallet.address);  
    const nativeEth = ethers.utils.formatEther(nativeBal);  
    const walletUSDCBalRaw = await USDC_CONTRACT.balanceOf(wallet.address);  
    const walletUSDCBal = toUSDC(walletUSDCBalRaw);  
    const vaultUSDCBalRaw = await USDC_CONTRACT.balanceOf(VAULT);  
    const vaultUSDCBal = toUSDC(vaultUSDCBalRaw);  

    console.log(`💠 Wallet MATIC balance: ${Number(nativeEth).toFixed(6)} MATIC`);  
    console.log(`💠 Wallet USDC balance: ${walletUSDCBal.toFixed(6)} USDC`);  
    console.log(`💠 Vault USDC balance: ${vaultUSDCBal.toFixed(6)} USDC`);  
  } catch (e) {  
    console.error("❌ BALANCE FETCH ERROR:", e?.message ?? e);  
  }  
}  

// 5) CORE SCAN/TRADE LOOP  
async function scan() {  
  if (EXECUTING) return;  
  EXECUTING = true;  

  try {  
    // 5.1 Logs: balances  
    await displayBalances();  

    // 5.2 Vault available USDC  
    const vaultBalRaw = await USDC_CONTRACT.balanceOf(VAULT);  
    const vaultBal = toUSDC(vaultBalRaw);  
    console.log(`🔎 Vault available USDC: ${vaultBal.toFixed(6)} USDC`);  

    // 5.3 Iterate tokens and DEX pairs  
    for (const t of TOKENS) {  
      // skip tokens with invalid decimals  
      if (!Number.isFinite(t.dec)) continue;  
      for (const buy of DEXES) {  
        for (const sell of DEXES) {  
          if (buy.addr === sell.addr) continue;  

          // BUY LEG: USDC -> token  
          let buyOut;  
          try {  
            // Path: USDC -> token  
            const path = [USDC, t.addr];  
            buyOut = await buy.router.getAmountsOut(usdcAmount(TRADE_USDC), path);  
          } catch (e) {  
            console.error(`⚠️ BUY GET AMOUNTS OUT FAILED for ${t.sym} ${buy.name} seeking ${t.addr} from USDC:`, e?.message ?? e);  
            continue;  
          }  

          const tokenRaw = buyOut?.[buyOut.length - 1];  
          const tokenVal = toToken(tokenRaw, t.dec);  

          // Guard: must be meaningful  
          if (!Number.isFinite(tokenVal) || tokenVal < 1e-6) {  
            console.log(`ℹ️ SKIP: ${t.sym} token received too small: ${tokenVal}`);  
            continue;  
          }  

          // SELL LEG: token -> USDC  
          let sellOut;  
          try {  
            const pathSell = [t.addr, USDC];  
            sellOut = await sell.router.getAmountsOut(tokenRaw, pathSell);  
          } catch (e) {  
            console.error(`⚠️ SELL GET AMOUNTS OUT FAILED for ${t.sym} ${sell.name} seeking ${USDC}:`, e?.message ?? e);  
            continue;  
          }  

          const usdcOutRaw = sellOut?.[sellOut.length - 1];  
          const usdcOut = toUSDC(usdcOutRaw);  

          // Profit delta  
          const potentialProfit = usdcOut - TRADE_USDC;  

          // SIM log  
          // Note: In the real environment, you would log per-trade sim details here.  
          console.log(  
            `[SIM] ${t.sym} ${buy.name}→${sell.name} | buy:${tokenVal.toFixed(6)} sell:${usdcOut.toFixed(6)} profit:${potentialProfit.toFixed(6)} | vault:${vaultBal.toFixed(4)}`  
          );  

          // Decision: profitability threshold  
          if (potentialProfit < JS_MIN_PROFIT) {  
            continue;  
          }  

          // Vault balance guard  
          const vaultBalNow = toUSDC(await USDC_CONTRACT.balanceOf(VAULT));  
          if (vaultBalNow < TRADE_USDC) {  
            console.log(`⚠️ SKIP: Vault insufficient USDC. Needed ${TRADE_USDC}, have ${vaultBalNow}`);  
            continue;  
          }  

          // Prepare amounts for executeArbitrage  
          const deadline = Math.floor(Date.now() / 1000) + 120;  

          // Build token amount in appropriate decimals  
          // minTokenOut uses tokenRaw, but we will base on tokenVal  
          const minTokenOut = ethers.utils.parseUnits(tokenVal.toFixed(t.dec), t.dec);  
          const minUSDCOut = ethers.utils.parseUnits(usdcOut.toFixed(6), 6);  

          // EXECUTE  
          console.log(`🚀 EXECUTING: ${t.sym} ${buy.name}→${sell.name} with ${TRADE_USDC} USDC`);  
          try {  
            const tx = await VAULT_CONTRACT.executeArbitrage(  
              buy.addr,  
              sell.addr,  
              t.addr,  
              usdcAmount(TRADE_USDC), // amountInUSDC  
              minTokenOut,            // minTokenOut  
              minUSDCOut,              // minUSDCOut  
              deadline  
            );  
            console.log(`✅ TX SENT: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`✅ TX CONFIRMED in block ${receipt.blockNumber}`);

// After execution, you could optionally verify on-chain results or recompute balances
try {
  const walletUSDCBalRaw = await USDC_CONTRACT.balanceOf(wallet.address);
  const walletUSDCBal = toUSDC(walletUSDCBalRaw);

  const vaultBalPostRaw = await USDC_CONTRACT.balanceOf(VAULT);
  const vaultBalPost = toUSDC(vaultBalPostRaw);

  console.log(`💠 Wallet USDC balance (post-arb): ${walletUSDCBal.toFixed(6)} USDC`);
  console.log(`💠 Vault USDC balance (post-arb): ${vaultBalPost.toFixed(6)} USDC`);
} catch (e) {
  console.error("❌ POST-ARB BALANCE CHECK FAILED:", e?.message ?? e);
}

// Optional: stop after first profitable execution in this cycle
EXECUTING = false;
return;
} catch (execErr) {
  EXECUTING = false;
  const errMsg = execErr?.reason ?? execErr?.message ?? String(execErr);
  console.error("❌ EXECUTION FAILED:", errMsg);
  // Continue scanning other opportunities
}








 






















