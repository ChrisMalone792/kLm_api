// Creates tables on first start. Safe to run every time.
require('dotenv').config();const fs=require('fs'),path=require('path'),{Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
  const has=(await c.query("select to_regclass('public.users') t")).rows[0].t;
  if(!has){await c.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));console.log('schema.sql applied')}
  await c.query(fs.readFileSync(path.join(__dirname,'schema_v2.sql'),'utf8'));console.log('schema_v2.sql applied');await c.end()})().catch(e=>{console.error('Migration failed:',e.message);process.exit(1)});
