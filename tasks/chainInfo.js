task("chain-info", "Show local chain accounts and latest block").setAction(async (_, hre) => {
  const accounts = await hre.ethers.getSigners();
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  const block = await hre.ethers.provider.getBlock(blockNumber);

  console.log(`Network: ${hre.network.name}`);
  console.log(`Latest block: #${blockNumber} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);

  for (const account of accounts.slice(0, 5)) {
    const balance = await hre.ethers.provider.getBalance(account.address);
    console.log(`${account.address}  ${hre.ethers.formatEther(balance)} ETH`);
  }
});

module.exports = {};

