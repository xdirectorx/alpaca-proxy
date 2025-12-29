const WebSocket = require('ws');

// Render가 제공하는 포트 사용 (없으면 8080)
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// 🔥 환경변수에서 Alpaca 키 가져오기 (Render 설정 메뉴에 입력할 것)
const APCA_API_KEY_ID = process.env.ALPACA_KEY_ID;
const APCA_API_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
// 무료/Paper 계좌는 'iex', 유료 계좌는 'sip'
const ALPACA_FEED = 'iex'; 
const ALPACA_URL = `wss://stream.data.alpaca.markets/v2/${ALPACA_FEED}`;

console.log(`🚀 Proxy Server running on port ${PORT}`);

wss.on('connection', (clientWs) => {
    console.log('Client connected');

    // 1. Alpaca 웹소켓 연결
    const alpacaWs = new WebSocket(ALPACA_URL);

    alpacaWs.on('open', () => {
        console.log('Connected to Alpaca');
        // 2. 인증 (서버가 대신 수행하므로 키 노출 안 됨)
        const authMsg = { action: 'auth', key: APCA_API_KEY_ID, secret: APCA_API_SECRET_KEY };
        alpacaWs.send(JSON.stringify(authMsg));
    });

    alpacaWs.on('message', (data) => {
        const msg = data.toString();
        const parsed = JSON.parse(msg);

        // 3. 인증 성공 시 -> 클라이언트가 요청한 종목들 구독 시작
        // (여기서는 간단하게 클라이언트가 보낸 메시지를 구독 요청으로 간주)
        
        // Alpaca 데이터를 클라이언트로 그대로 전달
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(msg);
        }
    });

    // 4. 클라이언트(insights.html)가 보낸 요청을 Alpaca로 토스
    clientWs.on('message', (message) => {
        if (alpacaWs.readyState === WebSocket.OPEN) {
            alpacaWs.send(message);
        }
    });

    // 연결 종료 처리
    clientWs.on('close', () => alpacaWs.close());
    alpacaWs.on('close', () => clientWs.close());
    alpacaWs.on('error', (e) => console.error('Alpaca Error:', e));
});