import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* =========================================================
   ENV
========================================================= */

const RPC_URL = process.env.RPC_URL?.trim();
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();

if (!RPC_URL || !PRIVATE_KEY) process.exit(1);

console.log("✅ RPC_URL active");
console.log("✅ PRIVATE_KEY active");

/* =========================================================
   COLORS
========================================================= */

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[92m";
const CYAN   = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED    = "\x1b[91m";

/* =========================================================
   SETTINGS
========================================================= */

const MIN_TRADE_USDC = 10;
const MIN_EXPECTED_PROFIT = 0.000001;
const PROFIT_MULT = 0.9;

const WORKERS = 25;
const LOOP_DELAY = 50;
const DEADLINE_SECONDS = 20;

/* =========================================================
   PROVIDER
========================================================= */

const provider = new ethers.WebSocketProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   VAULT
========================================================= */

const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  [
    "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256)",
    "function usdc() view returns(address)"
  ],
  wallet
);

const USDC_ADDR = await vault.usdc();

/* =========================================================
   ERC20
========================================================= */

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)"
];

const usdc = new ethers.Contract(USDC_ADDR, erc20Abi, provider);

/* =========================================================
   ROUTERS
========================================================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:     "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[])"
];

const routerContracts = Object.fromEntries(
  Object.entries(routers).map(([k, v]) => [
    k,
    new ethers.Contract(v, routerAbi, provider)
  ])
);

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = [
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  "0x4d224452801aced8b2f0aebe155379bb5d594381"
];

/* =========================================================
   HELPERS
========================================================= */

const ts = () =>
  new Date().toLocaleTimeString("en-GB", { hour12: false });

async function quote(router, amountIn, path) {
  try {
    const r = await router.getAmountsOut(amountIn, path);
    return r.at(-1);
  } catch {
    return null;
  }
}

async function balances() {
  const matic = await provider.getBalance(wallet.address);
  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

  return {
    matic: ethers.formatEther(matic),
    vault: ethers.formatUnits(vaultBal, 6)
  };
}

async function logBalances(label) {
  const b = await balances();
  console.log(
    `${CYAN}💰 ${label} | MATIC ${b.matic} | Vault ${b.vault}${RESET}`
  );
}

/* =========================================================
   ARB EXECUTION
========================================================= */

async function tryArb(buyName, sellName, token) {

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyOut = await quote(
    routerContracts[buyName],
    amountIn,
    [USDC_ADDR, token]
  );
  if (!buyOut) return;

  const sellOut = await quote(
    routerContracts[sellName],
    buyOut,
    [token, USDC_ADDR]
  );
  if (!sellOut) return;

  const buyPrice  = Number(ethers.formatUnits(buyOut, 6));
  const sellPrice = Number(ethers.formatUnits(sellOut, 6));

  const profit =
    (sellPrice - MIN_TRADE_USDC) * PROFIT_MULT;

  if (profit < MIN_EXPECTED_PROFIT) return;

  /* ===== PROFIT LOG ===== */

  console.log(
`${GREEN}
[${ts()}] 🟢 PROFITABLE
Buy  : ${buyName} @ ${buyPrice.toFixed(6)}
Sell : ${sellName} @ ${sellPrice.toFixed(6)}
Profit: +${profit.toFixed(6)} USDC
${RESET}`
  );

  await logBalances("BEFORE");

  /* ===== EXECUTE ===== */

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {

    const tx = await vault.executeFlashArbitrage(
      routers[buyName],
      routers[sellName],
      amountIn,
      [USDC_ADDR, token],
      [token, USDC_ADDR],
      deadline,
      { gasLimit: 2_000_000 }
    );

    console.log(`${YELLOW}⏳ TX SENT ${tx.hash}${RESET}`);

    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      console.log(`${RED}❌ TX FAILED${RESET}`);
      return;
    }

    console.log(
      `${GREEN}✅ MINED block=${receipt.blockNumber}${RESET}`
    );

    await logBalances("AFTER");

  } catch (e) {
    console.log(`${RED}❌ TX ERROR ${e.message}${RESET}`);
  }
}

/* =========================================================
   CONTINUOUS LOOP (RESTORED)
========================================================= */

async function scanLoop() {

  const jobs = [];

  for (const token of TOKENS)
    for (const buy of Object.keys(routers))
      for (const sell of Object.keys(routers))
        if (buy !== sell)
          jobs.push({ buy, sell, token });

  console.log(
    `${CYAN}🚀 Continuous arbitrage scanning | ${jobs.length} pairs${RESET}`
  );

  while (true) {

    for (let i = 0; i < jobs.length; i += WORKERS) {

      console.log(
        `${YELLOW}[${ts()}] 🔎 Scanning ${i + 1} → ${Math.min(i + WORKERS, jobs.length)}${RESET}`
      );

      await Promise.allSettled(
        jobs.slice(i, i + WORKERS).map(j =>
          tryArb(j.buy, j.sell, j.token)
        )
      );
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY));
  }
}

/* =========================================================
   START
========================================================= */

scanLoop();
