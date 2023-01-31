import { expect, ethers, Contract, SignerWithAddress, getContractFactory, createSpyLogger } from "./utils";
import { randomAddress, enableRoutes, zeroAddress, originChainId, destinationChainId } from "./utils";

import { SpokePoolClient } from "../src/clients"; // tested

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let owner: SignerWithAddress, depositor1: SignerWithAddress, depositor2: SignerWithAddress;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Deposit Routes", async function () {
  beforeEach(async function () {
    [owner, depositor1, depositor2] = await ethers.getSigners();
    // Deploy a minimal spokePool, without using the fixture as this does some route enabling within it.
    spokePool = await (
      await getContractFactory("MockSpokePool", owner)
    ).deploy(owner.address, owner.address, zeroAddress, zeroAddress);
    const deploymentBlock = await spokePool.provider.getBlockNumber();

    spokePoolClient = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool,
      null,
      originChainId,
      undefined,
      deploymentBlock
    );
  });

  it("Fetches enabled deposit routes", async function () {
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({});

    const originToken = randomAddress();
    await enableRoutes(spokePool, [{ originToken, destinationChainId }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: true } });
    expect(spokePoolClient.isDepositRouteEnabled(originToken, destinationChainId)).to.be.true;

    // Enable another destination chain with the same origin token should append to the previous structure.
    const destinationChainId2 = destinationChainId + 1;
    await enableRoutes(spokePool, [{ originToken, destinationChainId: destinationChainId2 }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken]: { [destinationChainId]: true, [destinationChainId2]: true },
    });

    // Enable another token should append at the key level of the structure.
    const originToken1 = randomAddress();
    await enableRoutes(spokePool, [{ originToken: originToken1, destinationChainId }]);
    await spokePoolClient.update();

    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken]: { [destinationChainId]: true, [destinationChainId2]: true },
      [originToken1]: { [destinationChainId]: true },
    });
  });
  it("Correctly toggles to disabled when a route is turned off", async function () {
    const originToken = randomAddress();
    await enableRoutes(spokePool, [{ originToken, destinationChainId }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: true } });

    await spokePool.setEnableRoute(originToken, destinationChainId, false); // Disable the route.
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: false } });
    expect(spokePoolClient.isDepositRouteEnabled(originToken, destinationChainId)).to.be.false;
    const destinationChainId2 = destinationChainId + 1;
    await enableRoutes(spokePool, [{ originToken, destinationChainId: destinationChainId2 }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken]: { [destinationChainId]: false, [destinationChainId2]: true },
    });
  });

  it("Correctly fetches origin tokens", async function () {
    const originToken = randomAddress();
    await enableRoutes(spokePool, [{ originToken, destinationChainId }]);
    const originToken2 = randomAddress();
    await enableRoutes(spokePool, [{ originToken: originToken2, destinationChainId }]);
    await spokePoolClient.update();

    expect(spokePoolClient.getAllOriginTokens()).to.deep.equal([originToken, originToken2]);
  });
});
