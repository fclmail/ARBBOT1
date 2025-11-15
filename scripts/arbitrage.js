// ----------------------------------------------------
// AAVE FLASH ARB BOT - POLYGON
// Fully fixed version
// ----------------------------------------------------
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ----------------------------------------------------
// Hardcoded contract address + minimal ABI
// ----------------------------------------------------
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const arbAbi = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
  "function owner() external view returns(address)",
  "function USDC() external view returns(address)"
];

// ----------------------------------------------------
// Provider + Wallet
// ----------------------------------------------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ----------------------------------------------------
// Contract instance
// ----------------------------------------------------
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ----------------------------------------------------
// Routers and tokens (example addresses, fix checksum!)
// ----------------------------------------------------
const routers = {
  QuickSwap: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  SushiSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  ApeSwap: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const tokens = {
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

// ----------------------------------------------------
// Normalize addresses
// ----------------------------------------------------
function norm(addr) {
  try { return ethers.getAddress(addr); }
  catch { return null; }
}

// ----------------------------------------------------
// Execute arbitrage
// ----------------------------------------------------
async function executeTrade(buyRouter, sellRouter, token, amountUnits) {
  try {
    const buy = norm(buyRouter);
    const sell = norm(sellRouter);
    const tok = norm(token);

    if (!buy || !sell || !tok) {
      console.log("❌ Invalid address checksum");
      return { executed: false };
    }

    // Simulate trade using callStatic with small amount
    try {
      await arbContract.callStatic.executeArbitrage(buy, sell, tok, amountUnits);
    } catch (err) {
      console.log("✖ callStatic would fail:", err.reason || err.message);
      return { executed: false };
    }

    // Send transaction
    console.log("🟢 Sending trade...");
    const tx = await arbContract.executeArbitrage(buy, sell, tok, amountUnits, { gasLimit: 2500000 });
    const receipt = await tx.wait();
    console.log("✅ Arbitrage executed:", receipt.transactionHash);

    // Print contract USDC balance
    const usdcAddress = await arbContract.USDC();
    const usdcContract = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);
    const contractBalanceRaw = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const contractBalance = Number(ethers.formatUnits(contractBalanceRaw, 6));
    console.log("Contract USDC balance:", contractBalance.toFixed(6));

    // Print wallet MATIC balance
    const walletBalanceRaw = await provider.getBalance(wallet.address);
    const walletBalance = Number(ethers.formatUnits(walletBalanceRaw, 18));
    console.log("Wallet MATIC balance:", walletBalance.toFixed(6));

    return { executed: true, hash: receipt.transactionHash };
  } catch (err) {
    console.log("❌ Error executing trade:", err.message);
    return { executed: false, reason: err.message };
  }
}

// ----------------------------------------------------
// Main loop
// ----------------------------------------------------
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    for (const tokenName of Object.keys(tokens)) {
      for (const buyName of Object.keys(routers)) {
        for (const sellName of Object.keys(routers)) {
          if (buyName === sellName) continue;
          const tokenAddr = tokens[tokenName];
          const buyAddr = routers[buyName];
          const sellAddr = routers[sellName];

          const tradeAmount = ethers.parseUnits("0.02", 6); // Small test amount

          console.log(`🔹 Checking trade: ${tokenName} | Buy:${buyName} -> Sell:${sellName}`);
          await executeTrade(buyAddr, sellAddr, tokenAddr, tradeAmount);
        }
      }
    }
    await new Promise(r => setTimeout(r, 5000)); // 5s delay
  }
}

main().catch(console.error);
