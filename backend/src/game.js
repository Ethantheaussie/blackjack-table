const SUITS = ["spades", "hearts", "clubs", "diamonds"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: `${rank}-${suit}-${crypto.randomUUID()}`,
        rank,
        suit,
      });
    }
  }

  return shuffle(deck);
}

export function shuffle(cards) {
  const deck = [...cards];

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  return deck;
}

export function drawCard(lobby) {
  if (!lobby.deck.length) {
    lobby.deck = createDeck();
  }

  return lobby.deck.pop();
}

export function getCardNumericValue(card) {
  if (card.rank === "A") {
    return 11;
  }

  if (["K", "Q", "J"].includes(card.rank)) {
    return 10;
  }

  return Number(card.rank);
}

export function getHandValue(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    total += getCardNumericValue(card);

    if (card.rank === "A") {
      aces += 1;
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }

  return {
    total,
    soft: aces > 0,
  };
}

export function isBlackjack(cards, { fromSplit = false } = {}) {
  return !fromSplit && cards.length === 2 && getHandValue(cards).total === 21;
}

export function canSplitCards(cards) {
  if (cards.length !== 2) {
    return false;
  }

  const [first, second] = cards;
  const firstValue = getCardNumericValue(first);
  const secondValue = getCardNumericValue(second);

  return first.rank === second.rank || firstValue === secondValue;
}

export function shouldDealerHit(cards, dealerHitsSoft17) {
  const hand = getHandValue(cards);

  if (hand.total < 17) {
    return true;
  }

  if (hand.total === 17 && hand.soft && dealerHitsSoft17) {
    return true;
  }

  return false;
}

export function formatCard(card, hidden = false) {
  if (hidden) {
    return {
      id: "hidden-card",
      rank: "?",
      suit: "hidden",
      hidden: true,
      label: "Hidden",
    };
  }

  return {
    ...card,
    hidden: false,
    label: `${card.rank}${getSuitSymbol(card.suit)}`,
  };
}

export function getSuitSymbol(suit) {
  return {
    spades: "♠",
    hearts: "♥",
    clubs: "♣",
    diamonds: "♦",
    hidden: "",
  }[suit];
}
