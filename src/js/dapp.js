import { ethers } from "./ethers.min.js";
import { contractAbi, contractAddress } from "./contract-config.js";
import { loadChainOperationLogs, loadProjectFinalizeTimes } from "./chain-log.js";

// Hardhat 本地节点默认地址，已开启 CORS，无需经前端 /rpc 代理
const RPC_URL = "http://127.0.0.1:8545";
const LOAD_TIMEOUT_MS = 20000;
const EARLY_DONOR_LIMIT = 10;
const LIFECYCLE_TICK_MS = 30000;

const state = {
  provider: null,
  signer: null,
  contract: null,
  readProvider: null,
  readContract: null,
  account: "",
  filter: "active",
  projects: [],
  loadProjectsPromise: null,
  selectedProjectId: null,
  lifecycleInterval: null,
  lifecycleDeadlineTimer: null
};

const els = {
  connectWalletBtn: document.getElementById("connectWalletBtn"),
  createModal: document.getElementById("createModal"),
  createProjectForm: document.getElementById("createProjectForm"),
  toggleCreateBtn: document.getElementById("toggleCreateBtn"),
  closeCreateBtn: document.getElementById("closeCreateBtn"),
  cancelCreateBtn: document.getElementById("cancelCreateBtn"),
  createModalBackdrop: document.getElementById("createModalBackdrop"),
  projectList: document.getElementById("projectList"),
  projectListView: document.getElementById("projectListView"),
  projectCompactTemplate: document.getElementById("projectCompactTemplate"),
  projectDetailTemplate: document.getElementById("projectDetailTemplate"),
  projectDetailView: document.getElementById("projectDetailView"),
  projectDetailBody: document.getElementById("projectDetailBody"),
  closeDetailBtn: document.getElementById("closeDetailBtn"),
  statsStrip: document.getElementById("statsStrip"),
  projectsSection: document.querySelector(".projects-section"),
  walletAddress: document.getElementById("walletAddress"),
  networkDot: document.getElementById("networkDot"),
  notice: document.getElementById("notice"),
  noticeMessage: document.getElementById("noticeMessage"),
  noticeTime: document.getElementById("noticeTime"),
  noticeLevel: document.getElementById("noticeLevel"),
  noticeType: document.getElementById("noticeType"),
  chainLogCount: document.getElementById("chainLogCount"),
  chainLogList: document.getElementById("chainLogList"),
  chainLogEmpty: document.getElementById("chainLogEmpty"),
  refreshBtn: document.getElementById("refreshBtn"),
  statFilterBtns: document.querySelectorAll(".stat-card--filterable"),
  summaryProjects: document.getElementById("summaryProjects"),
  summaryActive: document.getElementById("summaryActive"),
  summaryEnded: document.getElementById("summaryEnded"),
  summaryPledged: document.getElementById("summaryPledged"),
  walletPromptModal: document.getElementById("walletPromptModal"),
  walletPromptBackdrop: document.getElementById("walletPromptBackdrop"),
  walletPromptMessage: document.getElementById("walletPromptMessage"),
  walletPromptCloseBtn: document.getElementById("walletPromptCloseBtn"),
  walletPromptConnectBtn: document.getElementById("walletPromptConnectBtn"),
  deadlineInput: document.querySelector("input[name='deadline']")
};

function getMilestoneThresholdAmount(project) {
  if (project.milestonePercent <= 0) return 0n;
  return (project.goal * BigInt(project.milestonePercent)) / 100n;
}

function hasMilestone(project) {
  return project.milestonePercent > 0;
}

function canReleaseMilestone(project) {
  if (!hasMilestone(project) || project.finalized || project.milestoneReleased) return false;
  return project.pledged >= getMilestoneThresholdAmount(project);
}

function renderMilestoneProgress(card, project) {
  const panel = card.querySelector(".milestone-panel");
  if (!panel) return;

  panel.hidden = !hasMilestone(project);
  if (!hasMilestone(project)) return;

  const fill = panel.querySelector(".milestone-progress__fill");
  const marker = panel.querySelector(".milestone-progress__marker");
  const target = panel.querySelector(".milestone-panel__target");
  const value = panel.querySelector(".milestone-panel__value");
  const threshold = getMilestoneThresholdAmount(project);
  const milestoneProgress =
    threshold === 0n ? 0 : Number((project.pledged * 10000n) / threshold) / 100;
  const progressPercent = Math.min(milestoneProgress, 100);

  if (target) target.textContent = `${project.milestonePercent}%`;

  fill.style.width = `${progressPercent}%`;
  marker.style.left = `${progressPercent}%`;
  marker.title = `里程碑目标 ${formatEth(threshold)} ETH`;
  marker.classList.toggle("is-reached", progressPercent >= 100);
  marker.classList.toggle("is-released", project.milestoneReleased);
  value.textContent = `${progressPercent.toFixed(1)}%`;
}

function isWalletConnected() {
  return Boolean(state.contract && state.account);
}

function openWalletPrompt(message = "进行链上操作前，需要先连接 MetaMask 钱包。") {
  if (!els.walletPromptModal) {
    showNotice("请先连接钱包。", "error");
    return;
  }
  els.walletPromptMessage.textContent = message;
  els.walletPromptModal.hidden = false;
  els.walletPromptModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeWalletPrompt() {
  if (!els.walletPromptModal) return;
  els.walletPromptModal.hidden = true;
  els.walletPromptModal.setAttribute("aria-hidden", "true");
  if (els.createModal?.hidden !== false) {
    document.body.classList.remove("modal-open");
  }
}

function requireWallet(actionLabel = "进行链上操作") {
  if (isWalletConnected()) return true;
  openWalletPrompt(`${actionLabel}前，请先连接 MetaMask 钱包。`);
  return false;
}

function syncDeadlineEmptyState() {
  if (!els.deadlineInput) return;
  els.deadlineInput.classList.toggle("is-empty", !els.deadlineInput.value);
}

function shortAddress(address) {
  if (!address) return "-";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatEth(value) {
  return Number(ethers.formatEther(value)).toLocaleString("zh-CN", {
    maximumFractionDigits: 4
  });
}

function showNotice(message, type = "info") {
  const isError = type === "error";
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", { hour12: false });

  if (els.noticeMessage) {
    els.noticeMessage.textContent = message;
    els.noticeTime.textContent = time;
    els.noticeLevel.textContent = isError ? "error" : "info";
    els.noticeType.textContent = isError ? "ERROR" : "INFO";
  } else {
    els.notice.textContent = message;
  }
  els.notice.classList.toggle("error", isError);
  els.notice.hidden = false;
}

function clearNotice() {
  els.notice.hidden = false;
  if (els.noticeMessage) {
    els.noticeMessage.textContent = "等待链上操作事件";
    els.noticeTime.textContent = "--:--:--";
    els.noticeLevel.textContent = "ready";
    els.noticeType.textContent = "READY";
    els.notice.classList.remove("error");
    return;
  }
  els.notice.textContent = "";
}

function chainLogTypeLabel(type) {
  const labels = {
    project_created: "create",
    donated: "donate",
    early_donor_rewarded: "early",
    project_finalized: "finalize",
    milestone_released: "milestone",
    funds_withdrawn: "withdraw",
    refund_claimed: "refund"
  };
  return labels[type] || type;
}

function renderChainLogs(logs) {
  if (!els.chainLogList) return;

  els.chainLogCount.textContent = logs.length.toString();
  els.chainLogEmpty.hidden = logs.length > 0;
  els.chainLogList.replaceChildren();

  for (const log of [...logs].reverse()) {
    const item = document.createElement("article");
    item.className = `chain-log-item chain-log-item--${log.type}`;
    item.title = `block #${log.blockNumber}`;

    const time = document.createElement("span");
    time.className = "chain-log-item__time";
    time.textContent = log.time;

    const type = document.createElement("span");
    type.className = "chain-log-item__type";
    type.textContent = chainLogTypeLabel(log.type);

    const message = document.createElement("span");
    message.className = "chain-log-item__message";
    message.textContent = log.message;

    item.append(time, type, message);
    els.chainLogList.appendChild(item);
  }
}

async function syncChainLogs(contract = getReadContract()) {
  const logs = await loadChainOperationLogs(contract, formatEth, shortAddress);
  renderChainLogs(logs);
  return logs;
}

function requireContractConfig() {
  if (!contractAddress || contractAbi.length === 0) {
    throw new Error("请先运行 npm run deploy:localhost 部署合约，生成前端合约配置。");
  }
}

function requireConnected() {
  requireContractConfig();
  if (!state.contract) {
    throw new Error("请先连接钱包，再执行链上操作。");
  }
}

function setButtonBusy(button, busy, label = "处理中...") {
  if (!button) return;

  const isIconBtn = button.classList.contains("icon-btn");

  if (busy) {
    if (!button.classList.contains("is-loading")) {
      if (isIconBtn) {
        button.dataset.defaultLabel = button.getAttribute("aria-label") || "";
      } else {
        button.dataset.defaultLabel = button.textContent;
      }
    }
    if (isIconBtn) {
      button.setAttribute("aria-label", label);
    } else {
      button.textContent = label;
    }
    button.classList.add("is-loading");
    button.disabled = true;
    return;
  }

  if (isIconBtn) {
    if (button.dataset.defaultLabel !== undefined) {
      button.setAttribute("aria-label", button.dataset.defaultLabel);
      delete button.dataset.defaultLabel;
    }
  } else if (button.dataset.defaultLabel) {
    button.textContent = button.dataset.defaultLabel;
    delete button.dataset.defaultLabel;
  }
  button.classList.remove("is-loading");
  button.disabled = false;
}

function withTimeout(promise, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), LOAD_TIMEOUT_MS);
    })
  ]);
}

function showSlowTransactionNotice(message) {
  const timerId = window.setTimeout(() => {
    showNotice(message);
  }, LOAD_TIMEOUT_MS);

  return () => window.clearTimeout(timerId);
}

function formatLoadError(error) {
  const message = error?.shortMessage || error?.reason || error?.message || String(error);
  if (message.includes("could not decode result data") || error?.code === "BAD_DATA") {
    return "链上找不到众筹合约，或合约版本与前端不一致。请在新终端运行 npm run deploy:localhost 重新部署，并强制刷新页面（Ctrl+F5）。";
  }
  if (
    message.includes("unrecognized-selector") ||
    (message.includes("missing revert data") && !message.includes("Project does not exist"))
  ) {
    return "链上合约版本与前端 ABI 不匹配。请确认 npm run node 正在运行，再执行 npm run deploy:localhost，然后强制刷新浏览器（Ctrl+F5）。";
  }
  return message;
}

async function getReadProvider() {
  if (!state.readProvider) {
    state.readProvider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return state.readProvider;
}

async function ensureContractDeployed() {
  const provider = await getReadProvider();
  const code = await provider.getCode(contractAddress);
  if (!code || code === "0x") {
    throw new Error("链上找不到众筹合约，本地区块链可能已重启。请在新终端运行 npm run deploy:localhost 重新部署。");
  }

  const contract = new ethers.Contract(contractAddress, contractAbi, provider);
  try {
    await contract.milestoneThresholdAmount(0);
  } catch (error) {
    const message = error?.shortMessage || error?.reason || error?.message || "";
    if (!message.includes("Project does not exist")) {
      throw new Error(
        "链上合约版本与前端不一致。请运行 npm run deploy:localhost 重新部署，并强制刷新浏览器（Ctrl+F5）。"
      );
    }
  }
}

function getReadContract() {
  requireContractConfig();
  if (!state.readContract) {
    state.readContract = new ethers.Contract(contractAddress, contractAbi, state.readProvider);
  }
  return state.readContract;
}

function renderSkeleton() {
  els.projectList.setAttribute("aria-busy", "true");
  els.projectList.innerHTML = `
    <div class="skeleton-card">正在读取链上项目...</div>
    <div class="skeleton-card" aria-hidden="true"></div>
  `;
}

async function connectWallet() {
  requireContractConfig();
  if (!window.ethereum) {
    throw new Error("请安装 MetaMask，或使用支持 ethereum provider 的浏览器。");
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  state.contract = new ethers.Contract(contractAddress, contractAbi, state.signer);

  els.walletAddress.textContent = shortAddress(state.account);
  els.walletAddress.title = state.account;
  els.networkDot.classList.add("connected");
}

function applyProjectLifecycle(project, now = Math.floor(Date.now() / 1000)) {
  if (project.finalized) {
    project.status = project.successful ? "成功结束" : "失败结束";
    project.statusType = project.successful ? "success" : "failed";
    project.isEnded = true;
    return;
  }

  project.isEnded = false;
  if (project.deadline <= now) {
    project.status = "可结束";
    project.statusType = "pending";
    return;
  }

  project.status = "进行中";
  project.statusType = "active";
}

function parseProject(raw, contributors, contributorDetails, earlyDonors, myContribution = 0n, myEarlyRank = 0) {
  const deadline = Number(raw.deadline);
  const pledged = raw.pledged;
  const goal = raw.goal;
  const percent = goal === 0n ? 0 : Number((pledged * 10000n) / goal) / 100;

  const project = {
    id: Number(raw.id),
    creator: raw.creator,
    name: raw.name,
    description: raw.description,
    goal,
    deadline,
    pledged,
    releasedAmount: raw.releasedAmount,
    finalized: raw.finalized,
    successful: raw.successful,
    withdrawn: raw.withdrawn,
    milestonePercent: Number(raw.milestonePercent),
    milestoneReleased: raw.milestoneReleased,
    donorCount: Number(raw.donorCount),
    contributors,
    contributorDetails,
    earlyDonors,
    myContribution,
    myEarlyRank,
    percent,
    status: "进行中",
    statusType: "active",
    isEnded: raw.finalized,
    finalizedAt: 0
  };

  applyProjectLifecycle(project);
  return project;
}

function isAwaitingFinalize(project, now = Math.floor(Date.now() / 1000)) {
  return !project.finalized && project.deadline <= now;
}

function syncProjectLifecycle() {
  if (!state.projects.length) return false;

  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const project of state.projects) {
    const prevType = project.statusType;
    applyProjectLifecycle(project, now);
    if (prevType !== project.statusType) changed = true;
  }
  return changed;
}

function updateVisibleTimeLabels() {
  for (const card of els.projectList.querySelectorAll(".project-card--compact")) {
    const project = state.projects.find((item) => item.id === Number(card.dataset.projectId));
    if (!project) continue;
    card.querySelector(".project-time").textContent = getTimeLabel(project.deadline, project.finalized);
  }

  if (state.selectedProjectId === null) return;

  const card = els.projectDetailBody.querySelector(".project-card");
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!card || !project) return;

  card.querySelector(".project-time").textContent = getTimeLabel(project.deadline, project.finalized);
}

function refreshLifecyclePresentation() {
  const changed = syncProjectLifecycle();
  if (changed) {
    renderSummary(state.projects);
    renderProjects();
    return;
  }
  updateVisibleTimeLabels();
}

function scheduleLifecycleRefresh() {
  clearTimeout(state.lifecycleDeadlineTimer);
  clearInterval(state.lifecycleInterval);

  const now = Math.floor(Date.now() / 1000);
  let nextDeadline = Infinity;
  for (const project of state.projects) {
    if (!project.finalized && project.deadline > now) {
      nextDeadline = Math.min(nextDeadline, project.deadline);
    }
  }

  if (nextDeadline !== Infinity) {
    const delay = Math.max(nextDeadline - now, 0) * 1000 + 500;
    state.lifecycleDeadlineTimer = setTimeout(() => {
      refreshLifecyclePresentation();
      scheduleLifecycleRefresh();
    }, delay);
  }

  state.lifecycleInterval = setInterval(refreshLifecyclePresentation, LIFECYCLE_TICK_MS);
}

async function loadProjects() {
  if (state.loadProjectsPromise) {
    return state.loadProjectsPromise;
  }

  state.loadProjectsPromise = (async () => {
    renderSkeleton();

    try {
      requireContractConfig();
      await ensureContractDeployed();
      await getReadProvider();
      const contract = getReadContract();
      const count = Number(await withTimeout(contract.projectCount(), "读取项目数量超时，请确认本地区块链已启动。"));
      const account = state.account;
      const [projects, finalizeTimes] = await Promise.all([
        withTimeout(
          Promise.all(
            Array.from({ length: count }, (_, id) =>
              Promise.all([
                contract.getProject(id),
                contract.getContributors(id),
                contract.getEarlyDonors(id),
                account ? contract.getContribution(id, account) : Promise.resolve(0n),
                account ? contract.getEarlyDonorRank(id, account) : Promise.resolve(0n)
              ]).then(async ([raw, contributors, earlyDonors, myContribution, myEarlyRank]) => {
                const contributorDetails = await Promise.all(
                  contributors.map(async (address) => ({
                    address,
                    amount: await contract.getContribution(id, address)
                  }))
                );
                return parseProject(
                  raw,
                  contributors,
                  contributorDetails,
                  earlyDonors,
                  myContribution,
                  Number(myEarlyRank)
                );
              })
            )
          ),
          "读取项目详情超时，请稍后重试。"
        ),
        loadProjectFinalizeTimes(contract).catch(() => new Map())
      ]);

      for (const project of projects) {
        project.finalizedAt = finalizeTimes.get(project.id) ?? 0;
      }

      state.projects = projects;
      scheduleLifecycleRefresh();
      renderProjects();
      try {
        await syncChainLogs(contract);
      } catch (logError) {
        showNotice(`链上操作记录读取失败：${logError.message}`, "error");
      }
      return true;
    } catch (error) {
      showNotice(formatLoadError(error), "error");
      renderProjects();
      return false;
    } finally {
      els.projectList.removeAttribute("aria-busy");
      state.loadProjectsPromise = null;
    }
  })();

  return state.loadProjectsPromise;
}

function renderSummary(projects) {
  const active = projects.filter((project) => project.statusType === "active").length;
  const pending = projects.filter((project) => project.statusType === "pending").length;
  const ended = projects.filter((project) => project.isEnded).length;
  const pledged = projects.reduce((sum, project) => sum + project.pledged, 0n);

  els.summaryProjects.textContent = active.toString();
  els.summaryActive.textContent = pending.toString();
  els.summaryEnded.textContent = ended.toString();
  els.summaryPledged.textContent = formatEth(pledged);
}

function getTimeLabel(deadline, finalized) {
  if (finalized) return "已结束";

  const seconds = deadline - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "可结束";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${Math.max(minutes, 1)} 分钟`;
}

function matchesFilter(project) {
  if (state.filter === "active") return project.statusType === "active";
  if (state.filter === "pending") return project.statusType === "pending";
  if (state.filter === "ended") return project.isEnded;
  return true;
}

function updateFilterCards() {
  for (const button of els.statFilterBtns) {
    const selected = button.dataset.filter === state.filter;
    button.classList.toggle("stat-card--selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

function setProjectFilter(filter) {
  state.filter = filter;
  updateFilterCards();
  if (state.selectedProjectId !== null) {
    closeProjectDetail();
  }
  renderProjects();
}

function isProjectCreator(project) {
  return Boolean(state.account) && state.account.toLowerCase() === project.creator.toLowerCase();
}

function getProjectActions(project) {
  const now = Math.floor(Date.now() / 1000);
  const isCreator = isProjectCreator(project);
  const ended = project.deadline <= now;

  const canFinalize = !project.finalized && ended;
  const canMilestone =
    isCreator &&
    hasMilestone(project) &&
    !project.finalized &&
    !project.milestoneReleased &&
    canReleaseMilestone(project);
  const canWithdraw = isCreator && project.finalized && project.successful && !project.withdrawn;
  const canRefund =
    !project.successful && project.myContribution > 0n && project.finalized;

  let finalizeReason = "";
  if (project.finalized) finalizeReason = "项目已结算";
  else if (!ended) finalizeReason = "尚未到截止时间";

  let milestoneReason = "";
  if (!hasMilestone(project)) milestoneReason = "创建时未设置里程碑";
  else if (!state.account) milestoneReason = "请先连接钱包";
  else if (!isCreator) milestoneReason = "仅项目发起人可操作";
  else if (project.finalized) milestoneReason = "项目已结算";
  else if (project.milestoneReleased) milestoneReason = "阶段资金已释放";
  else if (project.pledged < getMilestoneThresholdAmount(project)) {
    milestoneReason = `需筹满里程碑 ${project.milestonePercent}%（${formatEth(getMilestoneThresholdAmount(project))} ETH）`;
  }

  let withdrawReason = "";
  if (!state.account) withdrawReason = "请先连接钱包";
  else if (!isCreator) withdrawReason = "仅项目发起人可操作";
  else if (!project.finalized) withdrawReason = "项目尚未结算";
  else if (!project.successful) withdrawReason = "项目未达标";
  else if (project.withdrawn) withdrawReason = "筹款已提现";

  let refundReason = "";
  if (!state.account) refundReason = "请先连接钱包";
  else if (project.myContribution === 0n) refundReason = "您尚未捐赠此项目";
  else if (project.successful) refundReason = "项目已成功，无法退款";
  else if (!project.finalized && ended) refundReason = "请先结束项目后再申请退款";
  else if (!project.finalized) refundReason = "项目仍在进行中";

  let donateReason = "";
  if (project.finalized) donateReason = "项目已结束";
  else if (ended) donateReason = "项目已截止，无法继续捐赠";

  return {
    canDonate: !project.finalized && project.deadline > now,
    donateReason,
    finalize: { available: canFinalize, reason: finalizeReason },
    milestone: { available: canMilestone, reason: milestoneReason },
    withdraw: { available: canWithdraw, reason: withdrawReason },
    refund: { available: canRefund, reason: refundReason }
  };
}

function applyActionButton(button, action) {
  button.hidden = false;
  button.classList.toggle("action-btn--off", !action.available);
  button.dataset.available = action.available ? "true" : "false";
  button.title = action.available ? "" : action.reason;
}

function applyDonateForm(donateForm, actions) {
  const submitBtn = donateForm.querySelector("button[type='submit']");
  const amountInput = donateForm.querySelector("input[name='amount']");

  donateForm.hidden = false;
  if (actions.canDonate) {
    submitBtn.disabled = false;
    amountInput.disabled = false;
    submitBtn.classList.remove("action-btn--off");
    submitBtn.title = "";
    return;
  }

  submitBtn.disabled = true;
  amountInput.disabled = true;
  submitBtn.classList.add("action-btn--off");
  submitBtn.title = actions.donateReason;
}

function sortProjectsForFilter(projects) {
  if (state.filter !== "ended") return projects;

  return [...projects].sort((a, b) => {
    const aTime = a.finalizedAt || a.deadline;
    const bTime = b.finalizedAt || b.deadline;
    return bTime - aTime || b.id - a.id;
  });
}

function setStatusBadge(statusEl, project) {
  statusEl.textContent = project.status;
  statusEl.classList.toggle("active", project.statusType === "active");
  statusEl.classList.toggle("pending", project.statusType === "pending");
  statusEl.classList.toggle("success", project.statusType === "success");
  statusEl.classList.toggle("failed", project.statusType === "failed");
}

function populateCompactCard(card, project) {
  const progress = card.querySelector(".progress-bar span");
  const status = card.querySelector(".project-status");

  card.dataset.projectId = project.id;
  card.classList.remove("status-active", "status-success", "status-failed");
  card.classList.add(`status-${project.statusType}`);
  card.querySelector(".project-id").textContent = `#${project.id}`;
  card.querySelector(".project-title").textContent = project.name;
  card.querySelector(".project-description").textContent = project.description;
  card.querySelector(".project-pledged").textContent = formatEth(project.pledged);
  card.querySelector(".project-goal").textContent = formatEth(project.goal);
  card.querySelector(".project-percent").textContent = `${Math.min(project.percent, 999).toFixed(1)}%`;
  card.querySelector(".project-time").textContent = getTimeLabel(project.deadline, project.finalized);
  const badgesEl = card.querySelector(".project-compact-badges");
  if (badgesEl) {
    const badges = [];
    const slotsLeft = Math.max(EARLY_DONOR_LIMIT - project.earlyDonors.length, 0);
    if (slotsLeft > 0) badges.push(`早鸟余 ${slotsLeft}`);
    else if (project.earlyDonors.length > 0) badges.push("早鸟已满");
    if (hasMilestone(project)) {
      if (!project.milestoneReleased && canReleaseMilestone(project)) {
        badges.push("可释放资金");
      } else if (project.milestoneReleased) {
        badges.push("已释放 30%");
      } else {
        badges.push(`里程碑 ${project.milestonePercent}%`);
      }
    }
    badgesEl.textContent = badges.length ? ` · ${badges.join(" · ")}` : "";
  }
  setStatusBadge(status, project);
  progress.style.width = `${Math.min(project.percent, 100)}%`;
}

function populateDetailCard(card, project) {
  const progress = card.querySelector(".progress-bar span");
  const status = card.querySelector(".project-status");

  card.dataset.projectId = project.id;
  card.classList.remove("status-active", "status-success", "status-failed");
  card.classList.add(`status-${project.statusType}`);
  card.querySelector(".project-id").textContent = `#${project.id}`;
  card.querySelector(".project-title").textContent = project.name;
  card.querySelector(".project-description").textContent = project.description;
  card.querySelector(".project-pledged").textContent = formatEth(project.pledged);
  card.querySelector(".project-goal").textContent = formatEth(project.goal);
  card.querySelector(".project-percent").textContent = `${Math.min(project.percent, 999).toFixed(1)}%`;
  card.querySelector(".project-time").textContent = getTimeLabel(project.deadline, project.finalized);
  card.querySelector(".project-creator").textContent = project.creator;
  card.querySelector(".project-creator").title = project.creator;
  const donorsEl = card.querySelector(".project-donors");
  if (project.contributorDetails.length === 0) {
    donorsEl.textContent = "暂无";
    donorsEl.classList.remove("donor-list");
  } else {
    donorsEl.classList.add("donor-list");
    donorsEl.innerHTML = project.contributorDetails
      .map(
        ({ address, amount }) =>
          `<span class="donor-chip" title="${address}">${shortAddress(address)} · ${formatEth(amount)} ETH</span>`
      )
      .join("");
  }
  const earlyList = card.querySelector(".project-early");
  const earlySlotsHint = card.querySelector(".early-slots-hint");
  const slotsLeft = Math.max(EARLY_DONOR_LIMIT - project.earlyDonors.length, 0);
  if (earlySlotsHint) {
    earlySlotsHint.textContent =
      slotsLeft > 0 ? `（剩余 ${slotsLeft} 个早鸟名额）` : "（名额已满）";
  }
  if (project.earlyDonors.length === 0) {
    earlyList.textContent = "暂无";
    earlyList.classList.remove("early-donor-list");
  } else {
    earlyList.classList.add("early-donor-list");
    earlyList.innerHTML = project.earlyDonors
      .map((address, index) => {
        const rank = index + 1;
        const isMe =
          state.account && address.toLowerCase() === state.account.toLowerCase();
        return `<span class="early-badge${isMe ? " early-badge--me" : ""}" title="第 ${rank} 位早鸟支持者">#${rank} ${shortAddress(address)}</span>`;
      })
      .join("");
  }
  if (project.myEarlyRank > 0) {
    const donorForm = card.querySelector(".donate-form");
    if (donorForm && !donorForm.querySelector(".early-rank-note")) {
      const note = document.createElement("p");
      note.className = "early-rank-note";
      note.textContent = `您是第 ${project.myEarlyRank} 位早鸟支持者，将获得额外感谢与后续福利。`;
      donorForm.insertAdjacentElement("beforebegin", note);
    }
  }

  renderMilestoneProgress(card, project);

  setStatusBadge(status, project);
  progress.style.width = `${Math.min(project.percent, 100)}%`;

  const actions = getProjectActions(project);
  const donateForm = card.querySelector(".donate-form");
  const finalizeBtn = card.querySelector(".finalize-btn");
  const milestoneBtn = card.querySelector(".milestone-btn");
  const withdrawBtn = card.querySelector(".withdraw-btn");
  const refundBtn = card.querySelector(".refund-btn");
  const awaitingFinalize = isAwaitingFinalize(project);

  if (awaitingFinalize) {
    applyDonateForm(donateForm, actions);
    milestoneBtn.hidden = true;
    withdrawBtn.hidden = true;
    refundBtn.hidden = true;
    finalizeBtn.hidden = false;
    applyActionButton(finalizeBtn, actions.finalize);
    return;
  }

  applyDonateForm(donateForm, actions);

  finalizeBtn.hidden = project.finalized;
  if (!project.finalized) {
    applyActionButton(finalizeBtn, actions.finalize);
  }

  if (hasMilestone(project) && !project.finalized) {
    milestoneBtn.hidden = false;
    applyActionButton(milestoneBtn, actions.milestone);
  } else {
    milestoneBtn.hidden = true;
  }

  if (project.finalized) {
    withdrawBtn.hidden = false;
    refundBtn.hidden = false;
    applyActionButton(withdrawBtn, actions.withdraw);
    applyActionButton(refundBtn, actions.refund);
  } else {
    withdrawBtn.hidden = true;
    refundBtn.hidden = true;
  }
}

function openProjectDetail(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;

  applyProjectLifecycle(project);
  state.selectedProjectId = projectId;
  els.projectDetailBody.innerHTML = "";
  const fragment = els.projectDetailTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".project-card");
  card.classList.add("project-card--detail");
  populateDetailCard(card, project);
  els.projectDetailBody.appendChild(fragment);

  els.projectListView.hidden = true;
  els.statsStrip.hidden = true;
  els.projectDetailView.hidden = false;
  document.body.classList.add("detail-open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeProjectDetail() {
  state.selectedProjectId = null;
  els.projectListView.hidden = false;
  els.statsStrip.hidden = false;
  els.projectDetailView.hidden = true;
  els.projectDetailBody.innerHTML = "";
  document.body.classList.remove("detail-open");
}

function renderProjectDetail() {
  if (state.selectedProjectId === null) return;

  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!project || !matchesFilter(project)) {
    closeProjectDetail();
    return;
  }

  openProjectDetail(project.id);
}

function renderProjects() {
  syncProjectLifecycle();
  renderSummary(state.projects);
  els.projectList.innerHTML = "";

  const projects = sortProjectsForFilter(state.projects.filter(matchesFilter));
  if (projects.length === 0) {
    if (state.selectedProjectId !== null) {
      closeProjectDetail();
    }
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无符合条件的众筹项目";
    els.projectList.appendChild(empty);
    return;
  }

  for (const project of projects) {
    const fragment = els.projectCompactTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".project-card");
    populateCompactCard(card, project);
    els.projectList.appendChild(fragment);
  }

  renderProjectDetail();
}

function handleBoardClick(event) {
  const compactCard = event.target.closest(".project-card--compact");
  if (compactCard) {
    openProjectDetail(Number(compactCard.dataset.projectId));
    return;
  }

  void handleProjectClick(event).catch((error) => {
    showNotice(error.shortMessage || error.reason || error.message, "error");
  });
}

function handleBoardKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;

  const compactCard = event.target.closest(".project-card--compact");
  if (!compactCard) return;

  event.preventDefault();
  openProjectDetail(Number(compactCard.dataset.projectId));
}

async function runTransaction(action, successMessage, trigger) {
  let clearSlowNotice = () => {};

  try {
    requireConnected();
    clearNotice();
    setButtonBusy(trigger, true);

    clearSlowNotice = showSlowTransactionNotice("MetaMask 确认较慢，请在钱包弹窗中确认或拒绝；确认后会自动刷新页面数据。");
    const tx = await action();
    clearSlowNotice();

    showNotice("交易已提交，等待区块确认...");
    clearSlowNotice = showSlowTransactionNotice("区块确认较慢，请稍候；确认完成后会自动刷新页面数据。");
    await tx.wait();
    clearSlowNotice();

    showNotice(successMessage);
    await loadProjects();
    return true;
  } catch (error) {
    showNotice(error.shortMessage || error.reason || error.message, "error");
    return false;
  } finally {
    clearSlowNotice();
    setButtonBusy(trigger, false);
  }
}

async function handleCreateProject(event) {
  event.preventDefault();

  if (!requireWallet("创建众筹项目")) return;

  const formEl = event.currentTarget;
  const submitter = event.submitter;
  const form = new FormData(formEl);
  const name = form.get("name").trim();
  const description = form.get("description").trim();
  const goalInput = form.get("goal");
  const milestoneInput = String(form.get("milestonePercent") ?? "").trim();
  const deadlineValue = form.get("deadline");
  const deadline = Math.floor(new Date(deadlineValue).getTime() / 1000);
  const goal = ethers.parseEther(goalInput);
  let milestonePercent = 0;

  if (milestoneInput) {
    milestonePercent = Number(milestoneInput);
    if (!Number.isInteger(milestonePercent) || milestonePercent < 1 || milestonePercent > 100) {
      showNotice("里程碑比例必须是 1 到 100 之间的整数。", "error");
      return;
    }
  }

  if (deadline <= Math.floor(Date.now() / 1000)) {
    showNotice("截止时间必须晚于当前时间。", "error");
    return;
  }

  const ok = await runTransaction(
    () => state.contract.createProject(name, description, goal, deadline, milestonePercent),
    milestonePercent > 0 ? "项目创建成功，已登记里程碑" : "项目创建成功",
    submitter
  );

  if (!ok) return;

  formEl.reset();
  closeCreateModal();
}

function openCreateModal() {
  if (!els.createModal) return;
  if (!requireWallet("创建众筹项目")) return;

  els.createModal.hidden = false;
  els.createModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  els.toggleCreateBtn?.classList.add("nav-link--active");
  els.createProjectForm.querySelector("input[name='name']")?.focus();
}

function closeCreateModal() {
  if (!els.createModal) return;
  els.createModal.hidden = true;
  els.createModal.setAttribute("aria-hidden", "true");
  if (els.walletPromptModal?.hidden !== false) {
    document.body.classList.remove("modal-open");
  }
  els.toggleCreateBtn?.classList.remove("nav-link--active");
}

async function handleProjectClick(event) {
  const button = event.target.closest(".action-row button");
  if (!button) return;

  const card = button.closest(".project-card");
  if (!card) return;

  const projectId = Number(card.dataset.projectId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;

  if (button.dataset.available !== "true") {
    if (!requireWallet("执行此操作")) return;
    showNotice(button.title || "当前暂不可执行此操作", "error");
    return;
  }

  if (button.classList.contains("finalize-btn")) {
    await runTransaction(
      () => state.contract.finalizeProject(projectId),
      "项目已结束",
      button
    );
    return;
  }

  if (button.classList.contains("milestone-btn")) {
    await runTransaction(
      () => state.contract.releaseMilestoneFunds(projectId),
      "阶段资金已释放",
      button
    );
    return;
  }

  if (button.classList.contains("withdraw-btn")) {
    await runTransaction(
      () => state.contract.withdrawFunds(projectId),
      "筹款已提现",
      button
    );
    return;
  }

  if (button.classList.contains("refund-btn")) {
    await runTransaction(
      () => state.contract.claimRefund(projectId),
      "退款已到账",
      button
    );
  }
}

async function handleDonate(event) {
  event.preventDefault();

  const form = event.target;
  if (!form.classList.contains("donate-form")) return;

  if (!requireWallet("捐赠")) return;

  const card = form.closest(".project-card");
  if (!card) return;

  const amountInput = new FormData(form).get("amount");
  if (!amountInput || Number(amountInput) <= 0) {
    showNotice("请输入有效的捐赠金额。", "error");
    return;
  }

  const projectId = Number(card.dataset.projectId);
  const project = state.projects.find((item) => item.id === projectId);
  const amount = ethers.parseEther(amountInput);
  const submitButton = event.submitter || form.querySelector("button[type='submit']");
  const wasEarlyDonor = project?.earlyDonors.some(
    (address) => address.toLowerCase() === state.account.toLowerCase()
  );
  const slotsLeftBefore = project ? EARLY_DONOR_LIMIT - project.earlyDonors.length : 0;

  await runTransaction(
    () => state.contract.donate(projectId, { value: amount }),
    wasEarlyDonor || slotsLeftBefore === 0
      ? "捐赠成功"
      : `捐赠成功！您已成为第 ${project.earlyDonors.length + 1} 位早鸟支持者，将获得额外感谢与后续福利`,
    submitButton
  );

  form.reset();
}

async function init() {
  els.connectWalletBtn.addEventListener("click", async () => {
    try {
      clearNotice();
      setButtonBusy(els.connectWalletBtn, true, "连接中...");
      await connectWallet();
      showNotice("钱包已连接");
      await loadProjects();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(els.connectWalletBtn, false);
    }
  });

  els.createProjectForm.addEventListener("submit", (event) => {
    void handleCreateProject(event).catch((error) => {
      showNotice(error.shortMessage || error.reason || error.message, "error");
    });
  });
  els.toggleCreateBtn?.addEventListener("click", openCreateModal);
  els.closeCreateBtn?.addEventListener("click", closeCreateModal);
  els.cancelCreateBtn?.addEventListener("click", closeCreateModal);
  els.createModalBackdrop?.addEventListener("click", closeCreateModal);
  els.walletPromptBackdrop?.addEventListener("click", closeWalletPrompt);
  els.walletPromptCloseBtn?.addEventListener("click", closeWalletPrompt);
  els.walletPromptConnectBtn?.addEventListener("click", async () => {
    closeWalletPrompt();
    els.connectWalletBtn?.click();
  });
  els.deadlineInput?.addEventListener("input", syncDeadlineEmptyState);
  els.deadlineInput?.addEventListener("change", syncDeadlineEmptyState);
  syncDeadlineEmptyState();
  els.projectsSection.addEventListener("click", handleBoardClick);
  els.projectsSection.addEventListener("keydown", handleBoardKeydown);
  els.projectsSection.addEventListener("submit", (event) => {
    if (event.target.classList.contains("donate-form")) {
      void handleDonate(event).catch((error) => {
        showNotice(error.shortMessage || error.reason || error.message, "error");
      });
    }
  });
  els.closeDetailBtn.addEventListener("click", closeProjectDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (els.walletPromptModal && !els.walletPromptModal.hidden) {
      closeWalletPrompt();
      return;
    }
    if (els.createModal && !els.createModal.hidden) {
      closeCreateModal();
      return;
    }
    if (state.selectedProjectId !== null) {
      closeProjectDetail();
    }
  });
  els.refreshBtn.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      requireContractConfig();
      setButtonBusy(button, true, "刷新中...");
      const ok = await loadProjects();
      if (ok) {
        showNotice("项目列表已刷新");
      }
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(button, false);
    }
  });

  for (const button of els.statFilterBtns) {
    button.addEventListener("click", () => {
      setProjectFilter(button.dataset.filter);
    });
  }
  updateFilterCards();

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
  }

  try {
    requireContractConfig();
    showNotice("正在读取链上众筹项目...");
    const ok = await loadProjects();
    if (ok) {
      showNotice("项目列表已加载，连接钱包后可执行链上操作");
    }
  } catch (error) {
    showNotice(error.message, "error");
  }
}

window.addEventListener("load", init);
