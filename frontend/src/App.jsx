import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const PLAYER_STORAGE_KEY = "blackjack-table-player";
const SOLO_STORAGE_KEY = "blackjack-table-solo-player";
const RESEARCH_STORAGE_KEY = "blackjack-table-research-player";
const DEALER_STORAGE_KEY = "blackjack-table-dealer";
const CHIP_VALUES = [5, 10, 20, 50];

const socket = io(API_URL, {
  autoConnect: true,
  transports: ["websocket"],
  reconnection: true,
});

function currency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function getVisibleHandValue(cards = []) {
  let total = 0;
  let aces = 0;

  cards.forEach((card) => {
    if (card.rank === "A") {
      total += 11;
      aces += 1;
      return;
    }

    if (["K", "Q", "J"].includes(card.rank)) {
      total += 10;
      return;
    }

    total += Number(card.rank || 0);
  });

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }

  return total;
}

function emitAsync(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response) => resolve(response));
  });
}

function StatusPill({ children, tone = "neutral" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function Card({ card }) {
  const red = card.suit === "hearts" || card.suit === "diamonds";

  return (
    <div className={`card-face ${card.hidden ? "card-hidden" : ""} ${red ? "card-red" : ""}`}>
      {card.hidden ? (
        <div className="card-hidden-inner">?</div>
      ) : (
        <>
          <span>{card.rank}</span>
          <strong>{card.label?.slice(-1) || ""}</strong>
        </>
      )}
    </div>
  );
}

function HandCards({ cards = [] }) {
  return (
    <div className="card-row">
      {cards.map((card) => (
        <Card key={card.id} card={card} />
      ))}
    </div>
  );
}

function AnimatedDealerHand({ cards = [], value = 0, revealTriggered }) {
  const [visibleCount, setVisibleCount] = useState(cards.some((card) => card.hidden) ? cards.length : 0);

  useEffect(() => {
    const hasHiddenCards = cards.some((card) => card.hidden);

    if (hasHiddenCards) {
      setVisibleCount(cards.length);
      return;
    }

    if (!revealTriggered) {
      setVisibleCount(cards.length ? 0 : 0);
      return;
    }

    if (!cards.length) {
      setVisibleCount(0);
      return;
    }

    setVisibleCount(1);

    if (cards.length === 1) {
      return;
    }

    let nextCount = 1;
    const interval = setInterval(() => {
      nextCount += 1;
      setVisibleCount(Math.min(nextCount, cards.length));

      if (nextCount >= cards.length) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [cards, revealTriggered]);

  const shownCards = cards.filter((_, index) => index < visibleCount);
  const visibleValue = getVisibleHandValue(shownCards);
  const valueLabel = revealTriggered ? visibleValue : value;

  return (
    <div className="dealer-strip">
      <HandCards cards={shownCards} />
      <div className="metric-card compact">
        <span>Dealer value</span>
        <strong>{valueLabel}</strong>
      </div>
    </div>
  );
}

function DealerHandInstant({ cards = [], value = 0 }) {
  return (
    <div className="dealer-strip">
      <HandCards cards={cards} />
      <div className="metric-card compact">
        <span>Dealer value</span>
        <strong>{cards.length ? value : 0}</strong>
      </div>
    </div>
  );
}

function SectionCard({ title, subtitle, actions, children }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function DealerRoundSummary({ lobby, onResolveRound, onResetRound }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (lobby?.status !== "finished" || !lobby?.round?.resetAvailableAt) {
      setNow(Date.now());
      return undefined;
    }

    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [lobby?.status, lobby?.round?.resetAvailableAt]);

  const players = lobby?.players || [];
  const waitingBuyIns = players.filter((player) => player.buyInStatus === "pending").length;
  const queuedBets = players.filter((player) => player.pendingBet > 0).length;
  const activeHands = players.reduce((count, player) => count + player.hands.length, 0);
  const activePlayer = players.find((player) => lobby?.round?.activePlayerId === player.id);
  const canReveal = lobby?.round?.phase === "awaiting_dealer";
  const resetCountdownMs = Math.max(0, Number(lobby?.round?.resetAvailableAt || 0) - now);
  const canReset = lobby?.status === "finished" && resetCountdownMs <= 0;
  const resetCountdownSeconds = Math.ceil(resetCountdownMs / 1000);

  return (
    <SectionCard
      title="Round Status"
      subtitle="Quick read on who is ready, what the table is waiting for, and what you should do next."
      actions={
        <div className="inline-actions">
          <button className="secondary-button" disabled={!canReveal} onClick={() => onResolveRound(lobby.id)}>
            Reveal & settle
          </button>
          <button className="ghost-button" disabled={!canReset} onClick={() => onResetRound(lobby.id)}>
            {canReset ? "Reset round" : `Reset in ${resetCountdownSeconds}s`}
          </button>
        </div>
      }
    >
      <div className="bankroll-grid">
        <div className="metric-card">
          <span>Pending buy-ins</span>
          <strong>{waitingBuyIns}</strong>
        </div>
        <div className="metric-card">
          <span>Queued bettors</span>
          <strong>{queuedBets}</strong>
        </div>
        <div className="metric-card">
          <span>Active hands</span>
          <strong>{activeHands}</strong>
        </div>
        <div className="metric-card">
          <span>Current turn</span>
          <strong>{activePlayer ? activePlayer.name : "None"}</strong>
        </div>
      </div>

      <div className="status-row">
        <StatusPill tone={canReveal ? "success" : canReset ? "neutral" : "warning"}>
          {canReveal ? "Ready to reveal" : canReset ? "Ready to reset" : "Round in progress"}
        </StatusPill>
        <span className="muted">{lobby?.round?.message}</span>
      </div>
    </SectionCard>
  );
}

function DealerLogin({ onLogin, busy, error }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="auth-card">
      <div>
        <p className="eyebrow">Dealer Access</p>
        <h2>Run the table from a secure dashboard.</h2>
        <p className="muted">
          Dealer auth is hardcoded for demo use, but the flow is separated so it can be swapped later.
        </p>
      </div>

      <label>
        Username
        <input
          value={username}
          placeholder="Dealer username"
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>

      <label>
        Password
        <input
          type="password"
          value={password}
          placeholder="Dealer password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      {error ? <div className="error-banner">{error}</div> : null}

      <button className="primary-button" disabled={busy} onClick={() => onLogin({ username, password })}>
        {busy ? "Logging in..." : "Enter Dealer Dashboard"}
      </button>
    </div>
  );
}

function PlayerEntry({ onEnter, error }) {
  const [name, setName] = useState("");

  return (
    <div className="auth-card">
      <div>
        <p className="eyebrow">Player Entry</p>
        <h2>Pick a display name and jump into a live table.</h2>
        <p className="muted">Players can browse open lobbies live and join without a password.</p>
      </div>

      <label>
        Display name
        <input
          value={name}
          placeholder="AcesHigh"
          maxLength={20}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      {error ? <div className="error-banner">{error}</div> : null}

      <button className="primary-button" onClick={() => onEnter(name)}>
        Continue as Player
      </button>
    </div>
  );
}

function ResearchEntry({ onEnter, error }) {
  const [name, setName] = useState("");

  return (
    <div className="auth-card research-card">
      <div>
        <p className="eyebrow">Transparent Simulator</p>
        <h2>Enter RESEARCH MODE</h2>
        <p className="muted">
          This is not fair blackjack. Outcomes may be controlled for testing and every session is clearly disclosed.
        </p>
      </div>

      <label>
        Display name
        <input
          value={name}
          placeholder="ResearchPlayer"
          maxLength={20}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      {error ? <div className="error-banner">{error}</div> : null}

      <button className="danger-button" onClick={() => onEnter(name)}>
        Continue to Research Mode
      </button>
    </div>
  );
}

function LobbyList({ lobbies, onJoin, joinedLobbyId }) {
  return (
    <SectionCard
      title="Open Lobbies"
      subtitle="Updates stream live as dealers create, close, or advance tables."
    >
      <div className="lobby-grid">
        {lobbies.length ? (
          lobbies.map((lobby) => (
            <div key={lobby.id} className="lobby-card">
              <div className="lobby-card-top">
                <div>
                  <h4>{lobby.name}</h4>
                  <p>Lobby #{lobby.id}</p>
                </div>
                <div className="inline-actions">
                  <StatusPill tone={lobby.status === "waiting" ? "success" : "warning"}>
                    {lobby.status}
                  </StatusPill>
                  {lobby.debugMode ? <StatusPill tone="danger">debug</StatusPill> : null}
                </div>
              </div>
              <p>{lobby.playerCount} players seated</p>
              <button
                className="secondary-button"
                disabled={joinedLobbyId === lobby.id}
                onClick={() => onJoin(lobby.id)}
              >
                {joinedLobbyId === lobby.id ? "Joined" : "Join Lobby"}
              </button>
            </div>
          ))
        ) : (
          <div className="empty-state">No open lobbies yet. Wait for a dealer to open one.</div>
        )}
      </div>
    </SectionCard>
  );
}

function BuyInPanel({ player, onRequestBuyIn, onAddChip, onClearBet, onAllIn, disabled }) {
  const [amount, setAmount] = useState("");
  const availableToBet = Math.max(0, Number(player?.bankroll || 0) - Number(player?.pendingBet || 0));
  const buyInApproved = player?.buyInStatus === "approved" || Number(player?.bankroll || 0) > 0;

  return (
    <div className="stack gap-md">
      <SectionCard title="Bankroll" subtitle="Request chips first, then build your hand wager with fixed chips.">
        <div className="bankroll-grid">
          <div className="metric-card">
            <span>Available bankroll</span>
            <strong>{currency(player?.bankroll)}</strong>
          </div>
          <div className="metric-card">
            <span>Queued bet</span>
            <strong>{currency(player?.pendingBet)}</strong>
          </div>
          <div className="metric-card">
            <span>Available to bet</span>
            <strong>{currency(availableToBet)}</strong>
          </div>
        </div>

        <div className="buyin-row">
          <input
            value={amount}
            type="number"
            min="1"
            placeholder="Request buy-in or rebuy"
            onChange={(event) => setAmount(event.target.value)}
          />
          <button
            className="secondary-button"
            disabled={disabled || player?.buyInStatus === "pending"}
            onClick={() => {
              onRequestBuyIn(amount);
              setAmount("");
            }}
          >
            {player?.bankroll > 0 ? "Request Rebuy" : "Request Buy-In"}
          </button>
        </div>

        <div className="status-row">
          <StatusPill
            tone={
              buyInApproved
                ? "success"
                : player?.buyInStatus === "denied"
                  ? "danger"
                  : player?.buyInStatus === "pending"
                    ? "warning"
                    : "neutral"
            }
          >
            {player?.buyInStatus?.replaceAll("_", " ")}
          </StatusPill>
          {player?.buyInRequest ? (
            <span className="muted">Pending request: {currency(player.buyInRequest.amount)}</span>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Betting Chips" subtitle="Your wager is only deducted when the dealer starts the round.">
        {!buyInApproved ? (
          <div className="info-banner">Chip buttons unlock after the dealer approves your buy-in or rebuy.</div>
        ) : null}
        <div className="bet-builder">
          <div className="metric-card compact">
            <span>Current queued bet</span>
            <strong>{currency(player?.pendingBet)}</strong>
          </div>
          <button
            className="ghost-button bet-reset-button"
            disabled={disabled || !player?.pendingBet}
            onClick={onClearBet}
          >
            Reset queued bet
          </button>
        </div>
        <div className="chip-row">
          {CHIP_VALUES.map((chip) => (
            <button
              key={chip}
              className="chip-button"
              disabled={disabled || availableToBet < chip || !buyInApproved}
              onClick={() => onAddChip(chip)}
            >
              +{currency(chip)}
            </button>
          ))}
          <button
            className="secondary-button"
            disabled={disabled || !buyInApproved || availableToBet <= 0}
            onClick={() => onAllIn(availableToBet)}
          >
            All in
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

function PlayerTable({ lobby, player, onAction, revealComplete }) {
  const isTurn = lobby?.round?.activePlayerId === player?.id;
  const activeHand = player?.hands?.[player?.activeHandIndex || 0];
  const canDouble = isTurn && activeHand?.cards?.length === 2 && player?.bankroll >= activeHand?.bet;
  const canSplit =
    isTurn &&
    activeHand?.cards?.length === 2 &&
    activeHand?.cards?.[0]?.rank &&
    activeHand?.cards?.[1]?.rank &&
    player?.bankroll >= activeHand?.bet &&
    (activeHand.cards[0].rank === activeHand.cards[1].rank ||
      (["10", "J", "Q", "K"].includes(activeHand.cards[0].rank) &&
        ["10", "J", "Q", "K"].includes(activeHand.cards[1].rank)));

  return (
    <div className="stack gap-md">
      <SectionCard
        title="Dealer Hand"
        subtitle={`Table state: ${lobby?.round?.message || "Waiting for action."}`}
      >
        <AnimatedDealerHand
          cards={lobby?.dealerHand?.cards || []}
          value={lobby?.dealerHand?.value || 0}
          revealTriggered={lobby?.status === "finished"}
        />
      </SectionCard>

      <SectionCard
        title="Your Hands"
        subtitle={
          revealComplete && player?.lastResult
            ? `Last result: ${player.lastResult}`
            : "Play only when your hand is active."
        }
      >
        <div className="hand-grid">
          {(player?.hands || []).length ? (
            player.hands.map((hand, index) => (
              <div
                key={hand.id}
                className={`hand-card ${index === player.activeHandIndex ? "hand-card-active" : ""}`}
              >
                <div className="hand-top">
                  <div>
                    <h4>Hand {index + 1}</h4>
                    <p>Bet {currency(hand.bet)}</p>
                  </div>
                  <StatusPill
                    tone={
                      revealComplete && (hand.result === "win" || hand.result === "blackjack")
                        ? "success"
                        : revealComplete && hand.result === "push"
                          ? "neutral"
                          : revealComplete && hand.result
                            ? "danger"
                            : "warning"
                    }
                  >
                    {revealComplete
                      ? hand.result || (hand.busted ? "busted" : hand.blackjack ? "blackjack" : "active")
                      : "active"}
                  </StatusPill>
                </div>
                <HandCards cards={hand.cards} />
                <p className="muted">Value: {hand.value}</p>
              </div>
            ))
          ) : (
            <div className="empty-state">Place a bet and wait for the dealer to start the round.</div>
          )}
        </div>

        <div className="actions-row">
          <button className="primary-button" disabled={!isTurn} onClick={() => onAction("hit")}>
            Hit
          </button>
          <button className="secondary-button" disabled={!isTurn} onClick={() => onAction("stand")}>
            Stand
          </button>
          <button className="secondary-button" disabled={!canDouble} onClick={() => onAction("double")}>
            Double Down
          </button>
          <button className="secondary-button" disabled={!canSplit} onClick={() => onAction("split")}>
            Split
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

function PlayerLobbyView({ lobby, playerId, onRequestBuyIn, onAddChip, onClearBet, onAllIn, onAction, onLeave }) {
  const player = useMemo(() => lobby?.players?.find((entry) => entry.id === playerId), [lobby, playerId]);
  const previousStatusRef = useRef(lobby?.status || "waiting");
  const displayedBankrollRef = useRef(player?.bankroll || 0);
  const [winFlashAmount, setWinFlashAmount] = useState(0);
  const [displayedBankroll, setDisplayedBankroll] = useState(Number(player?.bankroll || 0));
  const [now, setNow] = useState(Date.now());
  const bettingLocked = lobby?.status === "in_progress";
  const revealComplete =
    lobby?.status !== "finished" || !lobby?.round?.resetAvailableAt
      ? true
      : now >= Number(lobby.round.resetAvailableAt);

  useEffect(() => {
    if (lobby?.status !== "finished" || !lobby?.round?.resetAvailableAt) {
      setNow(Date.now());
      return undefined;
    }

    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [lobby?.status, lobby?.round?.resetAvailableAt]);

  useEffect(() => {
    if (!lobby || !player) {
      return undefined;
    }

    const previousStatus = previousStatusRef.current;
    const currentBankroll = Number(player.bankroll || 0);
    const currentDisplayed = Number(displayedBankrollRef.current || 0);
    const delta = Number((currentBankroll - currentDisplayed).toFixed(2));
    const hasWinningHand = (player.hands || []).some((hand) => ["win", "blackjack"].includes(hand.result));

    if (lobby.status !== "finished") {
      setDisplayedBankroll(currentBankroll);
      displayedBankrollRef.current = currentBankroll;
    }

    if (lobby.status === "finished" && previousStatus !== "finished" && delta !== 0) {
      const revealDelay = Math.max(0, Number(lobby.round?.resetAvailableAt || 0) - Date.now());
      const revealTimeout = setTimeout(() => {
        setDisplayedBankroll(currentBankroll);
        displayedBankrollRef.current = currentBankroll;
        setWinFlashAmount(hasWinningHand && delta > 0 ? delta : 0);
      }, revealDelay);
      const hideTimeout = setTimeout(() => setWinFlashAmount(0), revealDelay + 3200);
      previousStatusRef.current = lobby.status;
      return () => {
        clearTimeout(revealTimeout);
        clearTimeout(hideTimeout);
      };
    }

    previousStatusRef.current = lobby.status;
    return undefined;
  }, [lobby.status, lobby.round?.resetAvailableAt, player?.bankroll, player?.hands]);

  if (!lobby || !player) {
    return null;
  }

  return (
    <div className="stack gap-md">
      {winFlashAmount > 0 ? (
        <div className="win-overlay">
          <div className="win-overlay-text">WIN {currency(winFlashAmount)}</div>
        </div>
      ) : null}

      <SectionCard
        title={lobby.name}
        subtitle={`Lobby #${lobby.id} - Dealer rule: ${lobby.dealerHitsSoft17 ? "Hit soft 17" : "Stand on soft 17"}`}
        actions={
          <button className="ghost-button" onClick={onLeave}>
            Leave lobby
          </button>
        }
      >
        {lobby.debugMode ? (
          <div className="warning-banner">
           
          </div>
        ) : null}
        <div className="status-row">
          <StatusPill tone={lobby.status === "waiting" ? "success" : lobby.status === "finished" ? "neutral" : "warning"}>
            {lobby.status}
          </StatusPill>
          <span className="muted">{lobby.round.message}</span>
        </div>
      </SectionCard>

      <div className="content-grid player-layout">
        <SectionCard
          title="Your Seat"
          subtitle={
            revealComplete && player.lastResult
              ? `Last result: ${player.lastResult}`
              : "Manage bankroll and place the next wager here."
          }
        >
          <BuyInPanel
            player={{ ...player, bankroll: displayedBankroll }}
            onRequestBuyIn={onRequestBuyIn}
            onAddChip={onAddChip}
            onClearBet={onClearBet}
            onAllIn={onAllIn}
            disabled={bettingLocked}
          />
        </SectionCard>

        <PlayerTable lobby={lobby} player={player} onAction={onAction} revealComplete={revealComplete} />
      </div>

      <div className="content-grid player-seats-layout">
        <SectionCard title="Table Seats" subtitle="Track approvals, bankrolls, and who is currently acting.">
          <div className="seat-list">
            {lobby.players.map((seat) => (
              <div key={seat.id} className="seat-row">
                <div>
                  <strong>{seat.name}</strong>
                  <p>
                    {currency(seat.id === player.id ? displayedBankroll : seat.bankroll)} bankroll -{" "}
                    {currency(seat.pendingBet)} queued
                  </p>
                </div>
                <div className="seat-meta">
                  {lobby.round.activePlayerId === seat.id ? <StatusPill tone="warning">Current turn</StatusPill> : null}
                  <StatusPill tone={seat.connected ? "success" : "danger"}>
                    {seat.connected ? "connected" : "disconnected"}
                  </StatusPill>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function SoloTableView({
  solo,
  onRequestBuyIn,
  onAddChip,
  onClearBet,
  onAllIn,
  onStartRound,
  onAction,
  onResetRound,
  onLeave,
}) {
  const [now, setNow] = useState(Date.now());
  const previousStatusRef = useRef(solo?.status || "waiting");
  const displayedBankrollRef = useRef(solo?.player?.bankroll || 0);
  const onResetRoundRef = useRef(onResetRound);
  const [winFlashAmount, setWinFlashAmount] = useState(0);
  const [displayedBankroll, setDisplayedBankroll] = useState(Number(solo?.player?.bankroll || 0));

  useEffect(() => {
    onResetRoundRef.current = onResetRound;
  }, [onResetRound]);

  useEffect(() => {
    if (solo?.status !== "finished" || !solo?.round?.resetAvailableAt) {
      setNow(Date.now());
      return undefined;
    }

    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [solo?.status, solo?.round?.resetAvailableAt]);

  useEffect(() => {
    if (!solo?.player) {
      return undefined;
    }

    const previousStatus = previousStatusRef.current;
    const currentBankroll = Number(solo.player.bankroll || 0);
    const currentDisplayed = Number(displayedBankrollRef.current || 0);
    const delta = Number((currentBankroll - currentDisplayed).toFixed(2));
    const hasWinningHand = (solo.player.hands || []).some((hand) => ["win", "blackjack"].includes(hand.result));

    if (solo.status !== "finished") {
      setDisplayedBankroll(currentBankroll);
      displayedBankrollRef.current = currentBankroll;
    }

    if (solo.status === "finished" && previousStatus !== "finished") {
      const revealDelay = Math.max(0, Number(solo.round?.resetAvailableAt || 0) - Date.now());
      const winTimeout = setTimeout(() => {
        setDisplayedBankroll(currentBankroll);
        displayedBankrollRef.current = currentBankroll;

        if (hasWinningHand && delta > 0) {
          setWinFlashAmount(delta);
        }
      }, revealDelay);
      const hideTimeout = setTimeout(() => setWinFlashAmount(0), revealDelay + 3000);
      const resetTimeout = setTimeout(() => onResetRoundRef.current(), revealDelay + 3000);
      previousStatusRef.current = solo.status;

      return () => {
        clearTimeout(winTimeout);
        clearTimeout(hideTimeout);
        clearTimeout(resetTimeout);
      };
    }

    previousStatusRef.current = solo.status;
    return undefined;
  }, [solo?.status, solo?.round?.resetAvailableAt, solo?.player]);

  if (!solo?.player) {
    return <SectionCard title="SOLO Loading" subtitle="Connecting to your AI-hosted table." />;
  }

  const player = { ...solo.player, bankroll: displayedBankroll };
  const revealComplete =
    solo.status !== "finished" || !solo.round?.resetAvailableAt
      ? true
      : now >= Number(solo.round.resetAvailableAt);
  const bettingLocked = solo.status !== "waiting";
  const canStart = solo.status === "waiting" && player.pendingBet > 0 && player.pendingBet <= player.bankroll;
  const research = solo.research;
  const researchLog = research?.log || [];
  const tableView = {
    ...solo,
    players: [player],
    round: {
      ...solo.round,
      activePlayerId: solo.round.activePlayerId,
    },
  };

  return (
    <div className="stack gap-md">
      {winFlashAmount > 0 ? (
        <div className="win-overlay">
          <div className="win-overlay-text">WIN {currency(winFlashAmount)}</div>
        </div>
      ) : null}
        

      <div className="content-grid player-layout">
        <SectionCard title="SOLO Bankroll" subtitle="Request dealer-approved credits, then queue your AI-table bet.">
          <BuyInPanel
            player={player}
            onRequestBuyIn={onRequestBuyIn}
            onAddChip={onAddChip}
            onClearBet={onClearBet}
            onAllIn={onAllIn}
            disabled={bettingLocked}
          />
          <div className="actions-row solo-start-row">
            <button className="primary-button" disabled={!canStart || research?.paused || research?.ended} onClick={onStartRound}>
              Start SOLO hand
            </button>
          </div>
        </SectionCard>

        <PlayerTable lobby={tableView} player={player} onAction={onAction} revealComplete={revealComplete} />
      </div>
    </div>
  );
}

function SoloRequestBar({ requests, onRespond, onUpdateResearch }) {
  if (!requests.length) {
    return null;
  }

  return (
    <section className="solo-request-bar">
      <div>
        <p className="eyebrow">SOLO Buy-In Queue</p>
        <h3>{requests.length} pending SOLO request{requests.length === 1 ? "" : "s"}</h3>
      </div>
      <div className="solo-request-list">
        {requests.map((request) => (
          <SoloRequestCard
            key={request.requestId}
            request={request}
            onRespond={onRespond}
            onUpdateResearch={onUpdateResearch}
          />
        ))}
      </div>
    </section>
  );
}

function SoloRequestCard({ request, onRespond, onUpdateResearch }) {
  const [targetMax, setTargetMax] = useState(request.targetMax || "");
  const [targetMin, setTargetMin] = useState(request.targetMin || "");
  const [note, setNote] = useState(request.note || "");

  if (request.kind === "research_alert") {
    return (
      <div className="solo-request-card research-alert-card">
        <div>
          <strong>{request.playerName}</strong>
          <p>
            Research alert: {request.requestType} - bankroll {currency(request.bankroll)}
          </p>
          <p className="muted">
            SOLO #{request.sessionId} - target max {request.targetMax ? currency(request.targetMax) : "none"}
          </p>
        </div>
        <div className="research-request-controls">
          <input
            value={targetMax}
            type="number"
            min="1"
            placeholder="New target max"
            onChange={(event) => setTargetMax(event.target.value)}
          />
          <input
            value={targetMin}
            type="number"
            min="1"
            placeholder="New target min"
            onChange={(event) => setTargetMin(event.target.value)}
          />
          <input
            value={note}
            placeholder="Research note"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div className="inline-actions">
          <button
            className="secondary-button"
            onClick={() => onUpdateResearch(request.sessionId, { targetMax, targetMin, note, paused: false })}
          >
            Save limits & resume
          </button>
          <button
            className="ghost-button"
            onClick={() => onUpdateResearch(request.sessionId, { targetMax, targetMin, note })}
          >
            Save only
          </button>
          <button
            className="danger-button"
            onClick={() => onUpdateResearch(request.sessionId, { ended: true, paused: true, note })}
          >
            End session
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`solo-request-card ${request.researchMode ? "research-alert-card" : ""}`}>
      <div>
        <strong>{request.playerName}</strong>
        <p>
          {request.requestType} - {currency(request.amount)} - bankroll {currency(request.bankroll)}
        </p>
        <p className="muted">SOLO #{request.sessionId}</p>
        {request.researchMode ? <p className="research-disclosure-small">RESEARCH MODE request</p> : null}
      </div>

      {request.researchMode ? (
        <div className="research-request-controls">
          <input
            value={targetMax}
            type="number"
            min="1"
            placeholder="Target max"
            onChange={(event) => setTargetMax(event.target.value)}
          />
          <input
            value={targetMin}
            type="number"
            min="1"
            placeholder="Target min"
            onChange={(event) => setTargetMin(event.target.value)}
          />
          <input
            value={note}
            placeholder="Research note"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      ) : null}

      <div className="inline-actions">
        <button
          className="secondary-button"
          onClick={() => onRespond(request.sessionId, request.requestId, true, { targetMax, targetMin, note })}
        >
          Accept
        </button>
        <button
          className="ghost-button"
          onClick={() => onRespond(request.sessionId, request.requestId, false, { targetMax, targetMin, note })}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function ResearchControlPanel({ sessionId, onUpdate }) {
  const [targetMax, setTargetMax] = useState("");
  const [targetMin, setTargetMin] = useState("");
  const [note, setNote] = useState("");

  return (
    <SectionCard title="Research Session Controls" subtitle="Visible controls for active SOLO research sessions.">
      <div className="research-request-controls">
        <input value={targetMax} type="number" min="1" placeholder="New target max" onChange={(event) => setTargetMax(event.target.value)} />
        <input value={targetMin} type="number" min="1" placeholder="New target min" onChange={(event) => setTargetMin(event.target.value)} />
        <input value={note} placeholder="Research note visible to player" onChange={(event) => setNote(event.target.value)} />
      </div>
      <div className="inline-actions">
        <button className="secondary-button" onClick={() => onUpdate(sessionId, { targetMax, targetMin, note })}>
          Save targets/note
        </button>
        <button className="ghost-button" onClick={() => onUpdate(sessionId, { paused: true, note })}>
          Pause
        </button>
        <button className="secondary-button" onClick={() => onUpdate(sessionId, { paused: false, note })}>
          Resume
        </button>
        <button className="danger-button" onClick={() => onUpdate(sessionId, { ended: true, paused: true, note })}>
          End session
        </button>
      </div>
    </SectionCard>
  );
}

function DealerDashboard({
  lobbies,
  soloRequests,
  onCreateLobby,
  onToggleLobby,
  onToggleDebugMode,
  onRespondBuyIn,
  onRespondSoloBuyIn,
  onUpdateSoloResearch,
  onStartRound,
  onResolveRound,
  onForceDealerWin,
  onForceDealerLoss,
  onResetRound,
}) {
  const [name, setName] = useState("");
  const [dealerHitsSoft17, setDealerHitsSoft17] = useState(false);
  const [selectedLobbyId, setSelectedLobbyId] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!selectedLobbyId && lobbies[0]?.id) {
      setSelectedLobbyId(lobbies[0].id);
    }
  }, [lobbies, selectedLobbyId]);

  const selectedLobby = lobbies.find((lobby) => lobby.id === selectedLobbyId) || lobbies[0];

  useEffect(() => {
    if (!selectedLobby || selectedLobby.status !== "finished" || !selectedLobby.round?.resetAvailableAt) {
      setNow(Date.now());
      return undefined;
    }

    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [selectedLobby]);

  const resetCountdownMs = Math.max(0, Number(selectedLobby?.round?.resetAvailableAt || 0) - now);
  const canResetRound = selectedLobby?.status === "finished" && resetCountdownMs <= 0;
  const resetCountdownSeconds = Math.ceil(resetCountdownMs / 1000);

  return (
    <div className="content-grid two-column">
      <div className="dashboard-full">
        <SoloRequestBar
          requests={soloRequests}
          onRespond={onRespondSoloBuyIn}
          onUpdateResearch={onUpdateSoloResearch}
        />
      </div>

      <div className="stack gap-md">
        <SectionCard title="Create Lobby" subtitle="Spin up as many tables as you want for local testing.">
          <div className="stack gap-sm">
            <input
              value={name}
              placeholder="High Roller Table"
              onChange={(event) => setName(event.target.value)}
            />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={dealerHitsSoft17}
                onChange={(event) => setDealerHitsSoft17(event.target.checked)}
              />
              Dealer hits soft 17
            </label>
            <button
              className="primary-button"
              onClick={() => {
                onCreateLobby(name, dealerHitsSoft17);
                setName("");
                setDealerHitsSoft17(false);
              }}
            >
              Create Lobby
            </button>
          </div>
        </SectionCard>

        <SectionCard title="Managed Lobbies" subtitle="Open, close, and inspect each table in real time.">
          <div className="stack gap-sm">
            {lobbies.length ? (
              lobbies.map((lobby) => (
                <button
                  key={lobby.id}
                  className={`lobby-selector ${selectedLobby?.id === lobby.id ? "lobby-selector-active" : ""}`}
                  onClick={() => setSelectedLobbyId(lobby.id)}
                >
                  <div>
                    <strong>{lobby.name}</strong>
                    <p>
                      #{lobby.id} - {lobby.players.length} players
                    </p>
                  </div>
                  <StatusPill tone={lobby.isOpen ? "success" : "danger"}>
                    {lobby.isOpen ? "open" : "closed"}
                  </StatusPill>
                </button>
              ))
            ) : (
              <div className="empty-state">Create your first lobby to bring players into the game.</div>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="stack gap-md">
        {selectedLobby ? (
          <>
            <DealerRoundSummary
              lobby={selectedLobby}
              onResolveRound={onResolveRound}
              onResetRound={onResetRound}
            />

            {soloRequests
              .filter((request) => request.researchMode)
              .map((request) => (
                <ResearchControlPanel
                  key={`controls-${request.sessionId}`}
                  sessionId={request.sessionId}
                  onUpdate={onUpdateSoloResearch}
                />
              ))}

            <SectionCard
              title={selectedLobby.name}
              subtitle={`Lobby #${selectedLobby.id} - ${selectedLobby.round.message}`}
              actions={
                <div className="inline-actions">
                  {selectedLobby.debugMode ? <StatusPill tone="danger">Debug mode visible to players</StatusPill> : null}
                  <button
                    className="ghost-button"
                    onClick={() => navigator.clipboard?.writeText(selectedLobby.id)}
                  >
                    Copy code
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => onToggleLobby(selectedLobby.id, !selectedLobby.isOpen)}
                  >
                    {selectedLobby.isOpen ? "Close lobby" : "Open lobby"}
                  </button>
                </div>
              }
            >
              <div className="dealer-toolbar">
                <button className="primary-button" onClick={() => onStartRound(selectedLobby.id)}>
                  Start round
                </button>
                <button
                  className="ghost-button"
                  onClick={() => onToggleDebugMode(selectedLobby.id, !selectedLobby.debugMode)}
                >
                  {selectedLobby.debugMode ? "Disable Debug Mode" : "Enable Debug Mode"}
                </button>
                <button
                  className="secondary-button"
                  disabled={selectedLobby.round.phase !== "awaiting_dealer"}
                  onClick={() => onResolveRound(selectedLobby.id)}
                >
                  Reveal & settle
                </button>
                {selectedLobby.debugMode ? (
                  <>
                    <button
                      className="danger-button"
                      disabled={selectedLobby.round.phase !== "awaiting_dealer"}
                      onClick={() => onForceDealerWin(selectedLobby.id)}
                    >
                      Debug: Force Dealer Win
                    </button>
                    <button
                      className="secondary-button"
                      disabled={selectedLobby.round.phase !== "awaiting_dealer"}
                      onClick={() => onForceDealerLoss(selectedLobby.id)}
                    >
                      Debug: Force Player Win
                    </button>
                  </>
                ) : null}
                <button
                  className="ghost-button"
                  disabled={!canResetRound}
                  onClick={() => onResetRound(selectedLobby.id)}
                >
                  {canResetRound ? "Reset round" : `Reset in ${resetCountdownSeconds}s`}
                </button>
              </div>

              <div className="dealer-hand-panel">
                <div className="dealer-hand-stack">
                  <p className="muted">Dealer hand</p>
                  <DealerHandInstant
                    cards={selectedLobby.dealerHand.cards}
                    value={selectedLobby.dealerHand.value || 0}
                  />
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Players" subtitle="Approve bankroll requests, watch hands, and track current wagers.">
              <div className="stack gap-md">
                {selectedLobby.players.length ? (
                  selectedLobby.players.map((player) => (
                    <div key={player.id} className="dealer-player-card">
                      <div className="dealer-player-header">
                        <div>
                          <h4>{player.name}</h4>
                          <p>
                            {currency(player.bankroll)} bankroll - {currency(player.pendingBet)} queued -{" "}
                            {currency(player.currentBetTotal)} active
                          </p>
                        </div>
                        <div className="seat-meta">
                          {selectedLobby.round.activePlayerId === player.id ? (
                            <StatusPill tone="warning">Taking turn</StatusPill>
                          ) : null}
                          <StatusPill tone={player.connected ? "success" : "danger"}>
                            {player.connected ? "connected" : "offline"}
                          </StatusPill>
                        </div>
                      </div>

                      <div className="status-row">
                        <StatusPill
                          tone={
                            player.buyInStatus === "approved"
                              ? "success"
                              : player.buyInStatus === "pending"
                                ? "warning"
                                : player.buyInStatus === "denied"
                                  ? "danger"
                                  : "neutral"
                          }
                        >
                          {player.buyInStatus.replaceAll("_", " ")}
                        </StatusPill>
                        {player.buyInRequest ? (
                          <div className="inline-actions">
                            <span className="muted">Request {currency(player.buyInRequest.amount)}</span>
                            <button
                              className="secondary-button"
                              onClick={() => onRespondBuyIn(selectedLobby.id, player.id, true)}
                            >
                              Accept
                            </button>
                            <button
                              className="ghost-button"
                              onClick={() => onRespondBuyIn(selectedLobby.id, player.id, false)}
                            >
                              Deny
                            </button>
                          </div>
                        ) : null}
                      </div>

                      <div className="dealer-hands-grid">
                        {player.hands.length ? (
                          player.hands.map((hand) => (
                            <div key={hand.id} className="hand-card">
                              <div className="hand-top">
                                <p>Bet {currency(hand.bet)}</p>
                                <StatusPill
                                  tone={
                                    hand.result === "win" || hand.result === "blackjack"
                                      ? "success"
                                      : hand.result === "push"
                                        ? "neutral"
                                        : hand.result
                                          ? "danger"
                                          : "warning"
                                  }
                                >
                                  {hand.result || (hand.blackjack ? "blackjack" : hand.busted ? "busted" : "live")}
                                </StatusPill>
                              </div>
                              <HandCards cards={hand.cards} />
                              <p className="muted">Value: {hand.value}</p>
                            </div>
                          ))
                        ) : (
                          <div className="empty-state small">No active hand yet.</div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">No players have joined this lobby yet.</div>
                )}
              </div>
            </SectionCard>
          </>
        ) : (
          <SectionCard title="Dealer Dashboard" subtitle="Create a lobby to start hosting games." />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState("menu");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dealerSession, setDealerSession] = useState(() => {
    const raw = localStorage.getItem(DEALER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  });
  const [playerSession, setPlayerSession] = useState(() => {
    const raw = localStorage.getItem(PLAYER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  });
  const [soloSession, setSoloSession] = useState(() => {
    const raw = localStorage.getItem(SOLO_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  });
  const [researchSession, setResearchSession] = useState(() => {
    const raw = localStorage.getItem(RESEARCH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  });
  const [publicLobbies, setPublicLobbies] = useState([]);
  const [dealerLobbies, setDealerLobbies] = useState([]);
  const [soloRequests, setSoloRequests] = useState([]);
  const [playerLobby, setPlayerLobby] = useState(null);
  const [soloView, setSoloView] = useState(null);
  const lastSyncedPlayerLobbyRef = useRef("");
  const lastSyncedSoloRef = useRef("");
  const lastSyncedDealerSocketIdRef = useRef("");

  useEffect(() => {
    socket.on("public:lobbies", setPublicLobbies);
    socket.on("dealer:dashboard", setDealerLobbies);
    socket.on("dealer:soloRequests", setSoloRequests);
    socket.on("lobby:update", setPlayerLobby);
    socket.on("solo:update", setSoloView);

    return () => {
      socket.off("public:lobbies", setPublicLobbies);
      socket.off("dealer:dashboard", setDealerLobbies);
      socket.off("dealer:soloRequests", setSoloRequests);
      socket.off("lobby:update", setPlayerLobby);
      socket.off("solo:update", setSoloView);
    };
  }, []);

  useEffect(() => {
    if (dealerSession?.token) {
      setMode("dealer");
    } else if (researchSession?.name) {
      setMode("research");
    } else if (soloSession?.name) {
      setMode("solo");
    } else if (playerSession?.name) {
      setMode("player");
    }
  }, [dealerSession, playerSession, soloSession, researchSession]);

  useEffect(() => {
    async function syncCurrentSession() {
      if (!socket.connected || !socket.id) {
        return;
      }

      if (dealerSession?.token) {
        if (lastSyncedDealerSocketIdRef.current === socket.id) {
          return;
        }

        const response = await emitAsync("dealer:subscribe", { token: dealerSession.token });
        if (!response.ok) {
          setError(response.message);
          return;
        }

        lastSyncedDealerSocketIdRef.current = socket.id;
        return;
      }

      if ((mode === "solo" && soloSession?.name) || (mode === "research" && researchSession?.name)) {
        const activeSoloSession = mode === "research" ? researchSession : soloSession;
        const syncKey = `${socket.id}:${activeSoloSession.sessionId || "new"}:${activeSoloSession.playerId}:${mode}`;

        if (lastSyncedSoloRef.current === syncKey) {
          return;
        }

        const response = await emitAsync("solo:join", {
          sessionId: activeSoloSession.sessionId,
          playerId: activeSoloSession.playerId,
          name: activeSoloSession.name,
          researchMode: mode === "research",
        });

        if (!response.ok) {
          setError(response.message);
          return;
        }

        const session = { ...activeSoloSession, sessionId: response.sessionId, playerId: response.playerId };
        if (mode === "research") {
          setResearchSession(session);
          localStorage.setItem(RESEARCH_STORAGE_KEY, JSON.stringify(session));
        } else {
          setSoloSession(session);
          localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify(session));
        }
        lastSyncedSoloRef.current = `${socket.id}:${response.sessionId}:${response.playerId}:${mode}`;
        setError("");
        return;
      }

      if (mode === "player" && playerSession?.lobbyId && playerSession?.name) {
        const syncKey = `${socket.id}:${playerSession.lobbyId}:${playerSession.playerId}`;

        if (lastSyncedPlayerLobbyRef.current === syncKey) {
          return;
        }

        const response = await emitAsync("player:joinLobby", {
          lobbyId: playerSession.lobbyId,
          name: playerSession.name,
          playerId: playerSession.playerId,
        });

        if (!response.ok) {
          setError(response.message);
          return;
        }

        setError("");
        lastSyncedPlayerLobbyRef.current = syncKey;
      }
    }

    socket.on("connect", syncCurrentSession);

    syncCurrentSession();

    return () => {
      socket.off("connect", syncCurrentSession);
    };
  }, [dealerSession, mode, playerSession, soloSession, researchSession]);

  async function handleDealerLogin(credentials) {
    setBusy(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/api/dealer/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.message || "Dealer login failed.");
      }

      localStorage.setItem(DEALER_STORAGE_KEY, JSON.stringify(data));
      setDealerSession(data);
      setMode("dealer");
      await emitAsync("dealer:subscribe", { token: data.token });
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setBusy(false);
    }
  }

  function handlePlayerEnter(name) {
    const trimmed = String(name || "").trim();

    if (!trimmed) {
      setError("Please enter a display name.");
      return;
    }

    const session = {
      name: trimmed,
      playerId: playerSession?.playerId || crypto.randomUUID(),
      lobbyId: playerSession?.lobbyId || null,
    };

    setError("");
    setPlayerSession(session);
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(session));
    setMode("player");
  }

  async function handleSoloEnter(name) {
    const trimmed = String(name || "").trim();

    if (!trimmed) {
      setError("Please enter a display name for SOLO.");
      return;
    }

    const startingSession = {
      name: trimmed,
      playerId: soloSession?.playerId || crypto.randomUUID(),
      sessionId: soloSession?.sessionId || null,
    };

    const response = await emitAsync("solo:join", startingSession);

    if (!response.ok) {
      setError(response.message);
      return;
    }

    const session = {
      ...startingSession,
      playerId: response.playerId,
      sessionId: response.sessionId,
    };

    setError("");
    setSoloSession(session);
    localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify(session));
    lastSyncedSoloRef.current = `${socket.id || ""}:${response.sessionId}:${response.playerId}`;
    setMode("solo");
  }

  async function handleResearchEnter(name) {
    const trimmed = String(name || "").trim();

    if (!trimmed) {
      setError("Please enter a display name for research mode.");
      return;
    }

    const startingSession = {
      name: trimmed,
      playerId: researchSession?.playerId || crypto.randomUUID(),
      sessionId: researchSession?.sessionId || null,
    };

    const response = await emitAsync("solo:join", {
      ...startingSession,
      researchMode: true,
    });

    if (!response.ok) {
      setError(response.message);
      return;
    }

    const session = {
      ...startingSession,
      playerId: response.playerId,
      sessionId: response.sessionId,
    };

    setError("");
    setResearchSession(session);
    localStorage.setItem(RESEARCH_STORAGE_KEY, JSON.stringify(session));
    lastSyncedSoloRef.current = `${socket.id || ""}:${response.sessionId}:${response.playerId}:research`;
    setMode("research");
  }

  async function joinLobby(lobbyId) {
    if (!playerSession?.name) {
      setError("Choose a display name first.");
      return;
    }

    if (playerSession.lobbyId && playerSession.lobbyId !== lobbyId) {
      await emitAsync("player:leaveLobby", {
        lobbyId: playerSession.lobbyId,
        playerId: playerSession.playerId,
      });
    }

    const response = await emitAsync("player:joinLobby", {
      lobbyId,
      name: playerSession.name,
      playerId: playerSession.playerId,
    });

    if (!response.ok) {
      setError(response.message);
      return;
    }

    const session = { ...playerSession, playerId: response.playerId, lobbyId };
    setPlayerSession(session);
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(session));
    lastSyncedPlayerLobbyRef.current = `${socket.id || ""}:${lobbyId}:${response.playerId}`;
    setError("");
  }

  async function leaveLobby() {
    if (!playerSession?.lobbyId) {
      return;
    }

    await emitAsync("player:leaveLobby", {
      lobbyId: playerSession.lobbyId,
      playerId: playerSession.playerId,
    });

    const session = { ...playerSession, lobbyId: null };
    setPlayerSession(session);
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(session));
    lastSyncedPlayerLobbyRef.current = "";
    setPlayerLobby(null);
  }

  async function requestBuyIn(amount) {
    const response = await emitAsync("player:requestBuyIn", {
      lobbyId: playerSession.lobbyId,
      playerId: playerSession.playerId,
      amount,
    });

    setError(response.ok ? "" : response.message);
  }

  async function addChip(amount) {
    const response = await emitAsync("player:addChip", {
      lobbyId: playerSession.lobbyId,
      playerId: playerSession.playerId,
      amount,
    });

    setError(response.ok ? "" : response.message);
  }

  async function allIn(amount) {
    const response = await emitAsync("player:addChip", {
      lobbyId: playerSession.lobbyId,
      playerId: playerSession.playerId,
      amount,
    });

    setError(response.ok ? "" : response.message);
  }

  async function clearBet() {
    const response = await emitAsync("player:clearBet", {
      lobbyId: playerSession.lobbyId,
      playerId: playerSession.playerId,
    });

    setError(response.ok ? "" : response.message);
  }

  async function playerAction(action) {
    const response = await emitAsync("player:action", {
      lobbyId: playerSession.lobbyId,
      playerId: playerSession.playerId,
      action,
    });

    setError(response.ok ? "" : response.message);
  }

  async function soloRequestBuyIn(amount) {
    const activeSession = mode === "research" ? researchSession : soloSession;
    const response = await emitAsync("solo:requestBuyIn", {
      sessionId: activeSession.sessionId,
      playerId: activeSession.playerId,
      amount,
    });

    setError(response.ok ? "" : response.message);
  }

  async function soloAddChip(amount) {
    const activeSession = mode === "research" ? researchSession : soloSession;
    const response = await emitAsync("solo:addChip", {
      sessionId: activeSession.sessionId,
      playerId: activeSession.playerId,
      amount,
    });

    setError(response.ok ? "" : response.message);
  }

  async function soloClearBet() {
    const activeSession = mode === "research" ? researchSession : soloSession;
    const response = await emitAsync("solo:clearBet", {
      sessionId: activeSession.sessionId,
      playerId: activeSession.playerId,
    });

    setError(response.ok ? "" : response.message);
  }

  async function soloStartRound() {
    const activeSession = mode === "research" ? researchSession : soloSession;
    const response = await emitAsync("solo:startRound", {
      sessionId: activeSession.sessionId,
      playerId: activeSession.playerId,
    });

    setError(response.ok ? "" : response.message);
  }

  async function soloAction(action) {
    const activeSession = mode === "research" ? researchSession : soloSession;
    const response = await emitAsync("solo:action", {
      sessionId: activeSession.sessionId,
      playerId: activeSession.playerId,
      action,
    });

    setError(response.ok ? "" : response.message);
  }

  async function soloResetRound() {
    const activeSession = mode === "research" ? researchSession : soloSession;
    const response = await emitAsync("solo:resetRound", {
      sessionId: activeSession.sessionId,
      playerId: activeSession.playerId,
    });

    setError(response.ok ? "" : response.message);
  }

  function resetSolo() {
    localStorage.removeItem(SOLO_STORAGE_KEY);
    lastSyncedSoloRef.current = "";
    setSoloSession(null);
    setSoloView(null);
    setMode("menu");
  }

  function resetResearch() {
    localStorage.removeItem(RESEARCH_STORAGE_KEY);
    lastSyncedSoloRef.current = "";
    setResearchSession(null);
    setSoloView(null);
    setMode("menu");
  }

  async function dealerAction(event, payload) {
    const response = await emitAsync(event, {
      token: dealerSession?.token,
      ...payload,
    });

    setError(response.ok ? "" : response.message);
  }

  function logoutDealer() {
    localStorage.removeItem(DEALER_STORAGE_KEY);
    lastSyncedDealerSocketIdRef.current = "";
    setDealerSession(null);
    setMode("menu");
  }

  function resetPlayer() {
    localStorage.removeItem(PLAYER_STORAGE_KEY);
    lastSyncedPlayerLobbyRef.current = "";
    setPlayerSession(null);
    setPlayerLobby(null);
    setMode("menu");
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="hero">
        <div>
          <p className="eyebrow">Realtime Multiplayer Blackjack</p>
          <h1>Blackjack Table</h1>
          <p className="hero-copy">
            A clean local-first dealer and player experience built for live lobby management, bankroll approvals,
            and synced table play.
          </p>
        </div>

        <div className="hero-actions">
          {mode === "dealer" ? (
            <button className="ghost-button" onClick={logoutDealer}>
              Exit dealer view
            </button>
          ) : mode === "player" ? (
            <button className="ghost-button" onClick={resetPlayer}>
              Reset player session
            </button>
          ) : mode === "solo" ? (
            <button className="ghost-button" onClick={resetSolo}>
              Exit SOLO
            </button>
          ) : mode === "research" ? (
            <button className="ghost-button" onClick={resetResearch}>
              Exit Research Mode
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner global-error">{error}</div> : null}

      {mode === "menu" ? (
        <main className="menu-grid">
          <button className="menu-tile" onClick={() => { setError(""); setMode("dealer-login"); }}>
            <span className="tile-kicker">1</span>
            <h2>Log in as Dealer</h2>
            <p>Create lobbies, approve bankrolls, deal cards, and resolve rounds.</p>
          </button>

          <button className="menu-tile" onClick={() => { setError(""); setMode("player-entry"); }}>
            <span className="tile-kicker">2</span>
            <h2>Play as Player</h2>
            <p>Join an open table, request chips, place bets, and act when your turn arrives.</p>
          </button>

          <button className="menu-tile" onClick={() => { setError(""); setMode(soloSession?.name ? "solo" : "solo-entry"); }}>
            <span className="tile-kicker">3</span>
            <h2>SOLO</h2>
            <p>Play privately against an AI dealer while human dealers approve your credits.</p>
          </button>

          <button className="menu-tile research-menu-tile" onClick={() => { setError(""); setMode(researchSession?.name ? "research" : "research-entry"); }}>
            <span className="tile-kicker">R</span>
            <h2>RESEARCH MODE</h2>
            <p>Transparent controlled SOLO simulator. Outcomes may be manipulated for testing.</p>
          </button>
        </main>
      ) : null}

      {mode === "dealer-login" ? <DealerLogin onLogin={handleDealerLogin} busy={busy} error={error} /> : null}

      {mode === "player-entry" ? <PlayerEntry onEnter={handlePlayerEnter} error={error} /> : null}

      {mode === "solo-entry" ? <PlayerEntry onEnter={handleSoloEnter} error={error} /> : null}

      {mode === "research-entry" ? <ResearchEntry onEnter={handleResearchEnter} error={error} /> : null}

      {mode === "dealer" ? (
        <DealerDashboard
          lobbies={dealerLobbies}
          soloRequests={soloRequests}
          onCreateLobby={(name, hitsSoft17) => dealerAction("dealer:createLobby", { name, dealerHitsSoft17: hitsSoft17 })}
          onToggleLobby={(lobbyId, isOpen) => dealerAction("dealer:toggleLobby", { lobbyId, isOpen })}
          onToggleDebugMode={(lobbyId, debugMode) => dealerAction("dealer:toggleDebugMode", { lobbyId, debugMode })}
          onRespondBuyIn={(lobbyId, playerId, approved) => dealerAction("dealer:respondBuyIn", { lobbyId, playerId, approved })}
          onRespondSoloBuyIn={(sessionId, requestId, approved, researchControls = {}) => dealerAction("dealer:respondSoloBuyIn", { sessionId, requestId, approved, ...researchControls })}
          onUpdateSoloResearch={(sessionId, updates) => dealerAction("dealer:updateSoloResearch", { sessionId, ...updates })}
          onStartRound={(lobbyId) => dealerAction("dealer:startRound", { lobbyId })}
          onResolveRound={(lobbyId) => dealerAction("dealer:resolveRound", { lobbyId })}
          onForceDealerWin={(lobbyId) => dealerAction("dealer:forceDealerWin", { lobbyId })}
          onForceDealerLoss={(lobbyId) => dealerAction("dealer:forceDealerLoss", { lobbyId })}
          onResetRound={(lobbyId) => dealerAction("dealer:resetRound", { lobbyId })}
        />
      ) : null}

      {mode === "player" ? (
        <div className="stack gap-md">
          <LobbyList lobbies={publicLobbies} onJoin={joinLobby} joinedLobbyId={playerSession?.lobbyId} />
          {playerSession?.lobbyId && playerLobby ? (
            <PlayerLobbyView
              lobby={playerLobby}
              playerId={playerSession.playerId}
              onRequestBuyIn={requestBuyIn}
              onAddChip={addChip}
              onClearBet={clearBet}
              onAllIn={allIn}
              onAction={playerAction}
              onLeave={leaveLobby}
            />
          ) : (
            <SectionCard title="Waiting for a Lobby" subtitle="Join any open lobby to enter the table room." />
          )}
        </div>
      ) : null}

      {mode === "solo" ? (
        <SoloTableView
          solo={soloView}
          onRequestBuyIn={soloRequestBuyIn}
          onAddChip={soloAddChip}
          onClearBet={soloClearBet}
          onAllIn={soloAddChip}
          onStartRound={soloStartRound}
          onAction={soloAction}
          onResetRound={soloResetRound}
          onLeave={resetSolo}
        />
      ) : null}

      {mode === "research" ? (
        <SoloTableView
          solo={soloView}
          onRequestBuyIn={soloRequestBuyIn}
          onAddChip={soloAddChip}
          onClearBet={soloClearBet}
          onAllIn={soloAddChip}
          onStartRound={soloStartRound}
          onAction={soloAction}
          onResetRound={soloResetRound}
          onLeave={resetResearch}
        />
      ) : null}
    </div>
  );
}
