// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Crowdfunding {
    uint256 public constant EARLY_DONOR_LIMIT = 10;
    uint256 public constant MILESTONE_THRESHOLD_PERCENT = 50;
    uint256 public constant MILESTONE_RELEASE_PERCENT = 30;
    uint256 public constant PERCENT_DENOMINATOR = 100;
    // 百分比常量做整数运算，solidity中没有浮点数，无法直接计算数值 * 0.5

    struct Project {
        uint256 id;
        address payable creator;
        string name;
        string description;
        uint256 goal;
        uint256 deadline;
        uint256 pledged;        //当前已筹金额
        uint256 releasedAmount;
        bool finalized;
        bool successful;
        bool withdrawn;
        bool milestoneMarked;
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
        uint256 deadline
    );
    event Donated(uint256 indexed projectId, address indexed donor, uint256 amount, uint256 pledged);
    event EarlyDonorRewarded(uint256 indexed projectId, address indexed donor, uint256 rank);
    event ProjectFinalized(uint256 indexed projectId, bool successful, uint256 pledged);
    event MilestoneMarked(uint256 indexed projectId, address indexed creator);
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
        uint256 deadline
    ) external returns (uint256 projectId) {
        require(bytes(name).length > 0, "Name required");
        require(bytes(description).length > 0, "Description required");
        require(goal > 0, "Goal must be positive");
        require(deadline > block.timestamp, "Deadline must be future");

        projectId = projects.length;
        projects.push(
            Project({
                id: projectId,
                creator: payable(msg.sender),
                name: name,
                description: description,
                goal: goal,
                deadline: deadline,
                pledged: 0,
                releasedAmount: 0,
                finalized: false,
                successful: false,
                withdrawn: false,
                milestoneMarked: false,
                milestoneReleased: false,
                donorCount: 0
            })
        );

        emit ProjectCreated(projectId, msg.sender, name, goal, deadline);
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
        // 累加用户个人捐赠金额
        contributions[projectId][msg.sender] += msg.value;
        project.pledged += msg.value;

        emit Donated(projectId, msg.sender, msg.value, project.pledged);
    }

    // 没有onlyCreator的限制，任何人都可以调用
    function finalizeProject(uint256 projectId) public projectExists(projectId) {
        Project storage project = projects[projectId];
        require(block.timestamp >= project.deadline, "Deadline not reached");
        require(!project.finalized, "Already finalized");

        project.finalized = true;
        project.successful = project.pledged >= project.goal;

        emit ProjectFinalized(projectId, project.successful, project.pledged);
    }

    function markMilestoneComplete(uint256 projectId)
        external
        projectExists(projectId)
        onlyCreator(projectId)
    {
        Project storage project = projects[projectId];
        require(!project.finalized, "Project finalized");
        require(!project.milestoneMarked, "Milestone already marked");
        require(!project.milestoneReleased, "Milestone already released");

        project.milestoneMarked = true;
        emit MilestoneMarked(projectId, msg.sender);
    }

    function milestoneThreshold(uint256 projectId)
        public
        view
        projectExists(projectId)
        returns (uint256)
    {
        Project storage project = projects[projectId];
        return (project.goal * MILESTONE_THRESHOLD_PERCENT) / PERCENT_DENOMINATOR;
    }

    function canReleaseMilestone(uint256 projectId)
        public
        view
        projectExists(projectId)
        returns (bool)
    {
        Project storage project = projects[projectId];
        if (project.finalized || project.milestoneReleased) {
            return false;
        }
        return project.milestoneMarked || project.pledged >= milestoneThreshold(projectId);
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
        // 里程碑已释放给发起人的部分不再退还，按捐赠占比分摊未释放部分
        uint256 refundable = project.pledged - project.releasedAmount;
        uint256 amount = (contribution * refundable) / project.pledged;
        require(amount > 0, "Nothing to refund");
        // 先将贡献记录清零再转回资金，降低重入风险
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
