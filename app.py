"""
VortexStock — Autonomous Quantitative Trading Dashboard
========================================================
A production-grade market regime classifier, ATR-based position sizer,
and sentiment analyser built on free data (yfinance).

Author : sojufx
Stack  : Streamlit · yfinance · pandas · numpy · plotly
"""

import streamlit as st
import yfinance as yf
import pandas as pd
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from datetime import datetime, timedelta
import re

# ───────────────────────────────────────────────────────────────
# 0. PAGE CONFIG & CONSTANTS
# ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="VortexStock",
    page_icon="🌀",
    layout="wide",
    initial_sidebar_state="expanded",
)

# -- Colour palette (dark-first design) --
C_BG        = "#0E1117"
C_CARD      = "#161B22"
C_BORDER    = "#30363D"
C_TEXT      = "#E6EDF3"
C_MUTED     = "#8B949E"
C_GREEN     = "#3FB950"
C_RED       = "#F85149"
C_AMBER     = "#D29922"
C_TEAL      = "#20808D"
C_BLUE      = "#58A6FF"
C_PURPLE    = "#BC8CFF"

# Regime colour map
REGIME_COLOURS = {
    "Strong Bull"           : C_GREEN,
    "Weak Bull"             : "#2EA043",
    "Strong Bear"           : C_RED,
    "Weak Bear"             : "#DA3633",
    "Overbought / Blowoff"  : C_AMBER,
    "Oversold / Capitulation": C_PURPLE,
    "Chop / Ranging"        : C_MUTED,
}

# Sentiment lexicon
POSITIVE_WORDS = {
    "growth", "beat", "surge", "profit", "gain", "rally", "upgrade",
    "record", "bullish", "outperform", "strong", "boost", "soar",
    "high", "rise", "positive", "upbeat", "optimistic", "buy",
    "exceed", "breakout", "momentum", "innovation", "partnership",
    "deal", "revenue", "expansion", "recover", "success", "win",
    "dividend", "earnings", "approval", "launch", "demand",
}
NEGATIVE_WORDS = {
    "miss", "drop", "lawsuit", "loss", "decline", "downgrade",
    "bearish", "crash", "sell", "weak", "risk", "warning", "fear",
    "cut", "bankruptcy", "debt", "default", "recall", "fraud",
    "investigation", "penalty", "layoff", "restructure", "plunge",
    "slump", "inflation", "tariff", "concern", "volatility",
    "recession", "overvalued", "underperform", "delay", "shortage",
}


# ───────────────────────────────────────────────────────────────
# 1. GLOBAL CSS — sleek dark dashboard
# ───────────────────────────────────────────────────────────────
st.markdown("""
<style>
/* ---------- base ---------- */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

html, body, [class*="css"] {
    font-family: 'Inter', sans-serif;
    color: #E6EDF3;
}

/* ---------- sidebar ---------- */
section[data-testid="stSidebar"] {
    background-color: #0D1117;
    border-right: 1px solid #21262D;
}
section[data-testid="stSidebar"] .stMarkdown h1,
section[data-testid="stSidebar"] .stMarkdown h2,
section[data-testid="stSidebar"] .stMarkdown h3 {
    color: #E6EDF3;
}

/* ---------- metric cards ---------- */
div[data-testid="stMetric"] {
    background: #161B22;
    border: 1px solid #30363D;
    border-radius: 8px;
    padding: 14px 18px;
}
div[data-testid="stMetric"] label {
    color: #8B949E !important;
    font-size: 0.78rem !important;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
div[data-testid="stMetric"] [data-testid="stMetricValue"] {
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 1.35rem !important;
    font-weight: 600 !important;
}

/* ---------- signal box ---------- */
.signal-box {
    border-radius: 10px;
    padding: 20px 24px;
    margin: 8px 0 16px 0;
    border-left: 4px solid;
    font-family: 'Inter', sans-serif;
}
.signal-box h3 {
    margin: 0 0 6px 0;
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: -0.01em;
}
.signal-box p {
    margin: 2px 0;
    font-size: 0.92rem;
    line-height: 1.55;
    color: #C9D1D9;
}
.signal-box .mono {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 500;
}

/* ---------- regime badge ---------- */
.regime-badge {
    display: inline-block;
    padding: 6px 18px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 1.05rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
}

/* ---------- headline cards ---------- */
.headline-card {
    background: #161B22;
    border: 1px solid #30363D;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 8px;
}
.headline-card .title {
    font-size: 0.88rem;
    font-weight: 500;
    color: #E6EDF3;
    line-height: 1.4;
}
.headline-card .publisher {
    font-size: 0.75rem;
    color: #8B949E;
    margin-top: 4px;
}

/* ---------- sentiment chip ---------- */
.sentiment-chip {
    display: inline-block;
    padding: 4px 14px;
    border-radius: 20px;
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.03em;
}

/* ---------- misc polish ---------- */
.stPlotlyChart { border-radius: 10px; overflow: hidden; }
hr { border-color: #21262D; }

/* ---------- footer ---------- */
.vortex-footer {
    text-align: center;
    padding: 32px 0 16px 0;
    color: #484F58;
    font-size: 0.75rem;
}
.vortex-footer a {
    color: #58A6FF;
    text-decoration: none;
}
</style>
""", unsafe_allow_html=True)


# ───────────────────────────────────────────────────────────────
# 2. SIDEBAR — Dynamic Universal Inputs
# ───────────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("## 🌀 VortexStock")
    st.markdown("---")

    ticker_input = st.text_input(
        "Ticker Symbol",
        value="NVDA",
        help="Any Yahoo Finance ticker, e.g. AAPL, TSLA, BTC-USD, ETH-USD",
    ).upper().strip()

    account_size = st.number_input(
        "Account Size (USD)",
        min_value=100.0,
        max_value=100_000_000.0,
        value=10_000.0,
        step=500.0,
        format="%.2f",
    )

    risk_pct = st.slider(
        "Risk per Trade (%)",
        min_value=0.5,
        max_value=5.0,
        value=1.0,
        step=0.1,
        format="%.1f%%",
    )

    st.markdown("---")
    st.caption("Data: Yahoo Finance (yfinance)")
    st.caption("Charts: Plotly · Indicators: pandas/numpy")


# ───────────────────────────────────────────────────────────────
# 3. DATA FETCH — yfinance (1 year + buffer for 200 SMA)
# ───────────────────────────────────────────────────────────────
@st.cache_data(ttl=300, show_spinner=False)
def fetch_data(ticker: str) -> pd.DataFrame:
    """Pull 2 years of daily data so the 200-day SMA is valid for ≥1 year."""
    end = datetime.now()
    start = end - timedelta(days=730)
    df = yf.download(ticker, start=start, end=end, progress=False, auto_adjust=True)
    if df.empty:
        return df
    # Flatten multi-level columns if present
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df


@st.cache_data(ttl=600, show_spinner=False)
def fetch_news(ticker: str):
    """Return list of news dicts from yfinance."""
    try:
        t = yf.Ticker(ticker)
        news = t.news or []
        return news[:10]
    except Exception:
        return []


# ───────────────────────────────────────────────────────────────
# 4. TECHNICAL INDICATORS — pure pandas/numpy
# ───────────────────────────────────────────────────────────────
def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Compute SMA 50/200, RSI 14, ADX 14, ATR 14."""
    df = df.copy()
    close = df["Close"].squeeze()
    high = df["High"].squeeze()
    low = df["Low"].squeeze()

    # --- SMA ---
    df["SMA_50"] = close.rolling(50).mean()
    df["SMA_200"] = close.rolling(200).mean()

    # --- RSI 14 (Wilder smoothing) ---
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / 14, min_periods=14, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / 14, min_periods=14, adjust=False).mean()
    rs = avg_gain / avg_loss
    df["RSI"] = 100 - (100 / (1 + rs))

    # --- ATR 14 (Wilder) ---
    prev_close = close.shift(1)
    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    df["ATR"] = tr.ewm(alpha=1 / 14, min_periods=14, adjust=False).mean()

    # --- ADX 14 (Wilder) ---
    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

    atr_smooth = tr.ewm(alpha=1 / 14, min_periods=14, adjust=False).mean()
    plus_di = 100 * (plus_dm.ewm(alpha=1 / 14, min_periods=14, adjust=False).mean() / atr_smooth)
    minus_di = 100 * (minus_dm.ewm(alpha=1 / 14, min_periods=14, adjust=False).mean() / atr_smooth)

    dx = 100 * ((plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan))
    df["ADX"] = dx.ewm(alpha=1 / 14, min_periods=14, adjust=False).mean()

    return df


# ───────────────────────────────────────────────────────────────
# 5. REGIME CLASSIFIER — 7 Vortex Regimes
# ───────────────────────────────────────────────────────────────
def classify_regime(row: pd.Series) -> str:
    """Classify market regime from latest indicator row."""
    price = float(row["Close"])
    sma50 = float(row["SMA_50"])
    sma200 = float(row["SMA_200"])
    rsi = float(row["RSI"])
    adx = float(row["ADX"])

    # Overbought / Oversold take priority
    if rsi > 75:
        return "Overbought / Blowoff"
    if rsi < 25:
        return "Oversold / Capitulation"

    # Bull regimes
    if price > sma50 and sma50 > sma200:
        return "Strong Bull" if adx > 25 else "Weak Bull"

    # Bear regimes
    if price < sma50 and sma50 < sma200:
        return "Strong Bear" if adx > 25 else "Weak Bear"

    # Chop — catch-all
    return "Chop / Ranging"


# ───────────────────────────────────────────────────────────────
# 6. RISK MANAGEMENT — ATR position sizing
# ───────────────────────────────────────────────────────────────
def compute_risk(price: float, atr: float, account: float, risk_pct: float):
    """Return stop distance, dollar risk, position size, stop level (long & short)."""
    stop_distance = 2.0 * atr
    dollar_risk = (account * risk_pct) / 100.0
    position_size = dollar_risk / stop_distance if stop_distance > 0 else 0
    stop_long = price - stop_distance
    stop_short = price + stop_distance
    return {
        "stop_distance": round(stop_distance, 4),
        "dollar_risk": round(dollar_risk, 2),
        "position_size": int(position_size),
        "position_size_exact": round(position_size, 4),
        "stop_long": round(stop_long, 4),
        "stop_short": round(stop_short, 4),
    }


# ───────────────────────────────────────────────────────────────
# 7. SENTIMENT ENGINE — lightweight lexicon
# ───────────────────────────────────────────────────────────────
def score_headline(text: str) -> int:
    """Return +1 for each positive word, -1 for each negative."""
    words = set(re.findall(r"[a-z]+", text.lower()))
    return len(words & POSITIVE_WORDS) - len(words & NEGATIVE_WORDS)


def _extract_headline(item: dict) -> dict:
    """Handle both old and new yfinance news structures."""
    # New format: nested under 'content'
    content = item.get("content", {})
    if content:
        title = content.get("title", "")
        provider = content.get("provider", {})
        publisher = provider.get("displayName", "") if isinstance(provider, dict) else ""
        canon = content.get("canonicalUrl", {})
        link = canon.get("url", "#") if isinstance(canon, dict) else "#"
    else:
        # Old / flat format
        title = item.get("title", "")
        publisher = item.get("publisher", "")
        link = item.get("link", "#")
    return {"title": title, "publisher": publisher, "link": link}


def analyse_sentiment(news_items: list) -> dict:
    """Aggregate sentiment across headlines."""
    headlines = []
    total_score = 0
    for item in news_items:
        h = _extract_headline(item)
        title = h["title"]
        if not title:
            continue
        s = score_headline(title)
        total_score += s
        headlines.append({
            "title": title,
            "publisher": h["publisher"],
            "link": h["link"],
            "score": s,
        })

    n = len(headlines) or 1
    avg = total_score / n
    if avg > 0.25:
        label = "Bullish"
        colour = C_GREEN
    elif avg < -0.25:
        label = "Bearish"
        colour = C_RED
    else:
        label = "Neutral"
        colour = C_AMBER

    return {
        "headlines": headlines[:5],
        "label": label,
        "colour": colour,
        "avg_score": round(avg, 2),
        "total_score": total_score,
    }


# ───────────────────────────────────────────────────────────────
# 8. PLOTLY CHART — candlestick + SMA + volume
# ───────────────────────────────────────────────────────────────
def build_chart(df: pd.DataFrame, ticker: str) -> go.Figure:
    """Interactive candlestick with SMA overlays and volume bars."""
    # Trim to ~1 year for display
    display = df.tail(252).copy()

    fig = make_subplots(
        rows=3, cols=1,
        shared_xaxes=True,
        row_heights=[0.60, 0.20, 0.20],
        vertical_spacing=0.03,
    )

    # Candlestick
    fig.add_trace(go.Candlestick(
        x=display.index,
        open=display["Open"].squeeze(),
        high=display["High"].squeeze(),
        close=display["Close"].squeeze(),
        low=display["Low"].squeeze(),
        increasing_line_color=C_GREEN,
        decreasing_line_color=C_RED,
        increasing_fillcolor=C_GREEN,
        decreasing_fillcolor=C_RED,
        name="Price",
        showlegend=False,
    ), row=1, col=1)

    # SMA overlays
    fig.add_trace(go.Scatter(
        x=display.index, y=display["SMA_50"].squeeze(),
        line=dict(color=C_TEAL, width=1.5),
        name="SMA 50",
    ), row=1, col=1)

    fig.add_trace(go.Scatter(
        x=display.index, y=display["SMA_200"].squeeze(),
        line=dict(color=C_AMBER, width=1.5, dash="dot"),
        name="SMA 200",
    ), row=1, col=1)

    # Volume
    vol = display["Volume"].squeeze()
    close_series = display["Close"].squeeze()
    colours = [C_GREEN if c >= o else C_RED
               for c, o in zip(close_series, display["Open"].squeeze())]
    fig.add_trace(go.Bar(
        x=display.index, y=vol,
        marker_color=colours, opacity=0.45,
        name="Volume", showlegend=False,
    ), row=2, col=1)

    # RSI
    fig.add_trace(go.Scatter(
        x=display.index, y=display["RSI"].squeeze(),
        line=dict(color=C_BLUE, width=1.5),
        name="RSI 14",
    ), row=3, col=1)
    fig.add_hline(y=75, line_dash="dash", line_color=C_RED, opacity=0.5, row=3, col=1)
    fig.add_hline(y=25, line_dash="dash", line_color=C_GREEN, opacity=0.5, row=3, col=1)
    fig.add_hline(y=50, line_dash="dot", line_color=C_MUTED, opacity=0.3, row=3, col=1)

    # Layout
    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor="#0E1117",
        plot_bgcolor="#0E1117",
        font=dict(family="Inter, sans-serif", color=C_TEXT, size=12),
        title=dict(
            text=f"<b>{ticker}</b> — 1 Year",
            font=dict(size=18),
            x=0.01, xanchor="left",
        ),
        legend=dict(
            orientation="h", yanchor="bottom", y=1.02,
            xanchor="right", x=1,
            bgcolor="rgba(0,0,0,0)", font=dict(size=11),
        ),
        xaxis_rangeslider_visible=False,
        margin=dict(l=60, r=20, t=60, b=30),
        height=620,
    )

    fig.update_yaxes(title_text="Price", row=1, col=1, gridcolor="#21262D", zerolinecolor="#21262D")
    fig.update_yaxes(title_text="Vol", row=2, col=1, gridcolor="#21262D", zerolinecolor="#21262D")
    fig.update_yaxes(title_text="RSI", row=3, col=1, gridcolor="#21262D", zerolinecolor="#21262D",
                     range=[0, 100])
    fig.update_xaxes(gridcolor="#21262D", row=1, col=1)
    fig.update_xaxes(gridcolor="#21262D", row=2, col=1)
    fig.update_xaxes(gridcolor="#21262D", row=3, col=1)

    return fig


# ═══════════════════════════════════════════════════════════════
# 9. MAIN LAYOUT
# ═══════════════════════════════════════════════════════════════
st.markdown(
    "<h1 style='margin-bottom:2px; letter-spacing:-0.02em;'>🌀 VortexStock</h1>"
    "<p style='color:#8B949E; margin-top:0; font-size:0.92rem;'>"
    "Market Regime Classifier · ATR Position Sizer · Sentiment Scanner</p>",
    unsafe_allow_html=True,
)

# ---- Fetch data ----
with st.spinner(f"Fetching data for **{ticker_input}**…"):
    df_raw = fetch_data(ticker_input)

if df_raw.empty:
    st.error(f"No data returned for **{ticker_input}**. Check the ticker symbol and try again.")
    st.stop()

# ---- Compute indicators ----
df = compute_indicators(df_raw)
latest = df.dropna(subset=["SMA_50", "SMA_200", "RSI", "ADX", "ATR"]).iloc[-1]

price_now = float(latest["Close"])
sma50_now = float(latest["SMA_50"])
sma200_now = float(latest["SMA_200"])
rsi_now = float(latest["RSI"])
adx_now = float(latest["ADX"])
atr_now = float(latest["ATR"])
regime = classify_regime(latest)
regime_colour = REGIME_COLOURS.get(regime, C_MUTED)

# ---- Risk calc ----
risk = compute_risk(price_now, atr_now, account_size, risk_pct)

# ───────────────────────────────────────────────────────────────
# ROW 1 — Key metrics
# ───────────────────────────────────────────────────────────────
st.markdown("---")
m1, m2, m3, m4, m5, m6 = st.columns(6)

# Price delta from previous close
prev_close = float(df["Close"].squeeze().iloc[-2]) if len(df) > 1 else price_now
price_delta = price_now - prev_close
price_delta_pct = (price_delta / prev_close * 100) if prev_close != 0 else 0

m1.metric("Price", f"${price_now:,.2f}", f"{price_delta_pct:+.2f}%")
m2.metric("SMA 50", f"${sma50_now:,.2f}")
m3.metric("SMA 200", f"${sma200_now:,.2f}")
m4.metric("RSI 14", f"{rsi_now:.1f}")
m5.metric("ADX 14", f"{adx_now:.1f}")
m6.metric("ATR 14", f"${atr_now:,.2f}")

# ───────────────────────────────────────────────────────────────
# ROW 2 — Regime badge + Signal box
# ───────────────────────────────────────────────────────────────
col_regime, col_signal = st.columns([1, 2])

with col_regime:
    st.markdown("#### Market Regime")
    st.markdown(
        f'<span class="regime-badge" style="background:{regime_colour}; color:#fff;">'
        f'{regime}</span>',
        unsafe_allow_html=True,
    )
    st.markdown("")
    # Regime description
    regime_desc = {
        "Strong Bull": "Price above both MAs, trending strongly (ADX > 25). High-conviction long setups.",
        "Weak Bull": "Price above both MAs but momentum fading (ADX < 25). Lighter positions, tighter stops.",
        "Strong Bear": "Price below both MAs, strong downtrend (ADX > 25). High-conviction short setups.",
        "Weak Bear": "Price below both MAs but trend weakening (ADX < 25). Cautious shorts only.",
        "Overbought / Blowoff": "RSI > 75 — asset is extended. Risk of reversal. Trim longs or wait.",
        "Oversold / Capitulation": "RSI < 25 — asset is deeply oversold. Watch for reversal longs.",
        "Chop / Ranging": "No clear trend. ADX weak, price tangled in MAs. Stay cash or range-trade.",
    }
    st.caption(regime_desc.get(regime, ""))

with col_signal:
    st.markdown("#### Signal Box")

    # Determine direction
    if regime in ("Strong Bull", "Weak Bull", "Oversold / Capitulation"):
        direction = "LONG"
        conviction = "High Conviction" if regime == "Strong Bull" else "Moderate Conviction"
        stop_val = risk["stop_long"]
        box_colour = C_GREEN
        border_col = C_GREEN
    elif regime in ("Strong Bear", "Weak Bear"):
        direction = "SHORT"
        conviction = "High Conviction" if regime == "Strong Bear" else "Moderate Conviction"
        stop_val = risk["stop_short"]
        box_colour = C_RED
        border_col = C_RED
    else:
        direction = "CASH"
        conviction = "No Edge"
        stop_val = 0
        box_colour = C_MUTED
        border_col = C_MUTED

    if direction == "CASH":
        signal_html = f"""
        <div class="signal-box" style="background:{C_CARD}; border-color:{border_col};">
            <h3 style="color:{box_colour};">⏸ {conviction} — STAY CASH</h3>
            <p>Regime is <b>{regime}</b>. No actionable edge detected.</p>
            <p>Wait for a directional regime before deploying capital.</p>
        </div>
        """
    else:
        signal_html = f"""
        <div class="signal-box" style="background:{C_CARD}; border-color:{border_col};">
            <h3 style="color:{box_colour};">{conviction} {direction}</h3>
            <p>Regime: <b>{regime}</b></p>
            <p>Position Size: <span class="mono">{risk['position_size']}</span> shares
               &nbsp;·&nbsp; Dollar Risk: <span class="mono">${risk['dollar_risk']:,.2f}</span></p>
            <p>Stop Loss: <span class="mono">${stop_val:,.2f}</span>
               &nbsp;(2× ATR = <span class="mono">${risk['stop_distance']:,.2f}</span>)</p>
            <p style="color:{C_MUTED}; font-size:0.82rem; margin-top:8px;">
                Risking {risk_pct:.1f}% of ${account_size:,.0f} account</p>
        </div>
        """
    st.markdown(signal_html, unsafe_allow_html=True)

# ───────────────────────────────────────────────────────────────
# ROW 3 — Interactive Chart
# ───────────────────────────────────────────────────────────────
st.markdown("---")
fig = build_chart(df, ticker_input)
st.plotly_chart(fig, use_container_width=True)

# ───────────────────────────────────────────────────────────────
# ROW 4 — Risk detail + Sentiment side by side
# ───────────────────────────────────────────────────────────────
st.markdown("---")
col_risk, col_sent = st.columns(2)

# -- Risk breakdown --
with col_risk:
    st.markdown("#### Position Sizing Breakdown")
    r1, r2 = st.columns(2)
    r1.metric("Stop Distance (2× ATR)", f"${risk['stop_distance']:,.2f}")
    r2.metric("Dollar Risk", f"${risk['dollar_risk']:,.2f}")
    r3, r4 = st.columns(2)
    r3.metric("Position Size", f"{risk['position_size']} shares")
    r4.metric("Exact Size", f"{risk['position_size_exact']:,.4f}")
    if direction != "CASH":
        notional = risk["position_size"] * price_now
        st.caption(
            f"Notional exposure: **${notional:,.2f}** "
            f"({notional / account_size * 100:.1f}% of account)"
        )

# -- Sentiment --
with col_sent:
    st.markdown("#### Microstructure Vision — Sentiment")

    news_items = fetch_news(ticker_input)
    if not news_items:
        st.info("No headlines available for this ticker.")
    else:
        sentiment = analyse_sentiment(news_items)

        # Sentiment chip
        st.markdown(
            f'<span class="sentiment-chip" '
            f'style="background:{sentiment["colour"]}22; color:{sentiment["colour"]}; '
            f'border:1px solid {sentiment["colour"]}55;">'
            f'{sentiment["label"]}  (score: {sentiment["avg_score"]:+.2f})</span>',
            unsafe_allow_html=True,
        )
        st.markdown("")

        # Headlines
        for h in sentiment["headlines"]:
            score_icon = "🟢" if h["score"] > 0 else ("🔴" if h["score"] < 0 else "⚪")
            st.markdown(
                f'<div class="headline-card">'
                f'<div class="title">{score_icon} {h["title"]}</div>'
                f'<div class="publisher">{h["publisher"]}</div>'
                f'</div>',
                unsafe_allow_html=True,
            )

# ───────────────────────────────────────────────────────────────
# FOOTER
# ───────────────────────────────────────────────────────────────
st.markdown("---")
st.markdown(
    '<div class="vortex-footer">'
    'VortexStock · Built with Streamlit & yfinance · '
    '<a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">'
    'Created with Perplexity Computer</a>'
    '</div>',
    unsafe_allow_html=True,
)
