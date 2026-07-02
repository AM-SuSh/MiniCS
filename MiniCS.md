# MiniCS：基于区块链的众筹系统

github链接：[AM-SuSh/MiniCS](https://github.com/AM-SuSh/MiniCS)

## 一、项目简介

MiniCS 是一个基于 Hardhat 的本地区块链众筹 DApp。合约负责项目创建、捐赠、结束结算、成功提现、失败退款，并包含两个优化功能：创建时可配置里程碑百分比、达标后释放阶段性资金，以及前 10 位早鸟捐赠者排名与奖励记录。

## 二、项目说明

### 2.1 业务流程

- **创建项目**

1. 用户点击前端"创建项目"。
2. `dapp.js` 打开创建弹窗。
3. 用户填写名称、描述、目标 ETH、里程碑比例（选填）、截止时间。
4. `handleCreateProject` 校验里程碑比例范围与截止时间。
5. `runTransaction` 调用合约 `createProject`。
6. 合约创建 `Project` 并触发 `ProjectCreated`。
7. 前端重新执行 `loadProjects`，列表更新。

- **捐赠项目与早鸟机制**

1. 用户打开项目详情并输入 ETH 金额。
2. `handleDonate` 将金额通过 `ethers.parseEther` 转换为 wei。
3. 调用合约 `donate(projectId, { value: amount })`。
4. 合约记录捐赠者、早鸟支持者和项目总金额。
5. 前端刷新项目详情和统计卡片，并根据是否新成为早鸟给出对应提示。

- **项目结算**

1. 项目到达截止时间后，任何用户可以点击结算。
2. 前端调用 `finalizeProject`。
3. 合约判断 `pledged >= goal`。
4. 如果成功，发起人可以提现。
5. 如果失败，捐赠者可以退款。

- **阶段性资金释放**

​	发起人在创建项目时可设置里程碑百分比（如 50%），表示筹款达到目标金额的 50% 时可提前释放资金。

1. 筹款达到 `goal × milestonePercent / 100` 门槛。
2. 发起人调用 `releaseMilestoneFunds`，提前提取当前已筹金额的 30%。
3. 前端详情页显示里程碑进度条和已释放状态。
4. 最终项目成功结算后，`withdrawFunds` 只会提取剩余资金（`pledged - releasedAmount`）。

- **失败退款**

1. 项目截止后未达到目标金额。
2. 任意用户先调用 `finalizeProject` 完成结算。
3. 捐赠者再调用 `claimRefund`。
4. 如果项目未释放过里程碑资金，全额退还捐赠金额。
5. 如果项目已释放过里程碑资金，按比例退还：每位捐赠者退回 `捐赠金额 × (总筹款 - 已释放) / 总筹款`，保证退款后合约余额归零。

### 2.2 项目特点

- 合约数据结构清晰，项目状态、捐赠记录、捐赠者列表和早期捐赠者列表分开维护。
- 使用事件记录全部关键操作，便于测试断言和链上追踪。
- 成功项目提现和失败项目退款拆分为不同函数，逻辑清楚。
- 里程碑百分比在创建时可自定义配置（1–100%），而非固定值，提高灵活性。
- 阶段性资金释放考虑了已释放金额，避免最终重复提现；失败退款时按比例扣除已释放部分，保证合约资金守恒。
- 前端使用只读 provider 加载数据，使用 MetaMask signer 执行写交易，读写职责分离。
- 右侧链上操作日志面板实时展示合约事件历史，从链上读取真实记录而非前端模拟。
- 项目生命周期自动同步：截止时刻到达后约 0.5 秒内自动归类到「可结束」，每 30 秒刷新剩余时间和状态统计。
- 交易等待优化：MetaMask 确认或区块确认超时只提示"较慢"，不直接判定失败，确认完成后自动刷新页面。
- 「已结束」项目按链上 `ProjectFinalized` 事件时间倒序排列，最近结算的排在最前。
- 已截止/已结算项目的详情页自动禁用捐赠表单和无效操作按钮，并按生命周期隐藏不相关操作。
- `scripts/deploy.js` 自动写入前端配置，减少手动复制合约地址和 ABI 的步骤。
- 测试覆盖了创建、捐赠、结算、提现、退款、里程碑、按比例退款和权限错误等核心场景（17 个测试用例）。

## 三、基础功能实现

### 3.1 功能一：项目创建

**作业要求**

允许用户提交项目名称、描述、筹款目标金额和截止日期等信息。合约需要存储这些项目信息，并为每个项目分配唯一 ID。

**合约实现**

对应文件：`contracts/Crowdfunding.sol`。

核心代码位置：

- `Project` 结构体：保存项目的完整信息。
- `projects` 数组：保存所有项目，数组下标就是项目 ID。
- `createProject(...)`：创建项目并写入链上。
- `ProjectCreated` 事件：记录项目创建行为。

`createProject` 的主要逻辑：

1. 校验项目名称不能为空。
2. 校验项目描述不能为空。
3. 校验目标金额必须大于 0。
4. 校验截止时间必须晚于当前区块时间。
5. 校验里程碑百分比不超过 100（与里程碑优化配合，详见 4.1）。
6. 使用 `projects.length` 作为新项目 ID。
7. 把项目写入 `projects` 数组。
8. 触发 `ProjectCreated` 事件。

每个众筹项目都被抽象为 `Project` 结构体。用户调用 `createProject` 时，合约先检查输入是否合法，然后用当前项目数组长度生成唯一 ID，再把名称、描述、目标金额、截止时间、里程碑百分比和发起人地址一起存入链上。因此每个项目创建后都可以通过 ID 查询，满足作业中"存储项目信息并分配唯一 ID"的要求。

### 3.2 功能二：资金捐赠与项目展示

**作业要求**

允许用户选择正在进行中的项目并捐赠一定数量的币，资金存入合约。合约需要记录每个捐赠者地址和捐赠金额，并更新项目当前筹款总额。前端需要展示所有正在进行和已结束的项目，包括名称、描述、目标金额、已筹金额、剩余时间和捐赠者列表。

**合约实现：捐赠与记录**

对应文件：`contracts/Crowdfunding.sol`。

核心代码位置：

- `donate(uint256 projectId)`：接收捐赠。
- `contributions`：记录某项目中某地址累计捐了多少。
- `contributors`：记录某项目的捐赠者列表。
- `contributorAdded`：避免同一个捐赠者重复进入列表。
- `project.donorCount`：记录捐赠者人数。
- `project.pledged`：记录项目当前筹款总额。

`donate` 的主要逻辑：

1. 检查项目存在。
2. 检查项目尚未到截止时间。
3. 检查项目尚未结算。
4. 检查 `msg.value > 0`，即捐赠金额必须大于 0。
5. 如果用户第一次捐赠该项目，把用户地址加入 `contributors` 并将 `donorCount` 加 1。
6. 若早鸟名额未满且该地址未被记录，记入早鸟列表并触发 `EarlyDonorRewarded`（详见 4.2）。
7. 累加用户个人捐赠金额：

```solidity
contributions[projectId][msg.sender] += msg.value;
```

8. 累加项目已筹金额：

```solidity
project.pledged += msg.value;
```

9. 触发 `Donated` 事件。

捐赠函数 `donate` 使用 `payable` 接收 ETH。合约把 ETH 留存在合约账户中，同时用双层 mapping 记录"某个项目中某个用户捐了多少钱"，再用地址数组记录捐赠者列表。项目总金额保存在 `pledged` 字段中，每次捐赠都会累加更新。

**合约实现：项目查询**

前端展示项目需要合约提供读取接口：

- `projectCount()`：获取项目总数。
- `getProject(projectId)`：获取项目基本信息和状态。
- `getContributors(projectId)`：获取捐赠者列表。
- `getEarlyDonors(projectId)`：获取早鸟捐赠者列表。
- `getContribution(projectId, donor)`：获取某地址在某项目中的捐赠金额。
- `isEarlyDonor(projectId, donor)` / `getEarlyDonorRank(projectId, donor)` / `earlyDonorSlotsRemaining(projectId)`：早鸟资格与名额查询。

这些函数都是只读函数，不改变链上状态，适合前端频繁调用。前端通过 `projectCount` 遍历所有链上项目，再分别调用 `getProject`、`getContributors`、`getEarlyDonors`，并按当前钱包地址查询本人的捐赠额与早鸟排名，因此页面能展示所有进行中、可结束和已结束项目。项目卡片展示名称、描述、目标金额、已筹金额、完成度和剩余时间；详情页在右上角展示发起人地址，并展示捐赠者、早鸟支持者和按里程碑门槛计算的进度条。

### 3.3 功能三：筹款结束逻辑

**作业要求**

基于时间结束。当达到项目截止日期时，任何人都可以调用合约函数结束项目。结束结果分为两种：

1. 达到或超过目标：项目成功，发起人可以提取筹集到的资金。
2. 未达到目标：项目失败，捐赠者可以取回自己的捐赠资金。

**合约实现：项目结算**

对应文件：`contracts/Crowdfunding.sol`，核心函数是 `finalizeProject(uint256 projectId)`。

主要逻辑：

1. 检查当前区块时间已经达到截止时间：

```solidity
require(block.timestamp >= project.deadline, "Deadline not reached");
```

2. 检查项目不能重复结算。
3. 设置 `project.finalized = true`。
4. 判断是否成功：

```solidity
project.successful = project.pledged >= project.goal;
```

5. 触发 `ProjectFinalized` 事件。

该函数没有 `onlyCreator` 限制，因此任何人都可以在截止时间后调用，符合题目要求。

**重要说明：结算和转账拆分**

作业描述中写到"达到或超过目标时，合约将资金转移给项目发起人"。本项目实现时将这个过程拆成两步：

1. `finalizeProject`：先结束项目并判断成功或失败。
2. `withdrawFunds`：项目成功后，由发起人主动提现。

这样做的好处是状态判断更清晰，资金转移入口更明确，也便于前端展示"可结束、成功结束、失败结束、已提现"等状态。最终效果仍然满足作业要求：成功项目的资金会由合约转给发起人。

**合约实现：成功后发起人提现**

核心函数是 `withdrawFunds(uint256 projectId)`。

限制条件：

- 项目必须已经结算。
- 项目必须成功。
- 只能由项目发起人调用（`onlyCreator`）。
- 不能重复提现。

提现金额：

```solidity
uint256 amount = project.pledged - project.releasedAmount;
```

这里减去 `releasedAmount` 是为了兼容可选优化中的阶段性资金释放，避免已经提前释放的资金在最终提现时重复转出。项目成功后，发起人调用 `withdrawFunds` 提现。合约会检查项目已经结束且达到目标，并且调用者必须是项目发起人。提现后设置 `withdrawn = true`，防止重复提现。

**合约实现：失败后捐赠者退款**

核心函数是 `claimRefund(uint256 projectId)`。

主要逻辑：

1. 检查项目必须已经结算：

```solidity
require(project.finalized, "Project not finalized");
```

2. 检查项目必须失败：

```solidity
require(!project.successful, "Project succeeded");
```

3. 读取当前用户在该项目中的捐赠金额，要求金额大于 0。
4. 计算可退金额。如果项目未释放过里程碑资金，全额退还；如果已释放过，按比例退还：

```solidity
uint256 refundable = project.pledged - project.releasedAmount;
uint256 amount = (contribution * refundable) / project.pledged;
```

5. 先将贡献记录清零，再把对应 ETH 转回用户，触发 `RefundClaimed` 事件。

这满足"捐赠者在项目失败后可以提取他们捐赠的资金"的要求；当项目曾经释放过里程碑资金时，退款会按比例扣除已释放部分，保证退款后合约余额归零、资金守恒（详见 4.1 与 12.5）。

## 四、优化功能实现

### 4.1 优化一：阶段性资金释放（里程碑）

**优化要求**

实现基于目标完成度的阶段性资金释放。捐款达到一定比例后，允许释放一部分资金。

**合约实现**

相关常量：

```solidity
uint256 public constant MILESTONE_RELEASE_PERCENT = 30;
uint256 public constant PERCENT_DENOMINATOR = 100;
```

规则：

- 项目发起人在创建项目时可设置 `milestonePercent`（1–100 之间的整数），表示里程碑门槛占目标金额的百分比。留空或设为 0 表示不启用里程碑。
- 筹款达到 `goal × milestonePercent / 100` 时，发起人可提前释放当前已筹金额的 30%。
- 每个项目最多释放一次阶段性资金。

核心函数：

- `hasMilestone(projectId)`：判断项目是否设置了里程碑（`milestonePercent > 0`）。
- `milestoneThresholdAmount(projectId)`：计算里程碑门槛金额（`goal × milestonePercent / 100`）。
- `canReleaseMilestone(projectId)`：判断是否可释放（已设里程碑、未结算、未释放过、已筹金额 ≥ 门槛）。
- `releaseMilestoneFunds(projectId)`：发起人释放当前已筹金额的 30%。

`releaseMilestoneFunds` 在校验通过后，先置 `milestoneReleased = true` 并记录 `releasedAmount`，再通过 `creator.call{value: amount}` 把资金转给发起人，最后触发 `MilestoneReleased` 事件。合约用 `milestoneReleased` 防止重复释放，并用 `releasedAmount` 记录已释放金额，最终提现时会扣除这部分资金。如果项目最终失败，捐赠者退款时也会按比例扣除已释放部分，保证合约资金守恒。

### 4.2 优化二：前 10 位早期捐赠者奖励

**优化要求**

增加基于时间的早期捐赠奖励机制，例如前 10 位捐款人可以获得额外感谢或未来福利。

**合约实现**

相关常量和存储：

```solidity
uint256 public constant EARLY_DONOR_LIMIT = 10;
mapping(uint256 => address[]) private earlyDonors;
mapping(uint256 => mapping(address => bool)) private earlyDonorAdded;
```

在 `donate` 中，如果当前项目早期捐赠者数量少于 10，并且该地址还没有被记录过，就加入 `earlyDonors`：

```solidity
earlyDonors[projectId].push(msg.sender);
emit EarlyDonorRewarded(projectId, msg.sender, earlyDonors[projectId].length);
```

查询函数：

- `getEarlyDonors(projectId)`：返回早期捐赠者列表。
- `isEarlyDonor(projectId, donor)`：判断某地址是否为早期捐赠者。
- `getEarlyDonorRank(projectId, donor)`：返回早期捐赠者排名（未上榜返回 0）。
- `earlyDonorSlotsRemaining(projectId)`：返回剩余名额。

早期捐赠者机制在每次捐赠时自动触发。合约只记录每个项目最早的 10 个不同地址，并保存排名。这个排名虽然不直接发币，但可以作为后续感谢、徽章或福利资格的链上凭证。前端详情页通过 `populateDetailCard` 展示早鸟徽章与排名；若当前连接钱包属于早鸟支持者，会在捐赠表单上方显示"您是第 N 位早鸟支持者"的提示。

## 五、智能合约总览

**事件**

合约定义 7 个事件，覆盖全部关键操作，便于测试断言与链上追踪：

| 事件 | 触发位置 | 关键参数 |
|------|----------|----------|
| `ProjectCreated` | `createProject` | 项目 ID、发起人、名称、目标、截止时间、里程碑百分比 |
| `Donated` | `donate` | 项目 ID、捐赠者、金额、累计已筹 |
| `EarlyDonorRewarded` | `donate`（早鸟名额未满时） | 项目 ID、捐赠者、排名 |
| `ProjectFinalized` | `finalizeProject` | 项目 ID、是否成功、最终已筹 |
| `MilestoneReleased` | `releaseMilestoneFunds` | 项目 ID、发起人、释放金额 |
| `FundsWithdrawn` | `withdrawFunds` | 项目 ID、发起人、提现金额 |
| `RefundClaimed` | `claimRefund` | 项目 ID、捐赠者、退款金额 |

**修饰符**

- `projectExists(projectId)`：校验项目 ID 不越界。
- `onlyCreator(projectId)`：校验调用者为项目发起人，用于 `releaseMilestoneFunds` 和 `withdrawFunds`。

**状态字段含义**

`Project` 结构体中关键字段：`pledged`（已筹总额）、`releasedAmount`（已释放金额）、`finalized`（是否结算）、`successful`（是否达标）、`withdrawn`（是否已提现）、`milestoneReleased`（是否已释放里程碑）、`milestonePercent`（创建时设定的门槛百分比）、`donorCount`（捐赠者人数）。

## 六、工程配置与脚本

 **`hardhat.config.js`**

- 引入 `@nomicfoundation/hardhat-toolbox` 和自定义任务 `tasks/chainInfo`。
- Solidity 版本 `0.8.28`，开启 optimizer（runs=200）。
- 配置 `localhost` 网络指向 `http://127.0.0.1:8545`。

**`scripts/deploy.js`**

部署脚本通过 `ethers.getContractFactory("Crowdfunding")` 部署合约，读取编译产物中的 ABI 和部署地址，写入 `src/js/contract-config.js`：

```js
export const contractAddress = "<部署地址>";
export const contractAbi = <ABI JSON>;
```

这样前端只需 import 该配置即可创建合约对象，避免手动复制地址和 ABI。脚本在 `npm run deploy:localhost` 时执行。

**`scripts/serve.js`**

前端静态服务器，`npm run dev` 时启动，默认监听 `127.0.0.1:3000`，根目录指向 `src/`。主要特性：

- 按扩展名设置 MIME 类型，统一 `Cache-Control: no-store`。
- 路径解析做防穿越校验，禁止访问 `src/` 之外的文件。
- 提供 `POST /rpc` 反向代理到 `RPC_URL`（默认 `http://127.0.0.1:8545`），便于在浏览器受 CORS 限制时回退使用。
- `--check` 参数用于 `npm run dev:check`，启动后立即自检并关闭，验证服务器可正常启动。

说明：前端 `dapp.js` 当前直接使用 `http://127.0.0.1:8545` 作为 RPC（Hardhat 节点已开启 CORS），`/rpc` 代理作为备用通道保留。

**`tasks/chainInfo.js`**

注册 `chain-info` 任务，输出网络名、最新区块号与时间，以及前 5 个测试账户地址和余额，便于本地调试时快速确认链状态。运行方式：`npx hardhat chain-info --network localhost`。

## 七、前端实现

对应目录：`src/`。前端为原生 HTML/CSS/JavaScript（ES Module），不依赖前端框架。

**模块组成**

- `src/index.html`：提供 DOM 结构、项目卡片与详情页模板、创建弹窗与钱包提示弹窗。
- `src/css/styles.css`：布局与视觉样式，含状态色、进度条、早鸟徽章、链上日志面板等。
- `src/js/dapp.js`：前端核心逻辑，负责连接钱包、加载项目、渲染卡片与详情、处理用户操作。
- `src/js/chain-log.js`：链上事件日志模块，统一查询 7 类事件并格式化展示。
- `src/js/contract-config.js`：部署后自动生成，提供合约地址与 ABI（`.gitignore` 忽略）。
- `src/js/contract-config.example.js`：配置模板，未部署时参考用。
- `src/js/ethers.min.js`：ethers.js v6 本地打包，供 ES Module 导入。

**读写分离与合约对象**

- 读数据使用独立的 `ethers.JsonRpcProvider`（`state.readProvider`）和只读合约对象 `state.readContract`，可在未连接钱包时加载项目列表。
- 写交易使用 `ethers.BrowserProvider(window.ethereum)` 获取 signer，构造 `state.contract` 执行 `createProject`、`donate`、`finalizeProject`、`releaseMilestoneFunds`、`withdrawFunds`、`claimRefund`。
- 读职责与写职责分离，避免未连接钱包时页面空白。

**项目加载与渲染**

`loadProjects` 读取项目总数后，并发拉取每个项目的 `getProject`、`getContributors`、`getEarlyDonors`，以及当前账户的 `getContribution` 与 `getEarlyDonorRank`；同时并发读取所有 `ProjectFinalized` 事件以获取结算时间。完成后调用 `renderProjects` 渲染列表与统计。所有链上读取都带 20 秒超时（`LOAD_TIMEOUT_MS`），超时给出明确提示。

**状态筛选与统计**

顶部统计区有四个卡片，前三个可点击切换筛选：

- 进行中（`active`）：未到截止且未结算。
- 可结束（`pending`）：已到截止但未结算。
- 已结束（`ended`）：已链上结算（含成功与失败）。

筛选口径与卡片状态色、详情页操作按钮一致，详见 `docs/status-filters.md`。「已结束」列表按 `ProjectFinalized` 事件所在区块时间倒序排列，最近结算的排在最前；缺失结算时间时回退到截止时间。

**生命周期自动同步**

`applyProjectLifecycle` 根据当前时间和链上 `finalized`/`successful` 字段推导展示状态。`scheduleLifecycleRefresh` 设置两种定时器：

- 距离下一个未结算项目截止时刻加 500ms 的精确定时器，到期后立即刷新归类并重新调度。
- 每 30 秒（`LIFECYCLE_TICK_MS`）的轮询定时器，刷新可见的时间标签与状态统计。

因此截止时刻到达后约 0.5 秒内项目会自动从「进行中」归类到「可结束」，无需手动刷新页面。

**操作可用性控制**

`getProjectActions(project)` 根据合约状态、当前时间和当前钱包地址，推导详情页每个操作是否可用及不可用原因：

- 捐赠：仅未截止且未结算时可用。
- 结束项目：仅到达截止且未结算时可用。
- 释放资金：仅发起人、已设里程碑、未结算、未释放且达到门槛时可用。
- 提现：仅发起人、已结算成功且未提现时可用。
- 退款：仅已结算失败且本人有贡献时可用。

不可用按钮会禁用并展示原因提示，与合约权限逻辑保持一致，避免用户提交必然失败的交易。详情页还会根据项目生命周期隐藏不相关的按钮（例如「可结束」状态下只显示结束按钮）。

**链上操作日志面板**

`chain-log.js` 的 `loadChainOperationLogs` 并发查询 7 类事件，按 `blockNumber * 100000 + logIndex` 排序后格式化为中文条目，包括创建、捐赠、早鸟、结算、释放、提现、退款。面板从链上读取真实事件而非前端模拟，按时间倒序展示，并显示事件总数与所在区块号。

**交易等待与错误提示**

`runTransaction` 统一处理写交易：提交后等待 MetaMask 确认、等待区块确认，每个阶段都设置 20 秒慢交易提示（"较慢"），不直接判定失败；确认完成后调用 `loadProjects` 自动刷新页面数据。链上读取异常会区分"链上找不到合约""合约版本与前端 ABI 不匹配"等场景，给出对应的重新部署与强制刷新指引。

## 八、部署模块

**`ignition/modules/Crowdfunding.js`**

Hardhat Ignition 的部署模块定义：

```js
const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("CrowdfundingModule", (m) => {
  const crowdfunding = m.contract("Crowdfunding");
  return { crowdfunding };
});
```

作用：

- 定义名为 `CrowdfundingModule` 的部署模块。
- 通过 `m.contract("Crowdfunding")` 声明部署 `Crowdfunding` 合约。
- 返回 `{ crowdfunding }`，使部署结果可被 Ignition 追踪和引用。

当前项目主要使用 `scripts/deploy.js` 部署，因为该脚本还会自动生成前端配置。Ignition 模块作为 Hardhat 官方部署方式的保留入口。

## 九、测试文件

**`test/Crowdfunding.js`**

合约测试文件，使用 Hardhat、ethers、Chai 和 Hardhat Network Helpers 编写。

### 9.1 测试依赖

```js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
```

- `expect`：断言。
- `ethers`：部署合约、获取账户、转换 ETH。
- `time`：控制 Hardhat 本地区块链时间。

**`deployFixture`**

部署测试合约并返回测试账户：

- `creator`：项目发起人。
- `donor`：捐赠者。
- `secondDonor`：第二个捐赠者。
- `stranger`：无关账户，用于测试权限限制。

测试辅助函数 `createProject` 用于创建默认项目，返回真实的 `projectId`（基于 `projectCount()`）。可通过 `overrides` 覆盖名称、描述、目标金额、截止时间或里程碑百分比。

### 9.2 测试用例说明

**createProject（3 个）**

1. `creates projects with unique ids`：连续创建两个项目，验证 ID 递增且字段正确。
2. `stores milestone percent only at creation time`：验证 `milestonePercent`、`hasMilestone`、`milestoneThresholdAmount`。
3. `rejects invalid createProject inputs`：空名称、空描述、目标为 0、截止时间为过去、`milestonePercent > 100` 均回滚。

**donate（4 个）**

4. `accepts donations and records contributors plus early donors`：捐赠触发 `Donated` 和 `EarlyDonorRewarded`，记录贡献者与早鸟。
5. `accumulates repeat donations without duplicating contributor or early donor slots`：同一地址多次捐赠只计 1 位捐赠者和 1 个早鸟名额。
6. `blocks donations after deadline or after finalization`：截止后或已结算项目捐赠回滚 `Project ended`。
7. `tracks early donor rank and remaining slots`：验证早鸟排名和剩余名额。

**finalizeProject（3 个）**

8. `finalizes a successful project and lets the creator withdraw`：达标后结算并提现。
9. `finalizes a failed project and lets donors claim refunds`：未达标先结算再退款，须先 `finalizeProject`。
10. `blocks finalize before deadline and duplicate finalize`：截止前结算和重复结算均被拒绝。

**milestone release（4 个）**

11. `releases milestone funds after pledged amount reaches the preset percent`：50% 门槛达标后释放 30%，成功后提现剩余部分。
12. `uses milestonePercent from creation instead of a fixed threshold`：30% 自定义门槛，验证非固定 50% 逻辑。
13. `blocks milestone release when no milestone was set at creation`：未设里程碑时 `milestoneThresholdAmount` 为 0，释放被拒绝。
14. `blocks invalid milestone release attempts`：非发起人、重复释放、未达门槛时均被拒绝。

**withdraw and refund guards（3 个）**

15. `blocks invalid withdrawals and refunds`：未结算退款、非发起人提现、失败项目提现、无贡献退款均被拒绝。
16. `blocks refund on successful projects and duplicate withdrawals`：成功项目退款回滚 `Project succeeded`，重复提现回滚 `Already withdrawn`。
17. `refunds donors proportionally after a failed project released milestone funds`：已释放里程碑后失败，两位捐赠者按比例退款，合约余额归零。
