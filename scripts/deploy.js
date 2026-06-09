const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const Crowdfunding = await hre.ethers.getContractFactory("Crowdfunding");
  const crowdfunding = await Crowdfunding.deploy();
  await crowdfunding.waitForDeployment();

  const address = await crowdfunding.getAddress();
  const artifact = await hre.artifacts.readArtifact("Crowdfunding");
  const configPath = path.join(__dirname, "..", "src", "js", "contract-config.js");
  const content = `export const contractAddress = "${address}";\nexport const contractAbi = ${JSON.stringify(
    artifact.abi,
    null,
    2
  )};\n`;

  fs.writeFileSync(configPath, content);

  console.log(`Crowdfunding deployed to ${address}`);
  console.log(`Frontend config written to ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

