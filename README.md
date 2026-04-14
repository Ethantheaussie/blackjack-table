# Rigged Blackjack

Local full-stack Blackjack built with React, Vite, Express, and Socket.IO. It includes multiplayer dealer lobbies, a SOLO AI-dealer mode, a transparent RESEARCH MODE simulator, dealer-controlled bankroll approval flows, chip-based betting, split/double-down support, and synced game state across connected clients.

## Stack

- Frontend: React + Vite
- Backend: Node.js + Express
- Realtime: Socket.IO
- Storage: in-memory runtime state with JSON snapshot persistence for lobby/player session data in `backend/data/state.json`

## Features

- Hardcoded dealer login for development:
  - Username: `ethan`
  - Password: `2134asdf`
- Player display-name flow with live open lobby browsing
- SOLO mode for private AI-hosted blackjack hands
- RESEARCH MODE for transparent controlled SOLO simulations where outcomes may be controlled for testing
- Multiple dealer-created lobbies
- Dealer approvals for buy-ins and rebuys
- Global dealer SOLO approval queue visible at the top of every dealer dashboard
- Research-mode target controls, audit log, player disclosure banner, and target-reached alerts
- Bankroll-based chip betting with fixed chips: `$5`, `$10`, `$20`, `$50`
- Standard Blackjack flow with hit, stand, double down, split, blackjack, bust, and push
- Dealer soft-17 rule toggle per lobby
- Live dealer dashboard with player hands, bankrolls, pending requests, and round state
- Graceful disconnect handling:
  - players remain seated
  - current-turn disconnects auto-stand that hand
- Responsive casino-style UI

## Project Structure

```text
.
|-- backend/
|   |-- package.json
|   `-- src/
|       |-- game.js
|       |-- persistence.js
|       `-- server.js
|-- frontend/
|   |-- index.html
|   |-- package.json
|   |-- vite.config.js
|   `-- src/
|       |-- App.jsx
|       |-- main.jsx
|       `-- styles.css
|-- package.json
`-- README.md
```

## Local Setup

1. Install dependencies from the project root:

```bash
npm install
```

2. Start both apps:

```bash
npm run dev
```

3. Open:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

You can also run them separately:

```bash
npm run dev:backend
npm run dev:frontend
```

## Scripts

- `npm run dev` - run frontend and backend together
- `npm run dev:backend` - backend only
- `npm run dev:frontend` - frontend only
- `npm run build` - production frontend build
- `npm run start` - backend in non-watch mode

Run the research-mode engine sample tests:

```bash
node backend/src/researchModeEngine.test.js
```

## Gameplay Notes

- Dealer cannot start a round without at least one approved player with a valid queued bet.
- SOLO players cannot use requested chips until a human dealer approves the buy-in or rebuy.
- SOLO buy-in/rebuy requests appear globally for all logged-in dealers and disappear once handled.
- SOLO hands are dealt and resolved by the AI dealer; human dealers only approve or deny credits.
- RESEARCH MODE is not fair blackjack. It is a disclosed simulator that may use a controlled outcome engine.
- RESEARCH MODE never changes normal multiplayer or normal SOLO deck behavior.
- If a research target max is reached, the session pauses and asks the player to wait for dealer input.
- Players cannot act out of turn.
- Duplicate player names are blocked inside a lobby.
- Bets cannot exceed available bankroll.
- Double down and split require enough remaining bankroll.
- Dealer reveal/settle is only available after player turns finish.
- The backend is the source of truth for cards, bankroll, approvals, bets, and turn order.

## Research Mode

RESEARCH MODE is a transparent SOLO simulator for testing controlled outcomes. It is visually distinct from normal SOLO and always shows this player-facing disclosure:

```text
RESEARCH MODE ACTIVE: Outcomes in this session may be controlled for testing purposes. This is not a fair blackjack game.
```

Dealers can approve research-mode buy-ins and optionally set:

- Target max balance
- Target min balance
- Research note visible to the player

The backend keeps the research outcome logic separate in `backend/src/researchModeEngine.js`. Normal multiplayer and normal SOLO continue using the standard shuffled deck logic.

Research-mode audit logging records:

- Buy-in requests
- Buy-in approvals and denials
- Target changes
- Dealer notes
- Controlled round results
- Target-reached pauses

Included sample tests cover:

- Cap at `$60` from a `$50` approved bankroll
- Lowering the target below current bankroll
- Target-reached pause state
- Rebuy-style recovery behavior

## Persistence Notes

- Runtime gameplay is kept in memory for speed and simplicity.
- A lightweight snapshot is written to `backend/data/state.json` for local development.
- Active rounds safely reset to a waiting/betting state after a server restart.

## Future Extensions

- Per-lobby chat
- Persistent active rounds across restarts
- Sound effects
- SQLite storage
- Replace hardcoded auth with real sessions
