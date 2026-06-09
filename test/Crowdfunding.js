const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Crowdfunding", function () {
  async function deployFixture() {
    const [creator, donor, secondDonor, stranger] = await ethers.getSigners();
    const Crowdfunding = await ethers.getContractFactory("Crowdfunding");
    const crowdfunding = await Crowdfunding.deploy();
    await crowdfunding.waitForDeployment();

    return { crowdfunding, creator, donor, secondDonor, stranger };
  }

  async function createProject(crowdfunding, creator, overrides = {}) {
    const latest = await time.latest();
    const deadline = overrides.deadline ?? latest + 7 * 24 * 60 * 60;
    const goal = overrides.goal ?? ethers.parseEther("5");

    await crowdfunding
      .connect(creator)
      .createProject(
        overrides.name ?? "Open Source Lab",
        overrides.description ?? "Fund a small open source hardware lab.",
        goal,
        deadline
      );

    return { projectId: 0, goal, deadline };
  }

  it("creates a project with a unique id", async function () {
    const { crowdfunding, creator } = await deployFixture();
    const latest = await time.latest();
    const deadline = latest + 3600;
    const goal = ethers.parseEther("10");

    await expect(
      crowdfunding
        .connect(creator)
        .createProject("Campus DAO", "A student community project.", goal, deadline)
    )
      .to.emit(crowdfunding, "ProjectCreated")
      .withArgs(0, creator.address, "Campus DAO", goal, deadline);

    expect(await crowdfunding.projectCount()).to.equal(1);

    const project = await crowdfunding.getProject(0);
    expect(project.id).to.equal(0);
    expect(project.creator).to.equal(creator.address);
    expect(project.name).to.equal("Campus DAO");
    expect(project.goal).to.equal(goal);
    expect(project.deadline).to.equal(deadline);
  });

  it("accepts donations and records contributors plus early donors", async function () {
    const { crowdfunding, creator, donor, secondDonor } = await deployFixture();
    await createProject(crowdfunding, creator);

    await expect(
      crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") })
    )
      .to.emit(crowdfunding, "Donated")
      .withArgs(0, donor.address, ethers.parseEther("1"), ethers.parseEther("1"));

    await crowdfunding.connect(secondDonor).donate(0, { value: ethers.parseEther("2") });

    const project = await crowdfunding.getProject(0);
    expect(project.pledged).to.equal(ethers.parseEther("3"));
    expect(project.donorCount).to.equal(2);
    expect(await crowdfunding.getContribution(0, donor.address)).to.equal(
      ethers.parseEther("1")
    );

    const contributors = await crowdfunding.getContributors(0);
    expect(contributors).to.deep.equal([donor.address, secondDonor.address]);

    const earlyDonors = await crowdfunding.getEarlyDonors(0);
    expect(earlyDonors).to.deep.equal([donor.address, secondDonor.address]);
    expect(await crowdfunding.isEarlyDonor(0, donor.address)).to.equal(true);
  });

  it("finalizes a successful project and lets the creator withdraw", async function () {
    const { crowdfunding, creator, donor } = await deployFixture();
    const { deadline } = await createProject(crowdfunding, creator, {
      goal: ethers.parseEther("1")
    });

    await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });
    await time.increaseTo(deadline + 1);

    await expect(crowdfunding.connect(donor).finalizeProject(0))
      .to.emit(crowdfunding, "ProjectFinalized")
      .withArgs(0, true, ethers.parseEther("1"));

    await expect(crowdfunding.connect(creator).withdrawFunds(0)).to.changeEtherBalances(
      [crowdfunding, creator],
      [ethers.parseEther("-1"), ethers.parseEther("1")]
    );

    const project = await crowdfunding.getProject(0);
    expect(project.successful).to.equal(true);
    expect(project.withdrawn).to.equal(true);
  });

  it("finalizes a failed project and lets donors claim refunds", async function () {
    const { crowdfunding, creator, donor } = await deployFixture();
    const { deadline } = await createProject(crowdfunding, creator, {
      goal: ethers.parseEther("5")
    });

    await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });
    await time.increaseTo(deadline + 1);

    await expect(crowdfunding.connect(donor).claimRefund(0)).to.changeEtherBalances(
      [crowdfunding, donor],
      [ethers.parseEther("-1"), ethers.parseEther("1")]
    );

    expect(await crowdfunding.getContribution(0, donor.address)).to.equal(0);
    const project = await crowdfunding.getProject(0);
    expect(project.finalized).to.equal(true);
    expect(project.successful).to.equal(false);
  });

  it("releases a milestone payment after the goal is reached", async function () {
    const { crowdfunding, creator, donor } = await deployFixture();
    const { deadline } = await createProject(crowdfunding, creator, {
      goal: ethers.parseEther("2")
    });

    await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("2") });

    await expect(crowdfunding.connect(creator).releaseMilestoneFunds(0)).to.changeEtherBalances(
      [crowdfunding, creator],
      [ethers.parseEther("-0.6"), ethers.parseEther("0.6")]
    );

    let project = await crowdfunding.getProject(0);
    expect(project.milestoneReleased).to.equal(true);
    expect(project.releasedAmount).to.equal(ethers.parseEther("0.6"));

    await time.increaseTo(deadline + 1);
    await crowdfunding.finalizeProject(0);

    await expect(crowdfunding.connect(creator).withdrawFunds(0)).to.changeEtherBalances(
      [crowdfunding, creator],
      [ethers.parseEther("-1.4"), ethers.parseEther("1.4")]
    );

    project = await crowdfunding.getProject(0);
    expect(project.withdrawn).to.equal(true);
  });

  it("blocks invalid withdrawals and refunds", async function () {
    const { crowdfunding, creator, donor, stranger } = await deployFixture();
    const { deadline } = await createProject(crowdfunding, creator, {
      goal: ethers.parseEther("2")
    });

    await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });

    await expect(crowdfunding.connect(stranger).withdrawFunds(0)).to.be.revertedWith(
      "Only creator"
    );

    await time.increaseTo(deadline + 1);
    await crowdfunding.finalizeProject(0);

    await expect(crowdfunding.connect(creator).withdrawFunds(0)).to.be.revertedWith(
      "Project failed"
    );
    await expect(crowdfunding.connect(stranger).claimRefund(0)).to.be.revertedWith(
      "No contribution"
    );
  });
});

