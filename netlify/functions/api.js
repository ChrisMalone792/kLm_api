const serverless = require('serverless-http');
const app = require('../../klmserver');
const { run } = require('../../klmmigrate');
const handle = serverless(app);
const ORIGINS = ['https://klm-kenya-live-market.netlify.app'];
let ready;
exports.handler = async (event, context) => {
  const o = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const cors = {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Vary': 'Origin'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  ready = ready || run().catch((e) => { ready = null; throw e; });
  await ready;
  event.path = (event.path || '/').replace(/^\/\.netlify\/functions\/api/, '') || '/';
  const r = await handle(event, context);
  r.headers = Object.assign({}, r.headers, cors);
  return r;
};
