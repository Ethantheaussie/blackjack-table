import assert from "node:assert/strict";
import { chooseResearchOutcome, hasReachedResearchTarget } from "./researchModeEngine.js";

function hand(value, bet = 10) {
  const cards = value === 21
    ? [{ rank: "K", suit: "spades" }, { rank: "A", suit: "hearts" }]
    : [{ rank: "10", suit: "spades" }, { rank: String(value - 10), suit: "hearts" }];

  return { cards, bet, busted: false };
}

{
  const session = {
    bankroll: 40,
    hands: [hand(20, 10)],
    research: { targetMax: 60 },
  };
  const result = chooseResearchOutcome(session);
  assert.equal(result.outcome, "player_win", "cap at $60 from $50 approved bankroll should allow one $10 win");
}

{
  const session = {
    bankroll: 60,
    hands: [hand(19, 10)],
    research: { targetMax: 30 },
  };
  const result = chooseResearchOutcome(session);
  assert.equal(result.outcome, "dealer_win", "lower target below current bankroll should guide future losses");
}

{
  const session = {
    bankroll: 60,
    hands: [],
    research: { targetMax: 60 },
  };
  assert.equal(hasReachedResearchTarget(session), true, "target reached should pause the session");
}

{
  const session = {
    bankroll: 0,
    hands: [hand(18, 5)],
    research: { targetMin: 25 },
  };
  const result = chooseResearchOutcome(session);
  assert.equal(result.outcome, "player_win", "rebuy recovery flow should allow controlled player-positive outcome");
}

console.log("Research mode engine tests passed.");
