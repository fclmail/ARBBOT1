import { ethers } from "ethers";
import VaultABI from "./VaultArbitrageEnforcer.json";
import ERC20ABI from "./ERC20.json";

// ---------------- CONFIG ----------------
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com/");
const wallet = new ethers.Wallet("YOUR_PRIVATE_KEY", provider);

const vaultAddress = "0xYourVaultContract";
const vault = new ethers.Contract(vaultAddress, VaultABI, wallet);

// ---------------- ROUTERS ----------------
const routers = [
  { name: "QuickSwap", addr: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", addr: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "Dfyn", addr: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" },
  { name: "ComethSwap", addr: "0x93b5b775e3d27C9BfA2C91e7C8991B8466a05D21" },
  { name: "JetSwap", addr: "0x5C7f12bCe6E5b73F9cB49A619B0c26AaB3762c69" },
];

// ---------------- TOKENS ----------------
const tokens = [
  { symbol: "AAVE", addr: "0xd6df932a45c0f255f85145f286ea0b292b21c90b" },
  { symbol: "LINK", addr: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "WBTC", addr: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "USDT", addr: "0x3813e82e6f7098b9583FC0F33a962D02018B6803" },
  { symbol: "MATIC", addr: "0x0000000000000000000000000000000000001010" }, // placeholder WMATIC
  { symbol: "USDC", addr: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" },
];

// ---------------- PARAMETERS ----------------
const amountInUSDC = ethers.parseUnits("1", 6); // 1 USDC per trade
const slippage = 0.002; // 0.2%

// ---------------- HELPERS ----------------
async function getAmountsOut(router, path, amount) {
  const routerContract = new ethers.Contract(router.addr, [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
  ], provider);

  try {
    const amounts = await routerContract.getAmountsOut(amount, path);
    return amounts[amounts.length - 1];
  } catch {
    return ethers.BigInt(0);
  }
}

function calculateProfit(buyAmount, sellAmount) {
  const feeAdjustment = BigInt(buyAmount * slippage);
  return sellAmount > buyAmount ? sellAmount - buyAmount - feeAdjustment : ethers.BigInt(-1) * (buyAmount - sellAmount + feeAdjustment);
}

async function getVaultUSDCBalance() {
  const usdcAddress = await vault.usdc();
  const usdc = new ethers.Contract(usdcAddress, ERC20ABI, provider);
  return usdc.balanceOf(vaultAddress);
}

// ---------------- ARBITRAGE SCAN ----------------
async function scanArbitrage() {
  console.log("🚀 Arbitrage bot started");

  const walletMATIC = await provider.getBalance(wallet.address);
  const vaultUSDC = await getVaultUSDCBalance();

  console.log(`💎 Wallet MATIC balance: ${ethers.formatUnits(walletMATIC, 18)}`);
  console.log(`💰 Vault USDC balance: ${ethers.formatUnits(vaultUSDC, 6)}\n`);

  for (const token of tokens) {
    for (const buyRouter of routers) {
      for (const sellRouter of routers) {
        if (buyRouter.addr === sellRouter.addr) continue;

        // -------- ONE-HOP PATH --------
        const pathToToken = [tokens.find(t => t.symbol === "USDC").addr, token.addr];
        const pathToUSDC = [token.addr, tokens.find(t => t.symbol === "USDC").addr];

        const buyAmount = await getAmountsOut(buyRouter, pathToToken, amountInUSDC);
        const sellAmount = await getAmountsOut(sellRouter, pathToUSDC, buyAmount);
        let profit = calculateProfit(buyAmount, sellAmount);

        // -------- MULTI-HOP SCAN --------
        for (const midToken of tokens) {
          if (midToken.addr === token.addr || midToken.symbol === "USDC") continue;
          const multiPath = [tokens.find(t => t.symbol === "USDC").addr, midToken.addr, token.addr];
          const multiPathBack = [token.addr, midToken.addr, tokens.find(t => t.symbol === "USDC").addr];

          const multiBuy = await getAmountsOut(buyRouter, multiPath, amountInUSDC);
          const multiSell = await getAmountsOut(sellRouter, multiPathBack, multiBuy);

          const multiProfit = calculateProfit(multiBuy, multiSell);
          if (multiProfit > profit) {
            profit = multiProfit;
          }
        }

        console.log(`🔹 ARB SCAN | Token: ${token.addr} (${token.symbol})`);
        console.log(`  Buy on: ${buyRouter.addr} | Buy amount out: ${ethers.formatUnits(buyAmount, 18)}`);
        console.log(`  Sell on: ${sellRouter.addr} | Sell amount out: ${ethers.formatUnits(sellAmount, 18)}`);
        console.log(`  Expected Profit: ${ethers.formatUnits(profit, 6)} USDC ${profit > 0 ? "✅" : ""}\n`);

        // -------- EXECUTE ARBITRAGE --------
        if (profit > 0) {
          console.log("🔥 EXECUTING ARBITRAGE");
          const tx = await vault.executeArbitrage(
            buyRouter.addr,
            sellRouter.addr,
            amountInUSDC,
            pathToToken,
            pathToUSDC,
            Math.floor(Date.now() / 1000) + 60
          );
          console.log(`⛓ TX SENT: ${tx.hash}`);
          await tx.wait();
          console.log("✅ PROFIT DEPOSITED TO VAULT");

          // -------- CONVERT TO MATIC --------
          const usdcAddress = await vault.usdc();
          const usdcContract = new ethers.Contract(usdcAddress, ERC20ABI, wallet);
          const vaultBalance = await usdcContract.balanceOf(vaultAddress);

          if (vaultBalance > 0) {
            const wmaticAddress = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
            const routerContract = new ethers.Contract(buyRouter.addr, [
              "function swapExactTokensForTokens(uint,uint,address[],address,uint) external returns (uint[])"
            ], wallet);

            await usdcContract.approve(buyRouter.addr, vaultBalance);
            const swapTx = await routerContract.swapExactTokensForTokens(
              vaultBalance,
              0,
              [usdcAddress, wmaticAddress],
              wallet.address,
              Math.floor(Date.now() / 1000) + 60
            );
            console.log(`🔁 Converting profits to MATIC: ${swapTx.hash}`);
            await swapTx.wait();
            console.log("✅ PROFITS CONVERTED TO MATIC AND SENT TO OWNER WALLET\n");
          }
        }
      }
    }
  }

  const newVaultUSDC = await getVaultUSDCBalance();
  const newWalletMATIC = await provider.getBalance(wallet.address);
  console.log(`💎 Wallet MATIC balance: ${ethers.formatUnits(newWalletMATIC, 18)}`);
  console.log(`💰 Vault USDC balance: ${ethers.formatUnits(newVaultUSDC, 6)}\n`);
}

// ---------------- RUN ----------------
setInterval(scanArbitrage, 5000); // repeat every 5 seconds
