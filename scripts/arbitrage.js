




import dotenv from "dotenv";  
import { ethers } from "ethers";  

dotenv.config();  

/* ================= ENV ================= */  

const PRIVATE_KEY =  
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;  

if (!PRIVATE_KEY) throw new Error("Missing PK");  

/* ================= CONFIG ================= */  

const RPC = "https://polygon-bor-rpc.publicnode.com";  
const MODE = process.env.MODE || "VAULT";          // VAULT | FLASH | HYBRID  
const MIN_PROFIT_USDC = process.env.MIN_PROFIT || "0.0004";  

const provider = new ethers.JsonRpcProvider(RPC);  
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);  

/* ================= CONTRACT ================= */  

const CONTRACT_ADDRESS = "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";  
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";  

const contractAbi = [  
  "function triggerFlashArbitrage((address routerBuy,address routerSell,address token) route,uint256 amountIn,uint256 minimumExpectedProfit)",  
  "function startAaveFlashArbitrage(address asset,uint256 amount,(address routerBuy,address routerSell,address token) route,uint256 minProfit)",  
  "function findBestFlashLoanSize(address pair,uint256 maxTestAmount) view returns(uint256,uint256)",  
  "function getContractUSDCBalance() view returns(uint256)"  
];  

const vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);  

/* ================= TOKEN REGISTRY ================= */  

const TOKENS = {  
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",  
  CRV:  "0x172370d5Cd63279eFa6d502DAB29171933a610AF",  
  DAI:  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",  
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",  
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",  
  USDC: USDC  
};  

/* ================= PAIR DERIVATION (QuickSwap V2) ================= */  

const PAIR_FACTORY   = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";  
const PAIR_INIT_CODE = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";  

/**  
 * Derives the UniswapV2-style LP pair address for two tokens.  
 * Defaults baseToken to WETH (most Polygon pairs are WETH-based).  
 */  
function getPairAddress(tokenA, baseToken = TOKENS.WETH) {  
  const [t0, t1] = tokenA.toLowerCase() < baseToken.toLowerCase()  
    ? [tokenA, baseToken]  
    : [baseToken, tokenA];  

  const salt = ethers.solidityPackedKeccak256(  
    ["address", "address"],  
    [t0, t1]  
  );  

  return ethers.getCreate2Address(PAIR_FACTORY, salt, PAIR_INIT_CODE);  
}  

/* ================= HELPERS ================= */  

function makeRoute(token) {  
  return {  
    routerBuy:  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",   // QuickSwap  
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",  // SushiSwap  
    token  
  };  
}  

function sleep(ms) {  
  return new Promise(resolve => setTimeout(resolve, ms));  
}  



/* ================= MICRO SIGNAL (Multi-Token Scanner) ================= */  

/**  
 * Scans all 5 tokens (WETH, CRV, DAI, WBTC, USDT) for the best  
 * flash loan profit opportunity using findBestFlashLoanSize().  
 * Returns the single most profitable token.  
 */  
async function microDetect() {  
  console.log("  🔍 Scanning all tokens for best opportunity...");  

  const results = await Promise.allSettled(  
    Object.entries(TOKENS).map(async ([name, address]) => {  
      // Skip USDC (it's our quote/base asset)  
      if (address === USDC) return null;  

      const pair = getPairAddress(address);  
      const maxLoan = ethers.parseUnits("100000", 6);  // 100k USDC test max  
      const best = await vault.findBestFlashLoanSize(pair, maxLoan);  

      const optimalSize = BigInt(best[0]);  
      const estimatedProfit = BigInt(best[1]);  

      console.log(`    ${name}: ${ethers.formatUnits(estimatedProfit, 6)} USDC profit`);  

      return {  
        name,  
        token: address,  
        pair,  
        optimalSize,  
        estimatedProfit  
      };  
    })  
  );  

  // Filter successful scans with profit  
  const profitable = results  
    .filter(r => r.status === "fulfilled" && r.value !== null)  
    .map(r => r.value)  
    .filter(r => r.estimatedProfit > 0n);  

  if (profitable.length === 0) {  
    console.log("  ⚠️  No profitable opportunities found");  
    return {  
      profit: 0n,  
      token: TOKENS.WETH,  
      pair: getPairAddress(TOKENS.WETH)  
    };  
  }  

  // Sort descending by profit  
  profitable.sort((a, b) =>  
    b.estimatedProfit > a.estimatedProfit ? 1 : -1  
  );  

  const best = profitable[0];  
  console.log(`  🏆 Best: ${best.name} | Profit: ${ethers.formatUnits(best.estimatedProfit, 6)} USDC`);  

  return {  
    profit: best.estimatedProfit,  
    token: best.token,  
    pair: best.pair  
  };  
}  

/* ================= PROFIT WEIGHTED SCALING ================= */  

/**  
 * Dynamically scales the loan size based on profit density.  
 * Higher efficiency = more aggressive scaling multiplier.  
 */  
async function profitWeightedSize(pair, maxLoan) {  
  const depth = await vault.findBestFlashLoanSize(pair, maxLoan);  
  const size   = BigInt(depth[0]);  
  const profit = BigInt(depth[1]);  

  if (size === 0n) return 0n;  

  // Profit per million units of size (efficiency curve)  
  const efficiency = (profit * 1_000_000n) / size;  

  let multiplier = 100n;  // 1.0x baseline  

  if      (efficiency > 2000n) multiplier = 300n;  // 3.0x  
  else if (efficiency > 1000n) multiplier = 200n;  // 2.0x  
  else if (efficiency > 500n)  multiplier = 150n;  // 1.5x  

  const scaled = (size * multiplier) / 100n;  

  console.log(`  📐 Efficiency: ${efficiency} | Multiplier: ${multiplier/100n}x | Scaled: ${ethers.formatUnits(scaled < BigInt(maxLoan) ? scaled : BigInt(maxLoan), 6)} USDC`);  

  return scaled < BigInt(maxLoan) ? scaled : BigInt(maxLoan);  
}  

/* ================= EXECUTION ENGINE ================= */  

async function execute(token, size) {  
  const route = makeRoute(token);  
  const balance = await vault.getContractUSDCBalance();  
  const vaultBalance = BigInt(balance);  

  console.log(`  💰 Vault USDC Balance: ${ethers.formatUnits(vaultBalance, 6)} USDC`);  

  /* -------- VAULT MODE -------- */  
  if (MODE === "VAULT") {  
    const finalSize = size > vaultBalance ? vaultBalance : size;  


    if (finalSize === 0n) {  
      console.log("  ❌ Insufficient vault balance");  
      return null;  
    }  

    console.log(`  ⚡ VAULT EXEC: ${ethers.formatUnits(finalSize, 6)} USDC`);  
    console.log(`  📍 Route: ${route.token} via QuickSwap → SushiSwap`);  

    const tx = await vault.triggerFlashArbitrage(  
      route,  
      finalSize,  
      ethers.parseUnits("0.000001", 6)  // minimum profit threshold  
    );  

    console.log(`  🔗 TX Hash: ${tx.hash}`);  
    const receipt = await tx.wait();  
    console.log(`  ✅ Confirmed in Block: ${receipt.blockNumber}`);  
    console.log(`  ⛽ Gas Used: ${receipt.gasUsed.toString()}`);  
    return receipt;  
  }  

  /* -------- FLASH LOAN MODE -------- */  
  if (MODE === "FLASH") {  
    console.log(`  ⚡ FLASH LOAN EXEC: ${ethers.formatUnits(size, 6)} USDC`);  
    console.log(`  📍 Route: ${route.token} via QuickSwap → SushiSwap`);  

    const tx = await vault.startAaveFlashArbitrage(  
      USDC,  
      size,  
      route,  
      ethers.parseUnits("0.000001", 6)  
    );  

    console.log(`  🔗 TX Hash: ${tx.hash}`);  
    const receipt = await tx.wait();  
    console.log(`  ✅ Confirmed in Block: ${receipt.blockNumber}`);  
    console.log(`  ⛽ Gas Used: ${receipt.gasUsed.toString()}`);  
    return receipt;  
  }  

  /* -------- HYBRID MODE -------- */  
  if (MODE === "HYBRID") {  
    if (size > vaultBalance && vaultBalance > 0n) {  
      // Partial vault + flash not supported by contract, so use flash for full amount  
      console.log(`  ⚡ HYBRID → Using FLASH LOAN (size exceeds vault)`);  
      console.log(`  ⚡ FLASH EXEC: ${ethers.formatUnits(size, 6)} USDC`);  

      const tx = await vault.startAaveFlashArbitrage(  
        USDC,  
        size,  
        route,  
        ethers.parseUnits("0.000001", 6)  
      );  

      console.log(`  🔗 TX Hash: ${tx.hash}`);  
      const receipt = await tx.wait();  
      console.log(`  ✅ Confirmed in Block: ${receipt.blockNumber}`);  
      return receipt;  
    }  

    const finalSize = size > vaultBalance ? vaultBalance : size;  
    console.log(`  ⚡ HYBRID → Using VAULT FUNDS`);  
    console.log(`  ⚡ VAULT EXEC: ${ethers.formatUnits(finalSize, 6)} USDC`);  

    const tx = await vault.triggerFlashArbitrage(  
      route,  
      finalSize,  
      ethers.parseUnits("0.000001", 6)  
    );  

    console.log(`  🔗 TX Hash: ${tx.hash}`);  
    const receipt = await tx.wait();  
    console.log(`  ✅ Confirmed in Block: ${receipt.blockNumber}`);  
    return receipt;  
  }  
}  

/* ================= SCALE ENGINE ================= */  

async function scaleEngine(token) {  
  console.log(`\n${"=".repeat(55)}`);  
  console.log("📊 MULTI-TOKEN SCALE ENGINE");  
  console.log(`${"=".repeat(55)}`);  

  // Step 1: Micro-detect the best token  
  const micro = await microDetect();  

  // If microDetect found a better token than what was passed, use it  
  const targetToken = micro.profit > 0n ? micro.token : token;  

  console.log(`\n🎯 Target Token: ${Object.entries(TOKENS).find(([k,v]) => v === targetToken)?.[0] || targetToken}`);  
  console.log(`💰 Estimated Profit: ${ethers.formatUnits(micro.profit, 6)} USDC`);  

  // Step 2: Derive pair address  
  const pair = getPairAddress(targetToken);  
  console.log(`🔗 Pair Address: ${pair}`);  


  // Step 3: Calculate optimal scaled size
  const maxLoan = ethers.parseUnits("100000", 6);
  const size = await profitWeightedSize(pair, maxLoan);
  console.log(`🚀 FINAL EXECUTION SIZE: ${ethers.formatUnits(size, 6)} USDC`);

  if (size === 0n) {
    console.log("  ❌ Skipping: size is zero (no liquidity or no profit)");
    return;
  }

  // Step 4: Check minimum profit threshold
  const minProfit = ethers.parseUnits(MIN_PROFIT_USDC, 6);
  if (micro.profit < minProfit) {
    console.log(`  ⏳ Profit ${ethers.formatUnits(micro.profit, 6)} USDC below threshold ${MIN_PROFIT_USDC} USDC, skipping`);
    return;
  }

  // Step 5: Execute the arbitrage
  console.log(`\n⚡ EXECUTING ARBITRAGE...`);
  const receipt = await execute(targetToken, size);

  if (receipt) {
    console.log(`\n✅ ARBITRAGE COMPLETE`);
    console.log(`📦 Block: ${receipt.blockNumber}`);
    console.log(`⛽ Gas: ${receipt.gasUsed.toString()}`);
    console.log(`💰 Gas Price: ${ethers.formatUnits(receipt.gasPrice, "gwei")} Gwei`);
    console.log(`💵 TX Cost: ${ethers.formatEther(receipt.gasUsed * receipt.gasPrice)} MATIC`);
  }
}

/* ================= MAIN LOOP ================= */

async function main() {
  console.log(`\n${"█".repeat(55)}`);
  console.log("🚀 ARBITRAGE BOT STARTED");
  console.log(`${"█".repeat(55)}`);
  console.log(`📡 Network: Polygon Mainnet`);
  console.log(`🏦 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`⚙️  Mode: ${MODE}`);
  console.log(`💰 Min Profit: ${MIN_PROFIT_USDC} USDC`);
  console.log(`🪙 Tokens Scanned: ${Object.keys(TOKENS).filter(k => k !== "USDC").join(", ")}`);
  console.log(`🔁 Polling every 2 seconds\n`);

  let cycleCount = 0;

  while (true) {
    try {
      cycleCount++;
      console.log(`\n${"─".repeat(35)}`);
      console.log(`🔄 CYCLE #${cycleCount} | ${new Date().toLocaleTimeString()}`);
      console.log(`${"─".repeat(35)}`);

      // Perform multi-token scan
      const signal = await microDetect();

      // Check if profitable enough to execute
      const minProfit = ethers.parseUnits(MIN_PROFIT_USDC, 6);

      if (signal.profit > minProfit) {
        console.log(`\n🔥 PROFITABLE SIGNAL DETECTED!`);
        await scaleEngine(signal.token);
      } else {
        console.log(`  💤 No profitable opportunity (best: ${ethers.formatUnits(signal.profit, 6)} USDC, min: ${MIN_PROFIT_USDC} USDC)`);
      }

    } catch (error) {
      console.log(`\n❌ ERROR in cycle #${cycleCount}:`);
      console.log(`   ${error.message}`);
      if (error.stack) {
        console.log(`   Stack: ${error.stack.split("\n")[1]?.trim()}`);
      }
    }

    // Wait before next cycle
    await sleep(2000);
  }
}

/* ================= START ================= */

main().catch((error) => {
  console.error("💥 FATAL ERROR:", error);
  process.exit(1);
});
