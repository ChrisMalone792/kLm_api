// Creates tables on first start. Safe to run every time.
require('dotenv').config();const {Client}=require('pg'),S=require('./schemas');
async function run(){const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
  try{const has=(await c.query("select to_regclass('public.users') t")).rows[0].t;
    if(!has)await c.query(S.v1);await c.query(S.v2)}finally{await c.end()}}
module.exports={run};
if(require.main===module)run().then(()=>console.log('migrated')).catch(e=>{console.error('Migration failed:',e.message);process.exit(1)});
