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
    const milestonePercent = overrides.milestonePercent ?? 0n;
    const projectId = Number(await crowdfunding.projectCount());

    await crowdfunding
      .connect(creator)
      .createProject(
        overrides.name ?? "Open Source Lab",
        overrides.description ?? "Fund a small open source hardware lab.",
        goal,
        deadline,
        milestonePercent
      );

    return { projectId, goal, deadline, milestonePercent };
  }

  describe("createProject", function () {
    it("creates projects with unique ids", async function () {
      const { crowdfunding, creator } = await deployFixture();
      const latest = await time.latest();
      const deadline = latest + 3600;
      const goal = ethers.parseEther("10");

      await expect(
        crowdfunding
          .connect(creator)
          .createProject("Campus DAO", "A student community project.", goal, deadline, 0)
      )
        .to.emit(crowdfunding, "ProjectCreated")
        .withArgs(0, creator.address, "Campus DAO", goal, deadline, 0);

      await createProject(crowdfunding, creator, { name: "Second Project" });

      expect(await crowdfunding.projectCount()).to.equal(2);

      const first = await crowdfunding.getProject(0);
      const second = await crowdfunding.getProject(1);
      expect(first.id).to.equal(0);
      expect(second.id).to.equal(1);
      expect(first.name).to.equal("Campus DAO");
      expect(second.name).to.equal("Second Project");
    });

    it("stores milestone percent only at creation time", async function () {
      const { crowdfunding, creator } = await deployFixture();

      await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("5"),
        milestonePercent: 50n
      });

      const project = await crowdfunding.getProject(0);
      expect(project.milestonePercent).to.equal(50);
      expect(await crowdfunding.hasMilestone(0)).to.equal(true);
      expect(await crowdfunding.milestoneThresholdAmount(0)).to.equal(ethers.parseEther("2.5"));
    });

    it("rejects invalid createProject inputs", async function () {
      const { crowdfunding, creator } = await deployFixture();
      const latest = await time.latest();
      const deadline = latest + 3600;
      const goal = ethers.parseEther("1");

      await expect(
        crowdfunding.connect(creator).createProject("", "desc", goal, deadline, 0)
      ).to.be.revertedWith("Name required");

      await expect(
        crowdfunding.connect(creator).createProject("name", "", goal, deadline, 0)
      ).to.be.revertedWith("Description required");

      await expect(
        crowdfunding.connect(creator).createProject("name", "desc", 0, deadline, 0)
      ).to.be.revertedWith("Goal must be positive");

      await expect(
        crowdfunding.connect(creator).createProject("name", "desc", goal, latest, 0)
      ).to.be.revertedWith("Deadline must be future");

      await expect(
        crowdfunding.connect(creator).createProject("name", "desc", goal, deadline, 101)
      ).to.be.revertedWith("Invalid milestone percent");
    });
  });

  describe("donate", function () {
    it("accepts donations and records contributors plus early donors", async function () {
      const { crowdfunding, creator, donor, secondDonor } = await deployFixture();
      await createProject(crowdfunding, creator);

      await expect(
        crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") })
      )
        .to.emit(crowdfunding, "Donated")
        .withArgs(0, donor.address, ethers.parseEther("1"), ethers.parseEther("1"))
        .and.to.emit(crowdfunding, "EarlyDonorRewarded")
        .withArgs(0, donor.address, 1);

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

    it("accumulates repeat donations without duplicating contributor or early donor slots", async function () {
      const { crowdfunding, creator, donor } = await deployFixture();
      await createProject(crowdfunding, creator);

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("0.5") });
      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("0.5") });

      const project = await crowdfunding.getProject(0);
      expect(project.pledged).to.equal(ethers.parseEther("1"));
      expect(project.donorCount).to.equal(1);
      expect(await crowdfunding.getContribution(0, donor.address)).to.equal(ethers.parseEther("1"));
      expect(await crowdfunding.getEarlyDonors(0)).to.deep.equal([donor.address]);
      expect(await crowdfunding.getEarlyDonorRank(0, donor.address)).to.equal(1);
    });

    it("blocks donations after deadline or after finalization", async function () {
      const { crowdfunding, creator, donor } = await deployFixture();
      const { deadline } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("5")
      });

      await time.increaseTo(deadline + 1);
      await expect(
        crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Project ended");

      const { projectId: secondProjectId } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("5")
      });
      await crowdfunding.connect(donor).donate(secondProjectId, { value: ethers.parseEther("1") });
      const secondProject = await crowdfunding.getProject(secondProjectId);
      await time.increaseTo(Number(secondProject.deadline) + 1);
      await crowdfunding.finalizeProject(secondProjectId);

      await expect(
        crowdfunding.connect(donor).donate(secondProjectId, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Project ended");
    });

    it("tracks early donor rank and remaining slots", async function () {
      const { crowdfunding, creator, donor, secondDonor } = await deployFixture();
      await createProject(crowdfunding, creator);

      expect(await crowdfunding.earlyDonorSlotsRemaining(0)).to.equal(10);
      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("0.1") });
      expect(await crowdfunding.getEarlyDonorRank(0, donor.address)).to.equal(1);
      expect(await crowdfunding.earlyDonorSlotsRemaining(0)).to.equal(9);

      await crowdfunding.connect(secondDonor).donate(0, { value: ethers.parseEther("0.1") });
      expect(await crowdfunding.getEarlyDonorRank(0, secondDonor.address)).to.equal(2);
      expect(await crowdfunding.getEarlyDonorRank(0, creator.address)).to.equal(0);
    });
  });

  describe("finalizeProject", function () {
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

      await expect(crowdfunding.connect(donor).finalizeProject(0))
        .to.emit(crowdfunding, "ProjectFinalized")
        .withArgs(0, false, ethers.parseEther("1"));

      await expect(crowdfunding.connect(donor).claimRefund(0)).to.changeEtherBalances(
        [crowdfunding, donor],
        [ethers.parseEther("-1"), ethers.parseEther("1")]
      );

      expect(await crowdfunding.getContribution(0, donor.address)).to.equal(0);
      const project = await crowdfunding.getProject(0);
      expect(project.finalized).to.equal(true);
      expect(project.successful).to.equal(false);
    });

    it("blocks finalize before deadline and duplicate finalize", async function () {
      const { crowdfunding, creator, donor } = await deployFixture();
      const { deadline } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("2")
      });

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });

      await expect(crowdfunding.finalizeProject(0)).to.be.revertedWith("Deadline not reached");

      await time.increaseTo(deadline + 1);
      await crowdfunding.finalizeProject(0);

      await expect(crowdfunding.finalizeProject(0)).to.be.revertedWith("Already finalized");
    });
  });

  describe("milestone release", function () {
    it("releases milestone funds after pledged amount reaches the preset percent", async function () {
      const { crowdfunding, creator, donor } = await deployFixture();
      const { deadline, goal } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("2"),
        milestonePercent: 50n
      });

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("0.5") });
      expect(await crowdfunding.canReleaseMilestone(0)).to.equal(false);

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("0.5") });
      expect(await crowdfunding.canReleaseMilestone(0)).to.equal(true);

      await expect(crowdfunding.connect(creator).releaseMilestoneFunds(0)).to.changeEtherBalances(
        [crowdfunding, creator],
        [ethers.parseEther("-0.3"), ethers.parseEther("0.3")]
      );

      let project = await crowdfunding.getProject(0);
      expect(project.milestoneReleased).to.equal(true);
      expect(project.releasedAmount).to.equal(ethers.parseEther("0.3"));
      expect(project.milestonePercent).to.equal(50);

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });
      await time.increaseTo(deadline + 1);
      await crowdfunding.finalizeProject(0);

      await expect(crowdfunding.connect(creator).withdrawFunds(0)).to.changeEtherBalances(
        [crowdfunding, creator],
        [ethers.parseEther("-1.7"), ethers.parseEther("1.7")]
      );

      project = await crowdfunding.getProject(0);
      expect(project.withdrawn).to.equal(true);
      expect(project.goal).to.equal(goal);
    });

    it("uses milestonePercent from creation instead of a fixed threshold", async function () {
      const { crowdfunding, creator, donor } = await deployFixture();
      await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("10"),
        milestonePercent: 30n
      });

      expect(await crowdfunding.milestoneThresholdAmount(0)).to.equal(ethers.parseEther("3"));

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("2.9") });
      expect(await crowdfunding.canReleaseMilestone(0)).to.equal(false);

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("0.1") });
      expect(await crowdfunding.canReleaseMilestone(0)).to.equal(true);

      await expect(crowdfunding.connect(creator).releaseMilestoneFunds(0)).to.changeEtherBalances(
        [crowdfunding, creator],
        [ethers.parseEther("-0.9"), ethers.parseEther("0.9")]
      );
    });

    it("blocks milestone release when no milestone was set at creation", async function () {
      const { crowdfunding, creator, donor } = await deployFixture();
      await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("5"),
        milestonePercent: 0n
      });

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("5") });
      expect(await crowdfunding.hasMilestone(0)).to.equal(false);
      expect(await crowdfunding.milestoneThresholdAmount(0)).to.equal(0);
      expect(await crowdfunding.canReleaseMilestone(0)).to.equal(false);

      await expect(
        crowdfunding.connect(creator).releaseMilestoneFunds(0)
      ).to.be.revertedWith("Milestone not ready");
    });

    it("blocks invalid milestone release attempts", async function () {
      const { crowdfunding, creator, donor, stranger } = await deployFixture();
      const { deadline } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("2"),
        milestonePercent: 50n
      });

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });

      await expect(
        crowdfunding.connect(stranger).releaseMilestoneFunds(0)
      ).to.be.revertedWith("Only creator");

      await crowdfunding.connect(creator).releaseMilestoneFunds(0);

      await expect(
        crowdfunding.connect(creator).releaseMilestoneFunds(0)
      ).to.be.revertedWith("Milestone already released");

      await time.increaseTo(deadline + 1);
      await crowdfunding.finalizeProject(0);

      await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("2"),
        milestonePercent: 50n
      });
      await crowdfunding.connect(donor).donate(1, { value: ethers.parseEther("0.5") });

      await expect(
        crowdfunding.connect(creator).releaseMilestoneFunds(1)
      ).to.be.revertedWith("Milestone not ready");
    });
  });

  describe("withdraw and refund guards", function () {
    it("blocks invalid withdrawals and refunds", async function () {
      const { crowdfunding, creator, donor, stranger } = await deployFixture();
      const { deadline } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("2")
      });

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });

      await expect(crowdfunding.connect(donor).claimRefund(0)).to.be.revertedWith(
        "Project not finalized"
      );

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

    it("blocks refund on successful projects and duplicate withdrawals", async function () {
      const { crowdfunding, creator, donor } = await deployFixture();
      const { deadline } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("1")
      });

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("1") });
      await time.increaseTo(deadline + 1);
      await crowdfunding.finalizeProject(0);
      await crowdfunding.connect(creator).withdrawFunds(0);

      await expect(crowdfunding.connect(donor).claimRefund(0)).to.be.revertedWith(
        "Project succeeded"
      );
      await expect(crowdfunding.connect(creator).withdrawFunds(0)).to.be.revertedWith(
        "Already withdrawn"
      );
    });

    it("refunds donors proportionally after a failed project released milestone funds", async function () {
      const { crowdfunding, creator, donor, secondDonor } = await deployFixture();
      const { deadline } = await createProject(crowdfunding, creator, {
        goal: ethers.parseEther("10"),
        milestonePercent: 50n
      });

      await crowdfunding.connect(donor).donate(0, { value: ethers.parseEther("2.5") });
      await crowdfunding.connect(secondDonor).donate(0, { value: ethers.parseEther("2.5") });

      await crowdfunding.connect(creator).releaseMilestoneFunds(0);

      await time.increaseTo(deadline + 1);
      await crowdfunding.finalizeProject(0);

      const project = await crowdfunding.getProject(0);
      expect(project.successful).to.equal(false);
      expect(project.releasedAmount).to.equal(ethers.parseEther("1.5"));

      await expect(crowdfunding.connect(donor).claimRefund(0)).to.changeEtherBalances(
        [crowdfunding, donor],
        [ethers.parseEther("-1.75"), ethers.parseEther("1.75")]
      );
      await expect(crowdfunding.connect(secondDonor).claimRefund(0)).to.changeEtherBalances(
        [crowdfunding, secondDonor],
        [ethers.parseEther("-1.75"), ethers.parseEther("1.75")]
      );

      expect(await crowdfunding.getContribution(0, donor.address)).to.equal(0);
      expect(await crowdfunding.getContribution(0, secondDonor.address)).to.equal(0);
      expect(await ethers.provider.getBalance(crowdfunding.target)).to.equal(0);
    });
  });
});
