import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PK");

const RPC = "https://polygon-bor-rpc.publicnode.com";

/* ================= ENS-SAFE PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC, {
  name: "polygon",
  chainId: 137,
  ensAddress: null
});

provider.ens = null;

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const ABI = [
  "function findBestFlashLoanSize(address,uint256) view returns(uint256,uint256)",
  "function triggerFlashArbitrage((address,address,address),uint256,uint256)",
  "function startAaveFlashArbitrage(address,uint256,(address,address,address),uint256)",
  "function getContractUSDCBalance() view returns(uint256)",
  "function withdrawUSDC(address,uint256)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/* ================= TOKEN CONFIG ================= */

const TOKEN_MAP = {
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {
    pair: "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  }
};

/* ================= VALIDATION ================= */

function safeAddress(addr) {
  if (!ethers.isAddress(addr)) return null;
  return ethers.getAddress(addr);
}

/* ================= CHECK CONTRACT BALANCE ================= */

async function checkContractBalance() {
  try {
    const balance = await vault.getContractUSDCBalance();
    console.log("CONTRACTUSDCBALANCE:" + ethers.formatUnits(balance, 6));
    return balance;
  } catch (e) {
    console.log("BALANCECHECKERROR:" + e.message);
    return 0n;
  }
}

/* ================= EXECUTION ================= */

async function execute(token, size, config) {
  const route = {
    routerBuy: config.routerBuy,
    routerSell: config.routerSell,
    token
  };

  console.log("EXECMODE:FLASH");
  console.log("AAVECALLBACKSTART");
  console.log("SENDINGTRANSACTION");

  const tx = await vault.startAaveFlashArbitrage(
    USDC,
    size,
    route,
    ethers.parseUnits("0.000001", 6)
  );

  console.log("TXHASH:" + tx.hash);
  
  const receipt = await tx.wait();
  console.log("TXSTATUS:" + receipt.status);
  
  return receipt.blockNumber;
}

/* ================= MAIN EXECUTION ================= */

async function run() {
  console.log("ARBITRAGEBOTSTARTED");
  console.log("WALLET:" + wallet.address);
  console.log("CONTRACT:" + CONTRACT_ADDRESS);
  
  try {
    // Check initial contract balance
    const initialBalance = await checkContractBalance();
    console.log("INITIALCONTRACTBALANCE:" + initialBalance.toString());
    
    // Fixed token and config
    const token = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
    const config = TOKEN_MAP[token];
    
    if (!config) {
      console.log("ERROR:Invalid token configuration");
      return;
    }
    
    const pair = safeAddress(config.pair);
    if (!pair) {
      console.log("ERROR:Invalid pair address");
      return;
    }
    
    console.log("TOKEN:" + token);
    console.log("PAIR:" + pair);
    console.log("BUYROUTER:" + config.routerBuy);
    console.log("SELLROUTER:" + config.routerSell);
    
    // Check optimal loan size first
    console.log("FINDINGOPTIMALFLASHLOANSIZE");
    const maxLoan = ethers.parseUnits("100000", 6);
    const depth = await vault.findBestFlashLoanSize(pair, maxLoan);
    
    const optimalSize = BigInt(depth[0]);
    const expectedProfit = BigInt(depth[1]);
    
    console.log("OPTIMALSIZE:" + ethers.formatUnits(optimalSize, 6));
    console.log("EXPECTEDPROFIT:" + ethers.formatUnits(expectedProfit, 6));
    
    // Use 10% of optimal size for first execution
    const finalSize = optimalSize > 0n ? (optimalSize * 10n) / 100n : ethers.parseUnits("10000", 6);
    console.log("FINALSIZE:" + ethers.formatUnits(finalSize, 6));
    
    // Execute the arbitrage
    console.log("STARTINGARBITRAGE");
    const block = await execute(token, finalSize, config);
    
    // Check balance after execution
    console.log("ARBITRAGECOMPLETE");
    const finalBalance = await checkContractBalance();
    
    const profitChange = finalBalance - initialBalance;
    console.log("PROFITCHANGE:" + ethers.formatUnits(profitChange, 6));
    console.log("BLOCKCONFIRMED:" + block);
    
    if (profitChange > 0n) {
      console.log("SUCCESS:Profits retained in contract");
      console.log("CONTRACTBALANCE:" + ethers.formatUnits(finalBalance, 6));
    } else {
      console.log("INFO:No additional profits detected");
    }
    
  } catch (e) {
    console.log("ERROR:" + e.message);
    console.log("ERRORSTACK:" + e.stack);
    
    // Check balance even on error
    console.log("CHECKINGBALANCEAFTERERROR");
    await checkContractBalance();
  }
  
  console.log("EXECUTIONCOMPLETE");
}

/* ================= SCHEDULED EXECUTION ================= */

// Run immediately
run().then(() => {
  console.log("NEXTEXECUTIONIN60SECONDS");
}).catch(e => {
  console.log("FATALERROR:" + e.message);
});

// Schedule next runs every 60 seconds
setInterval(() => {
  console.log("SCHEDULEDEXECUTION");
  run().catch(e => {
    console.log("SCHEDULEDERROR:" + e.message);
  });
}, 60000);

/* ================= GRACEFUL SHUTDOWN ================= */

process.on('SIGINT', () => {
  console.log("SHUTTINGDOWN");
  checkContractBalance().then(() => {
    console.log("FINALBALANCERECORDED");
    process.exit(0);
  }).catch(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log("TERMINATING");
  process.exit(0);
});
