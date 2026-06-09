import { ethers } from "./ethers.min.js";
import { contractAbi, contractAddress } from "./contract-config.js";

const state = {
  provider: null,
  signer: null,
  contract: null,
  account: "",
  filter: "all",
  projects: []
};

const els = {
  connectWalletBtn: document.getElementById("connectWalletBtn"),
  createProjectForm: document.getElementById("createProjectForm"),
  projectList: document.getElementById("projectList"),
  projectTemplate: document.getElementById("projectTemplate"),
  walletAddress: document.getElementById("walletAddress"),
  networkDot: document.getElementById("networkDot"),
  notice: document.getElementById("notice"),
  refreshBtn: document.getElementById("refreshBtn"),
  filterBtns: document.querySelectorAll(".filter-btn"),
  summaryProjects: document.getElementById("summaryProjects"),
  summaryActive: document.getElementById("summaryActive"),
  summaryPledged: document.getElementById("summaryPledged")
};

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
  els.notice.textContent = message;
  els.notice.classList.toggle("error", type === "error");
  els.notice.hidden = false;
}

function clearNotice() {
  els.notice.hidden = true;
  els.notice.textContent = "";
}

function requireContractConfig() {
  if (!contractAddress || contractAbi.length === 0) {
    throw new Error("请先运行 npm run deploy:localhost 部署合约，生成前端合约配置。");
  }
}

async function connectWallet() {
  requireContractConfig();
  if (!window.ethereum) {
    throw new Error("请安装 MetaMask 或使用支持 ethereum provider 的浏览器。");
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

function parseProject(raw, contributors, earlyDonors) {
  const now = Math.floor(Date.now() / 1000);
  const deadline = Number(raw.deadline);
  const pledged = raw.pledged;
  const goal = raw.goal;
  const percent = goal === 0n ? 0 : Number((pledged * 10000n) / goal) / 100;

  let status = "进行中";
  if (raw.finalized) {
    status = raw.successful ? "成功结束" : "失败结束";
  } else if (deadline <= now) {
    status = "待结束";
  }

  return {
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
    milestoneReleased: raw.milestoneReleased,
    donorCount: Number(raw.donorCount),
    contributors,
    earlyDonors,
    percent,
    status,
    isEnded: raw.finalized || deadline <= now
  };
}

async function loadProjects() {
  if (!state.contract) return;

  const count = Number(await state.contract.projectCount());
  const projects = [];

  for (let id = 0; id < count; id += 1) {
    const [raw, contributors, earlyDonors] = await Promise.all([
      state.contract.getProject(id),
      state.contract.getContributors(id),
      state.contract.getEarlyDonors(id)
    ]);
    projects.push(parseProject(raw, contributors, earlyDonors));
  }

  state.projects = projects;
  renderProjects();
}

function renderSummary(projects) {
  const active = projects.filter((project) => !project.isEnded).length;
  const pledged = projects.reduce((sum, project) => sum + project.pledged, 0n);

  els.summaryProjects.textContent = projects.length.toString();
  els.summaryActive.textContent = active.toString();
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
  if (state.filter === "active") return !project.isEnded;
  if (state.filter === "ended") return project.isEnded;
  return true;
}

function renderProjects() {
  renderSummary(state.projects);
  els.projectList.innerHTML = "";

  const projects = state.projects.filter(matchesFilter);
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无符合条件的众筹项目";
    els.projectList.appendChild(empty);
    return;
  }

  for (const project of projects) {
    const fragment = els.projectTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".project-card");
    const progress = fragment.querySelector(".progress-bar span");
    const status = fragment.querySelector(".project-status");

    card.dataset.projectId = project.id;
    fragment.querySelector(".project-id").textContent = `#${project.id}`;
    fragment.querySelector(".project-title").textContent = project.name;
    fragment.querySelector(".project-description").textContent = project.description;
    fragment.querySelector(".project-pledged").textContent = formatEth(project.pledged);
    fragment.querySelector(".project-goal").textContent = formatEth(project.goal);
    fragment.querySelector(".project-percent").textContent = `${Math.min(project.percent, 999).toFixed(1)}%`;
    fragment.querySelector(".project-time").textContent = getTimeLabel(project.deadline, project.finalized);
    fragment.querySelector(".project-creator").textContent = shortAddress(project.creator);
    fragment.querySelector(".project-creator").title = project.creator;
    fragment.querySelector(".project-donors").textContent =
      project.contributors.map(shortAddress).join(", ") || "暂无";
    fragment.querySelector(".project-early").textContent =
      project.earlyDonors.map(shortAddress).join(", ") || "暂无";

    status.textContent = project.status;
    status.classList.toggle("success", project.finalized && project.successful);
    status.classList.toggle("failed", project.finalized && !project.successful);
    progress.style.width = `${Math.min(project.percent, 100)}%`;

    const isCreator = state.account.toLowerCase() === project.creator.toLowerCase();
    const canDonate = !project.finalized && project.deadline > Math.floor(Date.now() / 1000);
    const canFinalize = !project.finalized && project.deadline <= Math.floor(Date.now() / 1000);
    const canRelease = isCreator && !project.finalized && !project.milestoneReleased && project.pledged >= project.goal;
    const canWithdraw = isCreator && project.finalized && project.successful && !project.withdrawn;
    const canRefund = project.finalized && !project.successful;

    fragment.querySelector(".donate-form button").disabled = !canDonate;
    fragment.querySelector(".finalize-btn").disabled = !canFinalize;
    fragment.querySelector(".milestone-btn").disabled = !canRelease;
    fragment.querySelector(".withdraw-btn").disabled = !canWithdraw;
    fragment.querySelector(".refund-btn").disabled = !canRefund;

    els.projectList.appendChild(fragment);
  }
}

async function runTransaction(action, successMessage) {
  try {
    clearNotice();
    const tx = await action();
    showNotice("交易已提交，等待区块确认...");
    await tx.wait();
    showNotice(successMessage);
    await loadProjects();
  } catch (error) {
    showNotice(error.shortMessage || error.reason || error.message, "error");
  }
}

async function handleCreateProject(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const name = form.get("name").trim();
  const description = form.get("description").trim();
  const goal = ethers.parseEther(form.get("goal"));
  const deadlineValue = form.get("deadline");
  const deadline = Math.floor(new Date(deadlineValue).getTime() / 1000);

  await runTransaction(
    () => state.contract.createProject(name, description, goal, deadline),
    "项目创建成功"
  );
  event.currentTarget.reset();
}

async function handleProjectClick(event) {
  const card = event.target.closest(".project-card");
  if (!card) return;

  const projectId = Number(card.dataset.projectId);
  if (event.target.classList.contains("finalize-btn")) {
    await runTransaction(() => state.contract.finalizeProject(projectId), "项目已结束");
  }

  if (event.target.classList.contains("milestone-btn")) {
    await runTransaction(() => state.contract.releaseMilestoneFunds(projectId), "阶段资金已释放");
  }

  if (event.target.classList.contains("withdraw-btn")) {
    await runTransaction(() => state.contract.withdrawFunds(projectId), "筹款已提现");
  }

  if (event.target.classList.contains("refund-btn")) {
    await runTransaction(() => state.contract.claimRefund(projectId), "退款已到账");
  }
}

async function handleDonate(event) {
  event.preventDefault();
  const card = event.target.closest(".project-card");
  const projectId = Number(card.dataset.projectId);
  const form = new FormData(event.currentTarget);
  const amount = ethers.parseEther(form.get("amount"));

  await runTransaction(
    () => state.contract.donate(projectId, { value: amount }),
    "捐赠成功"
  );
  event.currentTarget.reset();
}

async function init() {
  els.connectWalletBtn.addEventListener("click", async () => {
    try {
      await connectWallet();
      showNotice("钱包已连接");
      await loadProjects();
    } catch (error) {
      showNotice(error.message, "error");
    }
  });

  els.createProjectForm.addEventListener("submit", handleCreateProject);
  els.projectList.addEventListener("click", handleProjectClick);
  els.projectList.addEventListener("submit", (event) => {
    if (event.target.classList.contains("donate-form")) {
      handleDonate(event);
    }
  });
  els.refreshBtn.addEventListener("click", loadProjects);

  for (const button of els.filterBtns) {
    button.addEventListener("click", () => {
      els.filterBtns.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.filter;
      renderProjects();
    });
  }

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
  }

  try {
    requireContractConfig();
    showNotice("请连接钱包以读取链上众筹项目");
  } catch (error) {
    showNotice(error.message, "error");
  }
}

window.addEventListener("load", init);

