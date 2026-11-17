const serverless = require('serverless-http');
const app = require('../../klmserver');
const { run } = require('../../klmmigrate');
const handle = serverless(app);
let ready;
exports.handler = async (event, context) => {
  ready = ready || run().catch((e) => { ready = null; throw e; });
  await ready;
  event.path = (event.path || '/').replace(/^\/\.netlify\/functions\/api/, '') || '/';
  return handle(event, context);
};
