// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Crowdfunding {
    uint256 public constant EARLY_DONOR_LIMIT = 10;
    uint256 public constant MILESTONE_RELEASE_PERCENT = 30;
    uint256 public constant PERCENT_DENOMINATOR = 100;

    struct Project {
        uint256 id;
        address payable creator;
        string name;
        string description;
        uint256 goal;
        uint256 deadline;
        uint256 milestonePercent;
        uint256 pledged;
        uint256 releasedAmount;
        bool finalized;
        bool successful;
        bool withdrawn;
        bool milestoneReleased;
        uint256 donorCount;
    }

    Project[] private projects;

    mapping(uint256 => mapping(address => uint256)) private contributions;
    mapping(uint256 => address[]) private contributors;
    mapping(uint256 => mapping(address => bool)) private contributorAdded;
    mapping(uint256 => address[]) private earlyDonors;
    mapping(uint256 => mapping(address => bool)) private earlyDonorAdded;

    event ProjectCreated(
        uint256 indexed projectId,
        address indexed creator,
        string name,
        uint256 goal,
        uint256 deadline,
        uint256 milestonePercent
    );
    event Donated(uint256 indexed projectId, address indexed donor, uint256 amount, uint256 pledged);
    event EarlyDonorRewarded(uint256 indexed projectId, address indexed donor, uint256 rank);
    event ProjectFinalized(uint256 indexed projectId, bool successful, uint256 pledged);
    event MilestoneReleased(uint256 indexed projectId, address indexed creator, uint256 amount);
    event FundsWithdrawn(uint256 indexed projectId, address indexed creator, uint256 amount);
    event RefundClaimed(uint256 indexed projectId, address indexed donor, uint256 amount);

    modifier projectExists(uint256 projectId) {
        require(projectId < projects.length, "Project does not exist");
        _;
    }

    modifier onlyCreator(uint256 projectId) {
        require(msg.sender == projects[projectId].creator, "Only creator");
        _;
    }

    function createProject(
        string calldata name,
        string calldata description,
        uint256 goal,
        uint256 deadline,
        uint256 milestonePercent
    ) external returns (uint256 projectId) {
        require(bytes(name).length > 0, "Name required");
        require(bytes(description).length > 0, "Description required");
        require(goal > 0, "Goal must be positive");
        require(deadline > block.timestamp, "Deadline must be future");
        require(milestonePercent <= PERCENT_DENOMINATOR, "Invalid milestone percent");

        projectId = projects.length;
        projects.push(
            Project({
                id: projectId,
                creator: payable(msg.sender),
                name: name,
                description: description,
                goal: goal,
                deadline: deadline,
                milestonePercent: milestonePercent,
                pledged: 0,
                releasedAmount: 0,
                finalized: false,
                successful: false,
                withdrawn: false,
                milestoneReleased: false,
                donorCount: 0
            })
        );

        emit ProjectCreated(projectId, msg.sender, name, goal, deadline, milestonePercent);
    }

    function donate(uint256 projectId) external payable projectExists(projectId) {
        Project storage project = projects[projectId];
        require(block.timestamp < project.deadline, "Project ended");
        require(!project.finalized, "Project finalized");
        require(msg.value > 0, "Donation required");

        if (!contributorAdded[projectId][msg.sender]) {
            contributorAdded[projectId][msg.sender] = true;
            contributors[projectId].push(msg.sender);
            project.donorCount += 1;
        }

        if (
            earlyDonors[projectId].length < EARLY_DONOR_LIMIT
                && !earlyDonorAdded[projectId][msg.sender]
        ) {
            earlyDonorAdded[projectId][msg.sender] = true;
            earlyDonors[projectId].push(msg.sender);
            emit EarlyDonorRewarded(projectId, msg.sender, earlyDonors[projectId].length);
        }

        contributions[projectId][msg.sender] += msg.value;
        project.pledged += msg.value;

        emit Donated(projectId, msg.sender, msg.value, project.pledged);
    }

    function finalizeProject(uint256 projectId) public projectExists(projectId) {
        Project storage project = projects[projectId];
        require(block.timestamp >= project.deadline, "Deadline not reached");
        require(!project.finalized, "Already finalized");

        project.finalized = true;
        project.successful = project.pledged >= project.goal;

        emit ProjectFinalized(projectId, project.successful, project.pledged);
    }

    function hasMilestone(uint256 projectId)
        public
        view
        projectExists(projectId)
        returns (bool)
    {
        return projects[projectId].milestonePercent > 0;
    }

    function milestoneThresholdAmount(uint256 projectId)
        public
        view
        projectExists(projectId)
        returns (uint256)
    {
        Project storage project = projects[projectId];
        if (project.milestonePercent == 0) {
            return 0;
        }
        return (project.goal * project.milestonePercent) / PERCENT_DENOMINATOR;
    }

    function canReleaseMilestone(uint256 projectId)
        public
        view
        projectExists(projectId)
        returns (bool)
    {
        Project storage project = projects[projectId];
        if (
            project.milestonePercent == 0
                || project.finalized
                || project.milestoneReleased
        ) {
            return false;
        }
        return project.pledged >= milestoneThresholdAmount(projectId);
    }

    function releaseMilestoneFunds(uint256 projectId)
        external
        projectExists(projectId)
        onlyCreator(projectId)
    {
        Project storage project = projects[projectId];
        require(!project.finalized, "Project finalized");
        require(!project.milestoneReleased, "Milestone already released");
        require(canReleaseMilestone(projectId), "Milestone not ready");

        uint256 amount = (project.pledged * MILESTONE_RELEASE_PERCENT) / PERCENT_DENOMINATOR;
        require(amount > 0, "Nothing to release");

        project.milestoneReleased = true;
        project.releasedAmount = amount;

        (bool ok, ) = project.creator.call{value: amount}("");
        require(ok, "Transfer failed");

        emit MilestoneReleased(projectId, project.creator, amount);
    }

    function withdrawFunds(uint256 projectId)
        external
        projectExists(projectId)
        onlyCreator(projectId)
    {
        Project storage project = projects[projectId];
        require(project.finalized, "Project not finalized");
        require(project.successful, "Project failed");
        require(!project.withdrawn, "Already withdrawn");

        uint256 amount = project.pledged - project.releasedAmount;
        project.withdrawn = true;

        (bool ok, ) = project.creator.call{value: amount}("");
        require(ok, "Transfer failed");

        emit FundsWithdrawn(projectId, project.creator, amount);
    }

    function claimRefund(uint256 projectId) external projectExists(projectId) {
        Project storage project = projects[projectId];
        if (!project.finalized) {
            finalizeProject(projectId);
        }

        require(!project.successful, "Project succeeded");

        uint256 contribution = contributions[projectId][msg.sender];
        require(contribution > 0, "No contribution");

        uint256 refundable = project.pledged - project.releasedAmount;
        uint256 amount = (contribution * refundable) / project.pledged;
        require(amount > 0, "Nothing to refund");

        contributions[projectId][msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Refund failed");

        emit RefundClaimed(projectId, msg.sender, amount);
    }

    function projectCount() external view returns (uint256) {
        return projects.length;
    }

    function getProject(uint256 projectId)
        external
        view
        projectExists(projectId)
        returns (Project memory)
    {
        return projects[projectId];
    }

    function getContributors(uint256 projectId)
        external
        view
        projectExists(projectId)
        returns (address[] memory)
    {
        return contributors[projectId];
    }

    function getEarlyDonors(uint256 projectId)
        external
        view
        projectExists(projectId)
        returns (address[] memory)
    {
        return earlyDonors[projectId];
    }

    function getContribution(uint256 projectId, address donor)
        external
        view
        projectExists(projectId)
        returns (uint256)
    {
        return contributions[projectId][donor];
    }

    function isEarlyDonor(uint256 projectId, address donor)
        external
        view
        projectExists(projectId)
        returns (bool)
    {
        return earlyDonorAdded[projectId][donor];
    }

    function getEarlyDonorRank(uint256 projectId, address donor)
        external
        view
        projectExists(projectId)
        returns (uint256)
    {
        address[] storage donors = earlyDonors[projectId];
        for (uint256 i = 0; i < donors.length; i++) {
            if (donors[i] == donor) {
                return i + 1;
            }
        }
        return 0;
    }

    function earlyDonorSlotsRemaining(uint256 projectId)
        external
        view
        projectExists(projectId)
        returns (uint256)
    {
        uint256 used = earlyDonors[projectId].length;
        if (used >= EARLY_DONOR_LIMIT) {
            return 0;
        }
        return EARLY_DONOR_LIMIT - used;
    }
}
