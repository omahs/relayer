import { buildSlowRelayTree, buildSlowRelayLeaves, buildFillForRepaymentChain } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBN, toBNWei, setupTokensForWallet } from "./utils";
import { buildDeposit, buildFill, buildSlowFill } from "./utils";
import { buildRelayerRefundTreeWithUnassignedLeafIds, constructPoolRebalanceTree } from "./utils";
import { HubPoolClient, RateModelClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId, MAX_REFUNDS_PER_LEAF, mockTreeRoot } from "./constants";
import { refundProposalLiveness, CHAIN_ID_TEST_LIST } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { RunningBalances } from "../src/interfaces/SpokePool";
import { getRealizedLpFeeForFills, getRefundForFills, getRefund } from "../src/utils";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, timer: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress, dataworker: SignerWithAddress;

let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker;

let updateAllClients: () => Promise<void>;

describe("Dataworker: Build merkle roots", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      rateModelClient,
      hubPoolClient,
      l1Token_1,
      depositor,
      relayer,
      dataworkerInstance,
      dataworker,
      timer,
      updateAllClients,
    } = await setupDataworker(ethers, MAX_REFUNDS_PER_LEAF));
  });
  it("Default conditions", async function () {
    // When given empty input data, returns null.
    await updateAllClients();
    expect(await dataworkerInstance.buildSlowRelayRoot([])).to.equal(null);
    expect(await dataworkerInstance.buildRelayerRefundRoot([])).to.equal(null);
  });
  it("Build slow relay root", async function () {
    await updateAllClients();

    // Submit deposits for multiple destination chain IDs.
    const deposit1 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit3 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Slow relays should be sorted by origin chain ID and deposit ID.
    const expectedSlowRelayLeaves = buildSlowRelayLeaves([deposit1, deposit2, deposit3, deposit4]);

    // Add fills for each deposit so dataworker includes deposits as slow relays:
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 0.1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 0.1);

    // Returns expected merkle root where leaves are ordered by origin chain ID and then deposit ID
    // (ascending).
    await updateAllClients();
    const merkleRoot1 = dataworkerInstance.buildSlowRelayRoot([]);
    const expectedMerkleRoot1 = await buildSlowRelayTree(expectedSlowRelayLeaves);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Fill deposits such that there are no unfilled deposits remaining.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 1);
    await updateAllClients();
    expect(dataworkerInstance.buildSlowRelayRoot([])).to.equal(null);
  });
  it("Build relayer refund root", async function () {
    await updateAllClients();

    // Submit deposits for multiple L2 tokens.
    const deposit1 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit3 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit.mul(2)
    );
    const deposit5 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit6 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );

    // Submit fills for two relayers on one repayment chain and one destination token. Note: we know that
    // depositor address is alphabetically lower than relayer address, so submit fill from depositor first and test
    // that data worker sorts on refund address.
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit3, 0.25, 100);
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit3, 1, 100);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, 100);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 1, 100);

    const depositorBeforeRelayer = toBN(depositor.address).lt(toBN(relayer.address));
    const leaf1 = {
      chainId: 100,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [
        depositorBeforeRelayer ? depositor.address : relayer.address,
        depositorBeforeRelayer ? relayer.address : depositor.address,
      ], // Sorted ascending alphabetically
      refundAmounts: [
        getRefund(deposit1.amount, deposit1.realizedLpFeePct),
        getRefund(deposit3.amount, deposit3.realizedLpFeePct),
      ], // Refund amounts should aggregate across all fills.
    };

    await updateAllClients();
    const merkleRoot1 = dataworkerInstance.buildRelayerRefundRoot([]);
    const expectedMerkleRoot1 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf1]);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Submit fills for a second destination token on on the same repayment chain.
    await buildFillForRepaymentChain(spokePool_1, relayer, deposit2, 1, 100);
    await buildFillForRepaymentChain(spokePool_1, depositor, deposit4, 1, 100);
    const leaf2 = {
      chainId: 100,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_1.address,
      refundAddresses: [depositor.address, relayer.address], // Ordered by fill amount
      refundAmounts: [
        getRefund(deposit4.amount, deposit4.realizedLpFeePct),
        getRefund(deposit2.amount, deposit2.realizedLpFeePct),
      ],
    };
    await updateAllClients();
    const merkleRoot2 = dataworkerInstance.buildRelayerRefundRoot([]);
    const leaves1And2Sorted = toBN(erc20_1.address).lt(toBN(erc20_2.address)) ? [leaf2, leaf1] : [leaf1, leaf2];
    const expectedMerkleRoot2 = await buildRelayerRefundTreeWithUnassignedLeafIds(leaves1And2Sorted);
    expect(merkleRoot2.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());

    // Submit fills for multiple repayment chains. Note: Send the fills for destination tokens in the
    // reverse order of the fills we sent above to test that the data worker is correctly sorting leaves
    // by L2 token address in ascending order. Also set repayment chain ID lower than first few leaves to test
    // that these leaves come first.
    await buildFillForRepaymentChain(spokePool_1, relayer, deposit5, 1, 99);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit6, 1, 99);
    const leaf3 = {
      chainId: 99,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [relayer.address],
      refundAmounts: [getRefund(deposit5.amount, deposit5.realizedLpFeePct)],
    };
    const leaf4 = {
      chainId: 99,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_1.address,
      refundAddresses: [relayer.address],
      refundAmounts: [getRefund(deposit6.amount, deposit6.realizedLpFeePct)],
    };
    await updateAllClients();
    const merkleRoot3 = await dataworkerInstance.buildRelayerRefundRoot([]);
    const leaves3And4Sorted = toBN(erc20_1.address).lt(toBN(erc20_2.address)) ? [leaf4, leaf3] : [leaf3, leaf4];
    const expectedMerkleRoot3 = await buildRelayerRefundTreeWithUnassignedLeafIds([
      ...leaves3And4Sorted,
      ...leaves1And2Sorted,
    ]);
    expect(merkleRoot3.getHexRoot()).to.equal(expectedMerkleRoot3.getHexRoot());

    // Splits leaf into multiple leaves if refunds > MAX_REFUNDS_PER_LEAF.
    const deposit7 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const allSigners: SignerWithAddress[] = await ethers.getSigners();
    expect(allSigners.length >= MAX_REFUNDS_PER_LEAF + 1, "ethers.getSigners doesn't have enough signers");
    for (let i = 0; i < MAX_REFUNDS_PER_LEAF + 1; i++) {
      await setupTokensForWallet(spokePool_2, allSigners[i], [erc20_2]);
      await buildFillForRepaymentChain(spokePool_2, allSigners[i], deposit7, 0.01 + i * 0.01, 98);
    }
    // Note: Higher refund amounts for same chain and L2 token should come first, so we test that by increasing
    // the fill amount in the above loop for each fill. Ultimately, the latest fills send the most tokens and
    // should come in the first leaf.
    const leaf5 = {
      chainId: 98,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [allSigners[3].address, allSigners[2].address, allSigners[1].address],
      refundAmounts: [
        getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.04")).div(toBNWei("1")),
        getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.03")).div(toBNWei("1")),
        getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.02")).div(toBNWei("1")),
      ],
    };
    const leaf6 = {
      chainId: 98,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [allSigners[0].address],
      refundAmounts: [getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.01")).div(toBNWei("1"))],
    };
    await updateAllClients();
    const merkleRoot4 = dataworkerInstance.buildRelayerRefundRoot([]);
    const expectedMerkleRoot4 = await buildRelayerRefundTreeWithUnassignedLeafIds([
      leaf5,
      leaf6,
      ...leaves3And4Sorted,
      ...leaves1And2Sorted,
    ]);
    expect(merkleRoot4.getHexRoot()).to.equal(expectedMerkleRoot4.getHexRoot());
  });
  it("Build pool rebalance root", async function () {
    await updateAllClients();

    // Submit deposits for multiple L2 tokens.
    const deposit1 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit.mul(toBN(2))
    );
    await updateAllClients();

    const deposits = [deposit1, deposit2];

    // Note: Submit fills with repayment chain set to one of the origin or destination chains since we have spoke
    // pools deployed on those chains.

    // Partial fill deposit1
    const fill1 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.5, destinationChainId);

    // Partial fill deposit2
    const fill2 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.3, originChainId);
    const fill3 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.2, originChainId);
    const blockOfLastFill = await hubPool.provider.getBlockNumber();

    // Prior to root bundle being executed, running balances should be:
    // - deposited amount
    // + partial fill refund
    const expectedRunningBalances: RunningBalances = {
      [destinationChainId]: {
        [l1Token_1.address]: getRefundForFills([fill1]).sub(deposit2.amount),
      },
      [originChainId]: {
        [l1Token_1.address]: getRefundForFills([fill2, fill3]).sub(deposit1.amount),
      },
    };
    const expectedRealizedLpFees: RunningBalances = {
      [destinationChainId]: {
        [l1Token_1.address]: getRealizedLpFeeForFills([fill1]),
      },
      [originChainId]: {
        [l1Token_1.address]: getRealizedLpFeeForFills([fill2, fill3]),
      },
    };
    await updateAllClients();
    const merkleRoot1 = dataworkerInstance.buildPoolRebalanceRoot([]);
    expect(merkleRoot1.runningBalances).to.deep.equal(expectedRunningBalances);
    expect(merkleRoot1.realizedLpFees).to.deep.equal(expectedRealizedLpFees);

    // Construct slow relay root which should include deposit1 and deposit2
    const slowRelayLeaves = buildSlowRelayLeaves(deposits);
    const expectedSlowRelayTree = await buildSlowRelayTree(slowRelayLeaves);

    // Construct pool rebalance root so we can publish slow relay root to spoke pool:
    const { tree: poolRebalanceTree, leaves: poolRebalanceLeaves } = await constructPoolRebalanceTree(
      expectedRunningBalances,
      expectedRealizedLpFees
    );

    // Propose root bundle so that we can test that the dataworker looks up ProposeRootBundle events properly.
    // TODO: Similarly, execute the root bundle because constructing the pool rebalance root is expected to look up
    // ExecutedRootBundleEvents.
    await hubPool.connect(dataworker).proposeRootBundle(
      Array(CHAIN_ID_TEST_LIST.length).fill(blockOfLastFill), // Set current block number as end block for bundle. Its important that we set a block for every possible chain ID.
      // so all fills to this point are before these blocks.
      poolRebalanceLeaves.length, // poolRebalanceLeafCount.
      poolRebalanceTree.getHexRoot(), // poolRebalanceRoot
      mockTreeRoot, // relayerRefundRoot
      expectedSlowRelayTree.getHexRoot() // slowRelayRoot
    );
    // await timer.setCurrentTime(Number(await timer.getCurrentTime()) + refundProposalLiveness + 1);
    // await Promise.all(
    //   poolRebalanceLeaves.map((leaf) => {
    //     return hubPool
    //       .connect(dataworker)
    //       .executeRootBundle(...Object.values(leaf), poolRebalanceTree.getHexProof(leaf));
    //   })
    // );

    // Execute 1 slow relay leaf:
    // Before we can execute the leaves on the spoke pool, we need to actually publish them since we're using a mock
    // adapter that doesn't send messages as you'd expect in executeRootBundle.
    await spokePool_1.relayRootBundle(mockTreeRoot, expectedSlowRelayTree.getHexRoot());
    const chainToExecuteSlowRelay = await spokePool_1.chainId();
    const slowFill2 = await buildSlowFill(
      spokePool_1,
      fill3,
      dataworker,
      expectedSlowRelayTree.getHexProof(
        // We can only execute a slow relay on its destination chain, so look up the relay data with
        // destination chain equal to the deployed spoke pool that we are calling.
        slowRelayLeaves.find((_) => _.destinationChainId === chainToExecuteSlowRelay.toString())
      )
    );
    await updateAllClients();

    // Running balance should now have accounted for the slow fill. However, there are no "extra" funds remaining in the
    // spoke pool following this slow fill because there were no fills that were submitted after the root bundle
    // was submitted that included the slow fill. The new running balance should only have added the slow fill amount.
    const merkleRoot2 = dataworkerInstance.buildPoolRebalanceRoot([]);
    expectedRunningBalances[slowFill2.destinationChainId][l1Token_1.address] = expectedRunningBalances[
      slowFill2.destinationChainId
    ][l1Token_1.address].add(getRefundForFills([slowFill2]));
    expectedRealizedLpFees[slowFill2.destinationChainId][l1Token_1.address] = expectedRealizedLpFees[
      slowFill2.destinationChainId
    ][l1Token_1.address].add(getRealizedLpFeeForFills([slowFill2]));
    expect(merkleRoot2.runningBalances).to.deep.equal(expectedRunningBalances);
    expect(merkleRoot2.realizedLpFees).to.deep.equal(expectedRealizedLpFees);

    // Now, submit another partial fill for the deposit whose slow fill has NOT been executed yet. This should result
    // in the slow fill execution leaving excess funds in the spoke pool.
    const fill4 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, destinationChainId);
    await updateAllClients();
    const merkleRoot3 = dataworkerInstance.buildPoolRebalanceRoot([]);
    expectedRunningBalances[fill4.destinationChainId][l1Token_1.address] = expectedRunningBalances[
      fill4.destinationChainId
    ][l1Token_1.address].add(getRefundForFills([fill4]));
    expectedRealizedLpFees[fill4.destinationChainId][l1Token_1.address] = expectedRealizedLpFees[
      fill4.destinationChainId
    ][l1Token_1.address].add(getRealizedLpFeeForFills([fill4]));
    expect(merkleRoot3.runningBalances).to.deep.equal(expectedRunningBalances);
    expect(merkleRoot3.realizedLpFees).to.deep.equal(expectedRealizedLpFees);

    // Execute second slow relay leaf:
    // Before we can execute the leaves on the spoke pool, we need to actually publish them since we're using a mock
    // adapter that doesn't send messages as you'd expect in executeRootBundle.
    await spokePool_2.relayRootBundle(mockTreeRoot, expectedSlowRelayTree.getHexRoot());
    const secondChainToExecuteSlowRelay = await spokePool_2.chainId();
    const slowFill1 = await buildSlowFill(
      spokePool_2,
      fill4,
      dataworker,
      expectedSlowRelayTree.getHexProof(
        // We can only execute a slow relay on its destination chain, so look up the relay data with
        // destination chain equal to the deployed spoke pool that we are calling.
        slowRelayLeaves.find((_) => _.destinationChainId === secondChainToExecuteSlowRelay.toString())
      )
    );
    await updateAllClients();

    // Running balance should decrease by excess from slow fill since fill4 was sent before the slow fill could be
    // executed. Since fill4 filled the remainder of the deposit, the entire slow fill amount should be subtracted
    // from running balances.
    const merkleRoot4 = dataworkerInstance.buildPoolRebalanceRoot([]);
    const sentAmount = fill1.amount.sub(fill1.totalFilledAmount);
    const excess = sentAmount.sub(slowFill1.fillAmount);
    expectedRunningBalances[slowFill1.destinationChainId][l1Token_1.address] = expectedRunningBalances[
      slowFill1.destinationChainId
    ][l1Token_1.address]
      .add(getRefundForFills([slowFill1]))
      .sub(excess);
    expectedRealizedLpFees[slowFill1.destinationChainId][l1Token_1.address] = expectedRealizedLpFees[
      slowFill1.destinationChainId
    ][l1Token_1.address].add(getRealizedLpFeeForFills([slowFill1]));
    expect(merkleRoot4.runningBalances).to.deep.equal(expectedRunningBalances);
    expect(merkleRoot4.realizedLpFees).to.deep.equal(expectedRealizedLpFees);
  });
});
