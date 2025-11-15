// ----------------------------------------------------
// AAVE FLASH ARB BOT - POLYGON (ES Module)
// ----------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ----------------------------------------------------
// CONFIG
// ----------------------------------------------------
const RPC_URL = process.env.RPC_URL;
const WALLET_PK = process.env.PRIVATE_KEY;
const ARB_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Hardcoded

if (!RPC_URL || !WALLET_PK) throw new Error("❌ Missing RPC_URL or PRIVATE_KEY");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PK, provider);

// ----------------------------------------------------
// FULL CONTRACT ABI
// ----------------------------------------------------
const arbAbi = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
  "function owner() external view returns(address)",
  "function USDC() external view returns(address)"
];

const arbContract = new ethers.Contract(ARB_CONTRACT, arbAbi, wallet);

// ----------------------------------------------------
// UTILITIES
// ----------------------------------------------------
const norm = (addr) => {
  try { return ethers.getAddress(addr); }
  catch { return null; }
};

// Get ERC20 balance
async function getTokenBalance(tokenAddress, account) {
  const token = new ethers.Contract(
    tokenAddress,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );
  return await token.balanceOf(account);
}

// Format balances
function formatUSDC(amount) {
  return ethers.formatUnits(amount, 6);
}
function formatMATIC(amount) {
  return ethers.formatEther(amount);
}

// ----------------------------------------------------
// EXECUTE TRADE
// ----------------------------------------------------
async function executeTrade(buyRouter, sellRouter, token, amountUnits) {
  try {
    const buy = norm(buyRouter);
    const sell = norm(sellRouter);
    const tok = norm(token);
    if (!buy || !sell || !tok) return { executed: false, reason: "Invalid checksum address" };

    // CallStatic simulation
    try {
      await arbContract.callStatic.executeArbitrage(buy, sell, tok, amountUnits);
      console.log(`✅ callStatic passed for token ${tok}`);
    } catch (err) {
      return { executed: false, reason: "callStatic fail: " + (err.reason || err.message) };
    }

    // Execute arbitrage
    const tx = await arbContract.executeArbitrage(buy, sell, tok, amountUnits, { gasLimit: 2500000 });
    const receipt = await tx.wait();

    // Get balances after trade
    const usdcAddress = await arbContract.USDC();
    const contractUSDC = await getTokenBalance(usdcAddress, ARB_CONTRACT);
    const walletMATIC = await provider.getBalance(wallet.address);

    return {
      executed: true,
      txHash: receipt.transactionHash,
      token: tok,
      buyRouter: buy,
      sellRouter: sell,
      contractUSDC: formatUSDC(contractUSDC),
      walletMATIC: formatMATIC(walletMATIC)
    };

  } catch (err) {
    return { executed: false, reason: err.message };
  }
}

// ----------------------------------------------------
// MOCK: Price fetch (replace with actual price fetch logic)
// ----------------------------------------------------
async function getPrice(token, router) {
  // Example: return a random price for testing
  return Math.random() * 100 + 1;
}

// ----------------------------------------------------
// SCAN & LOG
// ----------------------------------------------------
async function scan() {
  const tokens = [
    { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
    { symbol: "AAVE", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" }
  ];
  const routers = [
    { name: "QuickSwap", address: "0xa5E0829CaCED8bD8eE78d2eBfA2c6EeA78e2F5C0" },
    { name: "SushiSwap", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
    { name: "ApeSwap", address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
  ];

  const amountUnits = ethers.parseUnits("0.02", 6); // small test USDC amount

  for (const token of tokens) {
    for (const buy of routers) {
      for (const sell of routers) {
        if (buy.address === sell.address) continue;

        const buyPrice = await getPrice(token.address, buy.address);
        const sellPrice = await getPrice(token.address, sell.address);
        const profit = (sellPrice - buyPrice);

        console.log(`🔹 Checking trade: ${token.symbol} | Buy:${buy.name} @$${buyPrice.toFixed(4)} -> Sell:${sell.name} @$${sellPrice.toFixed(4)} | Net Profit: $${profit.toFixed(4)}`);

        const result = await executeTrade(buy.address, sell.address, token.address, amountUnits);
        if (result.executed) {
          console.log(`🟢 Arbitrage executed successfully! TxHash: ${result.txHash}`);
          console.log(`Contract USDC balance: ${result.contractUSDC}, Wallet MATIC: ${result.walletMATIC}`);
        } else {
          console.log(`✖ Trade failed: ${result.reason}`);
        }
      }
    }
  }
}

// ----------------------------------------------------
// MAIN LOOP
// ----------------------------------------------------
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    try {
      await scan();
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      console.error("Error in main loop:", err);
    }
  }
}

main();

