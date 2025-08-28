// reward-distributor.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface ClaimRecord {
  claimed: boolean;
  sequesteredAmount: number;
  rewardAmount: number;
  claimTime: number;
}

interface LastClaim {
  lastPeriod: number;
  lastBlock: number;
}

interface ContractState {
  isPaused: boolean;
  rewardMultiplier: number;
  totalRewardsDistributed: number;
  emissionReductionFactor: number;
  contractOwner: string;
  carbonTokenContract: string;
  soilMetricsContract: string;
  oracleVerifierContract: string;
  governanceDaoContract: string;
  farmRewardClaims: Map<string, ClaimRecord>; // Key: `${farmId}-${period}`
  farmLastClaims: Map<number, LastClaim>; // Key: farmId
  currentBlock: number; // Mocked block height
}

// Mock traits/interfaces
interface CarbonTokenTrait {
  mint: (recipient: string, amount: number) => ClarityResponse<boolean>;
}

interface SoilMetricsTrait {
  getSequesteredAmount: (farmId: number, period: number) => number;
  getFarmOwner: (farmId: number) => string | null;
}

interface OracleVerifierTrait {
  isDataVerified: (farmId: number, period: number) => boolean;
}

interface GovernanceDaoTrait {
  getDaoAddress: () => string;
}

// Mock contract implementation
class RewardDistributorMock {
  private state: ContractState = {
    isPaused: false,
    rewardMultiplier: 1000000,
    totalRewardsDistributed: 0,
    emissionReductionFactor: 900000,
    contractOwner: "deployer",
    carbonTokenContract: "carbon-token",
    soilMetricsContract: "soil-metrics",
    oracleVerifierContract: "oracle-verifier",
    governanceDaoContract: "governance-dao",
    farmRewardClaims: new Map(),
    farmLastClaims: new Map(),
    currentBlock: 1000,
  };

  private BASE_REWARD_RATE = 1000000;
  private MIN_SEQUESTERED = 1000000;
  private CLAIM_COOLDOWN = 144;
  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_FARM = 101;
  private ERR_UNVERIFIED_DATA = 102;
  private ERR_INSUFFICIENT_SEQUESTERED = 103;
  private ERR_REWARD_ALREADY_CLAIMED = 104;
  private ERR_PAUSED = 106;
  private ERR_COOLDOWN_NOT_MET = 113;
  private ERR_INVALID_PARAMETER = 105;

  // Mocked traits
  private carbonToken: CarbonTokenTrait = {
    mint: vi.fn((recipient: string, amount: number) => ({ ok: true, value: true })),
  };

  private soilMetrics: SoilMetricsTrait = {
    getSequesteredAmount: vi.fn((farmId: number, period: number) => 2000000), // Default 2 tons
    getFarmOwner: vi.fn((farmId: number) => "farmer1"),
  };

  private oracleVerifier: OracleVerifierTrait = {
    isDataVerified: vi.fn((farmId: number, period: number) => true),
  };

  private governanceDao: GovernanceDaoTrait = {
    getDaoAddress: vi.fn(() => "dao-address"),
  };

  private advanceBlock() {
    this.state.currentBlock += 1;
  }

  setPaused(caller: string, paused: boolean): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.isPaused = paused;
    return { ok: true, value: true };
  }

  updateRewardMultiplier(caller: string, newMultiplier: number): ClarityResponse<boolean> {
    const isAuthorized = caller === this.state.contractOwner || caller === this.governanceDao.getDaoAddress();
    if (!isAuthorized) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (newMultiplier <= 0 || newMultiplier > 5000000) {
      return { ok: false, value: this.ERR_INVALID_PARAMETER };
    }
    this.state.rewardMultiplier = newMultiplier;
    return { ok: true, value: true };
  }

  updateEmissionFactor(caller: string, newFactor: number): ClarityResponse<boolean> {
    const isAuthorized = caller === this.state.contractOwner || caller === this.governanceDao.getDaoAddress();
    if (!isAuthorized) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (newFactor < 500000 || newFactor > 1000000) {
      return { ok: false, value: this.ERR_INVALID_PARAMETER };
    }
    this.state.emissionReductionFactor = newFactor;
    return { ok: true, value: true };
  }

  claimReward(caller: string, farmId: number, period: number): ClarityResponse<{ rewardAmount: number }> {
    this.advanceBlock();
    if (this.state.isPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const owner = this.soilMetrics.getFarmOwner(farmId);
    if (!owner) {
      return { ok: false, value: this.ERR_INVALID_FARM };
    }
    if (caller !== owner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const isVerified = this.oracleVerifier.isDataVerified(farmId, period);
    if (!isVerified) {
      return { ok: false, value: this.ERR_UNVERIFIED_DATA };
    }
    const sequestered = this.soilMetrics.getSequesteredAmount(farmId, period);
    if (sequestered < this.MIN_SEQUESTERED) {
      return { ok: false, value: this.ERR_INSUFFICIENT_SEQUESTERED };
    }
    const key = `${farmId}-${period}`;
    const claim = this.state.farmRewardClaims.get(key);
    if (claim && claim.claimed) {
      return { ok: false, value: this.ERR_REWARD_ALREADY_CLAIMED };
    }
    const lastClaim = this.state.farmLastClaims.get(farmId);
    if (lastClaim && (this.state.currentBlock - lastClaim.lastBlock) < this.CLAIM_COOLDOWN) {
      return { ok: false, value: this.ERR_COOLDOWN_NOT_MET };
    }
    const base = sequestered * this.BASE_REWARD_RATE;
    const multiplied = (base * this.state.rewardMultiplier) / 1000000;
    const adjusted = (multiplied * this.state.emissionReductionFactor) / 1000000;
    const reward = adjusted;

    this.state.farmRewardClaims.set(key, {
      claimed: true,
      sequesteredAmount: sequestered,
      rewardAmount: reward,
      claimTime: this.state.currentBlock,
    });
    this.state.farmLastClaims.set(farmId, {
      lastPeriod: period,
      lastBlock: this.state.currentBlock,
    });
    this.state.totalRewardsDistributed += reward;
    this.carbonToken.mint(caller, reward);
    return { ok: true, value: { rewardAmount: reward } };
  }

  getRewardClaim(farmId: number, period: number): ClarityResponse<ClaimRecord | null> {
    const key = `${farmId}-${period}`;
    return { ok: true, value: this.state.farmRewardClaims.get(key) ?? null };
  }

  getTotalRewardsDistributed(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalRewardsDistributed };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.isPaused };
  }

  estimateReward(sequestered: number): ClarityResponse<number> {
    const base = sequestered * this.BASE_REWARD_RATE;
    const multiplied = (base * this.state.rewardMultiplier) / 1000000;
    const adjusted = (multiplied * this.state.emissionReductionFactor) / 1000000;
    return { ok: true, value: adjusted };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  farmer1: "farmer1",
  unauthorized: "unauthorized",
  dao: "dao-address",
};

describe("RewardDistributor Contract", () => {
  let contract: RewardDistributorMock;

  beforeEach(() => {
    contract = new RewardDistributorMock();
    vi.resetAllMocks();
  });

  it("should initialize with default values", () => {
    expect(contract.getTotalRewardsDistributed()).toEqual({ ok: true, value: 0 });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should allow owner to pause and unpause", () => {
    let result = contract.setPaused(accounts.deployer, true);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    result = contract.setPaused(accounts.deployer, false);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-owner from pausing", () => {
    const result = contract.setPaused(accounts.unauthorized, true);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should update reward multiplier by owner or DAO", () => {
    let result = contract.updateRewardMultiplier(accounts.deployer, 1500000);
    expect(result).toEqual({ ok: true, value: true });

    result = contract.updateRewardMultiplier(accounts.dao, 2000000);
    expect(result).toEqual({ ok: true, value: true });
  });

  it("should prevent invalid multiplier updates", () => {
    let result = contract.updateRewardMultiplier(accounts.deployer, 0);
    expect(result).toEqual({ ok: false, value: 105 });

    result = contract.updateRewardMultiplier(accounts.unauthorized, 1500000);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should allow farmer to claim reward successfully", () => {
    const result = contract.claimReward(accounts.farmer1, 1, 1);
    expect(result.ok).toBe(true);
    expect((result.value as { rewardAmount: number }).rewardAmount).toBe(1800000000000); // Calculation: 2e6 * 1e6 * 1 * 0.9
    expect(contract.getTotalRewardsDistributed()).toEqual({ ok: true, value: 1800000000000 });
    expect(contract.getRewardClaim(1, 1).value).toEqual(
      expect.objectContaining({ claimed: true, rewardAmount: 1800000000000 })
    );
  });

  it("should prevent claim if paused", () => {
    contract.setPaused(accounts.deployer, true);
    const result = contract.claimReward(accounts.farmer1, 1, 1);
    expect(result).toEqual({ ok: false, value: 106 });
  });

  it("should prevent claim if not owner", () => {
    const result = contract.claimReward(accounts.unauthorized, 1, 1);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should prevent claim if data not verified", () => {
    vi.spyOn(contract["oracleVerifier"], "isDataVerified").mockReturnValue(false);
    const result = contract.claimReward(accounts.farmer1, 1, 1);
    expect(result).toEqual({ ok: false, value: 102 });
  });

  it("should prevent claim if already claimed", () => {
    contract.claimReward(accounts.farmer1, 1, 1);
    const result = contract.claimReward(accounts.farmer1, 1, 1);
    expect(result).toEqual({ ok: false, value: 104 });
  });

  it("should enforce cooldown between claims", () => {
    contract.claimReward(accounts.farmer1, 1, 1);
    const result = contract.claimReward(accounts.farmer1, 1, 2);
    expect(result).toEqual({ ok: false, value: 113 });
  });

  it("should estimate reward correctly", () => {
    const result = contract.estimateReward(2000000);
    expect(result).toEqual({ ok: true, value: 1800000000000 });
  });
});