import { ethers } from "ethers";

// ---------------- CONFIG ----------------
// All sensitive info comes from environment variables / secrets
const RPC_URL = process.env.RPC_URL;
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY; 
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const SLIPPAGE_PERCENT = 0.2; // 0.2%
const TRADE_AMOUNT_USDC = 0.01; // per trade
const ROUTERS = {
  quickSwap: process.env.QUICKSWAP_ROUTER,
  sushiSwap: process.env.SUSHISWAP_ROUTER,
  apeSwap: process.env.APESWAP_ROUTER
};

// ---------------- EMBEDDED CONTRACT ABI ----------------
const arbAbi = [
  {
    "inputs":[
      {"internalType":"address","name":"_usdc","type":"address"},
      {"internalType":"uint256","name":"_minProfitUSDC","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"constructor"
  },
  {
    "anonymous":false,
    "inputs":[
      {"indexed":true,"internalType":"address","name":"executor","type":"address"},
      {"indexed":true,"internalType":"address","name":"buyRouter","type":"address"},
      {"indexed":true,"internalType":"address","name":"sellRouter","type":"address"},
      {"indexed":false,"internalType":"address","name":"token","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"amountIn","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"beforeUSDC","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"afterUSDC","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"profitUSDC","type":"uint256"}
    ],
    "name":"ArbitrageExecuted",
    "type":"event"
  },
  {
    "inputs":[
      {"internalType":"address","name":"buyRouter","type":"address"},
      {"internalType":"address","name":"sellRouter","type":"address"},
      {"internalType":"address","name":"token","type":"address"},
      {"internalType":"uint256","name":"amountInUSDC","type":"uint256"},
      {"internalType":"uint256","name":"minReturnUSDC","type":"uint256"}
    ],
    "name":"executeArbitrage",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "inputs":[],
    "name":"USDC",
    "outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],
    "stateMutability":"view",
    "type":"function"
  }
];

// ---------------- PROVIDER & CONTRACT ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ---------------- HELPERS ----------------
function parseUSDC(amount) {
  return ethers.parseUnits(amount.toFixed(6), 6); // USDC has 6 decimals
}

function formatUSDC(amountBN) {
  return Number(ethers.formatUnits(amountBN, 6));
}

// Mock fetch function for prices (replace with on-chain DEX calls for real bot)
async function getTokenPrice(tokenAddress, router) {
  try {
    const url = `https://api.mockdex.com/price?token=${tokenAddress}&router=${router}`;
    const res = await fetch(url);
    const data = await res.json();
    return parseFloat(data.price);
  } catch (err) {
    console.error("⚠️ Failed to fetch price:", err.message);
    return null;
  }
}

// ---------------- ARBITRAGE LOGIC ----------------
async function scanAndExecuteArbitrage() {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, [
      "function balanceOf(address owner) view returns (uint256)"
    ], provider);

    const vaultBalanceBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const vaultBalance = formatUSDC(vaultBalanceBN);
    console.log("🏦 Vault Balance Before:", vaultBalance, "USDC");

    const tokens = [
      { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
      { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" }
    ];

    for (const token of tokens) {
      const prices = {};
      for (const routerName in ROUTERS) {
        prices[routerName] = await getTokenPrice(token.address, ROUTERS[routerName]);
      }

      for (const buyRouter in prices) {
        for (const sellRouter in prices) {
          if (buyRouter === sellRouter) continue;
          const buyPrice = prices[buyRouter];
          const sellPrice = prices[sellRouter];
          if (!buyPrice || !sellPrice) continue;

          const expectedProfit = TRADE_AMOUNT_USDC * (sellPrice / buyPrice - 1);
          if (expectedProfit <= 0) continue;

          const minReturnUSDC = parseUSDC(TRADE_AMOUNT_USDC + expectedProfit * (1 - SLIPPAGE_PERCENT / 100));
          const amountInUSDC = parseUSDC(TRADE_AMOUNT_USDC);

          console.log(`🚨 PROFITABLE: ${token.symbol} | ${buyRouter} → ${sellRouter} | est profit: ${expectedProfit.toFixed(6)} USDC`);

          try {
            const tx = await contract.executeArbitrage(
              ROUTERS[buyRouter],
              ROUTERS[sellRouter],
              token.address,
              amountInUSDC,
              minReturnUSDC
            );
            console.log("🔹 Transaction sent:", tx.hash);
            await tx.wait();
            console.log("✅ Trade executed successfully!");
          } catch (err) {
            console.error("❌ Trade failed:", err.reason || err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Scan failed:", err.message);
  }
}

// ---------------- LOOP ----------------
(async () => {
  while (true) {
    await scanAndExecuteArbitrage();
    await new Promise(r => setTimeout(r, 5000)); // scan every 5s
  }
})();
