import express from "express";
import http from "node:http";
import cors from "cors";
import { Server } from "socket.io";
import {
  canSplitCards,
  createDeck,
  drawCard,
  formatCard,
  getHandValue,
  isBlackjack,
  shouldDealerHit,
} from "./game.js";
import { loadSnapshot, saveSnapshot } from "./persistence.js";
import {
  chooseResearchOutcome,
  hasReachedResearchTarget,
  makeResearchInitialPlayerCards,
} from "./researchModeEngine.js";

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const DEALER_USERNAME = "ethan";
const DEALER_PASSWORD = "2134asdf";
const DEALER_TOKEN = "dealer-demo-token";
const DEBUG_BETS = process.env.DEBUG_BETS !== "0";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    credentials: true,
  },
});

app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());

const state = {
  lobbies: new Map(),
  soloSessions: new Map(),
  dealerSockets: new Set(),
  pendingDisconnects: new Map(),
};

function createPlayerRecord({ playerId, name, socketId }) {
  return {
    id: playerId,
    name,
    socketId,
    connected: true,
    bankroll: 0,
    pendingBet: 0,
    currentBetTotal: 0,
    buyInRequest: null,
    buyInStatus: "needs_buy_in",
    hands: [],
    activeHandIndex: 0,
    lastResult: "",
    seatJoinedAt: new Date().toISOString(),
  };
}

function createLobbyRecord({ name, dealerHitsSoft17 = false }) {
  return {
    id: crypto.randomUUID().slice(0, 8).toUpperCase(),
    name,
    isOpen: true,
    status: "waiting",
    debugMode: false,
    dealerHitsSoft17,
    createdAt: new Date().toISOString(),
    players: [],
    deck: [],
    dealerHand: [],
    round: {
      phase: "betting",
      activePlayerId: null,
      activeHandIndex: 0,
      order: [],
      settledAt: null,
      resetAvailableAt: null,
      message: "Waiting for approved players and bets.",
    },
  };
}

function createSoloSessionRecord({ sessionId, playerId, name, socketId, researchMode = false }) {
  return {
    id: sessionId || crypto.randomUUID().slice(0, 8).toUpperCase(),
    playerId,
    name,
    socketId,
    connected: true,
    bankroll: 0,
    pendingBet: 0,
    currentBetTotal: 0,
    buyInRequest: null,
    buyInStatus: "needs_buy_in",
    hands: [],
    activeHandIndex: 0,
    lastResult: "",
    deck: [],
    dealerHand: [],
    dealerHitsSoft17: false,
    status: "waiting",
    createdAt: new Date().toISOString(),
    round: {
      phase: "betting",
      activePlayerId: null,
      activeHandIndex: 0,
      settledAt: null,
      resetAvailableAt: null,
      message: "SOLO table ready. Request chips or place a bet.",
    },
    research: {
      enabled: Boolean(researchMode),
      targetMax: null,
      targetMin: null,
      approvedBankroll: 0,
      roundStartBankroll: 0,
      paused: false,
      ended: false,
      note: "",
      alert: "",
      log: [],
      audit: [],
    },
  };
}

function removePlayerFromOtherLobbies(playerId, nextLobbyId) {
  const affectedLobbyIds = [];

  for (const lobby of state.lobbies.values()) {
    if (lobby.id === nextLobbyId) {
      continue;
    }

    const index = lobby.players.findIndex((player) => player.id === playerId);

    if (index >= 0) {
      lobby.players.splice(index, 1);
      affectedLobbyIds.push(lobby.id);
    }
  }

  return affectedLobbyIds;
}

function getLobbyOrThrow(lobbyId) {
  const lobby = state.lobbies.get(lobbyId);

  if (!lobby) {
    throw new Error("Lobby not found.");
  }

  return lobby;
}

function getSoloSessionOrThrow(sessionId) {
  const session = state.soloSessions.get(sessionId);

  if (!session) {
    throw new Error("SOLO session not found.");
  }

  return session;
}

function clearPendingDisconnect(playerId) {
  const timeout = state.pendingDisconnects.get(playerId);

  if (timeout) {
    clearTimeout(timeout);
    state.pendingDisconnects.delete(playerId);
  }
}

function debugLog(label, details = {}) {
  if (!DEBUG_BETS) {
    return;
  }

  console.log(`[debug:${label}]`, JSON.stringify(details));
}

function isSocketAlive(socketId) {
  if (!socketId) {
    return false;
  }

  return io.sockets.sockets.has(socketId);
}

function ensureDealer(token) {
  if (token !== DEALER_TOKEN) {
    throw new Error("Dealer authentication required.");
  }
}

function normalizeAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  return Number(amount.toFixed(2));
}

function clampPendingBet(player) {
  if (player.pendingBet > player.bankroll) {
    player.pendingBet = player.bankroll;
  }

  if (player.pendingBet < 0) {
    player.pendingBet = 0;
  }
}

function resetPlayerRoundData(player) {
  player.hands = [];
  player.activeHandIndex = 0;
  player.currentBetTotal = 0;
}

function makeHand(cards, bet, options = {}) {
  return {
    id: crypto.randomUUID(),
    cards,
    bet,
    stood: false,
    busted: false,
    doubled: false,
    resolved: false,
    result: "",
    fromSplit: options.fromSplit || false,
    blackjack: isBlackjack(cards, { fromSplit: options.fromSplit || false }),
  };
}

function getActiveParticipants(lobby) {
  return lobby.players.filter((player) => player.hands.length > 0);
}

function getPlayerById(lobby, playerId) {
  return lobby.players.find((player) => player.id === playerId);
}

function getSoloRequests() {
  const requests = Array.from(state.soloSessions.values())
    .filter((session) => session.buyInRequest)
    .map((session) => ({
      kind: "buy_in",
      researchMode: Boolean(session.research?.enabled),
      sessionId: session.id,
      requestId: session.buyInRequest.id,
      playerName: session.name,
      requestType: session.bankroll > 0 ? "rebuy" : "initial buy-in",
      amount: session.buyInRequest.amount,
      bankroll: session.bankroll,
      targetMax: session.research?.targetMax,
      targetMin: session.research?.targetMin,
      note: session.research?.note || "",
      createdAt: session.buyInRequest.createdAt,
    }));

  const alerts = Array.from(state.soloSessions.values())
    .filter((session) => session.research?.enabled && session.research?.alert)
    .map((session) => ({
      kind: "research_alert",
      researchMode: true,
      sessionId: session.id,
      requestId: `alert-${session.id}`,
      playerName: session.name,
      requestType: session.research.alert,
      amount: 0,
      bankroll: session.bankroll,
      targetMax: session.research.targetMax,
      targetMin: session.research.targetMin,
      note: session.research.note || "",
      createdAt: new Date().toISOString(),
    }));

  return [...requests, ...alerts];
}

function addResearchAudit(session, event, details = {}) {
  if (!session.research?.enabled) {
    return;
  }

  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    event,
    ...details,
  };

  session.research.audit.push(entry);
  session.research.log.push(entry);
  session.research.log = session.research.log.slice(-20);
}

function getCurrentHand(player) {
  return player.hands[player.activeHandIndex];
}

function getActionableHand(player) {
  return player.hands.find((hand) => !hand.resolved && !hand.busted && !hand.stood && !hand.blackjack);
}

function handSummary(hand) {
  const value = getHandValue(hand.cards);

  return {
    ...hand,
    value: value.total,
    soft: value.soft,
  };
}

function getPublicLobbySummary(lobby) {
  return {
    id: lobby.id,
    name: lobby.name,
    isOpen: lobby.isOpen,
    status: lobby.status,
    playerCount: lobby.players.length,
    approvedPlayers: lobby.players.filter((player) => player.bankroll > 0 || player.buyInStatus === "approved").length,
  };
}

function serializePlayerForDealer(player) {
  return {
    id: player.id,
    name: player.name,
    connected: player.connected,
    bankroll: player.bankroll,
    pendingBet: player.pendingBet,
    currentBetTotal: player.currentBetTotal,
    buyInStatus: player.buyInStatus,
    buyInRequest: player.buyInRequest,
    lastResult: player.lastResult,
    hands: player.hands.map((hand) => ({
      ...handSummary(hand),
      cards: hand.cards.map((card) => formatCard(card)),
    })),
    activeHandIndex: player.activeHandIndex,
    seatJoinedAt: player.seatJoinedAt,
  };
}

function serializePlayerForPlayer(viewerId, player, lobbyFinished) {
  const isSelf = player.id === viewerId;

  return {
    id: player.id,
    name: player.name,
    connected: player.connected,
    bankroll: player.bankroll,
    pendingBet: player.pendingBet,
    currentBetTotal: player.currentBetTotal,
    buyInStatus: player.buyInStatus,
    buyInRequest: player.buyInRequest,
    lastResult: player.lastResult,
    activeHandIndex: player.activeHandIndex,
    hands: player.hands.map((hand) => {
      const base = handSummary(hand);

      if (isSelf || lobbyFinished) {
        return {
          ...base,
          cards: hand.cards.map((card) => formatCard(card)),
        };
      }

      return {
        ...base,
        cards: hand.cards.map((card, index) => (index === 0 ? formatCard(card) : formatCard(card, true))),
      };
    }),
  };
}

function getDealerDashboard() {
  return Array.from(state.lobbies.values()).map((lobby) => ({
    id: lobby.id,
    name: lobby.name,
    isOpen: lobby.isOpen,
    status: lobby.status,
    debugMode: lobby.debugMode,
    dealerHitsSoft17: lobby.dealerHitsSoft17,
    createdAt: lobby.createdAt,
    round: { ...lobby.round },
    dealerHand: {
      cards: lobby.dealerHand.map((card) => formatCard(card)),
      value: getHandValue(lobby.dealerHand).total,
    },
    players: lobby.players.map(serializePlayerForDealer),
  }));
}

function getPlayerLobbyView(lobby, viewerId) {
  const finished = lobby.status === "finished";
  const dealerCards =
    finished || lobby.round.phase === "dealer_turn"
      ? lobby.dealerHand.map((card) => formatCard(card))
      : lobby.dealerHand.map((card, index) => (index === 0 ? formatCard(card) : formatCard(card, true)));

  const dealerVisibleCards =
    finished || lobby.round.phase === "dealer_turn"
      ? lobby.dealerHand
      : lobby.dealerHand.slice(0, 1);

  return {
    id: lobby.id,
    name: lobby.name,
    isOpen: lobby.isOpen,
    status: lobby.status,
    debugMode: lobby.debugMode,
    dealerHitsSoft17: lobby.dealerHitsSoft17,
    round: { ...lobby.round },
    dealerHand: {
      cards: dealerCards,
      value: dealerVisibleCards.length ? getHandValue(dealerVisibleCards).total : 0,
    },
    players: lobby.players.map((player) => serializePlayerForPlayer(viewerId, player, finished)),
  };
}

function serializeSoloSession(session) {
  const finished = session.status === "finished";
  const dealerCards =
    finished || session.round.phase === "dealer_turn"
      ? session.dealerHand.map((card) => formatCard(card))
      : session.dealerHand.map((card, index) => (index === 0 ? formatCard(card) : formatCard(card, true)));
  const dealerVisibleCards =
    finished || session.round.phase === "dealer_turn"
      ? session.dealerHand
      : session.dealerHand.slice(0, 1);

  return {
    id: session.id,
    name: "SOLO AI Table",
    isSolo: true,
    isOpen: true,
    status: session.status,
    debugMode: false,
    dealerHitsSoft17: session.dealerHitsSoft17,
    round: { ...session.round },
    dealerHand: {
      cards: dealerCards,
      value: dealerVisibleCards.length ? getHandValue(dealerVisibleCards).total : 0,
    },
    player: {
      id: session.playerId,
      name: session.name,
      connected: session.connected,
      bankroll: session.bankroll,
      pendingBet: session.pendingBet,
      currentBetTotal: session.currentBetTotal,
      buyInStatus: session.buyInStatus,
      buyInRequest: session.buyInRequest,
      lastResult: session.lastResult,
      activeHandIndex: session.activeHandIndex,
      hands: session.hands.map((hand) => ({
        ...handSummary(hand),
        cards: hand.cards.map((card) => formatCard(card)),
      })),
    },
    research: session.research
      ? {
          enabled: Boolean(session.research.enabled),
          targetMax: session.research.targetMax,
          targetMin: session.research.targetMin,
          approvedBankroll: session.research.approvedBankroll,
          roundStartBankroll: session.research.roundStartBankroll,
          paused: session.research.paused,
          ended: session.research.ended,
          note: session.research.note,
          alert: session.research.alert,
          log: session.research.log,
        }
      : null,
  };
}

function buildSnapshot() {
  return {
    lobbies: Array.from(state.lobbies.values()).map((lobby) => ({
      ...lobby,
      players: lobby.players.map((player) => ({
        ...player,
        socketId: null,
        connected: false,
      })),
    })),
    soloSessions: Array.from(state.soloSessions.values()).map((session) => ({
      ...session,
      socketId: null,
      connected: false,
    })),
  };
}

async function persistAndBroadcast(lobbyId) {
  await saveSnapshot(buildSnapshot());
  io.emit(
    "public:lobbies",
    Array.from(state.lobbies.values())
      .filter((lobby) => lobby.isOpen)
      .map(getPublicLobbySummary),
  );

  io.to("dealers").emit("dealer:dashboard", getDealerDashboard());
  io.to("dealers").emit("dealer:soloRequests", getSoloRequests());

  if (lobbyId) {
    const lobby = state.lobbies.get(lobbyId);

    if (lobby) {
      for (const player of lobby.players) {
        debugLog("broadcast_player", {
          lobbyId,
          playerId: player.id,
          socketId: player.socketId,
          connected: player.connected,
          bankroll: player.bankroll,
          pendingBet: player.pendingBet,
          currentBetTotal: player.currentBetTotal,
          buyInStatus: player.buyInStatus,
        });

        if (player.socketId) {
          io.to(player.socketId).emit("lobby:update", getPlayerLobbyView(lobby, player.id));
        }
      }
    }
  }
}

async function persistAndBroadcastSolo(sessionId) {
  await saveSnapshot(buildSnapshot());
  io.to("dealers").emit("dealer:dashboard", getDealerDashboard());
  io.to("dealers").emit("dealer:soloRequests", getSoloRequests());

  if (sessionId) {
    const session = state.soloSessions.get(sessionId);

    if (session?.socketId) {
      io.to(session.socketId).emit("solo:update", serializeSoloSession(session));
    }
  }
}

function setCurrentTurn(lobby) {
  const order = lobby.round.order;

  while (order.length) {
    const current = order[0];
    const player = getPlayerById(lobby, current.playerId);

    if (!player) {
      order.shift();
      continue;
    }

    player.activeHandIndex = current.handIndex;
    const hand = player.hands[current.handIndex];

    if (!hand || hand.resolved || hand.stood || hand.busted || hand.blackjack) {
      order.shift();
      continue;
    }

    lobby.round.activePlayerId = player.id;
    lobby.round.activeHandIndex = current.handIndex;
    lobby.round.phase = "player_turns";
    lobby.round.message = `${player.name} is acting on hand ${current.handIndex + 1}.`;
    return;
  }

  lobby.round.activePlayerId = null;
  lobby.round.activeHandIndex = 0;
  lobby.round.phase = "awaiting_dealer";
  lobby.round.message = "All players are finished. Dealer can resolve the hand.";
}

function rebuildTurnOrder(lobby) {
  lobby.round.order = [];

  for (const player of getActiveParticipants(lobby)) {
    player.hands.forEach((hand, handIndex) => {
      if (!hand.blackjack && !hand.busted && !hand.stood && !hand.resolved) {
        lobby.round.order.push({ playerId: player.id, handIndex });
      }
    });
  }

  setCurrentTurn(lobby);
}

function finishRoundIfNoActions(lobby) {
  const participants = getActiveParticipants(lobby);
  const hasActionableHands = participants.some((player) => getActionableHand(player));
  const allHandsBusted =
    participants.length > 0 &&
    participants.every((player) => player.hands.length > 0 && player.hands.every((hand) => hand.busted));

  if (!hasActionableHands) {
    if (allHandsBusted) {
      settleRound(lobby, {
        revealDurationMs: 250,
        message: "All players busted. Dealer wins automatically. You can reset the table now.",
      });
      return;
    }

    lobby.round.activePlayerId = null;
    lobby.round.phase = "awaiting_dealer";
    lobby.round.message = "Dealer can reveal and settle the round.";
  }
}

function settleRound(lobby, options = {}) {
  const settledAt = Date.now();
  const revealDurationMs = Number.isFinite(options.revealDurationMs)
    ? options.revealDurationMs
    : Math.max(1000, lobby.dealerHand.length * 1000);
  const dealerValue = getHandValue(lobby.dealerHand).total;
  const dealerBlackjack = isBlackjack(lobby.dealerHand);
  const dealerBust = dealerValue > 21;

  for (const player of getActiveParticipants(lobby)) {
    const results = [];

    for (const hand of player.hands) {
      const playerValue = getHandValue(hand.cards).total;
      let payout = 0;
      let result = "lose";

      if (hand.busted) {
        result = "bust";
      } else if (dealerBlackjack && hand.blackjack) {
        result = "push";
        payout = hand.bet;
      } else if (hand.blackjack && !dealerBlackjack) {
        result = "blackjack";
        payout = hand.bet * 2.5;
      } else if (dealerBlackjack) {
        result = "dealer_blackjack";
      } else if (dealerBust) {
        result = "win";
        payout = hand.bet * 2;
      } else if (playerValue > dealerValue) {
        result = "win";
        payout = hand.bet * 2;
      } else if (playerValue === dealerValue) {
        result = "push";
        payout = hand.bet;
      }

      hand.resolved = true;
      hand.result = result;
      player.bankroll = Number((player.bankroll + payout).toFixed(2));
      results.push(`${result.toUpperCase()} (${playerValue})`);
    }

    player.currentBetTotal = 0;
    player.pendingBet = 0;
    player.lastResult = results.join(" / ");

    debugLog("settle_round_player", {
      lobbyId: lobby.id,
      playerId: player.id,
      bankroll: player.bankroll,
      pendingBet: player.pendingBet,
      currentBetTotal: player.currentBetTotal,
      result: player.lastResult,
    });
  }

  lobby.status = "finished";
  lobby.round.phase = "settled";
  lobby.round.settledAt = settledAt;
  lobby.round.resetAvailableAt = settledAt + revealDurationMs;
  lobby.round.message =
    options.message || "Revealing dealer cards. Reset unlocks after players finish the reveal.";
}

function dealInitialCards(lobby, participants) {
  lobby.deck = createDeck();
  lobby.dealerHand = [];

  participants.forEach((player) => {
    resetPlayerRoundData(player);
    const bet = player.pendingBet;

    player.bankroll = Number((player.bankroll - bet).toFixed(2));
    player.currentBetTotal = bet;
    player.hands = [makeHand([drawCard(lobby), drawCard(lobby)], bet)];
    player.activeHandIndex = 0;
    player.lastResult = "";
  });

  lobby.dealerHand.push(drawCard(lobby));
  lobby.dealerHand.push(drawCard(lobby));

  lobby.status = "in_progress";
  lobby.round.phase = "player_turns";
  lobby.round.message = "Cards dealt. Waiting for player actions.";

  rebuildTurnOrder(lobby);

  if (isBlackjack(lobby.dealerHand)) {
    settleRound(lobby);
    return;
  }

  finishRoundIfNoActions(lobby);
}

function validatePlayerTurn(lobby, playerId) {
  if (lobby.round.phase !== "player_turns" || lobby.round.activePlayerId !== playerId) {
    throw new Error("It is not your turn.");
  }
}

function advanceAfterPlayerAction(lobby) {
  if (lobby.round.order.length) {
    lobby.round.order.shift();
  }

  setCurrentTurn(lobby);
}

function applyPlayerAction(lobby, playerId, action) {
  validatePlayerTurn(lobby, playerId);
  const player = getPlayerById(lobby, playerId);

  if (!player) {
    throw new Error("Player not found.");
  }

  const hand = getCurrentHand(player);

  if (!hand || hand.resolved || hand.busted || hand.stood || hand.blackjack) {
    throw new Error("This hand cannot act.");
  }

  if (action === "hit") {
    hand.cards.push(drawCard(lobby));
    const value = getHandValue(hand.cards).total;

    if (value > 21) {
      hand.busted = true;
      hand.resolved = true;
      advanceAfterPlayerAction(lobby);
    } else if (value === 21) {
      hand.stood = true;
      hand.resolved = true;
      advanceAfterPlayerAction(lobby);
    }
  } else if (action === "stand") {
    hand.stood = true;
    hand.resolved = true;
    advanceAfterPlayerAction(lobby);
  } else if (action === "double") {
    if (hand.cards.length !== 2 || player.bankroll < hand.bet) {
      throw new Error("Double down is not available for this hand.");
    }

    player.bankroll = Number((player.bankroll - hand.bet).toFixed(2));
    hand.bet = Number((hand.bet * 2).toFixed(2));
    player.currentBetTotal = Number((player.currentBetTotal + hand.bet / 2).toFixed(2));
    hand.doubled = true;
    hand.cards.push(drawCard(lobby));
    const value = getHandValue(hand.cards).total;

    if (value > 21) {
      hand.busted = true;
    } else {
      hand.stood = true;
    }

    hand.resolved = true;
    advanceAfterPlayerAction(lobby);
  } else if (action === "split") {
    if (!canSplitCards(hand.cards) || player.bankroll < hand.bet) {
      throw new Error("Split is not available for this hand.");
    }

    player.bankroll = Number((player.bankroll - hand.bet).toFixed(2));
    player.currentBetTotal = Number((player.currentBetTotal + hand.bet).toFixed(2));

    const [firstCard, secondCard] = hand.cards;
    const firstHand = makeHand([firstCard, drawCard(lobby)], hand.bet, { fromSplit: true });
    const secondHand = makeHand([secondCard, drawCard(lobby)], hand.bet, { fromSplit: true });

    player.hands.splice(player.activeHandIndex, 1, firstHand, secondHand);
    rebuildTurnOrder(lobby);
    return;
  } else {
    throw new Error("Unknown action.");
  }

  finishRoundIfNoActions(lobby);
}

function resolveDealer(lobby) {
  if (lobby.round.phase !== "awaiting_dealer") {
    throw new Error("Dealer cannot resolve yet.");
  }

  lobby.round.phase = "dealer_turn";
  lobby.round.message = "Dealer is drawing cards.";

  while (shouldDealerHit(lobby.dealerHand, false)) {
    lobby.dealerHand.push(drawCard(lobby));
  }

  settleRound(lobby);
}

function settleSoloRound(session, options = {}) {
  const settledAt = Date.now();
  const revealDurationMs = Number.isFinite(options.revealDurationMs)
    ? options.revealDurationMs
    : Math.max(1000, session.dealerHand.length * 1000);
  const dealerValue = getHandValue(session.dealerHand).total;
  const dealerBlackjack = isBlackjack(session.dealerHand);
  const dealerBust = dealerValue > 21;
  const results = [];

  for (const hand of session.hands) {
    const playerValue = getHandValue(hand.cards).total;
    let payout = 0;
    let result = "lose";

    if (hand.busted) {
      result = "bust";
    } else if (dealerBlackjack && hand.blackjack) {
      result = "push";
      payout = hand.bet;
    } else if (hand.blackjack && !dealerBlackjack) {
      result = "blackjack";
      payout = hand.bet * 2.5;
    } else if (dealerBlackjack) {
      result = "dealer_blackjack";
    } else if (dealerBust) {
      result = "win";
      payout = hand.bet * 2;
    } else if (playerValue > dealerValue) {
      result = "win";
      payout = hand.bet * 2;
    } else if (playerValue === dealerValue) {
      result = "push";
      payout = hand.bet;
    }

    hand.resolved = true;
    hand.result = result;
    session.bankroll = Number((session.bankroll + payout).toFixed(2));
    results.push(`${result.toUpperCase()} (${playerValue})`);
  }

  session.currentBetTotal = 0;
  session.pendingBet = 0;
  session.lastResult = results.join(" / ");
  session.status = "finished";
  session.round.phase = "settled";
  session.round.activePlayerId = null;
  session.round.activeHandIndex = 0;
  session.round.settledAt = settledAt;
  session.round.resetAvailableAt = settledAt + revealDurationMs;
  session.round.message = options.message || "AI dealer revealed. Reset when the reveal finishes.";

  if (session.research?.enabled) {
    addResearchAudit(session, "controlled_round_result", {
      bankroll: session.bankroll,
      targetMax: session.research.targetMax,
      targetMin: session.research.targetMin,
      result: session.lastResult,
      controllerReason: options.controllerReason || "Normal SOLO resolution.",
    });

    if (hasReachedResearchTarget(session)) {
      session.research.paused = true;
      session.research.alert = "target reached";
      session.round.message = "Wait for dealer input. You have reached the current research target.";
      addResearchAudit(session, "target_reached", {
        bankroll: session.bankroll,
        targetMax: session.research.targetMax,
      });
    }
  }
}

function resolveSoloDealer(session) {
  session.round.phase = "dealer_turn";
  session.round.activePlayerId = null;
  session.round.message = "AI dealer is drawing cards.";

  const allHandsBusted = session.hands.length > 0 && session.hands.every((hand) => hand.busted);

  if (session.research?.enabled && !allHandsBusted) {
    const controlled = chooseResearchOutcome(session);
    session.dealerHand = controlled.dealerHand;
    settleSoloRound(session, {
      controllerReason: controlled.reason,
    });
    return;
  }

  if (!allHandsBusted) {
    while (shouldDealerHit(session.dealerHand, false)) {
      session.dealerHand.push(drawCard(session));
    }
  }

  settleSoloRound(session, allHandsBusted
    ? {
        revealDurationMs: 250,
        message: "You busted. AI dealer wins automatically. You can reset now.",
      }
    : {});
}

function setSoloTurn(session) {
  const nextIndex = session.hands.findIndex(
    (hand) => !hand.resolved && !hand.busted && !hand.stood && !hand.blackjack,
  );

  if (nextIndex >= 0) {
    session.activeHandIndex = nextIndex;
    session.round.activePlayerId = session.playerId;
    session.round.activeHandIndex = nextIndex;
    session.round.phase = "player_turns";
    session.round.message = `${session.name} is acting on hand ${nextIndex + 1}.`;
    return;
  }

  resolveSoloDealer(session);
}

function startSoloRound(session) {
    if (session.research?.enabled) {
      if (session.research.ended) {
        throw new Error("This research session has ended.");
      }

    if (session.research.paused) {
      throw new Error("Wait for dealer input. You have reached the current research target.");
    }
  }

  if (session.status === "in_progress") {
    throw new Error("A SOLO round is already in progress.");
  }

  if (session.pendingBet <= 0 || session.pendingBet > session.bankroll) {
    throw new Error("Queue a valid SOLO bet first.");
  }

  session.deck = createDeck();
  session.dealerHand = [];
  resetPlayerRoundData(session);

  const bet = session.pendingBet;
  session.bankroll = Number((session.bankroll - bet).toFixed(2));
  session.currentBetTotal = bet;
  const playerCards = session.research?.enabled
    ? makeResearchInitialPlayerCards(session, drawCard)
    : [drawCard(session), drawCard(session)];
  session.hands = [makeHand(playerCards, bet)];
  session.activeHandIndex = 0;
  session.lastResult = "";
  session.dealerHand.push(drawCard(session));
  session.dealerHand.push(drawCard(session));
  session.status = "in_progress";
  session.round.phase = "player_turns";
  session.round.message = "AI dealer dealt the cards. Your move.";

  if (isBlackjack(session.dealerHand) || session.hands.every((hand) => hand.blackjack)) {
    settleSoloRound(session);
    return;
  }

  setSoloTurn(session);
}

function applySoloAction(session, action) {
  if (session.round.phase !== "player_turns" || session.round.activePlayerId !== session.playerId) {
    throw new Error("It is not your SOLO turn.");
  }

  const hand = getCurrentHand(session);

  if (!hand || hand.resolved || hand.busted || hand.stood || hand.blackjack) {
    throw new Error("This SOLO hand cannot act.");
  }

  if (action === "hit") {
    hand.cards.push(drawCard(session));
    const value = getHandValue(hand.cards).total;

    if (value > 21) {
      hand.busted = true;
      hand.resolved = true;
      setSoloTurn(session);
    } else if (value === 21) {
      hand.stood = true;
      hand.resolved = true;
      setSoloTurn(session);
    }
  } else if (action === "stand") {
    hand.stood = true;
    hand.resolved = true;
    setSoloTurn(session);
  } else if (action === "double") {
    if (hand.cards.length !== 2 || session.bankroll < hand.bet) {
      throw new Error("Double down is not available for this SOLO hand.");
    }

    session.bankroll = Number((session.bankroll - hand.bet).toFixed(2));
    hand.bet = Number((hand.bet * 2).toFixed(2));
    session.currentBetTotal = Number((session.currentBetTotal + hand.bet / 2).toFixed(2));
    hand.doubled = true;
    hand.cards.push(drawCard(session));
    hand.busted = getHandValue(hand.cards).total > 21;
    hand.stood = !hand.busted;
    hand.resolved = true;
    setSoloTurn(session);
  } else if (action === "split") {
    if (!canSplitCards(hand.cards) || session.bankroll < hand.bet) {
      throw new Error("Split is not available for this SOLO hand.");
    }

    session.bankroll = Number((session.bankroll - hand.bet).toFixed(2));
    session.currentBetTotal = Number((session.currentBetTotal + hand.bet).toFixed(2));

    const [firstCard, secondCard] = hand.cards;
    const firstHand = makeHand([firstCard, drawCard(session)], hand.bet, { fromSplit: true });
    const secondHand = makeHand([secondCard, drawCard(session)], hand.bet, { fromSplit: true });

    session.hands.splice(session.activeHandIndex, 1, firstHand, secondHand);
    setSoloTurn(session);
  } else {
    throw new Error("Unknown SOLO action.");
  }
}

function resetSoloRound(session) {
  session.status = "waiting";
  session.dealerHand = [];
  session.deck = [];
  session.hands = [];
  session.activeHandIndex = 0;
  session.currentBetTotal = 0;
  session.pendingBet = 0;
  session.lastResult = "";
  session.round = {
    phase: "betting",
    activePlayerId: null,
    activeHandIndex: 0,
    settledAt: null,
    resetAvailableAt: null,
    message: "SOLO table ready. Place your next bet.",
  };
}

function drawSpecificRank(lobby, rank) {
  const deckIndex = lobby.deck.findIndex((card) => card.rank === rank);

  if (deckIndex >= 0) {
    const [card] = lobby.deck.splice(deckIndex, 1);
    return card;
  }

  return {
    id: `debug-${rank}-${crypto.randomUUID()}`,
    rank,
    suit: "spades",
  };
}

function findRankCombinationForTarget(baseCards, targetTotal, maxAdditionalCards = 4) {
  const candidates = ["10", "K", "Q", "J", "9", "8", "7", "6", "5", "4", "3", "2", "A"];

  function buildPreviewCards(ranks) {
    return [
      ...baseCards,
      ...ranks.map((rank, index) => ({
        id: `debug-search-${rank}-${index}`,
        rank,
        suit: "spades",
      })),
    ];
  }

  function searchAtDepth(currentRanks, targetDepth) {
    const currentCards = buildPreviewCards(currentRanks);
    const currentTotal = getHandValue(currentCards).total;

    if (currentTotal > targetTotal) {
      return null;
    }

    if (currentRanks.length === targetDepth) {
      return currentTotal === targetTotal ? currentRanks : null;
    }

    for (const rank of candidates) {
      const result = searchAtDepth([...currentRanks, rank], targetDepth);

      if (result) {
        return result;
      }

      session.research.roundStartBankroll = Number(session.bankroll || 0);
    }

    return null;
  }

  for (let depth = 1; depth <= maxAdditionalCards; depth += 1) {
    const result = searchAtDepth([], depth);

    if (result) {
      return result;
    }
  }

  return null;
}

function forceDealerWin(lobby) {
  if (!lobby.debugMode) {
    throw new Error("Debug mode must be enabled first.");
  }

  if (lobby.round.phase !== "awaiting_dealer") {
    throw new Error("Dealer can only force a result after players finish.");
  }

  const liveHands = getActiveParticipants(lobby)
    .flatMap((player) => player.hands)
    .filter((hand) => !hand.busted);

  if (!liveHands.length) {
    throw new Error("No active player hands to beat.");
  }

  const highestPlayerTotal = Math.max(...liveHands.map((hand) => getHandValue(hand.cards).total));
  const targetTotal = highestPlayerTotal >= 21 ? 21 : Math.max(17, highestPlayerTotal + 1);

  if (targetTotal > 21) {
    throw new Error("Cannot force a dealer win against the current hands.");
  }

  const upcard = lobby.dealerHand[0];

  if (!upcard) {
    throw new Error("Dealer needs an upcard before forcing a result.");
  }

  const replacementRanks = findRankCombinationForTarget([upcard], targetTotal);

  if (!replacementRanks?.length) {
    throw new Error("Unable to build a winning dealer hand.");
  }

  lobby.dealerHand = [upcard, ...replacementRanks.map((rank) => drawSpecificRank(lobby, rank))];

  settleRound(lobby);
}

function forceDealerLoss(lobby) {
  if (!lobby.debugMode) {
    throw new Error("Debug mode must be enabled first.");
  }

  if (lobby.round.phase !== "awaiting_dealer") {
    throw new Error("Dealer can only force a result after players finish.");
  }

  const liveHands = getActiveParticipants(lobby)
    .flatMap((player) => player.hands)
    .filter((hand) => !hand.busted);

  if (!liveHands.length) {
    throw new Error("No active player hands to lose against.");
  }

  const highestPlayerTotal = Math.max(...liveHands.map((hand) => getHandValue(hand.cards).total));
  const upcard = lobby.dealerHand[0];

  if (!upcard) {
    throw new Error("Dealer needs an upcard before forcing a result.");
  }

  for (let targetTotal = Math.min(21, highestPlayerTotal - 1); targetTotal >= 17; targetTotal -= 1) {
    const replacementRanks = findRankCombinationForTarget([upcard], targetTotal);

    if (replacementRanks?.length) {
      lobby.dealerHand = [upcard, ...replacementRanks.map((rank) => drawSpecificRank(lobby, rank))];
      settleRound(lobby);
      return;
    }
  }

  for (let baseTotal = 12; baseTotal <= 16; baseTotal += 1) {
    const replacementRanks = findRankCombinationForTarget([upcard], baseTotal);

    if (!replacementRanks?.length) {
      continue;
    }

    const previewCards = [upcard, ...replacementRanks.map((rank, index) => ({
      id: `debug-loss-preview-${rank}-${index}`,
      rank,
      suit: "spades",
    }))];

    for (const bustRank of ["10", "K", "Q", "J", "9", "8", "7", "6", "5", "4", "3", "2", "A"]) {
      const bustPreview = [...previewCards, {
        id: `debug-loss-bust-${bustRank}`,
        rank: bustRank,
        suit: "spades",
      }];

      if (getHandValue(bustPreview).total > 21) {
        lobby.dealerHand = [
          upcard,
          ...replacementRanks.map((rank) => drawSpecificRank(lobby, rank)),
          drawSpecificRank(lobby, bustRank),
        ];
        settleRound(lobby);
        return;
      }
    }
  }

  lobby.dealerHand = [upcard, drawSpecificRank(lobby, "6"), drawSpecificRank(lobby, "K")];
  settleRound(lobby);
}

function resetRound(lobby) {
  lobby.status = "waiting";
  lobby.dealerHand = [];
  lobby.round = {
    phase: "betting",
    activePlayerId: null,
    activeHandIndex: 0,
    order: [],
    settledAt: null,
    resetAvailableAt: null,
    message: "Waiting for approved players and bets.",
  };

  for (const player of lobby.players) {
    resetPlayerRoundData(player);
    player.currentBetTotal = 0;
    player.pendingBet = 0;
    player.lastResult = "";

    debugLog("reset_round_player", {
      lobbyId: lobby.id,
      playerId: player.id,
      bankroll: player.bankroll,
      pendingBet: player.pendingBet,
      currentBetTotal: player.currentBetTotal,
    });
  }
}

function hydrateSnapshot(snapshot) {
  for (const lobbyData of snapshot.lobbies || []) {
    const lobby = {
      ...lobbyData,
      deck: [],
      dealerHand: [],
      players: (lobbyData.players || []).map((player) => ({
        ...player,
        socketId: null,
        connected: false,
        hands: [],
        activeHandIndex: 0,
        currentBetTotal: 0,
        pendingBet: 0,
        lastResult: "",
      })),
      round: {
        phase: "betting",
        activePlayerId: null,
        activeHandIndex: 0,
        order: [],
        settledAt: null,
        resetAvailableAt: null,
        message: "Waiting for approved players and bets.",
      },
      status: "waiting",
    };

    state.lobbies.set(lobby.id, lobby);
  }

  for (const sessionData of snapshot.soloSessions || []) {
    const session = {
      ...sessionData,
      socketId: null,
      connected: false,
      deck: [],
      dealerHand: [],
      hands: [],
      activeHandIndex: 0,
      currentBetTotal: 0,
      pendingBet: 0,
      lastResult: "",
      status: "waiting",
      round: {
        phase: "betting",
        activePlayerId: null,
        activeHandIndex: 0,
        settledAt: null,
        resetAvailableAt: null,
        message: "SOLO table ready. Request chips or place a bet.",
      },
      research: {
        enabled: Boolean(sessionData.research?.enabled),
        targetMax: sessionData.research?.targetMax ?? null,
        targetMin: sessionData.research?.targetMin ?? null,
        approvedBankroll: Number(sessionData.research?.approvedBankroll || 0),
        roundStartBankroll: Number(sessionData.research?.roundStartBankroll || 0),
        paused: false,
        ended: Boolean(sessionData.research?.ended),
        note: sessionData.research?.note || "",
        alert: "",
        log: sessionData.research?.log || [],
        audit: sessionData.research?.audit || [],
      },
    };

    state.soloSessions.set(session.id, session);
  }
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/dealer/login", (request, response) => {
  const { username, password } = request.body || {};

  if (username === DEALER_USERNAME && password === DEALER_PASSWORD) {
    response.json({
      ok: true,
      token: DEALER_TOKEN,
      dealer: { username: DEALER_USERNAME },
    });
    return;
  }

  response.status(401).json({
    ok: false,
    message: "Invalid dealer credentials.",
  });
});

io.on("connection", (socket) => {
  socket.emit(
    "public:lobbies",
    Array.from(state.lobbies.values())
      .filter((lobby) => lobby.isOpen)
      .map(getPublicLobbySummary),
  );

  socket.on("dealer:subscribe", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      state.dealerSockets.add(socket.id);
      socket.join("dealers");
      socket.emit("dealer:dashboard", getDealerDashboard());
      socket.emit("dealer:soloRequests", getSoloRequests());
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:createLobby", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const name = String(payload?.name || "").trim();

      if (!name) {
        throw new Error("Lobby name is required.");
      }

      const lobby = createLobbyRecord({
        name,
        dealerHitsSoft17: Boolean(payload?.dealerHitsSoft17),
      });

      state.lobbies.set(lobby.id, lobby);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true, lobbyId: lobby.id });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:toggleLobby", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      lobby.isOpen = Boolean(payload?.isOpen);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:toggleDebugMode", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      lobby.debugMode = Boolean(payload?.debugMode);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:respondBuyIn", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      const player = getPlayerById(lobby, payload?.playerId);

      if (!player || !player.buyInRequest) {
        throw new Error("No pending buy-in request found.");
      }

      const approved = Boolean(payload?.approved);
      if (approved) {
        player.bankroll = Number((player.bankroll + player.buyInRequest.amount).toFixed(2));
        player.buyInStatus = "approved";
      } else {
        player.buyInStatus = "denied";
      }

      player.buyInRequest = null;
      clampPendingBet(player);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:respondSoloBuyIn", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (!session.buyInRequest || session.buyInRequest.id !== payload?.requestId) {
        throw new Error("This SOLO request has already been handled.");
      }

      if (session.research?.enabled) {
        const targetMax = payload?.targetMax === "" || payload?.targetMax == null
          ? session.research.targetMax
          : normalizeAmount(payload.targetMax);
        const targetMin = payload?.targetMin === "" || payload?.targetMin == null
          ? session.research.targetMin
          : normalizeAmount(payload.targetMin);

        session.research.targetMax = targetMax;
        session.research.targetMin = targetMin;
        session.research.note = String(payload?.note || session.research.note || "").trim();
      }

      if (Boolean(payload?.approved)) {
        session.bankroll = Number((session.bankroll + session.buyInRequest.amount).toFixed(2));
        session.research.approvedBankroll = Number(
          ((session.research?.approvedBankroll || 0) + session.buyInRequest.amount).toFixed(2),
        );
        session.buyInStatus = "approved";
        session.round.message = `SOLO buy-in approved. ${session.name} can play.`;
        addResearchAudit(session, "buy_in_approved", {
          dealerSocketId: socket.id,
          amount: session.buyInRequest.amount,
          targetMax: session.research?.targetMax,
          targetMin: session.research?.targetMin,
          note: session.research?.note,
        });
      } else {
        session.buyInStatus = "denied";
        session.round.message = "SOLO buy-in denied. Submit a new request if needed.";
        addResearchAudit(session, "buy_in_denied", {
          dealerSocketId: socket.id,
          amount: session.buyInRequest.amount,
        });
      }

      session.buyInRequest = null;
      clampPendingBet(session);
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:updateSoloResearch", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (!session.research?.enabled) {
        throw new Error("This SOLO session is not in research mode.");
      }

      const previousTargetMax = session.research.targetMax;

      if (payload?.targetMax !== undefined && payload.targetMax !== "") {
        session.research.targetMax = normalizeAmount(payload.targetMax);
      }

      if (payload?.targetMin !== undefined && payload.targetMin !== "") {
        session.research.targetMin = normalizeAmount(payload.targetMin);
      }

      if (payload?.note !== undefined) {
        session.research.note = String(payload.note || "").trim();
      }

      if (payload?.paused !== undefined) {
        session.research.paused = Boolean(payload.paused);
      }

      if (payload?.ended !== undefined) {
        session.research.ended = Boolean(payload.ended);
      }

      session.research.alert = "";
      const targetLoweredBelowBankroll =
        session.research.targetMax &&
        session.research.targetMax !== previousTargetMax &&
        session.research.targetMax < session.bankroll;
      session.round.message = session.research.ended
        ? "Research session ended by dealer."
        : session.research.paused
          ? "Wait for dealer input. Research session is paused."
          : targetLoweredBelowBankroll
            ? `Dealer changed target balance to $${session.research.targetMax}. Research mode is controlling outcomes toward the new target.`
            : "Research controls updated by dealer. Session resumed.";
      addResearchAudit(session, "research_controls_updated", {
        dealerSocketId: socket.id,
        targetMax: session.research.targetMax,
        targetMin: session.research.targetMin,
        paused: session.research.paused,
        ended: session.research.ended,
        note: session.research.note,
      });
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:startRound", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);

      if (lobby.status === "in_progress") {
        throw new Error("A round is already in progress.");
      }

      const participants = lobby.players.filter(
        (player) => player.bankroll > 0 && player.pendingBet > 0 && player.pendingBet <= player.bankroll,
      );

      if (!participants.length) {
        throw new Error("At least one approved player with a valid bet is required.");
      }

      dealInitialCards(lobby, participants);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:resolveRound", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      resolveDealer(lobby);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:forceDealerWin", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      forceDealerWin(lobby);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:forceDealerLoss", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      forceDealerLoss(lobby);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("dealer:resetRound", async (payload, callback = () => {}) => {
    try {
      ensureDealer(payload?.token);
      const lobby = getLobbyOrThrow(payload?.lobbyId);

      if (lobby.status === "finished" && lobby.round.resetAvailableAt && Date.now() < lobby.round.resetAvailableAt) {
        throw new Error("Wait for players to finish the reveal before resetting.");
      }

      resetRound(lobby);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:joinLobby", async (payload, callback = () => {}) => {
    try {
      const lobby = getLobbyOrThrow(payload?.lobbyId);

      if (!lobby.isOpen) {
        throw new Error("This lobby is currently closed.");
      }

      const name = String(payload?.name || "").trim();
      const playerId = String(payload?.playerId || crypto.randomUUID());

      if (!name) {
        throw new Error("Display name is required.");
      }

      const duplicate = lobby.players.find(
        (player) => player.name.toLowerCase() === name.toLowerCase() && player.id !== playerId,
      );

      if (duplicate) {
        throw new Error("That player name is already in use in this lobby.");
      }

      const affectedLobbyIds = removePlayerFromOtherLobbies(playerId, lobby.id);

      let player = getPlayerById(lobby, playerId);

      if (!player) {
        player = createPlayerRecord({ playerId, name, socketId: socket.id });
        lobby.players.push(player);
      } else {
        player.name = name;
        player.socketId = socket.id;
        player.connected = true;
      }

      clearPendingDisconnect(player.id);

      socket.data.playerId = player.id;
      socket.data.lobbyId = lobby.id;
      socket.join(`lobby:${lobby.id}`);
      debugLog("join_lobby", {
        lobbyId: lobby.id,
        playerId: player.id,
        socketId: socket.id,
        connected: player.connected,
        bankroll: player.bankroll,
        pendingBet: player.pendingBet,
        currentBetTotal: player.currentBetTotal,
        buyInStatus: player.buyInStatus,
      });
      await persistAndBroadcast(lobby.id);

      for (const affectedLobbyId of affectedLobbyIds) {
        await persistAndBroadcast(affectedLobbyId);
      }

      callback({ ok: true, playerId: player.id });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:requestBuyIn", async (payload, callback = () => {}) => {
    try {
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      const player = getPlayerById(lobby, payload?.playerId);

      if (!player) {
        throw new Error("Player not found.");
      }

      if (player.buyInRequest) {
        throw new Error("A buy-in request is already pending.");
      }

      player.buyInRequest = {
        id: crypto.randomUUID(),
        amount: normalizeAmount(payload?.amount),
        createdAt: new Date().toISOString(),
      };
      player.buyInStatus = "pending";
      debugLog("request_buyin", {
        lobbyId: lobby.id,
        playerId: player.id,
        socketId: socket.id,
        bankroll: player.bankroll,
        pendingBet: player.pendingBet,
        requestedAmount: player.buyInRequest.amount,
      });
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:addChip", async (payload, callback = () => {}) => {
    try {
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      const player = getPlayerById(lobby, payload?.playerId);

      if (!player) {
        throw new Error("Player not found.");
      }

      if (lobby.status === "in_progress") {
        throw new Error("You cannot change bets during an active round.");
      }

      const chip = normalizeAmount(payload?.amount);
      const previousBet = player.pendingBet;
      const nextBet = Number((player.pendingBet + chip).toFixed(2));

      if (nextBet > player.bankroll) {
        throw new Error("Not enough bankroll for that chip.");
      }

      player.pendingBet = nextBet;
      debugLog("add_chip", {
        lobbyId: lobby.id,
        playerId: player.id,
        socketId: socket.id,
        chip,
        previousBet,
        nextBet: player.pendingBet,
        bankroll: player.bankroll,
        connected: player.connected,
      });
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:clearBet", async (payload, callback = () => {}) => {
    try {
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      const player = getPlayerById(lobby, payload?.playerId);

      if (!player) {
        throw new Error("Player not found.");
      }

      if (lobby.status === "in_progress") {
        throw new Error("You cannot clear bets during an active round.");
      }

      debugLog("clear_bet", {
        lobbyId: lobby.id,
        playerId: player.id,
        socketId: socket.id,
        previousBet: player.pendingBet,
        bankroll: player.bankroll,
      });
      player.pendingBet = 0;
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:action", async (payload, callback = () => {}) => {
    try {
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      applyPlayerAction(lobby, payload?.playerId, payload?.action);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:leaveLobby", async (payload, callback = () => {}) => {
    try {
      const lobby = getLobbyOrThrow(payload?.lobbyId);
      const index = lobby.players.findIndex((player) => player.id === payload?.playerId);

      if (index >= 0) {
        const [player] = lobby.players.splice(index, 1);

        if (lobby.round.activePlayerId === player.id) {
          advanceAfterPlayerAction(lobby);
        }
      }

      socket.leave(`lobby:${lobby.id}`);
      await persistAndBroadcast(lobby.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("solo:join", async (payload, callback = () => {}) => {
    try {
      const name = String(payload?.name || "").trim();
      const playerId = String(payload?.playerId || crypto.randomUUID());

      if (!name) {
        throw new Error("Display name is required for SOLO.");
      }

      let session = payload?.sessionId ? state.soloSessions.get(payload.sessionId) : null;
      const researchMode = Boolean(payload?.researchMode);

      if (!session) {
        session = createSoloSessionRecord({
          sessionId: payload?.sessionId,
          playerId,
          name,
          socketId: socket.id,
          researchMode,
        });
        state.soloSessions.set(session.id, session);
      } else if (session.playerId !== playerId) {
        throw new Error("That SOLO session belongs to another player.");
      } else {
        if (researchMode && !session.research?.enabled && session.bankroll <= 0 && !session.hands.length) {
          session.research.enabled = true;
        }

        session.name = name;
        session.socketId = socket.id;
        session.connected = true;
      }

      socket.data.soloSessionId = session.id;
      socket.data.soloPlayerId = session.playerId;
      socket.join(`solo:${session.id}`);
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true, sessionId: session.id, playerId: session.playerId });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("solo:requestBuyIn", async (payload, callback = () => {}) => {
    try {
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (session.playerId !== payload?.playerId) {
        throw new Error("SOLO player mismatch.");
      }

      if (session.buyInRequest) {
        throw new Error("A SOLO buy-in request is already pending.");
      }

      session.buyInRequest = {
        id: crypto.randomUUID(),
        amount: normalizeAmount(payload?.amount),
        createdAt: new Date().toISOString(),
      };
      session.buyInStatus = "pending";
      session.round.message = "SOLO buy-in request sent. Waiting for dealer approval.";
      addResearchAudit(session, "buy_in_requested", {
        amount: session.buyInRequest.amount,
        bankroll: session.bankroll,
      });
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("solo:addChip", async (payload, callback = () => {}) => {
    try {
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (session.playerId !== payload?.playerId) {
        throw new Error("SOLO player mismatch.");
      }

      if (session.status === "in_progress") {
        throw new Error("You cannot change SOLO bets during an active round.");
      }

      const chip = normalizeAmount(payload?.amount);
      const nextBet = Number((session.pendingBet + chip).toFixed(2));

      if (nextBet > session.bankroll) {
        throw new Error("Not enough bankroll for that SOLO chip.");
      }

      session.pendingBet = nextBet;
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("solo:clearBet", async (payload, callback = () => {}) => {
    try {
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (session.playerId !== payload?.playerId) {
        throw new Error("SOLO player mismatch.");
      }

      if (session.status === "in_progress") {
        throw new Error("You cannot clear SOLO bets during an active round.");
      }

      session.pendingBet = 0;
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("solo:startRound", async (payload, callback = () => {}) => {
    try {
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (session.playerId !== payload?.playerId) {
        throw new Error("SOLO player mismatch.");
      }

      startSoloRound(session);
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("solo:action", async (payload, callback = () => {}) => {
    try {
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (session.playerId !== payload?.playerId) {
        throw new Error("SOLO player mismatch.");
      }

      applySoloAction(session, payload?.action);
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("solo:resetRound", async (payload, callback = () => {}) => {
    try {
      const session = getSoloSessionOrThrow(payload?.sessionId);

      if (session.playerId !== payload?.playerId) {
        throw new Error("SOLO player mismatch.");
      }

      if (session.status === "finished" && session.round.resetAvailableAt && Date.now() < session.round.resetAvailableAt) {
        throw new Error("Wait for the AI dealer reveal to finish before resetting.");
      }

      resetSoloRound(session);
      await persistAndBroadcastSolo(session.id);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("disconnect", async () => {
    state.dealerSockets.delete(socket.id);

    const { lobbyId, playerId } = socket.data;

    if (socket.data.soloSessionId) {
      const session = state.soloSessions.get(socket.data.soloSessionId);

      if (session && session.socketId === socket.id) {
        session.connected = false;
        session.socketId = null;
        await persistAndBroadcastSolo(session.id);
      }
    }

    if (!lobbyId || !playerId) {
      return;
    }

    const lobby = state.lobbies.get(lobbyId);

    if (!lobby) {
      return;
    }

    const player = getPlayerById(lobby, playerId);

    if (!player) {
      return;
    }

    clearPendingDisconnect(player.id);

    const timeout = setTimeout(async () => {
      const latestLobby = state.lobbies.get(lobbyId);
      const latestPlayer = latestLobby ? getPlayerById(latestLobby, playerId) : null;

      if (!latestLobby || !latestPlayer) {
        state.pendingDisconnects.delete(playerId);
        return;
      }

      if (isSocketAlive(latestPlayer.socketId)) {
        latestPlayer.connected = true;
        debugLog("disconnect_ignored", {
          lobbyId,
          playerId,
          staleSocketId: socket.id,
          activeSocketId: latestPlayer.socketId,
          pendingBet: latestPlayer.pendingBet,
          bankroll: latestPlayer.bankroll,
        });
        state.pendingDisconnects.delete(playerId);
        return;
      }

      latestPlayer.connected = false;
      latestPlayer.socketId = null;
      debugLog("disconnect_finalized", {
        lobbyId,
        playerId,
        staleSocketId: socket.id,
        pendingBet: latestPlayer.pendingBet,
        bankroll: latestPlayer.bankroll,
      });

      if (latestLobby.round.activePlayerId === latestPlayer.id) {
        const hand = getCurrentHand(latestPlayer);

        if (hand && !hand.resolved) {
          hand.stood = true;
          hand.resolved = true;
        }

        advanceAfterPlayerAction(latestLobby);
      }

      state.pendingDisconnects.delete(playerId);
      await persistAndBroadcast(latestLobby.id);
    }, 4000);

    state.pendingDisconnects.set(playerId, timeout);
  });
});

const snapshot = await loadSnapshot();
hydrateSnapshot(snapshot);

server.listen(PORT, () => {
  console.log(`Blackjack server listening on http://localhost:${PORT}`);
});
