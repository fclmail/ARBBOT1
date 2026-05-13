

import dotenv from "dotenv";  
import { ethers } from "ethers";  

dotenv.config();  

/* =========================================================  
   ENV  
========================================================= */  

const PRIVATE_KEY =  
  process.env.WALLET_PRIVATE_KEY ||  
  process.env.PRIVATE_KEY;  

if (!PRIVATE_KEY) {  
  throw new Error("Missing PRIVATE_KEY");  
}  

/* =========================================================  
   RPC  
========================================================= */  

const RPCS = [  
  "https://polygon-bor-rpc.publicnode.com",  
  "https://polygon-mainnet.infura.io/v3/YOUR_INFURA_KEY",  
  "https://rpc-mainnet.maticvigil.com"  
];  

let rpcIndex = 0;  

const getProvider = () => {  
  const provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);  
  return provider;  
};  

const getWallet = () => {  
  const provider = getProvider();  
  return new ethers.Wallet(PRIVATE_KEY, provider);  
};  

let provider = getProvider();  
let wallet = getWallet();  

/* =========================================================  
   CONTRACT  
========================================================= */  

const CONTRACT_ADDRESS =  
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";  

/* =========================================================  
   ABI  
========================================================= */  

const arbAbi = [  
  "function owner() view returns(address)",  
  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",  
  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external",  
  "function getPairReserves(address,address,address) view returns(uint256,uint256)"  
];  

const erc20Abi = [  
  "function balanceOf(address) view returns(uint256)",  
  "function decimals() view returns(uint8)"  
];  

const pairAbi = [  
  "function getReserves() view returns(uint112,uint112,uint32)",  
  "function token0() view returns(address)",  
  "function token1() view returns(address)"  
];  

const routerAbi = [  
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"  
];  

let arb = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);  

/* =========================================================  
   TOKENS  
========================================================= */  

const TOKENS = {  
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },  
  WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },  
  DAI: { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },  
  USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },  
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 }  
};  

const USDC_ADDRESS = TOKENS.USDC.address;  

/* =========================================================  
   DEX CONFIGURATION  
========================================================= */  

const DEXES = [  
  {  
    name: "QuickSwap",  
    router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  
    factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32"  
  },  
  {  
    name: "SushiSwap",  
    router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",  
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"  
  }  
];  

/* --- PAIR ADDRESS HELPER (UniswapV2-style) --- */  

function getPairAddress(factory, tokenA, tokenB) {  
  const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase()  
    ? [tokenA, tokenB]  
    : [tokenB, tokenA];  

  const salt = ethers.keccak256(  
    ethers.solidityPacked(["address", "address"], [token0, token1])  
  );  

  const initCodeHash = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02e454eb7a6e1e4f5b5a7b";  

  return ethers.getCreate2Address(factory, salt, initCodeHash);  
}  

/* =========================================================  
   SETTINGS  
========================================================= */  

const LOOP_DELAY = 5;     // seconds between scans  
const WORKERS = 10;        // concurrent workers  

let EXECUTING = false;  

/* =========================================================  
   HELPERS  
========================================================= */  

const sleep = (ms) => new Promise(r => setTimeout(r, ms));  

const fmt6 = (x) => Number(ethers.formatUnits(x, 6)).toFixed(6);  

const fmt18 = (x) => Number(ethers.formatUnits(x, 18)).toFixed(6);  

/* =========================================================  
   FIXED: computeRequiredProfit — realistic costs  
========================================================= */  

function computeRequiredProfit(size) {  
  // Aave flash loan fee: 0.09%  
  const flashFee = (size * 9n) / 10000n;  

  // Gas estimate: ~500k gas at 50 gwei = ~25 MATIC = ~\$15 USDC  
  const gasEstimate = 15n * 10n ** 6n;  

  // Slippage buffer: 0.3% of size  
  const slippageRisk = (size * 3n) / 1000n;  

  // Base cost  
  const base = flashFee + gasEstimate + slippageRisk;  

  // FIXED: 1.2x buffer instead of 120x  
  return base + (base * 2n) / 10n;  
}  

/* =========================================================  
   SIZE GRID  
========================================================= */  

function buildDepthSizes() {  
  return [  
    10000n * 10n ** 6n,    // $10k  
    50000n * 10n ** 6n,    // $50k  
    100000n * 10n ** 6n,   // $100k  
    500000n * 10n ** 6n,   // $500k  
    1000000n * 10n ** 6n,  // $1M  
    2000000n * 10n ** 6n,  // $2M  
    5000000n * 10n ** 6n   // $5M  
  ];  
}  

/* =========================================================  
   BALANCES  
========================================================= */  

async function getVaultBalance() {  
  const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);  
  return await usdc.balanceOf(CONTRACT_ADDRESS);  
}  

async function getMaticBalance() {  
  return await provider.getBalance(CONTRACT_ADDRESS);  
}  

/* =========================================================  
   FIXED: REAL PRICE FETCHING FROM DEX PAIRS  
========================================================= */  

async function getTokenPrice(dexRouter, tokenIn, tokenOut, amount) {  
  try {  
    const router = new ethers.Contract(dexRouter, routerAbi, provider);  
    const amounts = await router.getAmountsOut(amount, [tokenIn, tokenOut]);  
    return amounts[1];  
  } catch (e) {  
    // Try direct pair reserves as fallback  
    try {  
      const pairAddress = getPairAddress(  
        DEXES.find(d => d.router === dexRouter).factory,  
        tokenIn,  
        tokenOut  
      );  
      const pair = new ethers.Contract(pairAddress, pairAbi, provider);  
      const [reserve0, reserve1] = await pair.getReserves();  
      const token0 = await pair.token0();  

      if (token0.toLowerCase() === tokenIn.toLowerCase()) {  
        return (reserve1 * amount) / reserve0;  
      } else {  
        return (reserve0 * amount) / reserve1;  
      }  
    } catch (e2) {  
      return null;  
    }  
  }  
}  

/* =========================================================  
   FIXED: detectSpread — real multi-DEX price comparison  
========================================================= */  

async function detectSpread() {  
  const amount = ethers.parseUnits("1000", 6); // 1000 USDC for price discovery  
  const opportunities = [];  

  for (const dex of DEXES) {  
    for (const [tokenName, tokenInfo] of Object.entries(TOKENS)) {  
      if (tokenInfo.address === USDC_ADDRESS) continue;  

      try {  
        const price = await getTokenPrice(dex.router, USDC_ADDRESS, tokenInfo.address, amount);  
        if (price !== null) {  
          opportunities.push({  
            dex: dex.name,  
            router: dex.router,  
            tokenName,  
            tokenAddress: tokenInfo.address,  
            priceOut: price,  
            priceOutFormatted: Number(ethers.formatUnits(price, tokenInfo.decimals))  
          });  
        }  
      } catch (e) {  
        continue;  
      }  
    }  
  }  

  // Find arbitrage: buy low on one DEX, sell high on another  
  for (let i = 0; i < opportunities.length; i++) {  
    for (let j = 0; j < opportunities.length; j++) {  
      if (i === j) continue;  
      if (opportunities[i].tokenName !== opportunities[j].tokenName) continue;  

      const buyPrice = opportunities[i].priceOut;  
      const sellPrice = opportunities[j].priceOut;  

      if (sellPrice > buyPrice * 1.002) { // 0.2% spread minimum  
        return {  
          buy: opportunities[i].router,  
          sell: opportunities[j].router,  
          buyPath: [USDC_ADDRESS, opportunities[i].tokenAddress],  
          sellPath: [opportunities[j].tokenAddress, USDC_ADDRESS],  
          spread: ((sellPrice - buyPrice) / buyPrice) * 100  
        };  
      }  
    }  
  }  

  return null;  
}  

/* =========================================================  
   DEPTH ANALYSIS  
========================================================= */  

let lastPrintedSize = "0";  

async function runDepthAnalysis() {  
  const spot = await detectSpread();  
  if (!spot) {  
    console.log("⚠️ No arbitrage spread found across DEXes");  
    return null;  
  }  

  const sizes = buildDepthSizes();  
  let bestSignal = null;  

  for (const size of sizes) {  
    for (let attempt = 0; attempt < 3; attempt++) {  
      try {  
        const [profit, _] = await arb.simulateArbitrageProfit(  
          spot.buy,  
          spot.sell,  
          size,  
          spot.buyPath,  
          spot.sellPath  
        );  

        const profitFormatted = Number(ethers.formatUnits(profit, 6));  
        const required = computeRequiredProfit(size);  
        const requiredFormatted = Number(ethers.formatUnits(required, 6));  
        const sizeFormatted = Number(ethers.formatUnits(size, 6));  

        // Only print if size changed (reduce spam)  
        if (lastPrintedSize !== sizeFormatted.toFixed(6)) {  
          console.log(`SIZE ${sizeFormatted.toFixed(6)} | PROFIT ${profitFormatted.toFixed(6)} | REQUIRED ${requiredFormatted.toFixed(6)}`);  
          lastPrintedSize = sizeFormatted.toFixed(6);  
        }  

        if (profit === 0n) {  
          // Check if this is curve collapse or just no profit at this size  
          if (attempt < 2) {  
            await sleep(200);  
            continue;  
          }  
          // If all attempts return 0 at this size, try next size  
          break;  
        }  

        if (profit > required) {  
          if (!bestSignal || profit > bestSignal.profit) {  
            bestSignal = {  
              buy: spot.buy,  
              sell: spot.sell,  
              buyPath: spot.buyPath,  
              sellPath: spot.sellPath,  
              size: size,  
              profit: profit,  
              profitFormatted: profitFormatted  
            };  
          }  
        }  

        // No need to retry if we got a result  
        break;  

      } catch (e) {  
        if (attempt === 2) {  
          console.log(`❌ Simulate error at size ${fmt6(size)}: ${e.message}`);  
        }  
        await sleep(200);  
      }  
    }  
  }  

  return bestSignal;  
}  

/* =========================================================  
   STATIC RE-CHECK  
========================================================= */  

async function staticReCheck(signal) {  
  try {  
    const [profit, _] = await arb.simulateArbitrageProfit(  
      signal.buy,  
      signal.sell,  
      signal.size,  
      signal.buyPath,  
      signal.sellPath  
    );  

    const required = computeRequiredProfit(signal.size);  
    
    if (profit > required) {  
      return true;  
    }  
    return false;  
  } catch (e) {  
    console.log(`❌ Re-check failed: ${e.message}`);  
    return false;  
  }  
}  

/* =========================================================  
   EXECUTE  
========================================================= */  

async function executeArbitrage(signal) {  
  const profitFormatted = Number(ethers.formatUnits(signal.profit, 6));  
  const sizeFormatted = Number(ethers.formatUnits(signal.size, 6));  
  
  console.log(`\n🚀 EXECUTING: ${sizeFormatted} USDC -> Profit ${profitFormatted} USDC`);  
  console.log(`   Buy DEX: ${signal.buy} | Sell DEX: ${signal.sell}`);  
  console.log(`   Path: ${signal.buyPath.join(" -> ")}`);  

  const sizes = [signal.size];  
  const buyPath = signal.buyPath;  
  const sellPath = signal.sellPath;  
  const minProfit = computeRequiredProfit(signal.size);  

  try {  
    const gasPrice = await provider.getFeeData();  
    const gasLimit = 1500000n;  

    const tx = await arb.executeBestFlashLoanArbitrage(  
      signal.buy,  
      signal.sell,  
      sizes,  
      buyPath,  
      sellPath,  
      minProfit,  
      {  
        gasLimit: gasLimit,  
        maxFeePerGas: gasPrice.maxFeePerGas,  
        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas  
      }  
    );  

    console.log(`⏳ TX submitted: ${tx.hash}`);  
    const receipt = await tx.wait();  
    
    if (receipt.status === 1) {  
      console.log(`✅ SUCCESS! Hash: ${tx.hash}`);  
      console.log(`   Gas used: ${receipt.gasUsed.toString()}`);  
      
      // Log final profit  
      const vaultBalance = await getVaultBalance();  
      console.log(`   Vault USDC: ${fmt6(vaultBalance)}`);  
    } else {  
      console.log(`❌ TX failed: ${tx.hash}`);  
    }  

    return receipt;  

  } catch (e) {  
    console.log(`❌ Execution error: ${e.message}`);  
    if (e.code === 'CALL_EXCEPTION') {  
      console.log(`   Revert reason: ${e.reason || 'Unknown'}`);  
    }  
    return null;  
  }  
}  

/* =========================================================  
   PROFIT CLAIM  
========================================================= */  

async function claimProfits() {  
  const balance = await getVaultBalance();  
  const maticBalance = await getMaticBalance();  
  
  console.log(`📊 Vault USDC: ${fmt6(balance)}`);  
  console.log(`📊 Vault MATIC: ${fmt18(maticBalance)}`);  

  if (balance > 100n * 10n ** 6n) { // More than 100 USDC  
    console.log(`💰 Profits accumulated: ${fmt6(balance)} USDC`);  
  }  
}  

/* =========================================================  
   WORKER  
========================================================= */  

async function worker(id) {  
  while (true) {  
    try {  
      if (EXECUTING) {  
        await sleep(1000);  
        continue;  
      }  

      const signal = await runDepthAnalysis();  

      if (signal) {  
        EXECUTING = true;  
        
        // Re-check before executing  
        const isValid = await staticReCheck(signal);  
        
        if (isValid) {  
          await executeArbitrage(signal);  
          await claimProfits();  
        } else {  
          console.log(`⚠️ Worker ${id}: Signal expired`);  
        }  
        
        EXECUTING = false;  
      } else {  
        await sleep(LOOP_DELAY * 1000);  
      }  

    } catch (e) {  
      console.log(`❌ Worker ${id} crashed: ${e.message}`);  
      
      // Rotate RPC on crash  
      rpcIndex = (rpcIndex + 1) % RPCS.length;  
      provider = getProvider();  
      wallet = getWallet();  
      arb = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);  
      
      EXECUTING = false;  
      await sleep(5000);  
    }  
  }  
}  

/* =========================================================  
   OPPORTUNITY MONITOR  
========================================================= */  

async function monitorOpportunities() {  
  console.log("🔍 Monitoring for arbitrage opportunities...\n");  
  
  while (true) {  
    try {  
      const signal = await runDepthAnalysis();  
      
      if (signal) {  
        const profitFormatted = Number(ethers.formatUnits(signal.profit, 6));  
        const sizeFormatted = Number(ethers.formatUnits(signal.size, 6));  
        
        console.log(`\n🎯 OPPORTUNITY FOUND!`);  
        console.log(`   Size: ${sizeFormatted} USDC`);  
        console.log(`   Profit: ${profitFormatted} USDC`);  
        console.log(`   Buy DEX: ${signal.buy}`);  
        console.log(`   Sell DEX: ${signal.sell}`);  
        console.log(`   Spread: ${((profitFormatted / sizeFormatted) * 100).toFixed(4)}%`);  
        
        // Only execute if profit is significant  
        if (profitFormatted > 50) { // More than $50 profit  
          if (!EXECUTING) {  
            EXECUTING = true;  
            const isValid = await staticReCheck(signal);  
            
            if (isValid) {  
              await executeArbitrage(signal);  
              await claimProfits();  
            }  
            EXECUTING = false;  
          }  
        }  
      }  
      
      await sleep(3000); // Check every 3 seconds  
      
    } catch (e) {  
      console.log(`❌ Monitor error: ${e.message}`);  
      await sleep(5000);  
    }  
  }  
}  

/* =========================================================  
   MAIN  
========================================================= */  

async function main() {  
  console.log("🤖 Arbitrage Bot Starting...");  
  console.log(`   Contract: ${CONTRACT_ADDRESS}`);  
  console.log(`   Network: Polygon`);  
  console.log(`   Workers: ${WORKERS}`);  
  console.log(`   Loop Delay: ${LOOP_DELAY}s\n`);  

  // Verify contract is reachable  
  try {  
    const owner = await arb.owner();  
    console.log(`✅ Contract owner: ${owner}`);  
  } catch (e) {  
    console.log(`❌ Cannot connect to contract: ${e.message}`);  
    console.log(`   Check RPC or contract address`);  
    process.exit(1);  
  }  

  // Check vault balances  
  const vaultBalance = await getVaultBalance();  
  const maticBalance = await getMaticBalance();  
  
  console.log(`💰 Vault USDC: ${fmt6(vaultBalance)}`);  
  console.log(`💰 Vault MATIC: ${fmt18(maticBalance)}`);  
  
  if (maticBalance < ethers.parseEther("1")) {  
    console.log("⚠️ Low MATIC balance! Need MATIC for gas.");  
  }  

  // Start opportunity monitor in background  
  monitorOpportunities().catch(console.error);  

  // Start workers  
  const workers = [];  
  for (let i = 0; i < WORKERS; i++) {  
    workers.push(worker(i));  
  }  

  // Handle shutdown gracefully  
  process.on('SIGINT', () => {  
    console.log('\n\n🛑 Shutting down...');  
    process.exit(0);  
  });  

  process.on('SIGTERM', () => {
    console.log('\n\n🛑 Shutting down...');
    process.exit(0);
  });

  // Wait forever
  await new Promise(() => {});
}

/* =========================================================
   START
========================================================= */

main().catch((e) => {
  console.log(`💥 Fatal error: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
});
