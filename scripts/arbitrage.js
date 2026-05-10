
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
  "function withdrawToken(address,uint256)"
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

/* ================= CHECK CONTRACT BALANCE ================= */

async function checkContractBalance() {
  try {
    // Try to call balanceOf directly on USDC token contract
    const usdcContract = new ethers.Contract(
      USDC,
      ["function balanceOf(address) view returns(uint256)"],
      provider
    );
    const balance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    console.log("CONTRACTUSDCBALANCE:" + ethers.formatUnits(balance, 6));
    return balance;
  } catch (e) {
    console.log("BALANCECHECKERROR:" + e.message.substring(0, 100));
    return 0n;
  }
}

/* ================= EXECUTION ================= */

async function execute(token, size, config) {
  const route = {
    routerBuy: config.routerBuy,
    routerSell: config.routerSell,
    token: token
  };

  console.log("EXECMODE:FLASH");
  console.log("AAVECALLBACKSTART");
  console.log("SENDINGTRANSACTION");
  console.log("ROUTE:", JSON.stringify(route));

  const tx = await vault.startAaveFlashArbitrage(
    USDC,
    size,
    route,
    ethers.parseUnits("0.000001", 6)  // minimum profit in USDC
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

async function run() {
  console.log("ARBITRAGEBOTSTARTED");
  console.log("WALLET:" + wallet.address);
  console.log("CONTRACT:" + CONTRACT_ADDRESS);
  console.log("CONTRACTDEPLOYER:" + await vault.owner());
  
  try {
    // Check initial contract balance using direct USDC call
    console.log("CHECKINGCONTRACTBALANCE");
    const initialBalance = await checkContractBalance();
    console.log("INITIALCONTRACTBALANCE:" + initialBalance.toString());
    
    // Fixed token and config
    const token = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
    const config = TOKEN_MAP[token];
    
    if (!config) {
      console.log("ERROR:Invalid token configuration");
      return;
    }
    
    console.log("TOKEN:" + token);
    console.log("PAIR:" + config.pair);
    console.log("BUYROUTER:" + config.routerBuy);
    console.log("SELLROUTER:" + config.routerSell);
    
    // Check optimal loan size first
    console.log("FINDINGOPTIMALFLASHLOANSIZE");
    const maxLoan = ethers.parseUnits("100000", 6);
    
    let optimalSize = ethers.parseUnits("10000", 6); // Default to 10k USDC
    let expectedProfit = 0n;
    
    try {
      const depth = await vault.findBestFlashLoanSize(config.pair, maxLoan);
      optimalSize = BigInt(depth[0]);
      expectedProfit = BigInt(depth[1]);
      console.log("OPTIMALSIZE:" + ethers.formatUnits(optimalSize, 6));
      console.log("EXPECTEDPROFIT:" + ethers.formatUnits(expectedProfit, 6));
      
      // Use optimal size if valid, otherwise use default
      if (optimalSize > 0n) {
        console.log("USINGOPTIMALSIZE");
      } else {
        console.log("OPTIMALSIZEZERO_USINGDEFAULT");
        optimalSize = ethers.parseUnits("10000", 6);
      }
    } catch (e) {
      console.log("FINDSIZEERROR:" + e.message.substring(0, 100));
      console.log("USINGDEFAULTSIZE");
      optimalSize = ethers.parseUnits("10000", 6);
    }
    
    console.log("FINALSIZE:" + ethers.formatUnits(optimalSize, 6));
    
    // Execute the arbitrage
    console.log("STARTINGARBITRAGE");
    const block = await execute(token, optimalSize, config);
    
    // Check balance after execution
    console.log("ARBITRAGECOMPLETE");
    const finalBalance = await checkContractBalance();
    
    const profitChange = finalBalance - initialBalance;
    console.log("PROFITCHANGE:" + ethers.formatUnits(profitChange, 6));
    console.log("BLOCKCONFIRMED:" + block);
    
    if (profitChange > 0n) {
      console.log("SUCCESS:Profits retained in contract");
      console.log("CONTRACTBALANCE:" + ethers.formatUnits(finalBalance, 6));
      console.log("PROFIT:" + ethers.formatUnits(profitChange, 6));
    } else if (profitChange === 0n) {
      console.log("INFO:No profit detected - check gas costs");
      console.log("FINALBALANCE:" + ethers.formatUnits(finalBalance, 6));
    } else {
      console.log("WARNING:Balance decreased - possible loss");
    }
    
  } catch (e) {
    console.log("ERROR:" + e.message.substring(0, 200));
    console.log("ERRORSTACK:" + e.stack?.substring(0, 300));
    
    // Check balance even on error
    console.log("CHECKINGBALANCEAFTERERROR");
    await checkContractBalance();
  }
  
  console.log("EXECUTIONCOMPLETE");
}

/* ================= SCHEDULED EXECUTION ================= */

// Run immediately
console.log("STARTINGBOT");
run().then(() => {
  console.log("NEXTEXECUTIONIN120SECONDS");
}).catch(e => {
  console.log("FATALERROR:" + e.message);
});

// Run every 2 minutes instead of 1 minute
setInterval(() => {
  console.log("SCHEDULEDEXECUTION");
  run().catch(e => {

// SCHEDULEDEXECUTION");
  run().catch(e => {
    console.log("SCHEDULEDERROR:" + e.message);
  });
}, 120000);

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

// Check if wallet is owner of contract
async function verifyOwner() {
  try {
    const contractOwner = await vault.owner();
    console.log("CONTRACTOWNER:" + contractOwner);
    console.log("WALLETADDRESS:" + wallet.address);
    console.log("ISOWNER:" + (contractOwner.toLowerCase() === wallet.address.toLowerCase()));
    return contractOwner.toLowerCase() === wallet.address.toLowerCase();
  } catch (e) {
    console.log("OWNERCHECKERROR:" + e.message.substring(0, 100));
    return false;
  }
}

// Additional execution modes
async function executeDirectArbitrage(token, size, config) {
  const route = {
    routerBuy: config.routerBuy,
    routerSell: config.routerSell,
    token: token
  };

  console.log("EXECMODE:DIRECT");
  console.log("SENDINGDIRECTTRANSACTION");

  const tx = await vault.triggerFlashArbitrage(
    route,
    size,
    ethers.parseUnits("0.000001", 6)
  );

  console.log("TXHASH:" + tx.hash);
  
  const receipt = await tx.wait();
  console.log("TXSTATUS:" + receipt.status);
  
  return receipt.blockNumber;
}

// Withdraw function if needed
async function withdrawProfits(token, amount) {
  console.log("WITHDRAWINGPROFITS");
  console.log("TOKEN:" + token);
  console.log("AMOUNT:" + ethers.formatUnits(amount, 6));
  
  const tx = await vault.withdrawToken(token, amount);
  console.log("WITHDRAWTX:" + tx.hash);
  
  const receipt = await tx.wait();
  console.log("WITHDRAWSTATUS:" + receipt.status);
  return receipt.blockNumber;
}

// Export for external use if needed
export {
  run,
  checkContractBalance,
  execute,
  executeDirectArbitrage,
  withdrawProfits,
  verifyOwner
};
