
// ================= WEBSOCKET VOLUME DELTA ================= //
function startVolumeDeltaSocket(symbol) {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@trade`);
    volumeDeltaStore[symbol] = { buyVolume: new Decimal(0), sellVolume: new Decimal(0), normalizedDelta: new Decimal(0), lastUpdated: Date.now() };
    ws.on("message", (data) => {
        try {
            const trade = JSON.parse(data.toString());
            if (trade && trade.q !== undefined && trade.m !== undefined) {
                const quantity = new Decimal(trade.q || 0);
                if (trade.m) {
                    volumeDeltaStore[symbol].sellVolume = volumeDeltaStore[symbol].sellVolume.plus(quantity);
                } else {
                    volumeDeltaStore[symbol].buyVolume = volumeDeltaStore[symbol].buyVolume.plus(quantity);
                }
                volumeDeltaStore

[symbol].lastUpdated = Date.now();
            } else {
                console.warn(`[Volume Delta ${symbol}] Dados inválidos: ${JSON.stringify(trade)}`);
            }
        } catch (e) {
            console.error(`[WS ${symbol}] Erro ao processar mensagem: ${e.message}`);
        }
    });
    ws.on("open", () => console.log(`[WS ${symbol}] Conectado ao WebSocket de trades.`));
    ws.on("close", () => {
        console.log(`[WS ${symbol}] Desconectado do WebSocket de trades. Tentando reconectar...`);
        setTimeout(() => startVolumeDeltaSocket(symbol), 5000);
    });
    ws.on("error", (err) => console.error(`[WS ${symbol}] Erro: ${err.message}`));
}

PARES_MONITORADOS.forEach(startVolumeDeltaSocket);

setInterval(() => {
    for (const symbol in volumeDeltaStore) {
        const data = volumeDeltaStore[symbol];
        const totalVolume = data.buyVolume.plus(data.sellVolume);
        data.normalizedDelta = totalVolume.isZero() ? new Decimal(0) : data.buyVolume.minus(data.sellVolume).dividedBy(totalVolume);
        data.buyVolume = new Decimal(0);
        data.sellVolume = new Decimal(0);
        console.log(`[Volume Delta ${symbol}] Delta normalizado (1min): ${formatDecimal(data.normalizedDelta, 4)}`);
    }
}, 60000);
