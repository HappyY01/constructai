"""
Vercel serverless entry point — wraps the FastAPI app.
Vercel automatically detects `handler = app` for ASGI apps.
"""
import sys
import os

# Add backend directory to path so we can import main.py
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from main import app  # noqa: E402  (FastAPI instance)

# Vercel requires the ASGI app to be named `handler` or `app`
handler = app
