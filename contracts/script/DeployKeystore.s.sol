// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {Vault} from "../src/Vault.sol";

/// @title Deploy —— 一键部署 mini-dex 合约
/// @notice 环境变量：
///         SIGNER_ADDRESS  后端签名地址（server 用对应私钥签 Withdraw）
///
///         部署者由 Foundry CLI keystore 提供，不从环境变量读取私钥。
///         fuji: SIGNER_ADDRESS=... forge script script/DeployKeystore.s.sol --rpc-url fuji --account task7-deployer --broadcast
contract DeployKeystore is Script {
    function run() external {
        address signer = vm.envAddress("SIGNER_ADDRESS");
        address deployer = msg.sender;

        vm.startBroadcast();

        // 1. 两个测试代币
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 wavax = new MockERC20("Wrapped AVAX", "WAVAX", 18);

        // 2. 金库，signer = 后端签名地址
        Vault vault = new Vault(signer);
        vault.setAllowedToken(address(usdc), true);
        vault.setAllowedToken(address(wavax), true);

        // 3. 给部署者发点启动资金：1,000,000 USDC + 10,000 WAVAX（学生自己用 mint 水龙头也行）
        usdc.mint(deployer, 1_000_000 * 10 ** 6);
        wavax.mint(deployer, 10_000 * 10 ** 18);

        vm.stopBroadcast();

        // 4. 直接复制到 server/.env 和 web/.env
        console.log("");
        console.log("# ---- mini-dex deployed: copy the lines below into server/.env and web/.env ----");
        console.log("CHAIN_ID=%s", block.chainid);
        console.log("VAULT_ADDRESS=%s", address(vault));
        console.log("USDC_ADDRESS=%s", address(usdc));
        console.log("WAVAX_ADDRESS=%s", address(wavax));
        console.log("SIGNER_ADDRESS=%s", signer);
        console.log("# deployer=%s", deployer);
    }
}
