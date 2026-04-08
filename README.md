# Rigged Blackjack

Local full-stack multiplayer Blackjack built with React, Vite, Express, and Socket.IO. It includes a dealer login, live lobby list, dealer-controlled bankroll approval flow, chip-based betting, multiplayer turn handling, split/double-down support, and synced game state across connected clients.

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
- Multiple dealer-created lobbies
- Dealer approvals for buy-ins and rebuys
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

## Gameplay Notes

- Dealer cannot start a round without at least one approved player with a valid queued bet.
- Players cannot act out of turn.
- Duplicate player names are blocked inside a lobby.
- Bets cannot exceed available bankroll.
- Double down and split require enough remaining bankroll.
- Dealer reveal/settle is only available after player turns finish.
- The backend is the source of truth for cards, bankroll, approvals, bets, and turn order.

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
