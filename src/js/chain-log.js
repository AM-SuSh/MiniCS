const EVENT_NAMES = [
  "ProjectCreated",
  "Donated",
  "EarlyDonorRewarded",
  "ProjectFinalized",
  "MilestoneReleased",
  "FundsWithdrawn",
  "RefundClaimed"
];

function eventOrder(event) {
  return event.blockNumber * 100000 + event.logIndex;
}

function blockTimeLabel(timestamp) {
  if (!timestamp) return "--:--:--";
  return new Date(Number(timestamp) * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

function projectLabel(projectId) {
  return `#${Number(projectId)}`;
}

function formatEventMessage(eventName, args, formatEth, shortAddress) {
  if (eventName === "ProjectCreated") {
    const milestoneText = Number(args.milestonePercent) > 0
      ? `，里程碑 ${Number(args.milestonePercent)}%`
      : "";
    return `创建项目 ${projectLabel(args.projectId)}「${args.name}」，目标 ${formatEth(args.goal)} ETH${milestoneText}`;
  }

  if (eventName === "Donated") {
    return `${shortAddress(args.donor)} 向项目 ${projectLabel(args.projectId)} 捐赠 ${formatEth(args.amount)} ETH，累计 ${formatEth(args.pledged)} ETH`;
  }

  if (eventName === "EarlyDonorRewarded") {
    return `${shortAddress(args.donor)} 成为项目 ${projectLabel(args.projectId)} 第 ${Number(args.rank)} 位早鸟支持者`;
  }

  if (eventName === "ProjectFinalized") {
    return `项目 ${projectLabel(args.projectId)} 已结算：${args.successful ? "成功" : "失败"}，最终筹集 ${formatEth(args.pledged)} ETH`;
  }

  if (eventName === "MilestoneReleased") {
    return `项目 ${projectLabel(args.projectId)} 释放阶段资金 ${formatEth(args.amount)} ETH 给 ${shortAddress(args.creator)}`;
  }

  if (eventName === "FundsWithdrawn") {
    return `项目 ${projectLabel(args.projectId)} 发起人 ${shortAddress(args.creator)} 提现 ${formatEth(args.amount)} ETH`;
  }

  if (eventName === "RefundClaimed") {
    return `${shortAddress(args.donor)} 从项目 ${projectLabel(args.projectId)} 申请退款 ${formatEth(args.amount)} ETH`;
  }

  return eventName;
}

function eventType(eventName) {
  return eventName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export async function loadChainOperationLogs(contract, formatEth, shortAddress) {
  const eventGroups = await Promise.all(
    EVENT_NAMES.map(async (eventName) => {
      const filter = contract.filters[eventName]();
      const logs = await contract.queryFilter(filter, 0, "latest");
      return logs.map((log) => ({ eventName, log }));
    })
  );

  const events = eventGroups
    .flat()
    .map(({ eventName, log }) => ({
      eventName,
      args: log.args,
      blockNumber: Number(log.blockNumber),
      logIndex: Number(log.index ?? log.logIndex ?? 0),
      transactionHash: log.transactionHash
    }))
    .sort((a, b) => eventOrder(a) - eventOrder(b));

  const provider = contract.runner?.provider || contract.runner;
  const blockNumbers = [...new Set(events.map((event) => event.blockNumber))];
  const blocks = provider?.getBlock
    ? await Promise.all(blockNumbers.map((blockNumber) => provider.getBlock(blockNumber)))
    : [];
  const blockTimes = new Map(blocks.filter(Boolean).map((block) => [Number(block.number), block.timestamp]));

  return events.map((event) => ({
    id: `${event.blockNumber}-${event.logIndex}-${event.eventName}`,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
    time: blockTimeLabel(blockTimes.get(event.blockNumber)),
    type: eventType(event.eventName),
    message: formatEventMessage(event.eventName, event.args, formatEth, shortAddress)
  }));
}
