# MiniCS：基于区块链的众筹系统

基于 Hardhat 的本地区块链众筹 DApp。合约负责项目创建、捐赠、结束结算、成功提现、失败退款，并包含两个优化功能：创建时可配置里程碑百分比、达标后释放阶段性资金，以及前 10 位早鸟捐赠者排名与奖励记录。

## 功能

### 基础功能

- **项目创建**：提交项目名称、描述、目标金额（ETH）和截止日期，每个项目自动获得唯一 ID。
- **资金捐赠**：用户选择进行中的项目捐赠 ETH，合约记录捐赠者地址和金额，更新筹款总额。
- **项目展示**：前端展示进行中、可结束和已结束项目的名称、描述、目标金额、已筹金额、剩余时间和捐赠者列表。
- **截止结算**：截止时间到达后，任何人都可以调用合约函数结束项目。
- **成功提现**：达到或超过目标后，项目发起人可以提取筹集到的资金。
- **失败退款**：未达到目标时，捐赠者可以取回自己的捐款。如果项目在失败前已释放过里程碑资金，退款按比例扣除已释放部分。

### 优化设计

- **阶段性资金释放（里程碑）**：创建项目时可设置里程碑百分比（1–100%），筹款达到该比例的目标金额时，发起人可提前释放当前已筹金额的 30%。
- **早鸟捐赠者奖励**：每个项目的前 10 位捐赠者会被记录为早鸟支持者，链上保存排名，前端详情页显示早鸟徽章和排名信息。

### 前端展示

- **链上操作日志**：右侧固定面板实时展示合约事件历史（创建、捐赠、结算、释放、提现、退款等），从链上读取真实记录。
- **生命周期自动同步**：截止时刻到达后自动归类到「可结束」，每 30 秒刷新剩余时间和状态统计。
- **交易等待优化**：MetaMask 确认或区块确认超时时提示"较慢"，确认完成后自动刷新页面数据。
- **操作状态控制**：已截止/已结算项目自动禁用捐赠和无效操作按钮，详情页按项目生命周期显示可用操作。
- **已结束项目排序**：按链上 `ProjectFinalized` 事件时间倒序，最近结算的项目排在最前。

## 目录结构

```text
MiniCS/
├─ contracts/
│  └─ Crowdfunding.sol          ← 核心众筹合约
├─ test/
│  └─ Crowdfunding.js           ← 合约测试（10 个用例）
├─ scripts/
│  ├─ deploy.js                 ← 部署脚本，自动生成前端配置
│  └─ serve.js                  ← 前端静态服务器
├─ src/
│  ├─ index.html                ← 前端页面
│  ├─ css/styles.css            ← 样式
│  └─ js/
│     ├─ dapp.js                ← 前端核心逻辑
│     ├─ chain-log.js           ← 链上事件日志模块
│     ├─ contract-config.js     ← 部署后自动生成（.gitignore）
│     ├─ contract-config.example.js
│     └─ ethers.min.js          ← ethers.js 本地打包
├─ docs/                        ← 扩展文档
├─ hardhat.config.js
├─ package.json
└─ MiniCS.md                    ← 详细项目说明文档
```

## 运行

### 1. 安装依赖

```shell
npm install
```

### 2. 运行测试

```shell
npm test
```

### 3. 启动本地区块链

```shell
npm run node
```

### 4. 部署合约（新开终端）

```shell
npm run deploy:localhost
```

部署完成后会自动生成 `src/js/contract-config.js`，包含合约地址和 ABI。

### 5. 启动前端

```shell
npm run dev
```

### 6. 浏览器访问

打开 `http://127.0.0.1:3000`。

### 7. MetaMask 配置

1. 在 MetaMask 中添加自定义网络：
   - 网络名称：`Hardhat`
   - RPC URL：`http://127.0.0.1:8545`
   - Chain ID：`31337`
   - 货币符号：`ETH`
2. 从 `npm run node` 的控制台输出中复制测试账户私钥，在 MetaMask 中导入。
3. 点击页面右上角「连接钱包」。

## 技术栈

| 组件 | 技术 |
|------|------|
| 智能合约 | Solidity 0.8.28 |
| 开发框架 | Hardhat + @nomicfoundation/hardhat-toolbox |
| 前端 | 原生 HTML/CSS/JavaScript（ES Module） |
| 链交互 | ethers.js v6 |
| 本地链 | Hardhat Network |
| 钱包 | MetaMask |

## npm 脚本

| 命令 | 作用 |
|------|------|
| `npm run compile` | 编译 Solidity 合约 |
| `npm test` | 运行合约测试（10 个用例） |
| `npm run node` | 启动 Hardhat 本地区块链节点 |
| `npm run deploy:localhost` | 部署合约到本地链并生成前端配置 |
| `npm run dev` | 启动前端静态服务器（默认 3000 端口） |
| `npm run dev:check` | 检查前端服务器能否正常启动 |
