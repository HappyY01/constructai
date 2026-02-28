# ConstructAI — Real Estate & Construction Planner

An AI-powered floor plan generator with Vastu compliance, cost estimates, and local property news.

## Features
- 🏗️ Multi-floor architectural drawings (doors, windows, stairs, furniture)
- 🧭 Vastu Shastra compliant room placement
- 💰 Itemised cost estimates (Indian market rates)
- 💬 AI chat to modify any part of the plan
- 📰 Local real estate news

## Tech Stack
| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS |
| Backend | Python FastAPI |
| AI | Groq API (llama-3.1-8b-instant) |
| News | GNews API |
| Geocoding | OpenCage + Gemini fallback |

## Local Development

```bash
# Backend
cd backend
pip install -r requirements.txt
cp ../.env.example .env   # add your API keys
uvicorn main:app --reload --port 8000

# Frontend (new terminal)
cd frontend
python -m http.server 3000 --bind 127.0.0.1
# Open http://127.0.0.1:3000
```

## Environment Variables (backend/.env)
```env
GROQ_API_KEY=gsk_...        # Required — console.groq.com
GNEWS_API_KEY=...           # Required — gnews.io
OPENCAGE_API_KEY=...        # Optional
GEMINI_API_KEY=...          # Optional
```

## Deployment

### Backend → Render.com
1. New Web Service → connect GitHub repo
2. Root Directory: `backend`
3. Build: `pip install -r requirements.txt`
4. Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add all 4 API keys as Environment Variables
6. Copy your Render URL

### Frontend → Vercel
1. Update `PROD_BACKEND` in `frontend/app.js` with your Render URL
2. New Project → import GitHub repo
3. Framework Preset: **Other**, Root Dir: `/`
4. Deploy!

## Project Structure
```
constructai/
├── backend/
│   ├── main.py
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── .env.example
├── render.yaml
├── vercel.json
└── README.md
```
