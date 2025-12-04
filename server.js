const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.RESUME_AI_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID || 'asst_l7877S10rt2TO0Yvr1Nm6rxW';
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function handleChatProxy(req, res, body) {
  let parsedBody;
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const message = typeof parsedBody.message === 'string' ? parsedBody.message.trim() : '';
  if (!message) {
    sendJson(res, 400, { error: 'Message is required.' });
    return;
  }

  if (!API_KEY) {
    sendJson(res, 503, { error: 'AI assistant is unavailable. Please configure RESUME_AI_KEY on the server.' });
    return;
  }

  try {
    const commonHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'OpenAI-Beta': 'assistants=v2'
    };

    const threadResponse = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: message
          }
        ]
      })
    });

    const threadPayload = await threadResponse.json().catch(() => ({}));
    if (!threadResponse.ok) {
      const errorMessage = threadPayload?.error?.message || 'AI request failed.';
      sendJson(res, threadResponse.status, { error: errorMessage });
      return;
    }

    const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadPayload.id}/runs`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });

    const runPayload = await runResponse.json().catch(() => ({}));
    if (!runResponse.ok) {
      const errorMessage = runPayload?.error?.message || 'AI request failed.';
      sendJson(res, runResponse.status, { error: errorMessage });
      return;
    }

    let runStatus = runPayload.status;
    let runId = runPayload.id;

    while (runStatus === 'queued' || runStatus === 'in_progress') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const statusResponse = await fetch(
        `https://api.openai.com/v1/threads/${threadPayload.id}/runs/${runId}`,
        { headers: commonHeaders }
      );
      const statusPayload = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) {
        const errorMessage = statusPayload?.error?.message || 'AI request failed.';
        sendJson(res, statusResponse.status, { error: errorMessage });
        return;
      }
      runStatus = statusPayload.status;
    }

    if (runStatus !== 'completed') {
      sendJson(res, 500, { error: 'AI run did not complete successfully.' });
      return;
    }

    const messagesResponse = await fetch(
      `https://api.openai.com/v1/threads/${threadPayload.id}/messages?limit=1`,
      { headers: commonHeaders }
    );
    const messagesPayload = await messagesResponse.json().catch(() => ({}));
    if (!messagesResponse.ok) {
      const errorMessage = messagesPayload?.error?.message || 'AI request failed.';
      sendJson(res, messagesResponse.status, { error: errorMessage });
      return;
    }

    const latestMessage = messagesPayload?.data?.[0];
    const reply = latestMessage?.content?.[0]?.text?.value;

    sendJson(res, 200, {
      message: reply || "I wasn't able to find that answer—try another question or email Jake directly."
    });
  } catch (error) {
    sendJson(res, 502, { error: 'The AI is unavailable right now. Please try again shortly.' });
  }
}

function serveStaticFile(res, filePath) {
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const { method, url } = req;
  const [pathname] = (url || '/').split('?');

  if (method === 'POST' && pathname === '/api/chat') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.socket.destroy();
      }
    });

    req.on('end', () => handleChatProxy(req, res, body));
    return;
  }

  let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^\/+/, '');
  if (!safePath || safePath === '.' || safePath === '..') {
    safePath = 'index';
  }

  if (!path.extname(safePath)) {
    safePath = safePath.replace(/\/$/, '');
    safePath = `${safePath || 'index'}.html`;
  }

  const filePath = path.join(ROOT_DIR, safePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  serveStaticFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
