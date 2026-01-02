/**
 * Alpaca WebSocket Proxy Server
 * 
 * 역할: Alpaca와 단일 연결을 유지하면서,
 *       여러 클라이언트(a.com, b.com 등)에게 데이터를 브로드캐스팅
 * 
 * 기존 insights.html과 호환:
 * - 클라이언트: { action: 'subscribe', trades: ['AAPL'] } 형식 전송
 * - 서버: Alpaca 데이터를 그대로 브로드캐스트
 */

const WebSocket = require('ws');
const http = require('http');

// ============================================================
// 설정 (Configuration)
// ============================================================
const CONFIG = {
  // 프록시 서버 포트
  PORT: process.env.PORT || 8080,
  
  // Alpaca WebSocket URL
  // - IEX (무료): wss://stream.data.alpaca.markets/v2/iex
  // - SIP (유료, 실시간): wss://stream.data.alpaca.markets/v2/sip
  UPSTREAM_URL: process.env.ALPACA_WS_URL || 'wss://stream.data.alpaca.markets/v2/sip',
  
  // Alpaca API 인증 정보 (환경변수로 설정 권장)
  ALPACA_API_KEY: process.env.ALPACA_KEY_ID || '',
  ALPACA_API_SECRET: process.env.ALPACA_SECRET_KEY || '',
  
  // 재연결 설정 (지수 백오프)
  RECONNECT: {
    INITIAL_DELAY: 1000,      // 첫 재연결 시도까지 대기 (ms)
    MAX_DELAY: 30000,         // 최대 대기 시간 (ms)
    MULTIPLIER: 2,            // 지수 백오프 배율
  },
  
  // Health Check 설정
  HEARTBEAT: {
    INTERVAL: 30000,          // Ping 전송 주기 (ms)
    TIMEOUT: 10000,           // Pong 응답 대기 시간 (ms)
  },
  
  // ============================================================
  // CORS 설정 - 허용할 도메인 목록
  // ============================================================
  // 현재: 모든 도메인 허용 (개발용)
  ALLOWED_ORIGINS: null,  // null = 모든 도메인 허용
  
  // 🔒 프로덕션에서는 아래 주석을 해제하고 실제 도메인 입력:
  // ALLOWED_ORIGINS: [
  //   'https://your-domain.com',
  //   'https://www.your-domain.com',
  //   'https://another-domain.com',
  //   'http://localhost:3000',  // 로컬 개발용
  //   'http://localhost:5500',  // Live Server
  // ],
};

// ============================================================
// 상태 관리
// ============================================================
let upstreamWs = null;                    // Alpaca WebSocket 인스턴스
let reconnectAttempts = 0;                // 재연결 시도 횟수
let reconnectTimeout = null;              // 재연결 타이머
let isIntentionalClose = false;           // 의도적 종료 여부
let isAuthenticated = false;              // Alpaca 인증 완료 여부
const clients = new Set();                // 연결된 클라이언트 Set
const pendingSubscriptions = [];          // 인증 전 대기 중인 구독 요청

// 현재 구독 중인 종목 (모든 클라이언트의 구독을 통합 관리)
const activeSubscriptions = {
  trades: new Set(),
  quotes: new Set(),
  bars: new Set(),
};

// ============================================================
// 유틸리티 함수
// ============================================================

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  
  if (data) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function isOriginAllowed(origin) {
  // 모든 도메인 허용 모드
  if (CONFIG.ALLOWED_ORIGINS === null) {
    return true;
  }
  
  if (!origin) {
    return false;
  }
  
  return CONFIG.ALLOWED_ORIGINS.includes(origin);
}

function getReconnectDelay() {
  const delay = Math.min(
    CONFIG.RECONNECT.INITIAL_DELAY * Math.pow(CONFIG.RECONNECT.MULTIPLIER, reconnectAttempts),
    CONFIG.RECONNECT.MAX_DELAY
  );
  return delay;
}

// ============================================================
// Alpaca 업스트림 연결 관리 (Singleton Pattern)
// ============================================================

function connectToUpstream() {
  if (upstreamWs && (upstreamWs.readyState === WebSocket.CONNECTING || upstreamWs.readyState === WebSocket.OPEN)) {
    log('info', 'Upstream connection already exists, skipping...');
    return;
  }
  
  log('info', `Connecting to Alpaca: ${CONFIG.UPSTREAM_URL}`);
  
  try {
    upstreamWs = new WebSocket(CONFIG.UPSTREAM_URL);
    
    // 연결 성공
    upstreamWs.on('open', () => {
      log('info', '✅ Connected to Alpaca WebSocket');
      reconnectAttempts = 0;
      
      // Alpaca 인증
      if (CONFIG.ALPACA_API_KEY && CONFIG.ALPACA_API_SECRET) {
        log('info', 'Sending authentication...');
        upstreamWs.send(JSON.stringify({
          action: 'auth',
          key: CONFIG.ALPACA_API_KEY,
          secret: CONFIG.ALPACA_API_SECRET,
        }));
      } else {
        log('error', '❌ Alpaca API credentials not configured!');
      }
    });
    
    // 데이터 수신
    upstreamWs.on('message', (data) => {
      handleUpstreamMessage(data);
    });
    
    // 연결 종료
    upstreamWs.on('close', (code, reason) => {
      log('warn', `Alpaca connection closed. Code: ${code}, Reason: ${reason || 'N/A'}`);
      upstreamWs = null;
      isAuthenticated = false;
      
      if (!isIntentionalClose) {
        scheduleReconnect();
      }
    });
    
    // 에러
    upstreamWs.on('error', (error) => {
      log('error', 'Alpaca connection error:', error.message);
    });
    
  } catch (error) {
    log('error', 'Failed to create Alpaca connection:', error.message);
    scheduleReconnect();
  }
}

/**
 * Alpaca 메시지 처리
 */
function handleUpstreamMessage(rawData) {
  try {
    const messages = JSON.parse(rawData.toString());
    
    // Alpaca는 배열로 메시지를 보냄
    if (Array.isArray(messages)) {
      messages.forEach(msg => {
        // 인증 응답 처리
        if (msg.T === 'success' && msg.msg === 'authenticated') {
          log('info', '✅ Alpaca authentication successful');
          isAuthenticated = true;
          
          // 대기 중이던 구독 요청 처리
          processPendingSubscriptions();
          
          // 기존 구독 복원 (재연결 시)
          restoreSubscriptions();
        }
        
        // 에러 메시지
        if (msg.T === 'error') {
          log('error', `Alpaca error: ${msg.msg}`, msg);
        }
        
        // 구독 확인 메시지
        if (msg.T === 'subscription') {
          log('info', 'Subscription confirmed:', msg);
        }
      });
    }
    
    // 모든 클라이언트에게 브로드캐스트 (원본 그대로)
    broadcastToClients(rawData);
    
  } catch (error) {
    log('error', 'Failed to parse upstream message:', error.message);
    // 파싱 실패해도 일단 브로드캐스트 (바이너리 데이터 등)
    broadcastToClients(rawData);
  }
}

/**
 * 재연결 스케줄링
 */
function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  const delay = getReconnectDelay();
  reconnectAttempts++;
  
  log('info', `Scheduling reconnect in ${delay}ms (attempt #${reconnectAttempts})`);
  
  reconnectTimeout = setTimeout(() => {
    connectToUpstream();
  }, delay);
}

/**
 * 대기 중인 구독 요청 처리
 */
function processPendingSubscriptions() {
  while (pendingSubscriptions.length > 0) {
    const subRequest = pendingSubscriptions.shift();
    sendToUpstream(subRequest);
  }
}

/**
 * 기존 구독 복원 (재연결 시)
 */
function restoreSubscriptions() {
  const trades = Array.from(activeSubscriptions.trades);
  const quotes = Array.from(activeSubscriptions.quotes);
  const bars = Array.from(activeSubscriptions.bars);
  
  if (trades.length > 0 || quotes.length > 0 || bars.length > 0) {
    log('info', 'Restoring subscriptions after reconnect...');
    
    const subMsg = { action: 'subscribe' };
    if (trades.length > 0) subMsg.trades = trades;
    if (quotes.length > 0) subMsg.quotes = quotes;
    if (bars.length > 0) subMsg.bars = bars;
    
    sendToUpstream(JSON.stringify(subMsg));
  }
}

/**
 * 업스트림으로 메시지 전송
 */
function sendToUpstream(message) {
  if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
    upstreamWs.send(message);
    return true;
  }
  return false;
}

// ============================================================
// 클라이언트 메시지 처리
// ============================================================

/**
 * 클라이언트 구독 요청 처리
 */
/**
 * 클라이언트 메시지 처리 (수정됨)
 */
/**
 * 클라이언트 메시지 처리
 */
function handleClientMessage(ws, rawMessage) {
  try {
    const message = JSON.parse(rawMessage);
    
    // 🔥 [수정됨] 여기가 핵심입니다!
    // 봇이 "살아있니?"(ping)라고 물어보면
    // 알파카한테 전달하지 말고, 여기서 "응 살아있어"(pong)라고 대답하고 끝내야 합니다.
    if (message.action === 'ping') {
        // log('debug', 'Received keep-alive ping from client'); // 로그 너무 많으면 주석 처리
        ws.send(JSON.stringify({ type: 'pong' })); // 봇한테 안심시켜주기
        return; // ⛔ 중요: 여기서 함수를 강제 종료해서 밑으로 못 내려가게 막음!
    }

    log('debug', 'Client message:', message);
    
    // ... (아래는 기존 구독 로직 그대로 유지) ...
    if (message.action === 'subscribe' || message.action === 'unsubscribe') {
      const isSubscribe = message.action === 'subscribe';
      
      ['trades', 'quotes', 'bars'].forEach(type => {
        if (message[type] && Array.isArray(message[type])) {
          message[type].forEach(symbol => {
            if (isSubscribe) {
              activeSubscriptions[type].add(symbol.toUpperCase());
            } else {
              activeSubscriptions[type].delete(symbol.toUpperCase());
            }
          });
        }
      });
      
      if (isAuthenticated) {
        sendToUpstream(rawMessage);
      } else {
        log('info', 'Queuing subscription request (waiting for auth)...');
        pendingSubscriptions.push(rawMessage);
      }
    }
    
  } catch (error) {
    log('error', 'Failed to parse client message:', error.message);
  }
}

// ============================================================
// 브로드캐스팅
// ============================================================

function broadcastToClients(data) {
  const message = data.toString();
  let successCount = 0;
  
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        successCount++;
      } catch (error) {
        log('error', 'Failed to send to client:', error.message);
      }
    }
  });
}

// ============================================================
// Health Check (Ping/Pong)
// ============================================================

function startHeartbeat(ws) {
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
}

function heartbeatInterval() {
  setInterval(() => {
    clients.forEach((ws) => {
      if (ws.isAlive === false) {
        log('warn', 'Client heartbeat timeout, terminating');
        return ws.terminate();
      }
      
      ws.isAlive = false;
      ws.ping();
    });
  }, CONFIG.HEARTBEAT.INTERVAL);
}

function upstreamHeartbeat() {
  setInterval(() => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.ping();
    }
  }, CONFIG.HEARTBEAT.INTERVAL);
}

// ============================================================
// HTTP & WebSocket 서버
// ============================================================

const server = http.createServer((req, res) => {
  // Health Check 엔드포인트
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      upstreamConnected: upstreamWs?.readyState === WebSocket.OPEN,
      authenticated: isAuthenticated,
      clientCount: clients.size,
      subscriptions: {
        trades: Array.from(activeSubscriptions.trades),
        quotes: Array.from(activeSubscriptions.quotes),
        bars: Array.from(activeSubscriptions.bars),
      },
      timestamp: new Date().toISOString(),
    }));
    return;
  }
  
  // 기본 응답
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Alpaca WebSocket Proxy Server is running');
});

const wss = new WebSocket.Server({
  server,
  verifyClient: ({ origin }, callback) => {
    const allowed = isOriginAllowed(origin);
    
    if (!allowed) {
      log('warn', `Connection rejected from origin: ${origin}`);
      callback(false, 403, 'Forbidden: Origin not allowed');
      return;
    }
    
    log('info', `Connection accepted from origin: ${origin || 'N/A'}`);
    callback(true);
  },
});

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log('info', `📱 New client connected. IP: ${clientIp}, Total: ${clients.size + 1}`);
  
  clients.add(ws);
  startHeartbeat(ws);
  
  // 클라이언트 메시지 수신
  ws.on('message', (message) => {
    handleClientMessage(ws, message.toString());
  });
  
  // 연결 종료
  ws.on('close', (code, reason) => {
    log('info', `Client disconnected. Code: ${code}, Total: ${clients.size - 1}`);
    clients.delete(ws);
  });
  
  // 에러
  ws.on('error', (error) => {
    log('error', 'Client error:', error.message);
    clients.delete(ws);
  });
  
  // 연결 성공 메시지
  ws.send(JSON.stringify([{
    T: 'success',
    msg: 'connected',
    upstreamStatus: isAuthenticated ? 'authenticated' : 'connecting',
  }]));
});

// ============================================================
// 서버 시작
// ============================================================

server.listen(CONFIG.PORT, () => {
  log('info', `🚀 Alpaca Proxy Server started on port ${CONFIG.PORT}`);
  log('info', `   Upstream: ${CONFIG.UPSTREAM_URL}`);
  log('info', `   CORS: ${CONFIG.ALLOWED_ORIGINS ? 'Restricted' : 'All origins allowed'}`);
  
  // Alpaca 연결 시작
  connectToUpstream();
  
  // Heartbeat 체크 시작
  heartbeatInterval();
  upstreamHeartbeat();
});

// ============================================================
// Graceful Shutdown
// ============================================================

function shutdown() {
  log('info', 'Shutting down...');
  isIntentionalClose = true;
  
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (upstreamWs) upstreamWs.close(1000, 'Server shutdown');
  
  clients.forEach((client) => {
    client.close(1000, 'Server shutdown');
  });
  
  server.close(() => {
    log('info', 'Server shutdown complete');
    process.exit(0);
  });
  
  setTimeout(() => {
    log('error', 'Forced shutdown');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
