import { ethers } from "ethers"; import dotenv from "dotenv"; dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com"; const PRIVATE_KEY = process.env.PRIVATE_KEY; const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; const MIN_NET_PROFIT_USDC = 1;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) throw new Error("Missing PRIVATE_KEY or CONTRACT_ADDRESS");

const provider = new ethers.JsonRpcProvider(RPC_URL); const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const arbAbi = [ { inputs: [{ internalType: "address", name: "buyRouter", type: "address" },{ internalType: "address", name: "sellRouter", type: "address" },{ internalType: "address", name: "token", type: "address" },{ internalType: "uint256", name: "amountIn", type: "uint256" }], name: "executeArbitrage", outputs: [], stateMutability: "nonpayable", type: "function" }, { inputs: [], name: "simulateArbitrage", outputs: [{ internalType: "int256", name: "profit", type: "int256" }], stateMutability: "view", type: "function" }, { inputs: [], name: "USDC", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" }, { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" } ];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

const routers = { QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73", ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" };

const tokens = { AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 }, CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 }, LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 }, WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 } };

const TRADE_AMOUNT_USDC = 0.04; const MIN_PROFIT_PCT = 3; const SLIPPAGE_PCT = 0; const DRY_RUN = true; const cumulative = { profit: 0 }; const fmt = (n,d=4)=>Number(n).toFixed(d);

async function getAmountOut(routerAddr, token, amountIn) { const router = new ethers.Contract(routerAddr,["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],provider); const usdcAddress = await arbContract.USDC(); try { const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(),6),[usdcAddress, token.address]); return Number(ethers.formatUnits(amounts.at(-1), token.decimals)); } catch { const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(),6),[usdcAddress,tokens.WBTC.address, token.address]); return Number(ethers.formatUnits(amounts.at(-1), token.decimals)); } }

async function checkProfitCallStatic(buyRouter,sellRouter,tokenAddr,amount){ try { return Number(ethers.formatUnits(await arbContract.simulateArbitrage.staticCall(buyRouter,sellRouter,tokenAddr,ethers.parseUnits(amount.toString(),6)),6)); } catch(e){ console.log("❌ callStatic revert:",e.message); return -9999; } }

async function executeTrade(buyRouter,sellRouter,tokenAddr,amount){ if(DRY_RUN){ console.log(🧪 DRY RUN: Buy ${buyRouter} Sell ${sellRouter} Token ${tokenAddr} Amount ${amount}); return; } try{ const tx=await arbContract.executeArbitrage(buyRouter,sellRouter,tokenAddr,ethers.parseUnits(amount.toString(),6),{gasLimit:2_000_000}); const receipt=await tx.wait(); const usdc=new ethers.Contract(await arbContract.USDC(),["function balanceOf(address) view returns(uint256)"],provider); const bal=await usdc.balanceOf(CONTRACT_ADDRESS); const net=Number(ethers.formatUnits(bal,6))-amount; cumulative.profit+=net; console.log(💹 Net: ${net.toFixed(6)} USDC | Total: ${cumulative.profit.toFixed(6)}); } catch(e){ console.log("❌ Exec failed:", e.message); } }

async function scan(){ for(const [symbol,token] of Object.entries(tokens)){ for(const [buyName,buyRouter] of Object.entries(routers)){ for(const [sellName,sellRouter] of Object.entries(routers)){ if(buyName===sellName) continue; try{ const buyOut=await getAmountOut(buyRouter,token,TRADE_AMOUNT_USDC); const sellOut=await getAmountOut(sellRouter,token,TRADE_AMOUNT_USDC); const buyPrice=TRADE_AMOUNT_USDC/buyOut; const sellPrice=TRADE_AMOUNT_USDC/sellOut; let pct=((sellPrice-buyPrice)/buyPrice)100(1-SLIPPAGE_PCT/100); if(pct>=MIN_PROFIT_PCT){ console.log(🚨 ${symbol} ${buyName}->${sellName} Profit ${fmt(sellPrice-buyPrice)} USDC (${fmt(pct,2)}%)); const staticNet=await checkProfitCallStatic(buyRouter,sellRouter,token.address,TRADE_AMOUNT_USDC); if(staticNet>MIN_NET_PROFIT_USDC){ console.log(🟢 callStatic PASS: +${staticNet.toFixed(4)} USDC); await executeTrade(buyRouter,sellRouter,token.address,TRADE_AMOUNT_USDC); } else console.log(🔴 callStatic FAIL: ${staticNet.toFixed(4)} USDC); } } catch(e){ console.log("⚠️ Scan error:", e.message); } } } } }

async function main(){ console.log("🚀 DRY RUN AAVE Arbitrage Bot Continuous Scan"); while(true){ await scan(); await new Promise(r=>setTimeout(r,5000)); } }

main().catch(console.error);
