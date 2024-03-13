import { OnChainMessageStatus } from "@consensys/linea-sdk";
import { Wallet } from "ethers";
import { groupBy } from "lodash";

import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { Signer, winston, convertFromWei } from "../../../utils";
import { FinalizerPromise, CrossChainMessage } from "../../types";
import { TokensBridged } from "../../../interfaces";
import { initLineaSdk, makeGetMessagesWithStatusByTxHash, MessageWithStatus } from "./common";

export async function lineaL2ToL1Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const [l1ChainId, l2ChainId] = [hubPoolClient.chainId, spokePoolClient.chainId];
  const lineaSdk = initLineaSdk(l1ChainId, l2ChainId);
  const l2Contract = lineaSdk.getL2Contract();
  const l1Contract = lineaSdk.getL1Contract();
  const l1ClaimingService = lineaSdk.getL1ClaimingService(l1Contract.contractAddress);
  const getMessagesWithStatusByTxHash = makeGetMessagesWithStatusByTxHash(l2Contract, l1ClaimingService);

  // Get src events
  const l2SrcEvents = spokePoolClient
    .getTokensBridged()
    .filter(({ blockNumber }) => blockNumber > latestBlockToFinalize);

  // Get Linea's MessageSent events for each src event
  const uniqueTxHashes = Array.from(new Set(l2SrcEvents.map((event) => event.transactionHash)));
  const relevantMessages = (
    await Promise.all(uniqueTxHashes.map((txHash) => getMessagesWithStatusByTxHash(txHash)))
  ).flat();

  // Merge messages with TokensBridged events
  const mergedMessages = mergeMessagesWithTokensBridged(relevantMessages, l2SrcEvents);

  // Group messages by status
  const {
    claimed = [],
    claimable = [],
    unknown = [],
  } = groupBy(mergedMessages, ({ message }) => {
    return message.status === OnChainMessageStatus.CLAIMED
      ? "claimed"
      : message.status === OnChainMessageStatus.CLAIMABLE
      ? "claimable"
      : "unknown";
  });

  // Populate txns for claimable messages
  const populatedTxns = await Promise.all(
    claimable.map(async ({ message }) => {
      const isProofNeeded = await l1ClaimingService.isClaimingNeedingProof(message.messageHash);

      if (isProofNeeded) {
        const proof = await l1ClaimingService.getMessageProof(message.messageHash);
        return l1ClaimingService.l1Contract.contract.populateTransaction.claimMessageWithProof({
          from: message.messageSender,
          to: message.destination,
          fee: message.fee,
          value: message.value,
          feeRecipient: (signer as Wallet).address,
          data: message.calldata,
          messageNumber: message.messageNonce,
          proof: proof.proof,
          leafIndex: proof.leafIndex,
          merkleRoot: proof.root,
        });
      }

      return l1ClaimingService.l1Contract.contract.populateTransaction.claimMessage(
        message.messageSender,
        message.destination,
        message.fee,
        message.value,
        (signer as Wallet).address,
        message.calldata,
        message.messageNonce
      );
    })
  );
  const multicall3Call = populatedTxns.map((txn) => ({
    target: l1Contract.contractAddress,
    callData: txn.data,
  }));

  // Populate cross chain transfers for claimed messages
  const transfers = claimable.map(({ tokensBridged }) => {
    const { l2TokenAddress, amountToReturn } = tokensBridged;
    const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
      l2TokenAddress,
      l2ChainId,
      hubPoolClient.latestBlockSearched
    );
    const { decimals, symbol: l1TokenSymbol } = hubPoolClient.getTokenInfo(l1ChainId, l1TokenCounterpart);
    const amountFromWei = convertFromWei(amountToReturn.toString(), decimals);
    const transfer: CrossChainMessage = {
      originationChainId: l2ChainId,
      destinationChainId: l1ChainId,
      l1TokenSymbol,
      amount: amountFromWei,
      type: "withdrawal",
    };

    return transfer;
  });

  logger.debug({
    at: "Finalizer#LineaL2ToL1Finalizer",
    message: `Detected ${mergedMessages.length} relevant messages`,
    statuses: {
      claimed: claimed.length,
      claimable: claimable.length,
      notReceived: unknown.length,
    },
  });

  return { callData: multicall3Call, crossChainMessages: transfers };
}

function mergeMessagesWithTokensBridged(messages: MessageWithStatus[], allTokensBridgedEvents: TokensBridged[]) {
  const messagesByTxHash = groupBy(messages, ({ txHash }) => txHash);
  const tokensBridgedEventByTxHash = groupBy(allTokensBridgedEvents, ({ transactionHash }) => transactionHash);

  const merged: {
    message: MessageWithStatus;
    tokensBridged: TokensBridged;
  }[] = [];
  for (const txHash of Object.keys(messagesByTxHash)) {
    const messages = messagesByTxHash[txHash].sort((a, b) => a.logIndex - b.logIndex);
    const tokensBridgedEvents = tokensBridgedEventByTxHash[txHash].sort((a, b) => a.logIndex - b.logIndex);

    if (messages.length !== tokensBridgedEvents.length) {
      throw new Error(
        `Mismatched number of MessageSent and TokensBridged events for transaction hash ${txHash}. ` +
          `Found ${messages.length} MessageSent events and ${tokensBridgedEvents.length} TokensBridged events.`
      );
    }

    for (const [i, message] of messages.entries()) {
      merged.push({
        message,
        tokensBridged: tokensBridgedEvents[i],
      });
    }
  }

  return merged;
}
