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
  INTERVALO_ALERTA_MS: 15 * 60 * 1000, // 15 minutos
  RSI_PERIOD: 14,
  ATR_PERIOD: 14, // Período para cálculo do ATR
  CACHE_TTL: 5 * 60 * 1000, // 5 minutos
  MAX_CACHE_SIZE: 100,
  LIMIT_TRADES_DELTA: 100, // Limite de trades para Volume Delta
  MIN_VOLUME_USDT: 1000000, // Volume mínimo em USDT para filtro de liquidez
  MIN_OPEN_INTEREST: 500000, // Open Interest mínimo em USDT
  VOLUME_SPIKE_THRESHOLD: 2, // 200% de aumento no volume
  FUNDING_RATE_CHANGE_THRESHOLD: 0.005 // Mudança de 0.5% no funding rate
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'monitor.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  dataCache: new Map(),
  lastFundingRates: new Map() // Cache para rastrear funding rates anteriores
};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Missing environment variable: ${key}`);
      process.exit(1);
    }
  }
}
validateEnv();

// Inicialização do Telegram e Exchange
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
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
        logger.warn(`Falha após ${retries} tentativas: ${e.message}`);
        throw e;
      }
      const delay = Math.pow(2, attempt - 1) * delayBase;
      logger.info(`Tentativa ${attempt} falhou, retry após ${delay}ms: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function getCachedData(key) {
  const cacheEntry = state.dataCache.get(key);
  if (cacheEntry && Date.now() - cacheEntry.timestamp < config.CACHE_TTL) {
    logger.info(`Usando cache para ${key}`);
    return cacheEntry.data;
  }
  state.dataCache.delete(key);
  return null;
}

function setCachedData(key, data) {
  if (state.dataCache.size >= config.MAX_CACHE_SIZE) {
    const oldestKey = state.dataCache.keys().next().value;
    state.dataCache.delete(oldestKey);
    logger.info(`Cache cheio, removido item mais antigo: ${oldestKey}`);
  }
  state.dataCache.set(key, { timestamp: Date.now(), data });
}

// Limpeza periódica do cache
function clearOldCache() {
  const now = Date.now();
  for (const [key, entry] of state.dataCache) {
    if (now - entry.timestamp > config.CACHE_TTL) {
      state.dataCache.delete(key);
      logger.info(`Cache removido: ${key}`);
    }
  }
}
setInterval(clearOldCache, 60 * 60 * 1000); // Limpa a cada hora

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
  if (!data || !Array.isArray(data)) return [];
  return data.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  })).filter(c => !isNaN(c.close) && !isNaN(c.volume));
}

function calculateRSI(data) {
  if (!data || data.length < config.RSI_PERIOD + 1) {
    logger.warn(`Dados insuficientes para calcular RSI: ${data?.length || 0} velas disponíveis`);
    return null;
  }
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: data.map(d => d.close || d[4])
  });
  return rsi.length ? parseFloat(rsi[rsi.length - 1].toFixed(2)) : null;
}

function calculateATR(data) {
  if (!data || data.length < config.ATR_PERIOD + 1) {
    logger.warn(`Dados insuficientes para calcular ATR: ${data?.length || 0} velas disponíveis`);
    return null;
  }
  const atr = TechnicalIndicators.ATR.calculate({
    period: config.ATR_PERIOD,
    high: data.map(d => d.high || d[2]),
    low: data.map(d => d.low || d[3]),
    close: data.map(d => d.close || d[4])
  });
  return atr.length ? parseFloat(atr[atr.length - 1].toFixed(8)) : null;
}

function calculateStochastic(data) {
  if (!data || data.length < 5 + 3) { // 5 para %K, +3 para suavização
    logger.warn(`Dados insuficientes para calcular Estocástico: ${data?.length || 0} velas disponíveis`);
    return { k: null, d: null, previousK: null };
  }
  const stochastic = TechnicalIndicators.Stochastic.calculate({
    period: 5,
    signalPeriod: 3,
    high: data.map(d => d.high || d[2]),
    low: data.map(d => d.low || d[3]),
    close: data.map(d => d.close || d[4])
  });
  if (stochastic.length < 2) {
    logger.warn(`Resultados insuficientes para Estocástico: ${stochastic.length} períodos calculados`);
    return { k: null, d: null, previousK: null };
  }
  return {
    k: parseFloat(stochastic[stochastic.length - 1].k.toFixed(2)),
    d: parseFloat(stochastic[stochastic.length - 1].d.toFixed(2)),
    previousK: parseFloat(stochastic[stochastic.length - 2].k.toFixed(2))
  };
}

async function fetchLSR(symbol) {
  const cacheKey = `lsr_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const res = await withRetry(() => axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
      params: { symbol: symbol.replace('/', ''), period: '15m', limit: 1 }
    }));
    if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
      logger.warn(`Dados insuficientes de LSR para ${symbol}`);
      return { value: null };
    }
    const longShortRatio = res.data[0].longShortRatio;
    if (typeof longShortRatio !== 'string' && typeof longShortRatio !== 'number') {
      logger.warn(`Formato inválido de longShortRatio para ${symbol}: ${longShortRatio}`);
      return { value: null };
    }
    const value = parseFloat(longShortRatio);
    if (isNaN(value)) {
      logger.warn(`longShortRatio inválido para ${symbol}: ${longShortRatio}`);
      return { value: null };
    }
    const result = { value: parseFloat(value.toFixed(2)) };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar LSR para ${symbol}: ${e.message}`);
    return { value: null };
  }
}

async function fetchFundingRate(symbol) {
  const cacheKey = `funding_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const fundingData = await withRetry(() => exchangeFutures.fetchFundingRate(symbol));
    const result = { current: parseFloat((fundingData.fundingRate * 100).toFixed(5)) };
    setCachedData(cacheKey, result);
    state.lastFundingRates.set(symbol, result.current); // Armazena para monitoramento de anomalias
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar Funding Rate para ${symbol}: ${e.message}`);
    return { current: null };
  }
}

async function fetchOpenInterest(symbol, timeframe) {
  const cacheKey = `oi_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const oiData = await withRetry(() => exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 6));
    if (!oiData || oiData.length < 3) {
      logger.warn(`Dados insuficientes de Open Interest para ${symbol} no timeframe ${timeframe}: ${oiData?.length || 0} registros`);
      return { isRising: false, value: null };
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
      logger.warn(`Registros válidos insuficientes para ${symbol} no timeframe ${timeframe}: ${validOiData.length}`);
      return { isRising: false, value: null };
    }
    const recentOi = validOiData.slice(0, 3).map(d => d.openInterest);
    const previousOi = validOiData.slice(3, 6).map(d => d.openInterest);
    const smaRecent = recentOi.reduce((sum, val) => sum + val, 0) / recentOi.length;
    const smaPrevious = previousOi.length >= 3 ? previousOi.reduce((sum, val) => sum + val, 0) / previousOi.length : recentOi[recentOi.length - 1];
    const result = { 
      isRising: smaRecent > smaPrevious,
      value: parseFloat(smaRecent.toFixed(2))
    };
    setCachedData(cacheKey, result);
    logger.info(`Open Interest calculado para ${symbol} no timeframe ${timeframe}: smaRecent=${smaRecent}, smaPrevious=${smaPrevious}, isRising=${result.isRising}`);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar Open Interest para ${symbol} no timeframe ${timeframe}: ${e.message}`);
    return { isRising: false, value: null };
  }
}

async function calculateAggressiveDelta(symbol) {
  const cacheKey = `delta_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const trades = await withRetry(() => exchangeFutures.fetchTrades(symbol, undefined, config.LIMIT_TRADES_DELTA));
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
    const deltaPercent = totalVolume !== 0 ? parseFloat((delta / totalVolume * 100).toFixed(2)) : 0;
    const result = { deltaPercent, isBuyPressure: delta > 0 };
    setCachedData(cacheKey, result);
    logger.info(`Delta Agressivo para ${symbol}: Buy=${buyVolume}, Sell=${sellVolume}, Delta%=${deltaPercent}%`);
    return result;
  } catch (e) {
    logger.error(`Erro ao calcular Delta Agressivo para ${symbol}: ${e.message}`);
    return { deltaPercent: 0, isBuyPressure: false };
  }
}

async function detectVolumeSpike(symbol, timeframe = '15m') {
  try {
    const ohlcv = await withRetry(() => exchangeFutures.fetchOHLCV(symbol, timeframe, undefined, 3));
    const volumes = normalizeOHLCV(ohlcv).map(d => d.volume);
    if (volumes.length < 2) return false;
    const spike = volumes[volumes.length - 1] / volumes[volumes.length - 2] > config.VOLUME_SPIKE_THRESHOLD;
    if (spike) {
      logger.info(`Pico de volume detectado em ${symbol}: ${volumes[volumes.length - 1]} vs ${volumes[volumes.length - 2]}`);
      return true;
    }
    return false;
  } catch (e) {
    logger.warn(`Erro ao detectar pico de volume para ${symbol}: ${e.message}`);
    return false;
  }
}

async function detectFundingRateChange(symbol, currentFundingRate) {
  const lastFundingRate = state.lastFundingRates.get(symbol) || currentFundingRate;
  const change = Math.abs(currentFundingRate - lastFundingRate);
  const isSignificantChange = change >= config.FUNDING_RATE_CHANGE_THRESHOLD;
  if (isSignificantChange) {
    logger.info(`Mudança significativa no Funding Rate para ${symbol}: ${lastFundingRate}% -> ${currentFundingRate}%`);
  }
  return isSignificantChange;
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

// ================= GERENCIAMENTO DE RISCO ================= //
function calculateRiskReward(coin, isBuy) {
  if (coin.atr === null || coin.atr === 'N/A') return 'N/A';
  const entry = coin.price;
  const atrMultiplierStop = 2; // Stop-loss em 2x ATR
  const atrMultiplierTarget = 3; // Take-profit em 3x ATR (Alvo 2)
  const stop = isBuy ? entry - atrMultiplierStop * coin.atr : entry + atrMultiplierStop * coin.atr;
  const target = isBuy ? entry + atrMultiplierTarget * coin.atr : entry - atrMultiplierTarget * coin.atr;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return reward / risk > 0 ? (reward / risk).toFixed(2) : 'N/A';
}

// ================= ALERTAS ================= //
async function sendMonitorAlert(coins) {
  const topLow = coins
    .filter(c => c.lsr !== null && c.rsi !== null)
    .sort((a, b) => (a.lsr + a.rsi) - (b.lsr + b.rsi))
    .slice(0, 20);
  const topHigh = coins
    .filter(c => c.lsr !== null && c.rsi !== null)
    .sort((a, b) => (b.lsr + b.rsi) - (a.lsr + b.rsi))
    .slice(0, 20);

  // Identificar moedas com Volume Delta mais positivo/negativo
  const topPositiveDelta = topLow
    .filter(c => c.delta.isBuyPressure)
    .sort((a, b) => b.delta.deltaPercent - a.delta.deltaPercent)
    .slice(0, 10)
    .map(c => c.symbol);
  const topNegativeDelta = topHigh
    .filter(c => !c.delta.isBuyPressure)
    .sort((a, b) => a.delta.deltaPercent - b.delta.deltaPercent)
    .slice(0, 10)
    .map(c => c.symbol);

  const format = (v, precision = 2) => isNaN(v) || v === null ? 'N/A' : v.toFixed(precision);
  const formatPrice = (price) => price < 1 ? price.toFixed(8) : price < 10 ? price.toFixed(6) : price < 100 ? price.toFixed(4) : price.toFixed(2);

  // Filtrar moedas com estrela (⭐)
  const starCoins = topLow.filter(coin => 
    topPositiveDelta.includes(coin.symbol) && 
    coin.delta.isBuyPressure && 
    coin.oi5m.isRising && 
    coin.oi15m.isRising && 
    coin.funding.current < 0 &&
    coin.lsr <= 2.5 &&
    coin.rsi1h !== null && coin.rsi1h < 60 &&
    coin.volume >= config.MIN_VOLUME_USDT &&
    coin.oi15m.value >= config.MIN_OPEN_INTEREST
  );

  // Filtrar moedas com caveira (💀)
  const skullCoins = topHigh.filter(coin => 
    topNegativeDelta.includes(coin.symbol) && 
    !coin.delta.isBuyPressure && 
    !coin.oi5m.isRising && 
    !coin.oi15m.isRising && 
    coin.funding.current > 0 &&
    coin.lsr >= 2.8 &&
    coin.rsi1h !== null && coin.rsi1h > 60 &&
    coin.volume >= config.MIN_VOLUME_USDT &&
    coin.oi15m.value >= config.MIN_OPEN_INTEREST
  );

  // Alerta para moedas com estrela
  if (starCoins.length > 0) {
    let starAlertText = `🟢*Possível Compra(Radar) *\n\n`;
    starAlertText += await Promise.all(starCoins.map(async (coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      const deltaText = coin.delta.isBuyPressure ? `💹${format(coin.delta.deltaPercent)}%` : `⭕${format(coin.delta.deltaPercent)}%`;
      let lsrSymbol = '';
      if (coin.lsr !== null) {
        if (coin.lsr <= 1.8) lsrSymbol = '✅Baixo';
        else if (coin.lsr >= 2.8) lsrSymbol = '📛Alto';
      }
      let fundingRateEmoji = '';
      if (coin.funding.current !== null) {
        if (coin.funding.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
        else if (coin.funding.current <= -0.001) fundingRateEmoji = '🟢🟢';
        else if (coin.funding.current <= -0.0005) fundingRateEmoji = '🟢';
        else if (coin.funding.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
        else if (coin.funding.current >= 0.0003) fundingRateEmoji = '🔴🔴';
        else if (coin.funding.current >= 0.0002) fundingRateEmoji = '🔴';
        else fundingRateEmoji = '🟢';
      }
      const oi5mText = coin.oi5m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const oi15mText = coin.oi15m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const atr = coin.atr !== null ? coin.atr : 'N/A';
      const target1 = atr !== 'N/A' ? formatPrice(coin.price + 1.5 * atr) : 'N/A';
      const target2 = atr !== 'N/A' ? formatPrice(coin.price + 3 * atr) : 'N/A';
      const target3 = atr !== 'N/A' ? formatPrice(coin.price + 5 * atr) : 'N/A';
      const target4 = atr !== 'N/A' ? formatPrice(coin.price + 7 * atr) : 'N/A';
      const stopLoss = atr !== 'N/A' ? formatPrice(coin.price - 2 * atr) : 'N/A';
      const riskReward = calculateRiskReward(coin, true);
      const isVolumeSpike = await detectVolumeSpike(coin.symbol);
      const isFundingAnomaly = await detectFundingRateChange(coin.symbol, coin.funding.current);
      const anomalyText = isVolumeSpike || isFundingAnomaly ? `🚨 Anomalia: ${isVolumeSpike ? 'Pico de Volume' : ''}${isVolumeSpike && isFundingAnomaly ? ' | ' : ''}${isFundingAnomaly ? 'Mudança no Funding Rate' : ''}\n` : '';
      const stoch4hK = coin.stoch4h.k !== null ? format(coin.stoch4h.k) : 'N/A';
      const stoch4hD = coin.stoch4h.d !== null ? format(coin.stoch4h.d) : 'N/A';
      const stoch4hKEmoji = getStochasticEmoji(coin.stoch4h.k);
      const stoch4hDEmoji = getStochasticEmoji(coin.stoch4h.d);
      const stoch4hDir = getSetaDirecao(coin.stoch4h.k, coin.stoch4h.previousK);
      const stoch1dK = coin.stoch1d.k !== null ? format(coin.stoch1d.k) : 'N/A';
      const stoch1dD = coin.stoch1d.d !== null ? format(coin.stoch1d.d) : 'N/A';
      const stoch1dKEmoji = getStochasticEmoji(coin.stoch1d.k);
      const stoch1dDEmoji = getStochasticEmoji(coin.stoch1d.d);
      const stoch1dDir = getSetaDirecao(coin.stoch1d.k, coin.stoch1d.previousK);
      return `${i + 1}. 🔹 *${coin.symbol}* [- TradingView](${tradingViewLink})\n` +
             `   💲 Preço: ${formatPrice(coin.price)}\n` +
             `     LSR: ${format(coin.lsr)} ${lsrSymbol}\n` +
             `     RSI (15m): ${format(coin.rsi)}\n` +
             `     RSI (1h): ${format(coin.rsi1h)}\n` +
             `     Stoch (4h): %K ${stoch4hK}${stoch4hKEmoji} ${stoch4hDir} | %D ${stoch4hD}${stoch4hDEmoji}\n` +
             `     Stoch (1d): %K ${stoch1dK}${stoch1dKEmoji} ${stoch1dDir} | %D ${stoch1dD}${stoch1dDEmoji}\n` +
             `     Vol.Delta: ${deltaText}\n` +
             `     Fund.Rate: ${fundingRateEmoji}${format(coin.funding.current, 5)}%\n` +
             `     OI 5m: ${oi5mText}\n` +
             `     OI 15m: ${oi15mText}\n` +
             `     Alvo 1: ${target1}\n` +
             `     Alvo 2: ${target2} (R:R = ${riskReward})\n` +
             `     Alvo 3: ${target3}\n` +
             `     Alvo 4: ${target4}\n` +
             `   ⛔Stop: ${stopLoss}\n` +
             anomalyText;
    })).then(results => results.join('\n'));
    starAlertText += `\n☑︎ 🤖 Monitor Titanium Optmus Prime`;

    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, starAlertText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }));
    logger.info('Alerta de moedas com estrela enviado com sucesso');
  }

  // Alerta para moedas com caveira
  if (skullCoins.length > 0) {
    let skullAlertText = `🔴*Possível Correção (Radar) *\n\n`;
    skullAlertText += await Promise.all(skullCoins.map(async (coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      const deltaText = coin.delta.isBuyPressure ? `💹${format(coin.delta.deltaPercent)}%` : `⭕${format(coin.delta.deltaPercent)}%`;
      let lsrSymbol = '';
      if (coin.lsr !== null) {
        if (coin.lsr <= 1.8) lsrSymbol = '✅Baixo';
        else if (coin.lsr >= 2.8) lsrSymbol = '📛Alto';
      }
      let fundingRateEmoji = '';
      if (coin.funding.current !== null) {
        if (coin.funding.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
        else if (coin.funding.current <= -0.001) fundingRateEmoji = '🟢🟢';
        else if (coin.funding.current <= -0.0005) fundingRateEmoji = '🟢';
        else if (coin.funding.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
        else if (coin.funding.current >= 0.0003) fundingRateEmoji = '🔴🔴';
        else if (coin.funding.current >= 0.0002) fundingRateEmoji = '🔴';
        else fundingRateEmoji = '🟢';
      }
      const oi5mText = coin.oi5m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const oi15mText = coin.oi15m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const atr = coin.atr !== null ? coin.atr : 'N/A';
      const target1 = atr !== 'N/A' ? formatPrice(coin.price - 1.5 * atr) : 'N/A';
      const target2 = atr !== 'N/A' ? formatPrice(coin.price - 3 * atr) : 'N/A';
      const target3 = atr !== 'N/A' ? formatPrice(coin.price - 5 * atr) : 'N/A';
      const target4 = atr !== 'N/A' ? formatPrice(coin.price - 7 * atr) : 'N/A';
      const stopLoss = atr !== 'N/A' ? formatPrice(coin.price + 2 * atr) : 'N/A';
      const riskReward = calculateRiskReward(coin, false);
      const isVolumeSpike = await detectVolumeSpike(coin.symbol);
      const isFundingAnomaly = await detectFundingRateChange(coin.symbol, coin.funding.current);
      const anomalyText = isVolumeSpike || isFundingAnomaly ? `🚨 Anomalia: ${isVolumeSpike ? 'Pico de Volume' : ''}${isVolumeSpike && isFundingAnomaly ? ' | ' : ''}${isFundingAnomaly ? 'Mudança no Funding Rate' : ''}\n` : '';
      const stoch4hK = coin.stoch4h.k !== null ? format(coin.stoch4h.k) : 'N/A';
      const stoch4hD = coin.stoch4h.d !== null ? format(coin.stoch4h.d) : 'N/A';
      const stoch4hKEmoji = getStochasticEmoji(coin.stoch4h.k);
      const stoch4hDEmoji = getStochasticEmoji(coin.stoch4h.d);
      const stoch4hDir = getSetaDirecao(coin.stoch4h.k, coin.stoch4h.previousK);
      const stoch1dK = coin.stoch1d.k !== null ? format(coin.stoch1d.k) : 'N/A';
      const stoch1dD = coin.stoch1d.d !== null ? format(coin.stoch1d.d) : 'N/A';
      const stoch1dKEmoji = getStochasticEmoji(coin.stoch1d.k);
      const stoch1dDEmoji = getStochasticEmoji(coin.stoch1d.d);
      const stoch1dDir = getSetaDirecao(coin.stoch1d.k, coin.stoch1d.previousK);
      return `${i + 1}. 🔻 *${coin.symbol}* [- TradingView](${tradingViewLink})\n` +
             `   💲 Preço: ${formatPrice(coin.price)}\n` +
             `     LSR: ${format(coin.lsr)} ${lsrSymbol}\n` +
             `     RSI (15m): ${format(coin.rsi)}\n` +
             `     RSI (1h): ${format(coin.rsi1h)}\n` +
             `     Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
             `     Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
             `     Vol.Delta: ${deltaText}\n` +
             `     Fund.Rate: ${fundingRateEmoji}${format(coin.funding.current, 5)}%\n` +
             `     OI 5m: ${oi5mText}\n` +
             `     OI 15m: ${oi15mText}\n` +
             `     Alvo 1: ${target1}\n` +
             `     Alvo 2: ${target2} (R:R = ${riskReward})\n` +
             `     Alvo 3: ${target3}\n` +
             `     Alvo 4: ${target4}\n` +
             `   ⛔Stop: ${stopLoss}\n` +
             anomalyText;
    })).then(results => results.join('\n'));
    skullAlertText += `\n☑︎ 🤖 Gerencie seu risco @J4Rviz`;

    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, skullAlertText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }));
    logger.info('Alerta de moedas com caveira enviado com sucesso');
  }

  // Alerta de anomalias
  const anomalyCoins = coins.filter(coin => coin.anomalyDetected);
  if (anomalyCoins.length > 0) {
    let anomalyAlertText = `🚨 *Alerta* 🚨\n\n`;
    anomalyAlertText += anomalyCoins.map((coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      const anomalyText = coin.volumeSpike || coin.fundingAnomaly ? `🚨Volume: ${coin.volumeSpike ? 'Pico de Volume' : ''}${coin.volumeSpike && coin.fundingAnomaly ? ' | ' : ''}${coin.fundingAnomaly ? 'Mudança no Funding Rate' : ''}` : '';
      return `${i + 1}. *${coin.symbol}* [- TradingView](${tradingViewLink})\n` +
             `   ${anomalyText}\n` +
             `   💲 Preço: ${formatPrice(coin.price)}\n`;
    }).join('\n');
    anomalyAlertText += `\n☑︎ 🤖 Titanium By @J4Rviz`;

    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, anomalyAlertText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }));
    logger.info('Alerta de anomalias enviado com sucesso');
  }

  if (starCoins.length === 0 && skullCoins.length === 0 && anomalyCoins.length === 0) {
    logger.info('Nenhuma moeda válida para alertas (estrela, caveira ou anomalia), nenhum alerta enviado.');
  } else {
    logger.info('Alertas de monitoramento processados com sucesso');
  }
}

// ================= LÓGICA PRINCIPAL ================= //
async function checkCoins() {
  try {
    const markets = await withRetry(() => exchangeFutures.loadMarkets());
    const usdtPairs = Object.keys(markets)
      .filter(symbol => symbol.endsWith('/USDT') && markets[symbol].active)
      .slice(0, 100); // Limita a 100 pares para evitar sobrecarga

    const coinsData = await limitConcurrency(usdtPairs, async (symbol) => {
      try {
        // Obter preço atual e volume
        const ticker = await withRetry(() => exchangeFutures.fetchTicker(symbol));
        const price = ticker?.last || null;
        const volume = ticker?.baseVolume * price || 0; // Volume em USDT
        if (!price) {
          logger.warn(`Preço inválido para ${symbol}, pulando...`);
          return null;
        }

        // Obter OHLCV para RSI (15m) e ATR
        const ohlcv15mRaw = getCachedData(`ohlcv_${symbol}_15m`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '15m', undefined, Math.max(config.RSI_PERIOD, config.ATR_PERIOD) + 1));
        setCachedData(`ohlcv_${symbol}_15m`, ohlcv15mRaw);
        const ohlcv15m = normalizeOHLCV(ohlcv15mRaw);
        if (!ohlcv15m.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (15m), pulando...`);
          return null;
        }

        // Obter OHLCV para RSI (1h)
        const ohlcv1hRaw = getCachedData(`ohlcv_${symbol}_1h`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1h', undefined, config.RSI_PERIOD + 1));
        setCachedData(`ohlcv_${symbol}_1h`, ohlcv1hRaw);
        const ohlcv1h = normalizeOHLCV(ohlcv1hRaw);
        if (!ohlcv1h.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (1h), pulando...`);
          return null;
        }

        // Obter OHLCV para Estocástico (4h)
        const ohlcv4hRaw = getCachedData(`ohlcv_${symbol}_4h`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '4h', undefined, 8)); // 5 + 3 para Stoch 5.3.3
        setCachedData(`ohlcv_${symbol}_4h`, ohlcv4hRaw);
        const ohlcv4h = normalizeOHLCV(ohlcv4hRaw);
        if (!ohlcv4h.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (4h), pulando...`);
          return null;
        }

        // Obter OHLCV para Estocástico (1d)
        const ohlcv1dRaw = getCachedData(`ohlcv_${symbol}_1d`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1d', undefined, 8)); // 5 + 3 para Stoch 5.3.3
        setCachedData(`ohlcv_${symbol}_1d`, ohlcv1dRaw);
        const ohlcv1d = normalizeOHLCV(ohlcv1dRaw);
        if (!ohlcv1d.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (1d), pulando...`);
          return null;
        }

        // Calcular indicadores
        const rsi = calculateRSI(ohlcv15m);
        const rsi1h = calculateRSI(ohlcv1h);
        const atr = calculateATR(ohlcv15m);
        const lsr = (await fetchLSR(symbol)).value;
        const funding = await fetchFundingRate(symbol);
        const delta = await calculateAggressiveDelta(symbol);
        const oi5m = await fetchOpenInterest(symbol, '5m');
        const oi15m = await fetchOpenInterest(symbol, '15m');
        const stoch4h = calculateStochastic(ohlcv4h);
        const stoch1d = calculateStochastic(ohlcv1d);

        // Detectar anomalias
        const volumeSpike = await detectVolumeSpike(symbol);
        const fundingAnomaly = await detectFundingRateChange(symbol, funding.current);
        const anomalyDetected = volumeSpike || fundingAnomaly;

        // Filtro de liquidez
        if (volume < config.MIN_VOLUME_USDT || oi15m.value < config.MIN_OPEN_INTEREST) {
          logger.info(`Par ${symbol} filtrado por baixa liquidez: Volume=${volume}, OI=${oi15m.value}`);
          return null;
        }

        return { symbol, price, rsi, rsi1h, atr, lsr, funding, delta, oi5m, oi15m, volume, volumeSpike, fundingAnomaly, anomalyDetected, stoch4h, stoch1d };
      } catch (e) {
        logger.warn(`Erro ao processar ${symbol}: ${e.message}`);
        return null;
      }
    }, 5);

    const validCoins = coinsData.filter(coin => coin !== null);
    if (validCoins.length > 0) {
      await sendMonitorAlert(validCoins);
    } else {
      logger.warn('Nenhuma moeda válida processada, nenhum alerta enviado.');
    }
  } catch (e) {
    logger.error(`Erro ao processar moedas: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando monitor de moedas');
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Titanium ...!'));
    await checkCoins();
    setInterval(checkCoins, config.INTERVALO_ALERTA_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar monitor: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));
