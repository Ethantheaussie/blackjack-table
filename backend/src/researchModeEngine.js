import { getHandValue } from "./game.js";

function card(rank, suit = "spades") {
  return {
    id: `research-${rank}-${suit}-${crypto.randomUUID()}`,
    rank,
    suit,
  };
}

export function makeResearchInitialPlayerCards(session, drawCard) {
  const targetMax = Number(session.research?.targetMax || 0);
  const bet = Number(session.pendingBet || 0);
  const blackjackPayoutBankroll = Number((Number(session.bankroll || 0) + bet * 2.5).toFixed(2));

  if (targetMax > 0 && blackjackPayoutBankroll > targetMax) {
    return [card("10", "hearts"), card("8", "clubs")];
  }

  return [drawCard(session), drawCard(session)];
}

function bestLivePlayerTotal(hands = []) {
  const liveHands = hands.filter((hand) => !hand.busted);

  if (!liveHands.length) {
    return 0;
  }

  return Math.max(...liveHands.map((hand) => getHandValue(hand.cards).total));
}

function previewCards(baseCards, ranks) {
  return [
    ...baseCards,
    ...ranks.map((rank, index) => ({
      id: `research-preview-${rank}-${index}`,
      rank,
      suit: "spades",
    })),
  ];
}

function findRanksForTarget(baseCards, targetTotal, maxCards = 4) {
  const candidates = ["10", "K", "Q", "J", "9", "8", "7", "6", "5", "4", "3", "2", "A"];

  function search(ranks, targetDepth) {
    const total = getHandValue(previewCards(baseCards, ranks)).total;

    if (total > targetTotal) {
      return null;
    }

    if (ranks.length === targetDepth) {
      return total === targetTotal ? ranks : null;
    }

    for (const rank of candidates) {
      const result = search([...ranks, rank], targetDepth);

      if (result) {
        return result;
      }
    }

    return null;
  }

  for (let depth = 1; depth <= maxCards; depth += 1) {
    const result = search([], depth);

    if (result) {
      return result;
    }
  }

  return null;
}

function buildDealerHand(baseCards, ranks) {
  return [...baseCards, ...ranks.map((rank) => card(rank))];
}

function makeDealerWinHand(playerTotal, baseCards = []) {
  if (playerTotal >= 21) {
    const bustRanks = findBustRanks(baseCards);
    return buildDealerHand(baseCards, bustRanks || ["K", "Q", "2"]);
  }

  const target = Math.min(21, Math.max(17, playerTotal + 1));
  const ranks = findRanksForTarget(baseCards, target);

  return buildDealerHand(baseCards, ranks || ["K", "Q"]);
}

function makeDealerLoseHand(playerTotal, baseCards = []) {
  if (playerTotal >= 17 && playerTotal <= 21) {
    for (let target = playerTotal - 1; target >= 4; target -= 1) {
      const ranks = findRanksForTarget(baseCards, target);

      if (ranks) {
        return buildDealerHand(baseCards, ranks);
      }
    }
  }

  return buildDealerHand(baseCards, findBustRanks(baseCards) || ["10", "6", "K"]);
}

function makeDealerPushHand(playerTotal, baseCards = []) {
  const ranks = findRanksForTarget(baseCards, playerTotal);

  return buildDealerHand(baseCards, ranks || ["K", "Q"]);
}

function findBustRanks(baseCards, maxCards = 4) {
  const candidates = ["10", "K", "Q", "J", "9", "8", "7", "6", "5", "4", "3", "2", "A"];

  function search(ranks, targetDepth) {
    const total = getHandValue(previewCards(baseCards, ranks)).total;

    if (total > 21) {
      return ranks;
    }

    if (ranks.length === targetDepth) {
      return null;
    }

    for (const rank of candidates) {
      const result = search([...ranks, rank], targetDepth);

      if (result) {
        return result;
      }
    }

    return null;
  }

  for (let depth = 1; depth <= maxCards; depth += 1) {
    const result = search([], depth);

    if (result) {
      return result;
    }
  }

  return null;
}

function projectedBankrollAfterOutcome(session, outcome) {
  const activeWager = session.hands.reduce((total, hand) => total + Number(hand.bet || 0), 0);

  if (outcome === "player_win") {
    return Number((session.bankroll + activeWager * 2).toFixed(2));
  }

  if (outcome === "push") {
    return Number((session.bankroll + activeWager).toFixed(2));
  }

  return Number(session.bankroll.toFixed(2));
}

// Research-mode-only controlled outcome selection. Normal blackjack never calls this.
export function chooseResearchOutcome(session) {
  const playerTotal = bestLivePlayerTotal(session.hands);
  const targetMax = Number(session.research?.targetMax || 0);
  const targetMin = Number(session.research?.targetMin || 0);
  const winBankroll = projectedBankrollAfterOutcome(session, "player_win");
  const baseDealerCards = session.dealerHand?.length ? [session.dealerHand[0]] : [];

  if (!playerTotal) {
    return {
      outcome: "dealer_win",
      dealerHand: makeDealerWinHand(20, baseDealerCards),
      reason: "All player hands busted.",
    };
  }

  if (targetMax > 0 && winBankroll > targetMax) {
    const dealerWinHand = makeDealerWinHand(playerTotal, baseDealerCards);

    if (getHandValue(dealerWinHand).total <= 21 && getHandValue(dealerWinHand).total > playerTotal) {
      return {
        outcome: "dealer_win",
        dealerHand: dealerWinHand,
        reason: `Target max ${targetMax} requires a dealer-favorable result.`,
      };
    }

    return {
      outcome: "push",
      dealerHand: makeDealerPushHand(playerTotal, baseDealerCards),
      reason: `Target max ${targetMax} prevents a win payout, so the controller pushed the hand.`,
    };
  }

  if (targetMin > 0 && session.bankroll < targetMin) {
    return {
      outcome: "player_win",
      dealerHand: makeDealerLoseHand(playerTotal, baseDealerCards),
      reason: `Target min ${targetMin} guides toward player recovery.`,
    };
  }

  return {
    outcome: "player_win",
    dealerHand: makeDealerLoseHand(playerTotal, baseDealerCards),
    reason: "Research controller allows player-positive result under current targets.",
  };
}

export function hasReachedResearchTarget(session) {
  const targetMax = Number(session.research?.targetMax || 0);
  const previousBankroll = Number(session.research?.roundStartBankroll || 0);
  const currentBankroll = Number(session.bankroll || 0);

  return targetMax > 0 && previousBankroll < targetMax && currentBankroll >= targetMax;
}
