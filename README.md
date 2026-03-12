# 🌀 VortexStock

**Market Regime Classifier · ATR Position Sizer · Sentiment Scanner**

A fully autonomous quantitative trading dashboard that classifies any asset into one of 7 market regimes, sizes positions using ATR-based risk management, and scans headline sentiment — all powered by free data from Yahoo Finance.

## Features

- **7 Market Regimes** — Strong/Weak Bull, Strong/Weak Bear, Overbought, Oversold, Chop
- **ATR-Based Position Sizing** — 2× ATR stop loss, automatic share calculation
- **Interactive Charts** — Candlestick + SMA 50/200 + Volume + RSI (Plotly)
- **Sentiment Analysis** — Lexicon-based headline scoring from Yahoo Finance news
- **Universal Input** — Any ticker, configurable account size and risk %

## Quick Start (Local)

```bash
pip install -r requirements.txt
streamlit run app.py
```

## Deploy to Streamlit Cloud (Free)

1. Push this repo to GitHub
2. Go to [share.streamlit.io](https://share.streamlit.io) and sign in with GitHub
3. Click "New app", select your repo, set `app.py` as the main file, and deploy

## Stack

- **Framework:** Streamlit
- **Data:** yfinance (no API key required)
- **Charts:** Plotly (`plotly.graph_objects`)
- **Indicators:** pandas + numpy (SMA, RSI, ADX, ATR — all Wilder smoothing)
