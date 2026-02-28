"""
Real Estate & Construction Planning API
FastAPI backend with Gemini LLM and GNews integration
"""

import os
import json
import re
import asyncio
import httpx

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# ─── Load environment variables ────────────────────────────────────────────────
load_dotenv()

GEMINI_API_KEY   = os.getenv("GEMINI_API_KEY")   # kept for reverse-geocode fallback
GROQ_API_KEY     = os.getenv("GROQ_API_KEY")     # primary LLM provider
GNEWS_API_KEY    = os.getenv("GNEWS_API_KEY")
OPENCAGE_API_KEY = os.getenv("OPENCAGE_API_KEY")

if GEMINI_API_KEY:
    pass  # Key used directly in REST calls below

# ─── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Real Estate & Construction Planner API",
    description="LLM-powered floor plan generation and local real estate news",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request / Response Models ─────────────────────────────────────────────────
class PlanRequest(BaseModel):
    plot_area: int
    building_type: str
    location: str

class ModifyRequest(BaseModel):
    current_plan: dict
    modification_request: str
    plot_area: int
    building_type: str
    location: str


# ─── System Prompt ───────────────────────────────────────────────────────────────
SYSTEM_PROMPT = (
    'Output ONLY valid JSON, no markdown. Schema: '
    '{"floors":[{"floor":1,"name":"Ground Floor","rooms":[{"name":"","x":0,"y":0,"width":0,"length":0}]}],'
    '"materials":[{"item":"","quantity":"","estimated_cost":"₹0"}],'
    '"vastu_notes":[{"room":"","direction":"","compliant":true,"note":""}]}. '

    'FLOORS: One floors[] entry per storey. Each floor has its own coordinate grid from (0,0). '
    'Add Terrace/Roof floor if requested. '

    'LAYOUT (CRITICAL): '
    'No two rooms on same floor may overlap. '
    'Scale: 1 unit = ~1 meter. Base sizes for 1500sqft house: bedroom=4x4, living=5x6. '
    'CRITICAL: Scale room sizes up proportionally for larger plots (e.g. 5000sqft) or commercial/hospitals (e.g. Ward=10x10, Reception=15x10). DO NOT leave massive empty grids. '
    'All rooms must be adjacent (touching) to form a cohesive building shape. '
    'Multi-floor buildings: include room named "Staircase" (w=2.5,l=3.5) at exactly the same x,y coordinates on every floor. '
    'Ground Floor: include room named "Main Entrance" (w=2,l=2) at outer edge. '
    'Never name a room "Roof". '

    'VASTU: Kitchen=SE, MasterBedroom=SW, LivingRoom=N/NE, Pooja=NE, '
    'Bathroom=NW/SE, ChildrenBedroom=W/NW, Study=N/W, Dining=W, Garage=NW, Entrance=E/N. '

    'COST: Realistic Indian rates heavily scaled to plot_area, city, and building_type. '
    '1500sqft residential baseline: ~₹45,00,000 total. '
    'RULE 1: Scale baseline linearly with area (e.g. 3000sqft = ~₹90L, 5000sqft = ~₹1.5Cr). '
    'RULE 2: If building_type is hospital/commercial/complex, multiply the scaled cost by 1.5x to 2x (e.g. 5000sqft hospital = ~₹2.5 to 3 Crores). '
    'Provide realistic massive material quantities for large commercial builds. '
    'COST FORMAT: All estimated_cost = absolute rupees "₹X,XX,XXX". Never use "lakhs" suffix.'

)

MODIFY_PROMPT = (
    'You are an architectural AI. Modify the existing floor plan per the user request. '
    'Use the same floors[] schema. Keep all layout rules: no overlapping rooms, each floor independent grid. '
    'Follow Vastu. Output ONLY valid JSON. No extra text.'
)

# ─── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "message": "Real Estate Planner API is running."}


@app.post("/generate-plan")
async def generate_plan(request: PlanRequest):
    """
    Calls Groq API (llama-3.1-8b-instant) for ultra-fast floor plan + materials JSON.
    Groq free tier: 30 RPM, 14,400 RPD — far more generous than Gemini free tier.
    """
    if not GROQ_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="GROQ_API_KEY is not set in the .env file. Get one free at console.groq.com"
        )

    user_message = (
        f"plot_area: {request.plot_area} sq ft\n"
        f"building_type: {request.building_type}\n"
        f"location: {request.location}\n"
        "Generate floor plan and materials cost estimate as JSON."
    )

    payload = {
        "model": "llama-3.1-8b-instant",  # fast Groq model for structured JSON
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_message},
        ],
        "temperature": 0.15,
        "max_tokens": 3500,
        "response_format": {"type": "json_object"},
    }

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                json=payload,
                headers=headers,
            )

            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", "10"))
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=429,
                    content={
                        "detail": f"Groq rate limit. Please wait {retry_after}s and retry.",
                        "retry_after": retry_after,
                    },
                    headers={"Retry-After": str(retry_after)},
                )

            resp.raise_for_status()
            data = resp.json()

        raw_text = (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )

        # Strip accidental markdown fences
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$", "", raw_text)

        plan_data = json.loads(raw_text)

        # Accept new floors[] schema OR legacy rooms[] (wrap it automatically)
        if "floors" not in plan_data:
            if "rooms" in plan_data:
                plan_data["floors"] = [{"floor": 1, "name": "Ground Floor", "rooms": plan_data.pop("rooms")}]
            else:
                raise ValueError("Response missing 'floors' key.")
        if "materials" not in plan_data:
            raise ValueError("Response missing 'materials' key.")

        return plan_data

    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"LLM returned invalid JSON: {str(e)}")
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Groq API error: {e.response.text[:300]}"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/modify-plan")
async def modify_plan(request: ModifyRequest):
    """Modifies an existing floor plan JSON based on a natural-language request."""
    if not GROQ_API_KEY:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY is not set.")

    user_message = (
        f"Current plan:\n{json.dumps(request.current_plan)}\n\n"
        f"plot_area:{request.plot_area} sqft | type:{request.building_type} | location:{request.location}\n"
        f"Request: {request.modification_request}\nReturn complete updated JSON."
    )

    payload = {
        "model": "llama-3.1-8b-instant",
        "messages": [
            {"role": "system", "content": MODIFY_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.2,
        "max_tokens": 3000,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                json=payload, headers=headers,
            )
            if resp.status_code == 429:
                ra = int(resp.headers.get("Retry-After", "10"))
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=429,
                    content={"detail": f"Rate limit. Wait {ra}s.", "retry_after": ra},
                    headers={"Retry-After": str(ra)})
            resp.raise_for_status()
            data = resp.json()

        raw_text = data["choices"][0]["message"]["content"].strip()
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$", "", raw_text)
        plan_data = json.loads(raw_text)
        if "floors" not in plan_data:
            if "rooms" in plan_data:
                plan_data["floors"] = [{"floor": 1, "name": "Ground Floor", "rooms": plan_data.pop("rooms")}]
            else:
                raise ValueError("Response missing required keys.")
        if "materials" not in plan_data:
            raise ValueError("Response missing 'materials' key.")
        return plan_data
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"LLM returned invalid JSON: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/get-news")
async def get_news(location: str = Query(..., description="City or region name")):
    """
    Fetches top 5 real estate / construction / infrastructure news for a location via GNews API.
    """
    if not GNEWS_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="GNEWS_API_KEY is not set in the .env file."
        )

    query = f'real estate construction {location}'

    params = {
        "q": query,
        "lang": "en",
        "max": 5,
        "sortby": "publishedAt",
        "apikey": GNEWS_API_KEY,
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://gnews.io/api/v4/search",
                params=params
            )
            response.raise_for_status()
            data = response.json()

        articles = data.get("articles", [])

        # Normalise the shape for the frontend
        result = [
            {
                "title":       a.get("title", "No title"),
                "description": a.get("description", ""),
                "url":         a.get("url", "#"),
                "image":       a.get("image", ""),
                "published_at": a.get("publishedAt", ""),
                "source":      a.get("source", {}).get("name", ""),
            }
            for a in articles
        ]

        return {"articles": result, "location": location}

    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"GNews API error: {e.response.text}"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/reverse-geocode")
async def reverse_geocode(lat: float = Query(...), lon: float = Query(...)):
    """
    Reverse-geocodes coordinates to a human-readable city name via OpenCage.
    """
    if not OPENCAGE_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="OPENCAGE_API_KEY is not set in the .env file."
        )

    params = {
        "q": f"{lat}+{lon}",
        "key": OPENCAGE_API_KEY,
        "limit": 1,
        "no_annotations": 1,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://api.opencagedata.com/geocode/v1/json",
                params=params
            )
            response.raise_for_status()
            data = response.json()

        results = data.get("results", [])
        if not results:
            raise HTTPException(status_code=404, detail="Location not found.")

        components = results[0].get("components", {})
        city    = components.get("city") or components.get("town") or components.get("village") or ""
        state   = components.get("state", "")
        country = components.get("country", "")

        display = ", ".join(filter(None, [city, state, country]))
        return {"display_name": display, "city": city, "state": state, "country": country}

    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"OpenCage API error: {e.response.text}"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
