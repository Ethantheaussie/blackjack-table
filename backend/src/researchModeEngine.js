import { getHandValue } from "./game.js";

function card(rank, suit = "spades") {
  return {
    id: `research-${rank}-${suit}-${crypto.randomUUID()}`,
    rank,
    suit,
  };
}

function bestLivePlayerTotal(hands = []) {
  const liveHands = hands.filter((hand) => !hand.busted);

  if (!liveHands.length) {
    return 0;
  }

  return Math.max(...liveHands.map((hand) => getHandValue(hand.cards).total));
}

function makeDealerWinHand(playerTotal) {
  if (playerTotal >= 21) {
    return [card("K"), card("Q"), card("2")];
  }

  const target = Math.min(21, Math.max(17, playerTotal + 1));
  const pairs = {
    17: ["10", "7"],
    18: ["10", "8"],
    19: ["10", "9"],
    20: ["K", "Q"],
    21: ["A", "K"],
  };

  return (pairs[target] || pairs[20]).map((rank) => card(rank));
}

function makeDealerLoseHand(playerTotal) {
  if (playerTotal >= 17 && playerTotal <= 21) {
    const target = playerTotal - 1;
    const pairs = {
      16: ["10", "6"],
      17: ["10", "7"],
      18: ["10", "8"],
      19: ["10", "9"],
      20: ["Q", "J"],
    };

    return (pairs[target] || ["10", "6", "K"]).map((rank) => card(rank));
  }

  return [card("10"), card("6"), card("K")];
}

function makeDealerPushHand(playerTotal) {
  const pairs = {
    17: ["10", "7"],
    18: ["10", "8"],
    19: ["10", "9"],
    20: ["K", "Q"],
    21: ["A", "K"],
  };

  return (pairs[playerTotal] || pairs[20]).map((rank) => card(rank));
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
  const pushBankroll = projectedBankrollAfterOutcome(session, "push");

  if (!playerTotal) {
    return {
      outcome: "dealer_win",
      dealerHand: makeDealerWinHand(20),
      reason: "All player hands busted.",
    };
  }

  if (targetMax > 0 && winBankroll > targetMax) {
    if (pushBankroll <= targetMax) {
      return {
        outcome: "push",
        dealerHand: makeDealerPushHand(playerTotal),
        reason: `Target max ${targetMax} prevents a win payout.`,
      };
    }

    return {
      outcome: "dealer_win",
      dealerHand: makeDealerWinHand(playerTotal),
      reason: `Target max ${targetMax} requires a dealer-favorable result.`,
    };
  }

  if (targetMin > 0 && session.bankroll < targetMin) {
    return {
      outcome: "player_win",
      dealerHand: makeDealerLoseHand(playerTotal),
      reason: `Target min ${targetMin} guides toward player recovery.`,
    };
  }

  return {
    outcome: "player_win",
    dealerHand: makeDealerLoseHand(playerTotal),
    reason: "Research controller allows player-positive result under current targets.",
  };
}

export function hasReachedResearchTarget(session) {
  const targetMax = Number(session.research?.targetMax || 0);

  return targetMax > 0 && Number(session.bankroll || 0) >= targetMax;
}
