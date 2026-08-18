const https = require('https');
const API_KEY = 'rnd_nZopeREhaLAdfVZJ1HWOVkfdChGT';
const OWNER_ID = 'tea-da257bqjnfac73akuno0';

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.render.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Try with buildCommand inside envSpecificDetails
  const body = {
    ownerID: OWNER_ID,
    name: 'blue-ocean-api',
    type: 'web_service',
    repo: 'https://github.com/devso3939/Blue-Ocean.git',
    branch: 'main',
    autoDeploy: 'yes',
    serviceDetails: {
      runtime: 'python',
      buildCommand: 'cd frontend && npm ci && npm run build && cd ../backend && pip install -r requirements.txt',
      startCommand: 'cd backend && python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT',
      envSpecificDetails: {
        buildCommand: 'cd frontend && npm ci && npm run build && cd ../backend && pip install -r requirements.txt',
        startCommand: 'cd backend && python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT',
        pythonVersion: '3.12'
      }
    },
    envVars: [
      { key: 'PYTHON_VERSION', value: '3.12' },
      { key: 'BLUEOCEAN_DATA_DIR', value: '/data' }
    ]
  };
  
  console.log('Creating service...');
  const result = await apiCall('POST', '/v1/services', body);
  console.log('Status:', result.status);
  console.log(JSON.stringify(result.body, null, 2));
}

main().catch(console.error);
