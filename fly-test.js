const https = require('https');

// The user gave a token that contains embedded URLs separated by newlines
// Let me extract just the bearer token part
// Looking at the raw token, it seems like: FlyV1 <base64-encoded-token>
// The base64 part is: fm2_lJPECAAAAAAAF6rFxBCockWV8GkBKEe2pTxjfl62wrVodHRwczovL2FwaS5mbHkuaW8vdjGUAJLOABywZh8Lk7lodHRwczovL2FwaS5mbHkuaW8vYWFhL3YxxDy7NCf878jhNKa1jzWbjVN+x8vqddUZs4CsBOnFS+rQjU1dMSapNPzaSUEVTITlMeJgOGxXauORa36e4OHETgcdA/L3OtpuB6a4Dapow+xrGUB4LtRI5cnJjxzJyyPaa/2MLr7tMWKdg6Zp+Tqqk0MJHOoQLYjJT1pHDQYVgddlXM60h/3uUZvVtUnCEcQglM/VAM/kN+u0aM1mtKZVyaR2sQu2SdV1k1IYDOZY1lE=

// Actually this token might be a session token, not an API token
// Let me try using it with the full raw value
const fullToken = `FlyV1 fm2_lJPECAAAAAAAF6rFxBCockWV8GkBKEe2pTxjfl62wrVodHRwczovL2FwaS5mbHkuaW8vdjGUAJLOABywZh8Lk7lodHRwczovL2FwaS5mbHkuaW8vYWFhL3YxxDy7NCf878jhNKa1jzWbjVN+x8vqddUZs4CsBOnFS+rQjU1dMSapNPzaSUEVTITlMeJgOGxXauORa36e4OHETgcdA/L3OtpuB6a4Dapow+xrGUB4LtRI5cnJjxzJyyPaa/2MLr7tMWKdg6Zp+Tqqk0MJHOoQLYjJT1pHDQYVgddlXM60h/3uUZvVtUnCEcQglM/VAM/kN+u0aM1mtKZVyaR2sQu2SdV1k1IYDOZY1lE=`;

// Second token from user message
const token2 = `FlyV1 fm2_lJPETgcdA/L3OtpuB6a4Dapow+xrGUB4LtRI5cnJjxzJyyPaa/2MLr7tMWKdg6Zp+Tqqk0MJHOoQLYjJT1pHDQYVgddlXM60h/3uUZvVtUnCEcQQ+vfs7No3TdPrKja8MnsRlcO5HR0cHM6Ly9hcGkuZmx5LmlvL2FhYS92MZgEks5qhFdDzwAAAAEmfHVhF84AG3YPCpHOABt2DwzEEFk4a6Q4jplPwxFBiIKNIXHEIAub/y3tuCsJqpVn/zS/AewKYXhtnsGxFB3Om/U3Xbre`;

async function testToken(token, label) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: '{ apps { nodes { id name } } }' });
    const options = {
      hostname: 'api.fly.io',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log(`${label} (${res.statusCode}):`, d.substring(0, 300));
        resolve();
      });
    });
    req.on('error', (e) => console.log(`${label} error:`, e.message));
    req.write(body);
    req.end();
  });
}

async function main() {
  await testToken(fullToken, 'Token 1');
  await testToken(token2, 'Token 2');
}

main();
