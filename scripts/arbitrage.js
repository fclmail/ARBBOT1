import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const WALLET_PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";

/* ================= CONSTANTS ================= */

const FLASH_AMOUNT_USDC = 1; // fixed flash loan amount
const SCAN_INTERVAL_MS = 30_000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS =
  "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  {
    name: "executeFlashArbitrage",
    type: "function",
    inputs: [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "address[]" },
      { type: "uint256" }
    ],
    stateMutability: "nonpayable"
  },
  {
    name: "usdc",
    type: "function",
    outputs: [{ type: "address" }],
    stateMutability: "view"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS = {
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= BALANCE DISPLAY ================= */

async function displayBalances() {
  try {
    const maticBalance = await provider.getBalance(wallet.address);
    const usdcAddress = await vault.usdc();

    const erc20Abi = [
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)"
    ];

    const usdc = new ethers.Contract(usdcAddress, erc20Abi, provider);

    const contractBalance = await usdc.balanceOf(VAULT_ADDRESS);
    const decimals = await usdc.decimals();

    console.log(
      `${YELLOW}Wallet MATIC:${RESET}`,
      ethers.formatEther(maticBalance)
    );

    console.log(
      `${YELLOW}Contract USDC:${RESET}`,
      ethers.formatUnits(contractBalance, decimals)
    );
  } catch (err) {
    console.error("Balance display error:", err.message);
  }
}

/* ================= PATHS ================= */

function buildPaths(usdc, token) {
  return [
    [usdc, token]
  ];
}

function buildSellPaths(usdc, token) {
  return [
    [token, usdc]
  ];
}

/* ================= FLASH EXECUTION ================= */

async function tryFlashArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();

  const buyPath = buildPaths(usdc, tokenAddr)[0];
  const sellPath = buildSellPaths(usdc, tokenAddr)[0];

  try {
    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      ethers.parseUnits(FLASH_AMOUNT_USDC.toString(), 6),
      buyPath,
      sellPath,
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );

    console.log(`${CYAN}⚡ Flash loan sent:${RESET} ${tx.hash}`);

    await tx.wait();

    console.log(`${GREEN}✅ FLASH ARB CONFIRMED:${RESET} ${tx.hash}`);

  } catch (err) {
    console.error(
      `${CYAN}⚡ Flash execution failed:${RESET}`,
      err.shortMessage || err.message
    );
  }
}

/* ================= SCAN ================= */

async function scan() {
  console.log(`🔍 Scan @ ${new Date().toISOString()}`);
  await displayBalances();

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await tryFlashArb(buy, sell, token);
        }
      }
    }
  }
}

/* ================= MAIN ================= */

(async function mainLoop() {
  console.log("🚀 Flash-enabled arbitrage bot started");

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(e);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
})();
