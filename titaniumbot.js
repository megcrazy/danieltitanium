require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');
const axios = require('axios');

// ================= CONFIGURAÇÃO ================= //
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PARES_MONITORADOS = (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT,NOTUSDT,QNTUSDT,FETUSDT").split(",");
const INTERVALO_ALERTA_3M_MS = 300000; // 3 minutos
const TEMPO_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutos por ativo
const WPR_PERIOD = 26;
const WPR_LOW_THRESHOLD = -99;
const WPR_HIGH_THRESHOLD = -1;
const ATR_PERIOD = 14;
const FI_PERIOD = 13;
const ATR_PERCENT_MIN = 0.5; // 0.5%
const ATR_PERCENT_MAX = 3.0; // 3%

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'combined_trading_bot.log' }),
    new winston.transports.Console()
  ]
});

// Estado
const ultimoAlertaPorAtivo = {};
const ultimoEstocastico = {};
const wprTriggerState = {}; // Memoriza estados do WPR para cada ativo

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
const bot = new Bot(TELEGRAM_BOT_TOKEN);
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

// ================= FUNÇÕES DE INDICADORES ================= //
function calculateWPR(data) {
  if (!data || data.length < WPR_PERIOD + 1) return [];
  return TechnicalIndicators.WilliamsR.calculate({
    period: WPR_PERIOD,
    high: data.map(d => d.high || d[2]),
    low: data.map(d => d.low || d[3]),
    close: data.map(d => d.close || d[4])
  });
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
    if (currClose > currOpen) cvd += volume;
    else if (currClose < currOpen) cvd -= volume;
  }
  return cvd;
}

function calculateATR(data) {
  return TechnicalIndicators.ATR.calculate({
    period: ATR_PERIOD,
    high: data.map(c => c.high || c[2]),
    low: data.map(c => c.low || c[3]),
    close: data.map(c => c.close || c[4])
  });
}

function calculateForceIndex(data, period = FI_PERIOD) {
  if (!data || data.length < 2) return null;
  const fiValues = [];
  for (let i = 1; i < data.length; i++) {
    const closeCurrent = data[i].close || data[i][4];
    const closePrevious = data[i - 1].close || data[i - 1][4];
    const volume = data[i].volume || data[i][5];
    if (closeCurrent == null || closePrevious == null || volume == null) continue;
    const fi = (closeCurrent - closePrevious) * volume;
    fiValues.push(fi);
  }
  if (fiValues.length < period) return null;
  const fiEma = TechnicalIndicators.EMA.calculate({ period, values: fiValues });
  return fiEma;
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
  if (!result || result.length === 0) return null;
  const lastResult = result[result.length - 1];
  return { k: parseFloat(lastResult.k.toFixed(2)), d: parseFloat(lastResult.d.toFixed(2)) };
}

function detectarQuebraEstrutura(ohlcv) {
  if (!ohlcv || ohlcv.length < 2) return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  const highs = ohlcv.map(c => c.high || c[2]).filter(h => !isNaN(h));
  const lows = ohlcv.map(c => c.low || c[3]).filter(l => !isNaN(l));
  const volumes = ohlcv.map(c => c.volume || c[5]).filter(v => !isNaN(v));
  if (highs.length === 0 || lows.length === 0 || volumes.length === 0) {
    return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const volumeThreshold = Math.max(...volumes) * 0.7;
  const buyLiquidityZones = [];
  const sellLiquidityZones = [];
  ohlcv.forEach(candle => {
    const high = candle.high || candle[2];
    const low = candle.low || candle[3];
    const volume = candle.volume || candle[5];
    if (volume >= volumeThreshold && !isNaN(low) && !isNaN(high)) {
      if (low <= minLow * 1.01) buyLiquidityZones.push(low);
      if (high >= maxHigh * 0.99) sellLiquidityZones.push(high);
    }
  });
  const uniqueBuyZones = [...new Set(buyLiquidityZones.filter(z => !isNaN(z)).sort((a, b) => b - a))].slice(0, 3); // Alterado para 3 zonas
  const uniqueSellZones = [...new Set(sellLiquidityZones.filter(z => !isNaN(z)).sort((a, b) => a - b))].slice(0, 3); // Alterado para 3 zonas
  return {
    estruturaAlta: isNaN(maxHigh) ? 0 : maxHigh,
    estruturaBaixa: isNaN(minLow) ? 0 : minLow,
    buyLiquidityZones: uniqueBuyZones.length > 0 ? uniqueBuyZones : [minLow].filter(z => !isNaN(z)),
    sellLiquidityZones: uniqueSellZones.length > 0 ? uniqueSellZones : [maxHigh].filter(z => !isNaN(z))
  };
}

async function fetchLSR(symbol) {
  try {
    const res = await axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
      params: { symbol: symbol.replace('/', ''), period: '15m', limit: 2 }
    });
    if (!res.data || res.data.length < 2) {
      logger.warn(`Dados insuficientes de LSR para ${symbol}: ${res.data?.length || 0} registros`);
      return { value: null, isRising: false, percentChange: '0.00' };
    }
    const currentLSR = parseFloat(res.data[0].longShortRatio);
    const previousLSR = parseFloat(res.data[1].longShortRatio);
    const percentChange = previousLSR !== 0 ? ((currentLSR - previousLSR) / previousLSR * 100).toFixed(2) : '0.00';
    return { value: currentLSR, isRising: currentLSR > previousLSR, percentChange };
  } catch (e) {
    logger.warn(`Erro ao buscar LSR para ${symbol}: ${e.message}`);
    return { value: null, isRising: false, percentChange: '0.00' };
  }
}

async function fetchOpenInterest(symbol, timeframe, retries = 2) {
  try {
    const oiData = await exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 15);
    logger.info(`Open Interest raw data para ${symbol} no timeframe ${timeframe}: ${JSON.stringify(oiData)}`);
    if (!oiData || oiData.length < 2) {
      logger.warn(`Dados insuficientes de Open Interest para ${symbol} no timeframe ${timeframe}: ${oiData?.length || 0} registros`);
      if (retries > 0) {
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const validOiData = oiData
      .filter(d => {
        const oiValue = d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest);
        const isValid = typeof oiValue === 'number' && !isNaN(oiValue) && oiValue >= 0;
        if (!isValid) {
          logger.warn(`Registro inválido para ${symbol} no timeframe ${timeframe}: openInterest=${d.openInterest}, openInterestAmount=${d.openInterestAmount}, sumOpenInterest=${d.info?.sumOpenInterest}, fullRecord=${JSON.stringify(d)}`);
        }
        return isValid;
      })
      .map(d => ({
        ...d,
        openInterest: d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest)
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 2);
    if (validOiData.length < 2) {
      logger.warn(`Registros válidos insuficientes para ${symbol} no timeframe ${timeframe}: ${validOiData.length} registros válidos`);
      if (retries > 0) {
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const currentOI = parseFloat(validOiData[0].openInterest);
    const previousOI = parseFloat(validOiData[1].openInterest);
    const oiPercentChange = previousOI !== 0 ? ((currentOI - previousOI) / previousOI * 100).toFixed(2) : '0.00';
    const usedField = validOiData[0].openInterest ? 'openInterest' : 
                     validOiData[0].openInterestAmount ? 'openInterestAmount' : 
                     (validOiData[0].info && validOiData[0].info.sumOpenInterest) ? 'sumOpenInterest' : 'unknown';
    logger.info(`Open Interest calculado para ${symbol} no timeframe ${timeframe}: currentOI=${currentOI}, previousOI=${previousOI}, percentChange=${oiPercentChange}%, usedField=${usedField}`);
    return {
      isRising: currentOI > previousOI,
      percentChange: oiPercentChange
    };
  } catch (e) {
    logger.warn(`Erro ao buscar Open Interest para ${symbol} no timeframe ${timeframe}: ${e.message}`);
    if (retries > 0) {
      logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return await fetchOpenInterest(symbol, timeframe, retries - 1);
    }
    return { isRising: false, percentChange: '0.00' };
  }
}

async function fetchFundingRate(symbol) {
  try {
    const fundingData = await exchangeFutures.fetchFundingRateHistory(symbol, undefined, 2);
    if (fundingData && fundingData.length >= 2) {
      const currentFunding = parseFloat(fundingData[fundingData.length - 1].fundingRate);
      const previousFunding = parseFloat(fundingData[fundingData.length - 2].fundingRate);
      const percentChange = previousFunding !== 0 ? ((currentFunding - previousFunding) / Math.abs(previousFunding) * 100).toFixed(2) : '0.00';
      return { current: currentFunding, isRising: currentFunding > previousFunding, percentChange };
    }
    return { current: null, isRising: false, percentChange: '0.00' };
  } catch (e) {
    logger.warn(`Erro ao buscar Funding Rate para ${symbol}: ${e.message}`);
    return { current: null, isRising: false, percentChange: '0.00' };
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

async function sendAlertScript1(symbol, data) {
  const { ohlcv15m, ohlcv3m, ohlcv1h, ohlcvDiario, ohlcv4h, price, wpr1h, wpr2h, rsi1h, atr, cvd, obv, lsr, fiValues, zonas, isOIRising, isOIRising15m, estocasticoD, estocastico4h, fundingRate } = data;
  const agora = Date.now();
  if (ultimoAlertaPorAtivo[symbol] && agora - ultimoAlertaPorAtivo[symbol] < TEMPO_COOLDOWN_MS) return;

  const fiBear3 = fiValues[fiValues.length - 1] < 0;
  const atrPercent = (atr / price) * 100;

  // Verificar e memorizar condição do WPR
  if (!wprTriggerState[symbol]) wprTriggerState[symbol] = { buyTriggered: false, sellTriggered: false };
  if (wpr1h <= WPR_LOW_THRESHOLD && wpr2h <= WPR_LOW_THRESHOLD) {
    wprTriggerState[symbol].buyTriggered = true;
  } else if (wpr1h >= WPR_HIGH_THRESHOLD && wpr2h >= WPR_HIGH_THRESHOLD) {
    wprTriggerState[symbol].sellTriggered = true;
  }

  if (!ultimoEstocastico[symbol]) ultimoEstocastico[symbol] = {};
  const kAnteriorD = ultimoEstocastico[symbol].kD || estocasticoD?.k || 0;
  const kAnterior4h = ultimoEstocastico[symbol].k4h || estocastico4h?.k || 0;
  ultimoEstocastico[symbol].kD = estocasticoD?.k;
  ultimoEstocastico[symbol].k4h = estocastico4h?.k;

  const direcaoD = getSetaDirecao(estocasticoD?.k, kAnteriorD);
  const direcao4h = getSetaDirecao(estocastico4h?.k, kAnterior4h);
  const stochDEmoji = estocasticoD ? getStochasticEmoji(estocasticoD.k) : "";
  const stoch4hEmoji = estocastico4h ? getStochasticEmoji(estocastico4h.k) : "";

  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => v.toFixed(precision);

  const entryLow = format(price - 0.3 * atr);
  const entryHigh = format(price + 0.5 * atr);
  const isSellSignal = wprTriggerState[symbol].sellTriggered && cvd < 0 && obv < 0 && rsi1h > 60 && !isOIRising && !isOIRising15m && (lsr.value === null || lsr.value >= 1.3) && fiBear3 && atrPercent >= ATR_PERCENT_MIN && atrPercent <= ATR_PERCENT_MAX;
  const targets = isSellSignal
   ? [2, 4, 6, 8].map(mult => format(price - mult * atr)).join(" / ")
   : [2, 4, 6, 8].map(mult => format(price + mult * atr)).join(" / ");
    // ? [3, 6, 9, 12].map(mult => format(price - mult * atr)).join(" / ")
     //: [3, 6, 9, 12].map(mult => format(price + mult * atr)).join(" / ");
  const stop = isSellSignal ? format(price + 3.0 * atr) : format(price - 3.0 * atr);

  const buyZonesText = zonas.buyLiquidityZones.map(format).join(' / ');
  const sellZonesText = zonas.sellLiquidityZones.map(format).join(' / ');

  let lsrSymbol = '🔸Consol.';
  if (lsr.value !== null) {
    if (lsr.value <= 1.3) lsrSymbol = '✅Baixo';
    else if (lsr.value >= 3) lsrSymbol = '📛Alto';
  }

  const rsi1hEmoji = rsi1h > 60 ? "✅" : rsi1h < 40 ? "✅" : "";
  let fundingRateEmoji = '';
  if (fundingRate.current !== null) {
    if (fundingRate.current <= -0.002) fundingRateEmoji = '🔴🔴🔴';
    else if (fundingRate.current <= -0.001) fundingRateEmoji = '🔴🔴';
    else if (fundingRate.current <= -0.0005) fundingRateEmoji = '🔴';
    else if (fundingRate.current >= 0.001) fundingRateEmoji = '🟢🟢🟢';
    else if (fundingRate.current >= 0.0003) fundingRateEmoji = '🟢🟢';
    else if (fundingRate.current >= 0.0002) fundingRateEmoji = '🟢';
    else fundingRateEmoji = '🟢';
  }
  const fundingRateText = fundingRate.current !== null 
    ? `${fundingRateEmoji} ${(fundingRate.current * 100).toFixed(5)}% ${fundingRate.isRising ? '⬆️' : '⬇️'}`
    : '🔹 Indisponível';
  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=60`;
  let alertText = `🔹Ativo: *${symbol}* [-🔗 TradingView](${tradingViewLink})\n` +
    `💲 Preço: ${format(price)}\n` +
    `   Captura de Liquid: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
    `   LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹 Moeda Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
    `   Funding Rate: ${fundingRateText}\n` +
    `   Stoch D %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
    `   Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
    `🔹 Entr.: ${entryLow}...${entryHigh}\n` +
    `🎯 Alvos: ${targets}\n` +
    `⛔ Stop: ${stop}\n` +
    `🔹 Romp. de Baixa: ${format(zonas.estruturaBaixa)} | Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
    `🔹 Liquid.Suporte: ${buyZonesText}\n` +
    `🔹 Liquid.Resistência : ${sellZonesText}\n`;

  if (wprTriggerState[symbol].buyTriggered && cvd > 0 && obv > 0 && (lsr.value === null || lsr.value < 2) && fiValues[fiValues.length - 1] > 0 && atrPercent >= ATR_PERCENT_MIN && atrPercent <= ATR_PERCENT_MAX) {
    await bot.api.sendMessage(TELEGRAM_CHAT_ID, `🟢 *Possível Compra*\n\n${alertText}`, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    ultimoAlertaPorAtivo[symbol] = agora;
    wprTriggerState[symbol].buyTriggered = false;
  } else if (isSellSignal) {
    await bot.api.sendMessage(TELEGRAM_CHAT_ID, `🔴 *Possível Correção*\n\n${alertText}`, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    ultimoAlertaPorAtivo[symbol] = agora;
    wprTriggerState[symbol].sellTriggered = false;
  }
}

async function checkConditions() {
  try {
    for (const symbol of PARES_MONITORADOS) {
      const ohlcv3mRaw = await exchangeSpot.fetchOHLCV(symbol, '3m', undefined, Math.max(FI_PERIOD + 2, 100));
      const ohlcv15mRaw = await exchangeSpot.fetchOHLCV(symbol, '15m', undefined, WPR_PERIOD + 1);
      const ohlcv1hRaw = await exchangeSpot.fetchOHLCV(symbol, '1h', undefined, WPR_PERIOD + 1);
      const ohlcv2hRaw = await exchangeSpot.fetchOHLCV(symbol, '2h', undefined, WPR_PERIOD + 1);
      const ohlcv4hRaw = await exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20);
      const ohlcvDiarioRaw = await exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 20);
      if (!ohlcv3mRaw || !ohlcv15mRaw || !ohlcv1hRaw || !ohlcv2hRaw || !ohlcv4hRaw || !ohlcvDiarioRaw) continue;

      const ohlcv3m = ohlcv3mRaw.map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
      const ohlcv15m = ohlcv15mRaw.map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
      const ohlcv1h = ohlcv1hRaw.map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
      const ohlcv2h = ohlcv2hRaw.map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));

      const closes3m = ohlcv3m.map(c => c.close);
      const currentPrice = closes3m[closes3m.length - 1];

      const wpr1hValues = calculateWPR(ohlcv1h);
      const wpr2hValues = calculateWPR(ohlcv2h);
      const rsi1hValues = calculateWPR(ohlcv1h); // Mantido para exibição no alerta
      const obvValues = calculateOBV(ohlcv3m);
      const cvd = calculateCVD(ohlcv3m);
      const lsr = await fetchLSR(symbol);
      const oi1h = await fetchOpenInterest(symbol, '1h');
      const oi5m = await fetchOpenInterest(symbol, '5m');
      const oi15m = await fetchOpenInterest(symbol, '15m');
      const fundingRate = await fetchFundingRate(symbol);

      const atrValues = calculateATR(ohlcv15m);
      const fiValues = calculateForceIndex(ohlcv3m, FI_PERIOD);
      const zonas = detectarQuebraEstrutura(ohlcv15m);
      const estocasticoD = calculateStochastic(ohlcvDiarioRaw, 5, 3, 3);
      const estocastico4h = calculateStochastic(ohlcv4hRaw, 5, 3, 3);
      if (wpr1hValues.length && wpr2hValues.length && rsi1hValues.length && atrValues.length && fiValues && fiValues.length) {
        await sendAlertScript1(symbol, {
          ohlcv15m, ohlcv3m, ohlcv1h, ohlcvDiario: ohlcvDiarioRaw, ohlcv4h: ohlcv4hRaw,
          price: currentPrice,
          wpr1h: wpr1hValues[wpr1hValues.length - 1],
          wpr2h: wpr2hValues[wpr2hValues.length - 1],
          rsi1h: rsi1hValues[rsi1hValues.length - 1],
          atr: atrValues[atrValues.length - 1],
          cvd, obv: obvValues[obvValues.length - 1], lsr, fiValues, zonas,
          isOIRising: oi1h.isRising, isOIRising5m: oi5m.isRising, isOIRising15m: oi15m.isRising,
          estocasticoD, estocastico4h, fundingRate
        });
      }
    }
  } catch (e) {
    logger.error(`Erro ao processar condições: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando Combined Trading Bot');
  try {
    await bot.api.sendMessage(TELEGRAM_CHAT_ID, '🤖 Titanium Radar Combined');
    await checkConditions();
    setInterval(checkConditions, INTERVALO_ALERTA_3M_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));
