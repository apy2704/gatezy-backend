# GATEZY Backend — Your Gate. Your Control. 🚪⚡

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/Node.js-v18%2B-brightgreen.svg)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express-v5-black.svg)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15%2B-blue.svg)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-v6%2B-red.svg)](https://redis.io/)

**GATEZY Backend** is the core RESTful API and asynchronous event processing service powering the GATEZY security and visitor management ecosystem for gated communities.

---

## ⚡ Key Capabilities

- 🔐 **Guard Authentication & Shift Management:** JWT-based guard login and active shift tracking.
- 📱 **Real-Time WhatsApp Delivery:** Twilio-powered visitor notifications sent directly to residents with interactive approval options (`1` Allow, `2` Deny, `3` Wait).
- ⏱️ **4-Step Bull Queue Escalation Chain:** Automated delayed job processing (30s, 60s, 90s, 120s) for non-responsive residents.
- 🚨 **Emergency Gate Bypass:** Immediate access logging for emergency vehicles (Ambulance, Police, Fire) with instant WhatsApp alerts to society administration.
- 📊 **Automated Shift Reports:** Daily visitor summary statistics compiled and dispatched to society secretaries upon guard shift closure.
- 📥 **WhatsApp Webhooks:** Express webhook processing for incoming resident text/button replies and local test simulation endpoints.

---

## 🛠️ Tech Stack

| Layer | Component | Description |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v18+) | Asynchronous event-driven JavaScript runtime |
| **Framework** | Express.js v5 | Backend Web API framework |
| **Database** | PostgreSQL 15+ (`pg`) | Relational database supporting PgBouncer pooling |
| **Queue Engine** | Bull (`bull`) | Redis-backed delayed queue processor |
| **In-Memory Store** | Redis | Caching and queue persistence |
| **Messaging** | Twilio WhatsApp API | WhatsApp message dispatch & TwiML webhook parsing |
| **Security** | JWT, bcrypt, Helmet, CORS | Auth token signing, PIN hashing, security headers & rate limiting |

---

## 📁 Folder Structure

```text
backend/
├── database/
│   └── schema.sql             # SQL Schema (9 tables, views, indexes)
├── src/
│   ├── index.js               # Express entry point & middleware registration
│   ├── jobs/
│   │   └── escalationJob.js   # Bull queue escalation job scheduler & processor
│   ├── middleware/
│   │   ├── auth.js            # JWT guard authentication middleware
│   │   └── rateLimiter.js     # IP rate limiting middleware
│   ├── routes/
│   │   ├── guards.js          # Guard auth & shift endpoints
│   │   ├── visitors.js        # Visitor request, emergency, & exit routes
│   │   ├── societies.js       # Society & flat discovery routes
│   │   └── webhooks.js        # WhatsApp webhook & test endpoint
│   ├── services/
│   │   ├── authService.js     # Guard authentication logic
│   │   ├── visitorService.js  # Visitor management & emergency workflow
│   │   └── notificationService.js # WhatsApp message templates & dispatch
│   └── utils/
│       ├── db.js              # PostgreSQL pool connection
│       ├── logger.js          # Console logger utility
│       ├── redis.js           # Redis connection & Bull queue setup
│       └── seedData.js        # Database seed runner
├── .env.example               # Environment variables template
└── package.json               # Dependencies & scripts
```

---

## 🚀 Running Locally

### Prerequisites

Ensure the following services are installed and running:
- [Node.js (v18+)](https://nodejs.org/)
- [PostgreSQL (v15+)](https://www.postgresql.org/)
- [Redis Server (v6+)](https://redis.io/)

### Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   Create a `.env` file inside the `backend/` root directory:
   ```bash
   cp .env.example .env
   ```

3. **Initialize Database**
   Import the schema into your PostgreSQL database:
   ```bash
   psql -U postgres -d gatezy_db -f database/schema.sql
   ```

4. **Ensure Redis is Running**
   ```bash
   redis-server
   ```

5. **Launch the Server**
   ```bash
   # Development mode with Nodemon
   npm run dev

   # Production mode
   npm start
   ```

---

## 🔑 Environment Variables

| Variable | Description | Default Value |
| :--- | :--- | :--- |
| `PORT` | Server HTTP Port | `5000` |
| `NODE_ENV` | Environment (`development` / `production`) | `development` |
| `DB_HOST` | PostgreSQL Host | `localhost` |
| `DB_PORT` | PostgreSQL Port | `5432` |
| `DB_NAME` | Database Name | `gatezy_db` |
| `DB_USER` | Database User | `postgres` |
| `DB_PASSWORD` | Database Password | `postgres` |
| `REDIS_HOST` | Redis Server Host | `localhost` |
| `REDIS_PORT` | Redis Server Port | `6379` |
| `REDIS_PASSWORD` | Redis Server Password | `undefined` |
| `JWT_SECRET` | Secret key for Guard JWT signing | `gatezy_default_secret` |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID | *(Mocked in dev)* |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | *(Mocked in dev)* |
| `TWILIO_WHATSAPP_FROM` | Twilio WhatsApp Sender Number | `whatsapp:+14155238886` |

---

## 📡 API Endpoints

### 🩺 System & Health
| Method | Path | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Server health check and timestamp | Public |

### 👮 Guard Auth & Shifts
| Method | Path | Description | Access |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/guards/login` | Guard authentication (Phone + PIN) | Public |
| `POST` | `/api/guards/shift/start` | Start an active guard shift | Bearer Guard JWT |
| `POST` | `/api/guards/shift/end` | Close active shift & dispatch summary report | Bearer Guard JWT |

### 🚪 Visitor & Emergency Management
| Method | Path | Description | Access |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/visitors/request` | Create visitor request & trigger escalations | Bearer Guard JWT |
| `GET` | `/api/visitors/active` | Get visitors currently inside society | Bearer Guard JWT |
| `PATCH` | `/api/visitors/:id/exit` | Mark visitor exit timestamp | Bearer Guard JWT |
| `POST` | `/api/visitors/emergency` | Emergency vehicle gate bypass entry | Bearer Guard JWT |

### 🏢 Societies & Flats
| Method | Path | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/societies` | List all registered societies | Public |
| `GET` | `/api/societies/:id` | Fetch specific society details | Public |
| `GET` | `/api/societies/:id/flats` | List all flats in a society | Public |

### 💬 WhatsApp Webhooks
| Method | Path | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/webhooks/ping` | Webhook route ping test | Public |
| `POST` | `/api/webhooks/whatsapp` | Twilio WhatsApp incoming webhook handler | Public |
| `POST` | `/api/webhooks/test` | Local simulated webhook endpoint (`{ phone, body }`) | Public |

---

## 🗺️ Roadmap

- [x] **Phase 1: Backend Infrastructure (Complete)**
  - Database schema & PgBouncer optimization.
  - JWT Guard auth & shift lifecycle.
  - WhatsApp notification service with development mock mode.
  - 4-step Bull Queue escalation chain (30s, 60s, 90s, 120s).
  - Emergency entry override & secretary notifications.
  - WhatsApp decision webhooks (`1`, `2`, `3`).
- [ ] **Phase 2: Guard Mobile App (Next)**
  - Cross-platform React Native / Flutter Guard App for gate entry.
- [ ] **Phase 3: Admin Dashboard (Next)**
  - Web dashboard for society secretaries & management.

---

## 📄 License

This backend module is licensed under the [ISC License](package.json).
