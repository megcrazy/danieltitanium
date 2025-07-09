require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');
const axios = require('axios');

// ================= CONFIGURAÇÃO ================= //
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  PARES_MONITORADOS: (process.env.PARES_MONITORADOS || "BTCUSDT,ETHUSDT,BNBUSDT").split(","),
  INTERVALO_ALERTA_3M_MS: 300000,
  TEMPO_COOLDOWN_MS: 15 * 60 * 1000,
  WPR_PERIOD: 26,
  WPR_LOW_THRESHOLD: -97,
  WPR_HIGH_THRESHOLD: -2,
  ATR_PERIOD: 14,
  RSI_PERIOD: 14,
  FI_PERIOD: 13,
  ATR_PERCENT_MIN: 0.5,
  ATR_PERCENT_MAX: 3.0,
  CACHE_TTL: 10 * 60 * 1000,
  EMA_34_PERIOD: 34,
  EMA_89_PERIOD: 89,
  MAX_CACHE_SIZE: 100,
  MAX_HISTORICO_ALERTAS: 10,
  HEARTBEAT_INTERVAL_MS: 120 * 60 * 1000
};

// Logger com nível reduzido para 'error' no console e arquivo
const logger = winston.createLogger({
  level: 'error', // Log apenas erros
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'quick_trading_bot.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  ultimoAlertaPorAtivo: {},
  ultimoEstocastico: {},
  wprTriggerState: {},
  ultimoRompimento: {},
  ultimoEMACruzamento: {},
  dataCache: new Map()
};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PARES_MONITORADOS'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Missing environment variable: ${key}`);
      process.exit(1);
    }
  }
}
validateEnv();

// Inicialização do Telegram e Exchanges
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const exchangeSpot = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: 'spot' }
});
const exchangeFutures = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: 'future' }
});

// ================= UTILITÁRIOS ================= //
async function withRetry(fn, retries = 5, delayBase = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries) {
        logger.error(`Falha após ${retries} tentativas: ${e.message}`);
        throw e;
      }
      const delay = Math.pow(2, attempt - 1) * delayBase;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function getCachedData(key) {
  const cacheEntry = state.dataCache.get(key);
  if (cacheEntry && Date.now() - cacheEntry.timestamp < config.CACHE_TTL) {
    return cacheEntry.data;
  }
  state.dataCache.delete(key);
  return null;
}

function setCachedData(key, data) {
  if (state.dataCache.size >= config.MAX_CACHE_SIZE) {
    const oldestKey = state.dataCache.keys().next().value;
    state.dataCache.delete(oldestKey);
  }
  state.dataCache.set(key, { timestamp: Date.now(), data });
  setTimeout(() => {
    if (state.dataCache.has(key) && Date.now() - state.dataCache.get(key).timestamp >= config.CACHE_TTL) {
      state.dataCache.delete(key);
    }
  }, config.CACHE_TTL + 1000);
}

async function limitConcurrency(items, fn, limit = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(item => fn(item)));
    results.push(...batchResults);
  }
  return results;
}

// ================= INDICADORES ================= //
function normalizeOHLCV(data) {
  return data.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }))..filter(c => !isNaN(c.close) && !isNaN(c.volume));
}

function calculateWPR(data) {
  if (!data || data.length < config.WPR_PERIOD + 1) return [];
  const wpr = TechnicalIndicators.WilliamsR.calculate({
    period: config.WPR_PERIOD,
    high: data.map(d => d.high || d[2]),
    low: data.map(d => d.low || d[3]),
    close: data.map(d => d.close || d[4])
  });
  return wpr.filter(v => !isNaN(v));
}

function calculateRSI(data) {
  if (!data || data.length < config.RSI_PERIOD + 1) return [];
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: data.map(d => d.close || d[4])
  });
  return rsi.filter(v => !isNaN(v));
}

function calculateOBV(data) {
  let obv = 0;
  const obvValues = [data[0].volume || data[0][5]];
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    const prev = data[i - 1];
    const currClose = curr.close || curr[4];
    const prevClose = prev.close || prev[4];
    const volume = curr.volume || curr[5];
    if (isNaN(currClose) || isNaN(prevClose) || isNaN(volume)) continue;
    if (currClose > prevClose) obv += volume;
    else if (currClose < prevClose) obv -= volume;
    obvValues.push(obv);
  }
  return obvValues;
}

function calculateCVD(data) {
  let cvd = 0;
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    const currClose = curr.close || curr[4];
    const currOpen = curr.open || curr[1];
    const volume = curr.volume || curr[5];
    if (isNaN(currClose) || isNaN(currOpen) || isNaN(volume)) continue;
    if (currClose > currOpen) cvd += volume;
    else if (currClose < currOpen) cvd -= volume;
  }
  return cvd;
}

function calculateATR(data) {
  const atr = TechnicalIndicators.ATR.calculate({
    period: config.ATR_PERIOD,
    high: data.map(c => c.high || c[2]),
    low: data.map(c => c.low || c[3]),
    close: data.map(c => c.close || c[4])
  });
  return atr.filter(v => !isNaN(v));
}

function calculateForceIndex(data, period = config.FI_PERIOD) {
  if (!data || data.length < 2) return [];
  const fiValues = [];
  for (let i = 1; i < data.length; i++) {
    const closeCurrent = data[i].close || data[i][4];
    const closePrevious = data[i - 1].close || data[i - 1][4];
    const volume = data[i].volume || data[i][5];
    if (isNaN(closeCurrent) || isNaN(closePrevious) || isNaN(volume)) continue;
    const fi = (closeCurrent - closePrevious) * volume;
    fiValues.push(fi);
  }
  return fiValues.length >= period ? TechnicalIndicators.EMA.calculate({ period, values: fiValues }).filter(v => !isNaN(v)) : [];
}

function calculateStochastic(data, periodK = 5, smoothK = 3, periodD = 3) {
  if (!data || data.length < periodK + smoothK + periodD - 2) return null;
  const highs = data.map(c => c.high || c[2]).filter(h => !isNaN(h));
  const lows = data.map(c => c.low || c[3]).filter(l => !isNaN(l));
  const closes = data.map(c => c.close || c[4]).filter(cl => !isNaN(cl));
  if (highs.length < periodK || lows.length < periodK || closes.length < periodK) return null;
  const result = TechnicalIndicators.Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: periodK,
    signalPeriod: periodD,
    smoothing: smoothK
  });
  return result.length ? { k: parseFloat(result[result.length - 1].k.toFixed(2)), d: parseFloat(result[result.length - 1].d.toFixed(2)) } : null;
}

function calculateEMA(data, period) {
  if (!data || data.length < period) return [];
  const ema = TechnicalIndicators.EMA.calculate({
    period: period,
    values: data.map(d => d.close || d[4])
  });
  return ema.filter(v => !isNaN(v));
}

function detectarQuebraEstrutura(ohlcv) {
  if (!ohlcv || ohlcv.length < 2) return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  constLike lookbackPeriod = 20;
  const previousCandles = ohlcv.slice(0, -1).slice(-lookbackPeriod);
  const highs = previousCandles.map(c => c.high || c[2]).filter(h => !isNaN(h));
  const lows = previousCandles.map(c => c.low || c[3]).filter(l => !isNaN(l));
  const volumes = previousCandles.map(c => c.volume || c[5]).filter(v => !isNaN(v));
  if (highs.length === 0 || lows.length === 0 || volumes.length === 0) {
    return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const volumeThreshold = Math.max(...volumes) * 0.7;
  const buyLiquidityZones = [];
  const sellLiquidityZones = [];
  previousCandles.forEach(candle => {
    const high = candle.high || candle[2];
    const low = candle.low || candle[3];
    const volume = candle.volume || candle[5];
    if (volume >= volumeThreshold && !isNaN(low) && !isNaN(high)) {
      if (low <= minLow * 1.01) buyLiquidityZones.push(low);
      if (high >= maxHigh * 0.99) sellLiquidityZones.push(high);
    }
  });
  return {
    estruturaAlta: maxHigh,
    estruturaBaixa: minLow,
    buyLiquidityZones: [...new Set(buyLiquidityZones)].sort((a, b) => b - a).slice(0, 3),
    sellLiquidityZones: [...new Set(sellLiquidityZones)].sort((a, b) => a - b).slice(0, 3)
  };
}

function calculateVolumeProfile(ohlcv, priceStepPercent = 0.1) {
  if (!ohlcv || ohlcv.length < 2) return { buyLiquidityZones: [], sellLiquidityZones: [] };
  const priceRange = Math.max(...ohlcv.map(c => c.high || c[2])) - Math.min(...ohlcv.map(c => c.low || c[3]));
  const step = priceRange * priceStepPercent / 100;
  const volumeProfile = {};
  ohlcv.forEach(candle => {
    const price = ((candle.high || candle[2]) + (candle.low || candle[3])) / 2;
    if (isNaN(price) || isNaN(candle.volume || candle[5])) return;
    const bucket = Math.floor(price / step) * step;
    volumeProfile[bucket] = (volumeProfile[bucket] || 0) + (candle.volume || candle[5]);
  });
  const sortedBuckets = Object.entries(volumeProfile)
    .sort(([, volA], [, volB]) => volB - volA)
    .slice(0, 3)
    .map(([price]) => parseFloat(price));
  return {
    buyLiquidityZones: sortedBuckets.filter(p => p <= ohlcv[ohlcv.length - 1].close).sort((a, b) => b - a),
    sellLiquidityZones: sortedBuckets.filter(p => p > ohlcv[ohlcv.length - 1].close).sort((a, b) => a - b)
  };
}

async function fetchLiquidityZones(symbol) {
  const cacheKey = `liquidity_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const orderBook = await withRetry(() => exchangeSpot.fetchOrderBook(symbol, 20));
    const bids = orderBook.bids;
    const asks = orderBook.asks;
    const liquidityThreshold = 0.5;
    const totalBidVolume = bids.reduce((sum, [, vol]) => sum + vol, 0);
    const totalAskVolume = asks.reduce((sum, [, vol]) => sum + vol, 0);
    const buyLiquidityZones = bids
      .filter(([price, volume]) => volume >= totalBidVolume * liquidityThreshold)
      .map(([price]) => price);
    const sellLiquidityZones = asks
      .filter(([price, volume]) => volume >= totalAskVolume * liquidityThreshold)
      .map(([price]) => price);
    const result = { buyLiquidityZones, sellLiquidityZones };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    logger.error(`Erro ao buscar zonas de liquidez para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { buyLiquidityZones: [], sellLiquidityZones: [] };
  }
}

async function fetchLSR(symbol) {
  const cacheKey = `lsr_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const res = await withRetry(() => axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
      params: { symbol: symbol.replace('/', ''), period: '15m', limit: 2 }
    }));
    if (!res.data || res.data.length < 2) {
      return getCachedData(cacheKey) || { value: null, isRising: false, percentChange: '0.00' };
    }
    const currentLSR = parseFloat(res.data[0].longShortRatio);
    const previousLSR = parseFloat(res.data[1].longShortRatio);
    const percentChange = previousLSR !== 0 ? ((currentLSR - previousLSR) / previousLSR * 100).toFixed(2) : '0.00';
    const result = { value: currentLSR, isRising: currentLSR > previousLSR, percentChange };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    logger.error(`Erro ao buscar LSR para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { value: null, isRising: false, percentChange: '0.00' };
  }
}

async function fetchOpenInterest(symbol, timeframe, retries = 5) {
  const cacheKey = `oi_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const oiData = await withRetry(() => exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 30));
    if (!oiData || oiData.length < 3) {
      if (retries > 0) {
        const delay = Math.pow(2, 5 - retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '5m') {
        return await fetchOpenInterest(symbol, '15m', 3);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const validOiData = oiData
      .filter(d => {
        const oiValue = d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest);
        return typeof oiValue === 'number' && !isNaN(oiValue) && oiValue >= 0;
      })
      .map(d => ({
        ...d,
        openInterest: d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest)
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (validOiData.length < 3) {
      if (retries > 0) {
        const delay = Math.pow(2, 5 - retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '5m') {
        return await fetchOpenInterest(symbol, '15m', 3);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const oiValues = validOiData.map(d => d.openInterest).filter(v => v !== undefined);
    const sortedOi = [...oiValues].sort((a, b) => a - b);
    const median = sortedOi[Math.floor(sortedOi.length / 2)];
    const filteredOiData = validOiData.filter(d => d.openInterest >= median * 0.5 && d.openInterest <= median * 1.5);
    if (filteredOiData.length < 3) {
      if (retries > 0) {
        const delay = Math.pow(2, 5 - retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '5m') {
        return await fetchOpenInterest(symbol, '15m', 3);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const recentOi = filteredOiData.slice(0, 3).map(d => d.openInterest);
    const sma = recentOi.reduce((sum, val) => sum + val, 0) / recentOi.length;
    const previousRecentOi = filteredOiData.slice(3, 6).map(d => d.openInterest);
    const previousSma = previousRecentOi.length >= 3 ? previousRecentOi.reduce((sum, val) => sum + val, 0) / previousRecentOi.length : recentOi[recentOi.length - 1];
    const oiPercentChange = previousSma !== 0 ? ((sma - previousSma) / previousSma * 100).toFixed(2) : '0.00';
    const result = {
      isRising: sma > previousSma,
      percentChange: oiPercentChange
    };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    if (e.message.includes('binance does not have market symbol') || e.message.includes('Invalid symbol')) {
      logger.error(`Símbolo ${symbol} não suportado para Open Interest no timeframe ${timeframe}. Ignorando.`);
      return { isRising: false, percentChange: '0.00' };
    }
    logger.error(`Erro ao buscar Open Interest para ${symbol} no timeframe ${timeframe}: ${e.message}`);
    return getCachedData(cacheKey) || { isRising: false, percentChange: '0.00' };
  }
}

async function fetchFundingRate(symbol) {
  const cacheKey = `funding_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const fundingData = await withRetry(() => exchangeFutures.fetchFundingRateHistory(symbol, undefined, 2));
    if (fundingData && fundingData.length >= 2) {
      const currentFunding = parseFloat(fundingData[fundingData.length - 1].fundingRate);
      const previousFunding = parseFloat(fundingData[fundingData.length - 2].fundingRate);
      const percentChange = previousFunding !== 0 ? ((currentFunding - previousFunding) / Math.abs(previousFunding) * 100).toFixed(2) : '0.00';
      const result = { current: currentFunding, isRising: currentFunding > previousFunding, percentChange };
      setCachedData(cacheKey, result);
      return result;
    }
    return getCachedData(cacheKey) || { current: null, isRising: false, percentChange: '0.00' };
  } catch (e) {
    logger.error(`Erro ao buscar Funding Rate para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { current: null, isRising: false, percentChange: '0.00' };
  }
}

async function calculateAggressiveDelta(symbol, timeframe = '3m', limit = 100) {
  const cacheKey = `delta_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const trades = await withRetry(() => exchangeSpot.fetchTrades(symbol, undefined, limit));
    let buyVolume = 0;
    let sellVolume = 0;
    for (const trade of trades) {
      const { side, amount, price } = trade;
      if (!side || !amount || !price || isNaN(amount) || isNaN(price)) continue;
      if (side === 'buy') buyVolume += amount;
      else if (side === 'sell') sellVolume += amount;
    }
    const delta = buyVolume - sellVolume;
    const totalVolume = buyVolume + sellVolume;
    const deltaPercent = totalVolume !== 0 ? (delta / totalVolume * 100).toFixed(2) : '0.00';
    const result = {
      delta,
      deltaPercent: parseFloat(deltaPercent),
      isBuyPressure: delta > 0,
      isSignificant: Math.abs(deltaPercent) > 10
    };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    logger.error(`Erro ao calcular Delta Agressivo para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { delta: 0, deltaPercent: 0, isBuyPressure: false, isSignificant: false };
  }
}

// ================= FUNÇÕES DE ALERTAS ================= //
function getStochasticEmoji(value) {
  if (!value) return "";
  return value < 10 ? "🔵" : value < 25 ? "🟢" : value <= 55 ? "🟡" : value <= 70 ? "🟠" : value <= 80 ? "🔴" : "💥";
}

function getSetaDirecao(current, previous) {
  if (!current || !previous) return "➡️";
  return current > previous ? "⬆️" : current < previous ? "⬇️" : "➡️";
}

async function sendAlertRompimentoEstrutura15m(symbol, price, zonas, ohlcv15m, rsi1h, lsr, fundingRate, aggressiveDelta, estocasticoD, estocastico4h, oi15m) {
  const agora = Date.now();
  if (!state.ultimoRompimento[symbol]) state.ultimoRompimento[symbol] = { historico: [] };
  if (state.ultimoRompimento[symbol]['15m'] && agora - state.ultimoRompimento[symbol]['15m'] < config.TEMPO_COOLDOWN_MS) return;
  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const currentCandle = ohlcv15m[ohlcv15m.length - 1];
  const previousCandle = ohlcv15m.length >= 2 ? ohlcv15m[ohlcv15m.length - 2] : null;
  const isValidPreviousCandle = previousCandle !== null && !isNaN(previousCandle.close || previousCandle[4]);
  if (!currentCandle || !isValidPreviousCandle) return;
  const currentClose = currentCandle.close || currentCandle[4];
  const currentHigh = currentCandle.high || currentCandle[2];
  const currentLow = currentCandle.low || currentCandle[3];
  const previousClose = previousCandle.close || previousCandle[4];
  const isPriceRising = currentClose > previousClose;
  const isPriceFalling = currentClose < previousClose;
  let alertText = '';
  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=15`;
  const rsi1hEmoji = rsi1h > 60 ? "☑︎" : rsi1h < 40 ? "☑︎" : "";
  let lsrSymbol = '🔘Consol.';
  if (lsr.value !== null) {
    if (lsr.value <= 1.4) lsrSymbol = '✅Baixo';
    else if (lsr.value >= 3) lsrSymbol = '📛Alto';
  }
  let fundingRateEmoji = '';
  if (fundingRate.current !== null) {
    if (fundingRate.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
    else if (fundingRate.current <= -0.001) fundingRateEmoji = '🟢🟢';
    else if (fundingRate.current <= -0.0005) fundingRateEmoji = '🟢';
    else if (fundingRate.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
    else if (fundingRate.current >= 0.0003) fundingRateEmoji = '🔴🔴';
    else if (fundingRate.current >= 0.0002) fundingRateEmoji = '🔴';
    else fundingRateEmoji = '🟢';
  }
  const fundingRateText = fundingRate.current !== null 
    ? `${fundingRateEmoji} ${(fundingRate.current * 100).toFixed(5)}%  ${fundingRate.isRising ? '⬆️' : '⬇️'}`
    : '🔹 Indisp.';
  const deltaText = aggressiveDelta.isSignificant 
    ? `${aggressiveDelta.isBuyPressure ? '💹F.Comprador' : '⭕F.Vendedor'} ${aggressiveDelta.deltaPercent > 60 && lsr.value !== null && lsr.value < 1 ? '💥' : ''}(${aggressiveDelta.deltaPercent}%)`
    : '🔘Neutro';
  const oiText = oi15m ? `${oi15m.isRising ? '📈' : '📉'} OI 15m: ${oi15m.percentChange}%` : '🔹 Indisp.';
  if (!state.ultimoEstocastico[symbol]) state.ultimoEstocastico[symbol] = {};
  const kAnteriorD = state.ultimoEstocastico[symbol].kD || estocasticoD?.k || 0;
  const kAnterior4h = state.ultimoEstocastico[symbol].k4h || estocastico4h?.k || 0;
  state.ultimoEstocastico[symbol].kD = estocasticoD?.k;
  state.ultimoEstocastico[symbol].k4h = estocastico4h?.k;
  const direcaoD = getSetaDirecao(estocasticoD?.k, kAnteriorD);
  const direcao4h = getSetaDirecao(estocastico4h?.k, kAnterior4h);
  const stochDEmoji = estocasticoD ? getStochasticEmoji(estocasticoD.k) : "";
  const stoch4hEmoji = estocastico4h ? getStochasticEmoji(estocastico4h.k) : "";
  const buyZonesText = zonas.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const sellZonesText = zonas.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpBuyZonesText = calculateVolumeProfile(ohlcv15m).buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpSellZonesText = calculateVolumeProfile(ohlcv15m).sellLiquidityZones.map(format).join(' / ') || 'N/A';
  if (isValidPreviousCandle && 
      zonas.estruturaAlta > 0 && 
      previousClose < zonas.estruturaAlta && 
      currentHigh >= zonas.estruturaAlta && 
      isPriceRising && 
      (lsr.value === null || lsr.value < 1.7) && 
      aggressiveDelta.isBuyPressure && 
      estocasticoD?.k < 73 && 
      estocastico4h?.k < 73 &&
      rsi1h < 52 &&
      oi15m.isRising) {
    const nivelRompido = zonas.estruturaAlta;
    const foiAlertado = state.ultimoRompimento[symbol].historico.some(r => 
      r.nivel === nivelRompido && 
      r.direcao === 'alta' && 
      (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🟢 *Rompimento de Alta*\n\n` +
                  `🔹 Ativo: *${symbol}* [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço Atual: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 OI 15m: ${oiText}\n` +
                  `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Liquid. Compra: ${buyZonesText}\n` +
                  `   Liquid. Venda: ${sellZonesText}\n` +
                  `   POC Bull: ${vpBuyZonesText}\n` +
                  `   POC Bear: ${vpSellZonesText}\n` +
                  `☑︎  🤖 @J4Rviz`;
      state.ultimoRompimento[symbol]['15m'] = agora;
      state.ultimoRompimento[symbol].historico.push({ nivel: nivelRompido, direcao: 'alta', timestamp: agora });
      state.ultimoRompimento[symbol].historico = state.ultimoRompimento[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.error(`Rompimento de alta detectado para ${symbol}: Preço=${format(price)}, Estrutura Alta=${format(zonas.estruturaAlta)}, Tendência=Subindo`);
    }
  } else if (isValidPreviousCandle && 
             zonas.estruturaBaixa > 0 && 
             previousClose > zonas.estruturaBaixa && 
             currentLow <= zonas.estruturaBaixa && 
             isPriceFalling && 
             (lsr.value === null || lsr.value > 1.8) && 
             !aggressiveDelta.isBuyPressure && 
             estocastico4h?.k > 73 && 
             rsi1h > 50 &&
             !oi15m.isRising) {
    const nivelRompido = zonas.estruturaBaixa;
    const foiAlertado = state.ultimoRompimento[symbol].historico.some(r => 
      r.nivel === nivelRompido && 
      r.direcao === 'baixa' && 
      (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🔴 *Rompimento de Baixa*\n\n` +
                  `🔹 Ativo: *${symbol}* [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço Atual: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 OI 15m: ${oiText}\n` +
                  `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Liquid. Compra: ${buyZonesText}\n` +
                  `   Liquid. Venda: ${sellZonesText}\n` +
                  `   POC Bull: ${vpBuyZonesText}\n` +
                  `   POC Bear: ${vpSellZonesText}\n` +
                  `☑︎  🤖 @J4Rviz`;
      state.ultimoRompimento[symbol]['15m'] = agora;
      state.ultimoRompimento[symbol].historico.push({ nivel: nivelRompido, direcao: 'baixa', timestamp: agora });
      state.ultimoRompimento[symbol].historico = state.ultimoRompimento[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.error(`Rompimento de baixa detectado para ${symbol}: Preço=${format(price)}, Estrutura Baixa=${format(zonas.estruturaBaixa)}, Tendência=Caindo`);
    }
  }
  if (alertText) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, alertText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      logger.error(`Alerta de rompimento de estrutura enviado para ${symbol}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta para ${symbol}: ${e.message}`);
    }
  }
}

async function sendAlertEMACruzamento3m(symbol, price, zonas, ohlcv15m, rsi1h, lsr, fundingRate, aggressiveDelta, estocasticoD, estocastico4h, ema34, ema89, direction, oi15m) {
  const agora = Date.now();
  if (!state.ultimoEMACruzamento[symbol]) state.ultimoEMACruzamento[symbol] = { historico: [] };
  if (state.ultimoEMACruzamento[symbol]['3m'] && agora - state.ultimoEMACruzamento[symbol]['3m'] < config.TEMPO_COOLDOWN_MS) return;
  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const currentCandle = ohlcv15m[ohlcv15m.length - 1];
  const previousCandle = ohlcv15m.length >= 2 ? ohlcv15m[ohlcv15m.length - 2] : null;
  const isValidPreviousCandle = previousCandle !== null && !isNaN(previousCandle.close || previousCandle[4]);
  if (!currentCandle || !isValidPreviousCandle) return;
  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=3`;
  const rsi1hEmoji = rsi1h > 60 ? "☑︎" : rsi1h < 40 ? "☑︎" : "";
  let lsrSymbol = '🔘Consol.';
  if (lsr.value !== null) {
    if (lsr.value <= 1.4) lsrSymbol = '✅Baixo';
    else if (lsr.value >= 3) lsrSymbol = '📛Alto';
  }
  let fundingRateEmoji = '';
  if (fundingRate.current !== null) {
    if (fundingRate.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
    else if (fundingRate.current <= -0.001) fundingRateEmoji = '🟢🟢';
    else if (fundingRate.current <= -0.0005) fundingRateEmoji = '🟢';
    else if (fundingRate.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
    else if (fundingRate.current >= 0.0003) fundingRateEmoji = '🔴🔴';
    else if (fundingRate.current >= 0.0002) fundingRateEmoji = '🔴';
    else fundingRateEmoji = '🟢';
  }
  const fundingRateText = fundingRate.current !== null 
    ? `${fundingRateEmoji} ${(fundingRate.current * 100).toFixed(5)}%  ${fundingRate.isRising ? '⬆️' : '⬇️'}`
    : '🔹 Indisp.';
  const deltaText = aggressiveDelta.isSignificant 
    ? `${aggressiveDelta.isBuyPressure ? '💹F.Comprador' : '⭕F.Vendedor'} ${aggressiveDelta.deltaPercent > 60 && lsr.value !== null && lsr.value < 1 ? '💥' : ''}(${aggressiveDelta.deltaPercent}%)`
    : '🔘Neutro';
  const oiText = oi15m ? `${oi15m.isRising ? '📈' : '📉'} OI 15m: ${oi15m.percentChange}%` : '🔹 Indisp.';
  if (!state.ultimoEstocastico[symbol]) state.ultimoEstocastico[symbol] = {};
  const kAnteriorD = state.ultimoEstocastico[symbol].kD || estocasticoD?.k || 0;
  const kAnterior4h = state.ultimoEstocastico[symbol].k4h || estocastico4h?.k || 0;
  state.ultimoEstocastico[symbol].kD = estocasticoD?.k;
  state.ultimoEstocastico[symbol].k4h = estocastico4h?.k;
  const direcaoD = getSetaDirecao(estocasticoD?.k, kAnteriorD);
  const direcao4h = getSetaDirecao(estocastico4h?.k, kAnterior4h);
  const stochDEmoji = estocasticoD ? getStochasticEmoji(estocasticoD.k) : "";
  const stoch4hEmoji = estocastico4h ? getStochasticEmoji(estocastico4h.k) : "";
  const buyZonesText = zonas.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const sellZonesText = zonas.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpBuyZonesText = calculateVolumeProfile(ohlcv15m).buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpSellZonesText = calculateVolumeProfile(ohlcv15m).sellLiquidityZones.map(format).join(' / ') || 'N/A';
  let alertText = '';
  if (direction === 'buy' && lsr.value !== null && lsr.value < 1.7 && 
      aggressiveDelta.isSignificant && 
      aggressiveDelta.isBuyPressure && 
      estocasticoD?.k < 73 && 
      estocastico4h?.k < 73 && 
      rsi1h < 52 &&
      oi15m.isRising) {
    const foiAlertado = state.ultimoEMACruzamento[symbol].historico.some(r => 
      r.direcao === 'buy' && 
      (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🟢 *Analisar Compra #CrossEma34/89*\n\n` +
                  `🔹 Ativo: *${symbol}* [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço Atual: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 OI 15m: ${oiText}\n` +
                  `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Liquid. Compra: ${buyZonesText}\n` +
                  `   Liquid. Venda: ${sellZonesText}\n` +
                  `   POC Bull: ${vpBuyZonesText}\n` +
                  `   POC Bear: ${vpSellZonesText}\n` +
                  `☑︎  🤖 @J4Rviz`;
      state.ultimoEMACruzamento[symbol]['3m'] = agora;
      state.ultimoEMACruzamento[symbol].historico.push({ direcao: 'buy', timestamp: agora });
      state.ultimoEMACruzamento[symbol].historico = state.ultimoEMACruzamento[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.error(`Cruzamento EMA de alta detectado para ${symbol}: Preço=${format(price)}, EMA34=${format(ema34)}, EMA89=${format(ema89)}`);
    }
  } else if (direction === 'sell' && lsr.value !== null && lsr.value > 2.0 && 
      aggressiveDelta.isSignificant && 
      !aggressiveDelta.isBuyPressure && 
      estocastico4h?.k > 73 &&
      rsi1h > 50 &&
      !oi15m.isRising) {
    const foiAlertado = state.ultimoEMACruzamento[symbol].historico.some(r => 
      r.direcao === 'sell' && 
      (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🔴 *Analisar Correção #CrossEma34/89*\n\n` +
                  `🔹 Ativo: *${symbol}* [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço Atual: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 OI 15m: ${oiText}\n` +
                  `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Liquid. Compra: ${buyZonesText}\n` +
                  `   Liquid. Venda: ${sellZonesText}\n` +
                  `   POC Bull: ${vpBuyZonesText}\n` +
                  `   POC Bear: ${vpSellZonesText}\n` +
                  `☑︎  🤖 @J4Rviz`;
      state.ultimoEMACruzamento[symbol]['3m'] = agora;
      state.ultimoEMACruzamento[symbol].historico.push({ direcao: 'sell', timestamp: agora });
      state.ultimoEMACruzamento[symbol].historico = state.ultimoEMACruzamento[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.error(`Cruzamento EMA de baixa detectado para ${symbol}: Preço=${format(price)}, EMA34=${format(ema34)}, EMA89=${format(ema89)}`);
    }
  }
  if (alertText) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, alertText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      logger.error(`Alerta de cruzamento EMA enviado para ${symbol}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta de cruzamento EMA para ${symbol}: ${e.message}`);
    }
  }
}

async function sendAlert1h2h(symbol, data) {
  const { ohlcv15m, ohlcv3m, ohlcv1h, ohlcvDiario, ohlcv4h, price, wpr2h, wpr1h, rsi1h, atr, cvd, obv, lsr, fiValues, zonas, volumeProfile, orderBookLiquidity, isOIRising5m, estocasticoD, estocastico4h, fundingRate } = data;
  const agora = Date.now();
  if (state.ultimoAlertaPorAtivo[symbol]?.['1h_2h'] && agora - state.ultimoAlertaPorAtivo[symbol]['1h_2h'] < config.TEMPO_COOLDOWN_MS) return;
  const aggressiveDelta = await calculateAggressiveDelta(symbol);
  const fiBear3 = fiValues[fiValues.length - 1] < 0;
  const atrPercent = (atr / price) * 100;
  if (!state.wprTriggerState[symbol]) state.wprTriggerState[symbol] = { '1h_2h': { buyTriggered: false, sellTriggered: false } };
  if (wpr2h <= config.WPR_LOW_THRESHOLD && wpr1h <= config.WPR_LOW_THRESHOLD) {
    state.wprTriggerState[symbol]['1h_2h'].buyTriggered = true;
  } else if (wpr2h >= config.WPR_HIGH_THRESHOLD && wpr1h >= config.WPR_HIGH_THRESHOLD) {
    state.wprTriggerState[symbol]['1h_2h'].sellTriggered = true;
  }
  if (!state.ultimoEstocastico[symbol]) state.ultimoEstocastico[symbol] = {};
  const kAnteriorD = state.ultimoEstocastico[symbol].kD || estocasticoD?.k || 0;
  const kAnterior4h = state.ultimoEstocastico[symbol].k4h || estocastico4h?.k || 0;
  state.ultimoEstocastico[symbol].kD = estocasticoD?.k;
  state.ultimoEstocastico[symbol].k4h = estocastico4h?.k;
  const direcaoD = getSetaDirecao(estocasticoD?.k, kAnteriorD);
  const direcao4h = getSetaDirecao(estocastico4h?.k, kAnterior4h);
  const stochDEmoji = estocasticoD ? getStochasticEmoji(estocasticoD.k) : "";
  const stoch4hEmoji = estocastico4h ? getStochasticEmoji(estocastico4h.k) : "";
  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const entryLow = format(price - 0.3 * atr);
  const entryHigh = format(price + 0.5 * atr);
  const isSellSignal = state.wprTriggerState[symbol]['1h_2h'].sellTriggered && 
                      cvd < 0 && 
                      obv < 0 && 
                      rsi1h > 68 && 
                      !isOIRising5m && 
                      (lsr.value === null || lsr.value >= 2.5) && 
                      fiBear3 && 
                      atrPercent >= config.ATR_PERCENT_MIN && 
                      atrPercent <= config.ATR_PERCENT_MAX && 
                      aggressiveDelta.isSignificant && 
                      !aggressiveDelta.isBuyPressure;
  const targets = isSellSignal
    ? [2, 4, 6, 8].map(mult => format(price - mult * atr)).join(" / ")
    : [2, 4, 6, 8].map(mult => format(price + mult * atr)).join(" / ");
  const stop = isSellSignal ? format(price + 5.0 * atr) : format(price - 5.0 * atr);
  const buyZonesText = zonas.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const sellZonesText = zonas.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpBuyZonesText = volumeProfile.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpSellZonesText = volumeProfile.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  const obBuyZonesText = orderBookLiquidity.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const obSellZonesText = orderBookLiquidity.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  let lsrSymbol = '🔘Consol.';
  if (lsr.value !== null) {
    if (lsr.value <= 1.3) lsrSymbol = '✅Baixo';
    else if (lsr.value >= 3) lsrSymbol = '📛Alto';
  }
  const rsi1hEmoji = rsi1h > 60 ? "☑︎" : rsi1h < 40 ? "☑︎" : "";
  let fundingRateEmoji = '';
  if (fundingRate.current !== null) {
    if (fundingRate.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
    else if (fundingRate.current <= -0.001) fundingRateEmoji = '🟢🟢';
    else if (fundingRate.current <= -0.0005) fundingRateEmoji = '🟢';
    else if (fundingRate.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
    else if (fundingRate.current >= 0.0003) fundingRateEmoji = '🔴🔴';
    else if (fundingRate.current >= 0.0002) fundingRateEmoji = '🔴';
    else fundingRateEmoji = '🟢';
  }
  const fundingRateText = fundingRate.current !== null 
    ? `${fundingRateEmoji} ${(fundingRate.current * 100).toFixed(5)}%  ${fundingRate.isRising ? '⬆️' : '⬇️'}`
    : '🔹 Indisp.';
  const deltaText = aggressiveDelta.isSignificant 
    ? `${aggressiveDelta.isBuyPressure ? '💹F.Comprador' : '⭕F.Vendedor'} ${aggressiveDelta.deltaPercent > 60 && lsr.value !== null && lsr.value < 1 ? '💥' : ''}(${aggressiveDelta.deltaPercent}%)`
    : '🔘Neutro';
  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=15`;
  let alertText = `🔹Ativo: *${symbol}* [- TradingView](${tradingViewLink})\n` +
    `💲 Preço: ${format(price)}\n` +
    `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
    `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
    `🔹 Fund. R: ${fundingRateText}\n` +
    `🔸 Vol.Delta : ${deltaText}\n` +
    `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
    `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
    `🔹 Entr.: ${entryLow}...${entryHigh}\n` +
    `🎯 Tps: ${targets}\n` +
    `⛔ Stop: ${stop}\n` +
    `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
    `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
    `   Liquid. Compra: ${buyZonesText}\n` +
    `   Liquid. Venda: ${sellZonesText}\n` +
    `   POC Bull: ${vpBuyZonesText}\n` +
    `   POC Bear: ${vpSellZonesText}\n` +
    ` ☑︎ Gerencie seu Risco - @J4Rviz\n`;
  if (state.wprTriggerState[symbol]['1h_2h'].buyTriggered && 
      cvd > 0 && 
      obv > 0 && 
      (lsr.value === null || lsr.value < 1.4) && 
      fiValues[fiValues.length - 1] > 0 && 
      atrPercent >= config.ATR_PERCENT_MIN && 
      atrPercent <= config.ATR_PERCENT_MAX && 
      isOIRising5m && 
      aggressiveDelta.isSignificant && 
      aggressiveDelta.isBuyPressure) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `🟢*Possível Compra WPR *\n\n${alertText}`, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      if (!state.ultimoAlertaPorAtivo[symbol]) state.ultimoAlertaPorAtivo[symbol] = {};
      state.ultimoAlertaPorAtivo[symbol]['1h_2h'] = agora;
      state.wprTriggerState[symbol]['1h_2h'].buyTriggered = false;
      logger.error(`Alerta de compra WPR enviado para ${symbol}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta de compra para ${symbol}: ${e.message}`);
    }
  } else if (isSellSignal) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `🔴*Possível Correção WPR *\n\n${alertText}`, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      if (!state.ultimoAlertaPorAtivo[symbol]) state.ultimoAlertaPorAtivo[symbol] = {};
      state.ultimoAlertaPorAtivo[symbol]['1h_2h'] = agora;
      state.wprTriggerState[symbol]['1h_2h'].sellTriggered = false;
      logger.error(`Alerta de correção WPR enviado para ${symbol}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta de correção para ${symbol}: ${e.message}`);
    }
  }
}

async function checkConditions() {
  try {
    await limitConcurrency(config.PARES_MONITORADOS, async (symbol) => {
      const cacheKeyPrefix = `ohlcv_${symbol}`;
      const ohlcv3mRawFutures = getCachedData(`${cacheKeyPrefix}_3m`) || await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '3m', undefined, Math.max(config.FI_PERIOD + 2, config.EMA_89_PERIOD + 1)));
      const ohlcv15mRaw = getCachedData(`${cacheKeyPrefix}_15m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '15m', undefined, config.WPR_PERIOD + 1));
      const ohlcv1hRaw = getCachedData(`${cacheKeyPrefix}_1h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1h', undefined, config.WPR_PERIOD + 1));
      const ohlcv2hRaw = getCachedData(`${cacheKeyPrefix}_2h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '2h', undefined, config.WPR_PERIOD + 1));
      const ohlcv4hRaw = getCachedData(`${cacheKeyPrefix}_4h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20));
      const ohlcvDiarioRaw = getCachedData(`${cacheKeyPrefix}_1d`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 20));
      setCachedData(`${cacheKeyPrefix}_3m`, ohlcv3mRawFutures);
      setCachedData(`${cacheKeyPrefix}_15m`, ohlcv15mRaw);
      setCachedData(`${cacheKeyPrefix}_1h`, ohlcv1hRaw);
      setCachedData(`${cacheKeyPrefix}_2h`, ohlcv2hRaw);
      setCachedData(`${cacheKeyPrefix}_4h`, ohlcv4hRaw);
      setCachedData(`${cacheKeyPrefix}_1d`, ohlcvDiarioRaw);
      if (!ohlcv3mRawFutures || !ohlcv15mRaw || !ohlcv1hRaw || !ohlcv2hRaw || !ohlcv4hRaw || !ohlcvDiarioRaw) {
        logger.error(`Dados OHLCV insuficientes para ${symbol}, pulando...`);
        return;
      }
      const ohlcv3m = normalizeOHLCV(ohlcv3mRawFutures);
      const ohlcv15m = normalizeOHLCV(ohlcv15mRaw);
      const ohlcv1h = normalizeOHLCV(ohlcv1hRaw);
      const ohlcv2h = normalizeOHLCV(ohlcv2hRaw);
      const ohlcv4h = normalizeOHLCV(ohlcv4hRaw);
      const ohlcvDiario = normalizeOHLCV(ohlcvDiarioRaw);
      const closes3m = ohlcv3m.map(c => c.close).filter(c => !isNaN(c));
      const currentPrice = closes3m[closes3m.length - 1];
      if (isNaN(currentPrice)) {
        logger.error(`Preço atual inválido para ${symbol}, pulando...`);
        return;
      }
      const wpr2hValues = calculateWPR(ohlcv2h);
      const wpr1hValues = calculateWPR(ohlcv1h);
      const rsi1hValues = calculateRSI(ohlcv1h);
      const obvValues = calculateOBV(ohlcv3m);
      const cvd = calculateCVD(ohlcv3m);
      const lsr = await fetchLSR(symbol);
      const oi5m = await fetchOpenInterest(symbol, '5m');
      const oi15m = await fetchOpenInterest(symbol, '15m');
      const fundingRate = await fetchFundingRate(symbol);
      const atrValues = calculateATR(ohlcv15m);
      const fiValues = calculateForceIndex(ohlcv3m, config.FI_PERIOD);
      const zonas = detectarQuebraEstrutura(ohlcv15m);
      const volumeProfile = calculateVolumeProfile(ohlcv15m);
      const estocasticoD = calculateStochastic(ohlcvDiario, 5, 3, 3);
      const estocastico4h = calculateStochastic(ohlcv4h, 5, 3, 3);
      const ema34Values = calculateEMA(ohlcv3m, config.EMA_34_PERIOD);
      const ema89Values = calculateEMA(ohlcv3m, config.EMA_89_PERIOD);
      if (!wpr2hValues.length || !wpr1hValues.length || !rsi1hValues.length || !atrValues.length || !fiValues.length || !ema34Values.length || !ema89Values.length) {
        logger.error(`Indicadores insuficientes para ${symbol}, pulando...`);
        return;
      }
      const ema34Current = ema34Values[ema34Values.length - 1];
      const ema34Previous = ema34Values[ema34Values.length - 2] || ema34Current;
      const ema89Current = ema89Values[ema89Values.length - 1];
      const ema89Previous = ema89Values[ema89Values.length - 2] || ema89Current;
      const isBuyCross = ema34Previous <= ema89Previous && ema34Current > ema89Current;
      const isSellCross = ema34Previous >= ema89Previous && ema34Current < ema89Current;
      if (isBuyCross || isSellCross) {
        await sendAlertEMACruzamento3m(
          symbol, 
          currentPrice, 
          zonas, 
          ohlcv15m, 
          rsi1hValues[rsi1hValues.length - 1], 
          lsr, 
          fundingRate, 
          await calculateAggressiveDelta(symbol), 
          estocasticoD, 
          estocastico4h, 
          ema34Current, 
          ema89Current, 
          isBuyCross ? 'buy' : 'sell',
          oi15m
        );
      }
      await sendAlertRompimentoEstrutura15m(
        symbol, 
        currentPrice, 
        zonas, 
        ohlcv15m, 
        rsi1hValues[rsi1hValues.length - 1], 
        lsr, 
        fundingRate, 
        await calculateAggressiveDelta(symbol), 
        estocasticoD, 
        estocastico4h,
        oi15m
      );
      await sendAlert1h2h(symbol, {
        ohlcv15m, ohlcv3m, ohlcv1h, ohlcvDiario, ohlcv4h,
        price: currentPrice,
        wpr2h: wpr2hValues[wpr2hValues.length - 1],
        wpr1h: wpr1hValues[wpr1hValues.length - 1],
        rsi1h: rsi1hValues[rsi1hValues.length - 1],
        atr: atrValues[atrValues.length - 1],
        cvd, obv: obvValues[obvValues.length - 1], lsr, fiValues, zonas,
        volumeProfile, orderBookLiquidity: await fetchLiquidityZones(symbol),
        isOIRising5m: oi5m.isRising,
        estocasticoD, estocastico4h, fundingRate
      });
    }, 5);
  } catch (e) {
    logger.error(`Erro ao processar condições: ${e.message}`);
  }
}

async function startHeartbeat() {
  setInterval(async () => {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 💥Dica Operacional: Para 🟢Compra prefira moedas com Stoch 4h e Diário baixos, abaixo de 40, em conjunto com LSR abaixo de 1.7 e verifique o Volume Delta uma importante informação de dados reais do livro comprador do ativo, 💹Positivo acima de 30% a 50%  é o ideal. 💥Dica de Venda: para a 🔴Venda observar o Stoch 4h e Diário altos acima de 80 a 95, LSR Alto acima de 3, com Volume Delta ⭕Negativo -30% a -50%, que significa ausênsia de conpradores ...Observe também o 📍Funding Rate, para 🟢Compra com círculo verde, e valor do Funding rate negativo,  Ja para 🔴Venda com círculo vermelho, valor do Funding rate positivo, 💹 seus trades serão mais lucrativos... ☑︎ Gerencie seu Risco - @J4Rviz'));
    } catch (e) {
      logger.error(`Erro no heartbeat: ${e.message}`);
    }
  }, config.HEARTBEAT_INTERVAL_MS);
}

async function main() {
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Titanium Optimus Prime-💹Start...'));
    startHeartbeat();
    await checkConditions();
    setInterval(checkConditions, config.INTERVALO_ALERTA_3M_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));
