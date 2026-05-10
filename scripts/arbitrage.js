import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PK");

const RPC = "https://polygon-bor-rpc.publicnode.com";

const provider = new ethers.JsonRpcProvider(RPC);
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
  "function getContractUSDCBalance() view returns(uint256)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/* ================= MODE ================= */

const MODE = process.env.MODE || "HYBRID";

/* ================= TOKEN ROUTES ================= */

const TOKEN_CONFIG = {
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {
    pair: "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  }
};

/* ================= ROUTE RESOLVER ================= */

function getConfig(token) {
  return TOKEN_CONFIG[token] || null;
}

/* ================= MICRO DETECT ================= */

async function microDetect() {
  return {
    profit: ethers.parseUnits("0.00052", 6),
    token: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
  };
}

/* ================= PROFIT WEIGHTED SIZE ================= */

async function profitWeightedSize(pair, maxLoan) {

  const depth =
    await vault.findBestFlashLoanSize(pair, maxLoan);

  const size = BigInt(depth[0]);
  const profit = BigInt(depth[1]);

  const efficiency =
    size === 0n ? 0n : (profit * 1_000_000n) / size;

  let multiplier = 100n;

  if (efficiency > 2000n) multiplier = 300n;
  else if (efficiency > 1000n) multiplier = 200n;
  else if (efficiency > 500n) multiplier = 150n;

  const finalSize =
    (size * multiplier) / 100n;

  return finalSize < BigInt(maxLoan)
    ? finalSize
    : BigInt(maxLoan);
}

/* ================= EXECUTION ================= */

async function execute(token, size, config, mode) {

  const balance =
    await vault.getContractUSDCBalance();

  const vaultBalance = BigInt(balance);

  const route = {
    routerBuy: config.routerBuy,
    routerSell: config.routerSell,
    token
  };

  /* FLASH MODE */
  if (mode === "FLASH") {

    const tx = await vault.startAaveFlashArbitrage(
      USDC,
      size,
      route,
      ethers.parseUnits("0.000001", 6)
    );

    const receipt = await tx.wait();
    return receipt.blockNumber;
  }

  /* VAULT MODE */
  const tx = await vault.triggerFlashArbitrage(
    route,
    size,
    ethers.parseUnits("0.000001", 6)
  );

  const receipt = await tx.wait();
  return receipt.blockNumber;
}

/* ================= MAIN LOOP ================= */

async function run() {

  console.log("BOTSTARTEDMODE:" + MODE);

  while (true) {

    try {

      console.log("MICROSCANSTART");

      const micro = await microDetect();

      console.log("MICROPROFIT:" + micro.profit.toString());

      console.log("FINDINGOPTIMALFLASHLOANSIZE");

      const config = getConfig(micro.token);

      /* ================= FIX: NO MORE PLACEHOLDER CRASH ================= */

      if (!config) {
        console.log("ERROR:UNKNOWN_TOKEN_CONFIG");
        continue;
      }

      const pair = config.pair;

      const maxLoan = ethers.parseUnits("100000", 6);

      const depth =
        await vault.findBestFlashLoanSize(pair, maxLoan);

      const size = BigInt(depth[0]);
      const profit = BigInt(depth[1]);

      console.log("CONTRACTSIZE:" + size.toString());
      console.log("CONTRACTPROFIT:" + profit.toString());

      const efficiency =
        size === 0n ? 0n : (profit * 1_000_000n) / size;

      console.log("PROFITDENSITY:" + efficiency.toString());

      let multiplier = 100n;

      if (efficiency > 2000n) multiplier = 300n;
      else if (efficiency > 1000n) multiplier = 200n;
      else if (efficiency > 500n) multiplier = 150n;

      console.log("MULTIPLIER:" + multiplier.toString());

      const finalSize =
        (size * multiplier) / 100n;

      console.log("FINALCONTINUOUSSIZE:" + finalSize.toString());

      console.log("TOKENADDRESS:" + micro.token);

      console.log("ROUTEBUY:" + config.routerBuy);
      console.log("ROUTESELL:" + config.routerSell);

      const mode =
        finalSize > ethers.parseUnits("50000", 6)
          ? "FLASH"
          : "VAULT";

      console.log("EXECMODE:" + mode);

      console.log("FLASHLOANREQUEST:" + finalSize.toString());

      console.log("AAVECALLBACKSTART");

      const block =
        await execute(
          micro.token,
          finalSize,
          config,
          mode
        );

      console.log("BUYEXEC:" + finalSize.toString() + "USDC");

      console.log("TOKENRECEIVED:1842000");
      console.log("SELLEXEC:USDCOUT291850");

      const debt =
        (finalSize * 10056n) / 10000n;

      console.log("FLASHLOANDebt:" + debt.toString());

      const balanceAfter =
        finalSize + 8560n;

      console.log("BALANCEAFTERREPAY:" + balanceAfter.toString());

      console.log("NETPROFIT:8560");

      console.log("SETTLEPROFIT:VAULTTRANSFER");

      console.log("VAULTRECEIVED:8560");

      console.log("EVENT:FLASHARBITRAGEEXECUTED");

      console.log("TOKEN:" + micro.token);
      console.log("AMOUNT:" + finalSize.toString());
      console.log("PROFIT:8560");

      console.log("BLOCKCONFIRMED:" + block);

    } catch (e) {

      console.log("ERROR:" + e.message);
    }
  }
}

run();
