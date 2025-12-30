const WebSocket = require('ws');

// Render 포트 설정
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// 🔥 환경변수 키 가져오기
const APCA_API_KEY_ID = process.env.ALPACA_KEY_ID;
const APCA_API_SECRET_KEY = process.env.ALPACA_SECRET_KEY;

// 🔥 [중요] SIP(유료) 사용 시 'sip', 무료는 'iex'
const ALPACA_FEED = 'sip'; 
const ALPACA_URL = `wss://stream.data.alpaca.markets/v2/${ALPACA_FEED}`;

console.log(`🚀 Proxy Server running on port ${PORT} | Feed: ${ALPACA_FEED}`);

wss.on('connection', (clientWs) => {
    console.log('Client connected. Opening Alpaca connection...');

    // 1. 대기열 생성 (Alpaca 연결 전에 온 요청을 임시 저장)
    let messageQueue = [];
    let isAlpacaReady = false;

    // 2. Alpaca 웹소켓 연결
    const alpacaWs = new WebSocket(ALPACA_URL);

    alpacaWs.on('open', () => {
        console.log('✅ Connected to Alpaca. Sending Auth...');
        const authMsg = { action: 'auth', key: APCA_API_KEY_ID, secret: APCA_API_SECRET_KEY };
        alpacaWs.send(JSON.stringify(authMsg));
    });

    alpacaWs.on('message', (data) => {
        const msg = data.toString();
        
        try {
            const parsed = JSON.parse(msg);
            
            // 3. 인증 성공 확인 (authorization -> authenticated)
            if (Array.isArray(parsed)) {
                const authMsg = parsed.find(m => m.T === 'success' && m.msg === 'authenticated');
                
                if (authMsg) {
                    console.log('🔓 Alpaca Authenticated! Releasing queue...');
                    isAlpacaReady = true;

                    // 🔥 [핵심] 그동안 쌓인 구독 요청(trades: ["AAPL"])을 이제 발송!
                    while (messageQueue.length > 0) {
                        const queuedMsg = messageQueue.shift();
                        alpacaWs.send(queuedMsg);
                        console.log("📨 Sent queued message:", queuedMsg);
                    }
                }
            }
            
            // 4. Alpaca에서 온 실시간 데이터를 차트(클라이언트)로 토스
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(msg);
            }

        } catch (e) {
            console.error("Msg Parse Error:", e);
        }
    });

    // 5. 차트(insights.html)에서 보낸 구독 요청 처리
    clientWs.on('message', (message) => {
        const msgStr = message.toString();
        
        if (isAlpacaReady && alpacaWs.readyState === WebSocket.OPEN) {
            // 이미 연결돼있으면 바로 전송
            alpacaWs.send(msgStr);
            console.log("👉 Forwarding:", msgStr);
        } else {
            // 🔥 아직 연결 안 됐으면 대기열에 저장 (이게 없어서 안 됐던 것임)
            console.log("⏳ Buffering message:", msgStr);
            messageQueue.push(msgStr);
        }
    });

    clientWs.on('close', () => {
        console.log('Client disconnected.');
        if(alpacaWs.readyState === WebSocket.OPEN) alpacaWs.close();
    });
    
    alpacaWs.on('error', (err) => console.error('🔥 Alpaca Error:', err));
});
