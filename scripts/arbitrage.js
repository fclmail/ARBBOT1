// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/* ===================== ORIGINAL INTERFACES ===================== */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

/* ===================== MAIN CONTRACT ===================== */

contract VaultArbitrageEnforcer {

    address public owner;
    address public vault;
    IERC20 public usdc;

    uint256 public minimumProfitUSDC;

    /* ===================== STRUCT ===================== */

    struct BatchParams {
        address[] buyRouters;
        address[] sellRouters;
        uint256[] amountsInUSDC;
        address[][] pathsToToken;
        address[][] pathsToUSDC;
        uint256 deadline;
    }

    event ArbitrageExecuted(
        address indexed buyRouter,
        address indexed sellRouter,
        address indexed token,
        uint256 amountInUSDC,
        uint256 beforeBal,
        uint256 afterBal,
        uint256 profitUSDC
    );

    event MinProfitUpdated(uint256 newMin);
    event VaultUpdated(address newVault);

    constructor(
        address _usdc,
        address _vault,
        uint256 _minimumProfitUSDC
    ) {
        owner = msg.sender;
        usdc = IERC20(_usdc);
        vault = _vault;
        minimumProfitUSDC = _minimumProfitUSDC;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /* ================= SET VAULT ================= */

    function setVault(address _newVault) external onlyOwner {
        require(_newVault != address(0), "Zero address");
        vault = _newVault;
        emit VaultUpdated(_newVault);
    }

    /* ================= INTERNAL ARB ================= */

    function _performOnChainArbitrage(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] memory pathToToken,
        address[] memory pathToUSDC,
        uint256 deadline
    ) internal returns (uint256) {

        uint256 beforeBal = usdc.balanceOf(address(this));

        if (usdc.allowance(address(this), buyRouter) < amountInUSDC) {
            usdc.approve(buyRouter, type(uint256).max);
        }

        IUniswapV2Router(buyRouter).swapExactTokensForTokens(
            amountInUSDC,
            0,
            pathToToken,
            address(this),
            deadline
        );

        IERC20 token = IERC20(pathToUSDC[0]);

        uint256 tokenBal = token.balanceOf(address(this));

        if (token.allowance(address(this), sellRouter) < tokenBal) {
            token.approve(sellRouter, type(uint256).max);
        }

        IUniswapV2Router(sellRouter).swapExactTokensForTokens(
            tokenBal,
            0,
            pathToUSDC,
            address(this),
            deadline
        );

        return usdc.balanceOf(address(this));
    }

    /* ================= SINGLE ================= */

    function executeArbitrage(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] calldata pathToToken,
        address[] calldata pathToUSDC,
        uint256 deadline
    ) external {

        require(msg.sender == owner || msg.sender == vault, "Unauthorized");

        uint256 beforeBal = usdc.balanceOf(address(this));

        require(beforeBal >= amountInUSDC, "Insufficient vault balance");

        uint256 afterBal = _performOnChainArbitrage(
            buyRouter,
            sellRouter,
            amountInUSDC,
            pathToToken,
            pathToUSDC,
            deadline
        );

        require(
            afterBal >= beforeBal + minimumProfitUSDC,
            "Profit below minimum"
        );

        uint256 profit = afterBal - beforeBal;

        usdc.transfer(vault, profit);

        emit ArbitrageExecuted(
            buyRouter,
            sellRouter,
            pathToUSDC[0],
            amountInUSDC,
            beforeBal,
            afterBal,
            profit
        );
    }

    /* ================= SAFE BATCH ================= */

    function executeFlashBatchArbitrage(
        BatchParams calldata batch
    ) external onlyOwner {

        require(
            batch.buyRouters.length == batch.sellRouters.length &&
            batch.buyRouters.length == batch.amountsInUSDC.length &&
            batch.buyRouters.length == batch.pathsToToken.length &&
            batch.buyRouters.length == batch.pathsToUSDC.length,
            "Length mismatch"
        );

        uint256 totalProfit = 0;

        for (uint256 i = 0; i < batch.buyRouters.length; i++) {

            if (batch.amountsInUSDC[i] > usdc.balanceOf(address(this))) {
                continue;
            }

            try this._executeBatchTrade(
                batch.buyRouters[i],
                batch.sellRouters[i],
                batch.amountsInUSDC[i],
                batch.pathsToToken[i],
                batch.pathsToUSDC[i],
                batch.deadline
            ) returns (uint256 tradeAfterBal, uint256 tradeProfit) {

                if (tradeProfit > 0) {
                    totalProfit += tradeProfit;
                }

                emit ArbitrageExecuted(
                    batch.buyRouters[i],
                    batch.sellRouters[i],
                    batch.pathsToUSDC[i][0],
                    batch.amountsInUSDC[i],
                    tradeAfterBal - tradeProfit,
                    tradeAfterBal,
                    tradeProfit
                );

            } catch {

                continue;

            }
        }

        if (totalProfit > 0) {
            usdc.transfer(vault, totalProfit);
        }
    }

    /* ================= FIXED TRADE EXECUTOR ================= */

    function _executeBatchTrade(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] memory pathToToken,
        address[] memory pathToUSDC,
        uint256 deadline
    ) external returns (uint256 tradeAfterBal, uint256 tradeProfit) {

        uint256 beforeBal = usdc.balanceOf(address(this));

        uint256 afterBal = _performOnChainArbitrage(
            buyRouter,
            sellRouter,
            amountInUSDC,
            pathToToken,
            pathToUSDC,
            deadline
        );

        /* ✅ FIX — enforce minimum profit */

        require(
            afterBal >= beforeBal + minimumProfitUSDC,
            "Profit below minimum"
        );

        tradeAfterBal = afterBal;
        tradeProfit = afterBal - beforeBal;

        return (tradeAfterBal, tradeProfit);
    }

    /* ================= OWNER ================= */

    function withdraw(uint256 amount) external onlyOwner {
        usdc.transfer(owner, amount);
    }
}
