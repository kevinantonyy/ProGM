# ProGM - Personalized Fantasy Sports Assistant

A full-stack NBA fantasy sports application with AI-powered trade suggestions personalized for your team.

## Features

- **AI Trade Engine** — Analyzes your roster for position gaps, injury risks, and upgrade opportunities, then generates personalized trade suggestions with confidence scores and reasoning
- **Roster Management** — Build and manage your NBA roster (up to 15 players)
- **Player Database** — Browse 30 NBA players with real-style stats, filterable by position and sortable by stats
- **Dashboard** — Overview of team performance, top performers, and AI insights at a glance
- **User Auth** — Register/login with JWT-based authentication

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS, React Router |
| Backend | Node.js, Express |
| Database | MySQL 8.0 (Docker) |
| Auth | JWT + bcrypt |

## Prerequisites

- Node.js 18+
- Docker Desktop (for MySQL)
- Python 3 (for setup script)

## Quick Start

```bash
# One command to rule them all
python setup.py
```

This will:
1. Check prerequisites
2. Start MySQL in Docker
3. Install dependencies (if needed)
4. Seed the database with NBA players + demo user
5. Start both backend and frontend servers

Then open **http://localhost:5173** and log in with:
- Username: `demo`
- Password: `demo123`

## Manual Setup

If you prefer to run things manually:

```bash
# 1. Start MySQL
docker compose up -d

# 2. Install server dependencies
cd server
npm install

# 3. Seed the database
npm run seed

# 4. Start the backend
npm run dev

# 5. In another terminal - install client dependencies
cd client
npm install

# 6. Start the frontend
npm run dev
```

## Project Structure

```
ProGM/
├── client/                  # React frontend
│   ├── src/
│   │   ├── components/      # Layout, shared components
│   │   ├── context/         # Auth context
│   │   ├── pages/           # Login, Dashboard, Roster, Players, Trades
│   │   ├── services/        # API client (axios)
│   │   ├── App.jsx          # Routes
│   │   └── main.jsx         # Entry point
│   ├── package.json
│   └── vite.config.js       # Dev proxy to backend
├── server/                  # Express backend
│   ├── src/
│   │   ├── db/              # Connection + seed script
│   │   ├── middleware/      # JWT auth middleware
│   │   ├── routes/          # API routes
│   │   ├── services/        # AI Trade Engine
│   │   └── index.js         # Server entry
│   ├── .env                 # DB + JWT config
│   └── package.json
├── docker-compose.yml       # MySQL container
├── setup.py                 # One-click setup script
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Login |
| GET | /api/auth/me | Current user |
| GET | /api/players | List players (filter/sort) |
| GET | /api/players/:id | Single player |
| GET | /api/roster | User's roster |
| POST | /api/roster/add | Add player to roster |
| DELETE | /api/roster/remove/:id | Remove player |
| GET | /api/trades/suggestions | AI trade suggestions |

## AI Trade Engine

The trade suggestion engine analyzes your roster across 4 strategies:

1. **Position Need** — Identifies positions where you're below minimum depth and suggests trades to fill gaps
2. **Injury Risk** — Flags injured players and suggests healthy replacements before value drops
3. **Upgrade** — Finds available players who outperform your weakest roster spots
4. **Sell High** — Identifies surplus positions where trading from depth can address a weakness

Each suggestion includes:
- Confidence score (30-95%)
- Category label
- Detailed reasoning
- Full stat comparison

## Extending This Demo

To add real AI functionality:
- Replace the mock trade engine in `server/src/services/tradeEngine.js` with an OpenAI/Claude API call
- Add real-time NBA data via a sports API (e.g., balldontlie.io, ESPN)
- Add league support (multiple users in a shared league)
- Add trade history and acceptance/rejection flow
- Integrate DFS (daily fantasy) lineup optimization

## Environment Variables (server/.env)

```
PORT=3002
DB_HOST=localhost
DB_PORT=3307
DB_USER=root
DB_PASSWORD=fantasy123
DB_NAME=fantasyprogm
JWT_SECRET=fantasyprogm-secret-key-change-in-production
```

## Permanent Render deployment

This repository includes a `render.yaml` Blueprint that deploys the React frontend and Express API together at one permanent HTTPS address, plus a private MySQL 8 service with persistent storage.

1. Push the project to a GitHub or GitLab repository.
2. In Render, choose **New → Blueprint** and select the repository.
3. When prompted, enter `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`.
4. In Yahoo Developer Network, set the Redirect URI to:
   `https://progm.onrender.com/api/yahoo/callback`

The web service URL is also the production frontend URL. No ngrok process is needed.
