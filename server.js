require('dotenv').config();
const express=require('express'),{Pool}=require('pg'),jwt=require('jsonwebtoken'),crypto=require('crypto');
const PROD=process.env.NODE_ENV==='production',FEE=+(process.env.FEE_PCT||3)/100;
const db=new Pool({connectionString:process.env.DATABASE_URL}),q=(s,p)=>db.query(s,p);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const bad=(m,s=400)=>Object.assign(new Error(m),{status:s});
const h=f=>(req,res)=>f(req,res).catch(e=>{if(!e.status)console.error(e);res.status(e.status||500).json({error:e.status?e.message:'server error'})});
async function tx(f){const c=await db.connect();try{await c.query('begin');await c.query('select pg_advisory_xact_lock(42)');const r=await f(c);await c.query('commit');return r}catch(e){await c.query('rollback');throw e}finally{c.release()}}
async function audit(c,actor,action,type,id,prev,next){
  const {rows}=await c.query('select hash from audit_trail order by seq desc limit 1'),ph=rows[0]?.hash||'GENESIS';
  const hash=sha(ph+action+type+id+JSON.stringify(next));
  await c.query('insert into audit_trail(actor_id,action,entity_type,entity_id,prev_state,new_state,prev_hash,hash) values($1,$2,$3,$4,$5,$6,$7,$8)',[actor,action,type,id,prev,next,ph,hash]);
}
async function rep(c,uid,d,why,ref){await c.query('insert into reputation_events(user_id,delta,reason,ref_id) values($1,$2,$3,$4)',[uid,d,why,ref]);await c.query('update users set reputation=greatest(0,reputation+$1) where id=$2',[d,uid])}
const auth=(...roles)=>(req,res,next)=>{try{req.user=jwt.verify((req.headers.authorization||'').slice(7),process.env.JWT_SECRET)}catch{return res.status(401).json({error:'unauthorized'})}
  if(roles.length&&!roles.includes(req.user.role))return res.status(403).json({error:'forbidden'});next()};

/* ---- M-Pesa (Daraja). Without keys, dev mode simulates a successful payment. ---- */
async function stkPush(phone,amount,ref){
  const k=process.env.MPESA_CONSUMER_KEY;if(!k){if(PROD)throw bad('M-Pesa not configured',500);return{simulated:true,checkout:'SIM-'+ref}}
  const base='https://sandbox.safaricom.co.ke',tok=(await(await fetch(base+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+Buffer.from(k+':'+process.env.MPESA_CONSUMER_SECRET).toString('base64')}})).json()).access_token;
  const ts=new Date().toISOString().replace(/\D/g,'').slice(0,14),sc=process.env.MPESA_SHORTCODE;
  const r=await(await fetch(base+'/mpesa/stkpush/v1/processrequest',{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},body:JSON.stringify({BusinessShortCode:sc,Password:Buffer.from(sc+process.env.MPESA_PASSKEY+ts).toString('base64'),Timestamp:ts,TransactionType:'CustomerPayBillOnline',Amount:Math.ceil(amount),PartyA:phone,PartyB:sc,PhoneNumber:phone,CallBackURL:process.env.MPESA_CALLBACK_URL,AccountReference:ref.slice(0,12),TransactionDesc:'KLM escrow'})})).json();
  if(!r.CheckoutRequestID)throw bad('STK push failed',502);return{checkout:r.CheckoutRequestID};
}
async function markFunded(c,txId){
  const t=(await c.query("update escrow_transactions set status='funded' where id=$1 and status='pending' returning contract_id",[txId])).rows[0];if(!t)return;
  await c.query("update contracts set status='funded' where id=$1",[t.contract_id]);await audit(c,null,'contract_funded','contract',t.contract_id,{status:'pending'},{status:'funded'});
}

const app=express();app.use(express.json({limit:'1mb'}));
app.get('/health',(_,res)=>res.json({ok:true}));
app.get('/sectors',h(async(_,res)=>res.json((await q('select s.*,(select json_agg(k) from skills k where k.sector_id=s.id) skills from sectors s')).rows)));

/* ---- Auth: phone OTP ---- */
app.post('/auth/otp/request',h(async(req,res)=>{
  const ph=String(req.body.phone||'').replace(/\D/g,'');if(!/^254\d{9}$/.test(ph))throw bad('Use format 2547XXXXXXXX');
  if((await q("select count(*) from otp_codes where phone=$1 and expires_at>now()-interval '4 minutes'",[ph])).rows[0].count>=3)throw bad('Too many codes, wait a few minutes',429);
  const code=String(crypto.randomInt(100000,999999));
  await q("insert into otp_codes(phone,code_hash,expires_at) values($1,$2,now()+interval '5 minutes')",[ph,sha(code)]);
  // TODO: send via an SMS gateway (e.g. Africa's Talking). Dev only: code is returned.
  res.json({sent:true,...(PROD?{}:{devCode:code})});}));
app.post('/auth/otp/verify',h(async(req,res)=>{
  const ph=String(req.body.phone||'').replace(/\D/g,''),role=['worker','client','insurer'].includes(req.body.role)?req.body.role:'worker';
  const o=(await q('select * from otp_codes where phone=$1 and not used and expires_at>now() order by expires_at desc limit 1',[ph])).rows[0];
  if(!o||o.attempts>=5)throw bad('Code expired, request a new one',401);
  await q('update otp_codes set attempts=attempts+1 where id=$1',[o.id]);
  if(o.code_hash!==sha(String(req.body.code)))throw bad('Wrong code',401);
  await q('update otp_codes set used=true where id=$1',[o.id]);
  const r=ph===process.env.ADMIN_PHONE?'admin':role;
  const u=(await q("insert into users(phone,role,kyc) values($1,$2,'verified') on conflict(phone) do update set kyc='verified' returning id,role,insurer_id,reputation",[ph,r])).rows[0];
  res.json({token:jwt.sign({id:u.id,role:u.role,insurer_id:u.insurer_id},process.env.JWT_SECRET,{expiresIn:'7d'}),user:u});}));
app.get('/me',auth(),h(async(req,res)=>res.json((await q('select id,phone,role,kyc,reputation,insurer_id from users where id=$1',[req.user.id])).rows[0])));

/* ---- Verification: credential check -> review -> outcome tracking ---- */
app.post('/verification',auth('worker'),h(async(req,res)=>{
  const {skill_id,credential_ref}=req.body;if(!skill_id||!credential_ref)throw bad('skill_id and credential_ref required');
  res.json((await q('insert into verification_records(user_id,skill_id,credential_ref) values($1,$2,$3) returning *',[req.user.id,skill_id,credential_ref])).rows[0]);}));
app.post('/verification/:id/review',auth('admin'),h(async(req,res)=>{
  const score=+req.body.score,pass=score>=70;
  res.json(await tx(async c=>{
    const r=(await c.query("update verification_records set score=$1,status=$2,reviewer_id=$3,expires_at=case when $2='passed' then now()+interval '1 year' end where id=$4 and status='pending' returning *",[score,pass?'passed':'failed',req.user.id,req.params.id])).rows[0];
    if(!r)throw bad('Not found or already reviewed',404);
    await rep(c,r.user_id,pass?1:-2,pass?'verification_passed':'verification_failed',r.id);
    await audit(c,req.user.id,pass?'verification_passed':'verification_failed','verification',r.id,{status:'pending'},{status:r.status,score});return r;}));}));

/* ---- Problems and matching ---- */
async function createProblem(c,u,b){
  const s=(await c.query('select * from sectors where id=$1',[b.sector_id])).rows[0];if(!s||!b.title)throw bad('title and valid sector_id required');
  const bounty=+b.bounty||Math.round((s.min_rate+s.max_rate)/2*s.std_hours);
  const p=(await c.query('insert into active_problems(title,description,sector_id,severity,lat,lng,source,bounty,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[b.title,b.description,b.sector_id,b.severity||'medium',b.lat,b.lng,b.source||'manual',bounty,u])).rows[0];
  await audit(c,u,'problem_created','problem',p.id,null,{sector:p.sector_id,bounty});return p;}
app.post('/problems',auth(),h(async(req,res)=>res.json(await tx(c=>createProblem(c,req.user.id,req.body)))));
app.get('/problems',auth(),h(async(req,res)=>res.json((await q('select * from active_problems where ($1::text is null or status=$1) order by created_at desc limit 100',[req.query.status||null])).rows)));
async function match(c,problemId,payer,claimId){
  const p=(await c.query("select * from active_problems where id=$1 and status in('detected','matching') for update",[problemId])).rows[0];if(!p)throw bad('Problem not found or already dispatched',404);
  const w=await require('./brain').pickWorker(c,p);
  if(!w)throw bad('No verified, available worker for this sector yet',409);
  const fee=+(p.bounty*FEE).toFixed(2);
  const k=(await c.query('insert into contracts(problem_id,claim_id,worker_id,payer_id,sector_id,total,fee) values($1,$2,$3,$4,$5,$6,$7) returning *',[p.id,claimId||null,w.id,payer,p.sector_id,p.bounty,fee])).rows[0];
  await c.query("insert into dispatches(problem_id,worker_id) values($1,$2)",[p.id,w.id]);await c.query('update worker_profiles set active_jobs=active_jobs+1 where user_id=$1',[w.id]);
  await c.query("update active_problems set status='dispatched' where id=$1",[p.id]);
  await audit(c,payer,'worker_dispatched','contract',k.id,null,{worker:w.id});return k;}
app.post('/problems/:id/match',auth('admin','client','insurer'),h(async(req,res)=>res.json(await tx(c=>match(c,req.params.id,req.user.id)))));

/* ---- Worker profile ---- */
app.put('/profile',auth('worker'),h(async(req,res)=>res.json((await q('insert into worker_profiles(user_id,full_name,county,bio) values($1,$2,$3,$4) on conflict(user_id) do update set full_name=$2,county=$3,bio=$4 returning *',[req.user.id,req.body.full_name,req.body.county,req.body.bio])).rows[0])));

/* ---- Contracts and escrow ---- */
const getK=async(id)=>{const k=(await q('select c.*,s.req_gps,s.req_photo,s.req_signature from contracts c join sectors s on s.id=c.sector_id where c.id=$1',[id])).rows[0];if(!k)throw bad('Contract not found',404);return k};
app.get('/contracts',auth(),h(async(req,res)=>res.json((await q('select * from contracts where worker_id=$1 or payer_id=$1 or $2=\'admin\' order by created_at desc limit 100',[req.user.id,req.user.role])).rows)));
app.post('/contracts/:id/fund',auth('client','insurer','admin'),h(async(req,res)=>{
  const k=await getK(req.params.id);if(k.status!=='pending')throw bad('Contract is '+k.status);
  const ph=String(req.body.phone||'').replace(/\D/g,'');if(!/^254\d{9}$/.test(ph))throw bad('Payer phone required (2547XXXXXXXX)');
  const r=await stkPush(ph,k.total,k.id);
  res.json(await tx(async c=>{const t=(await c.query("insert into escrow_transactions(contract_id,kind,amount,checkout_id) values($1,'funding',$2,$3) returning id",[k.id,k.total,r.checkout])).rows[0];
    if(r.simulated)await markFunded(c,t.id);return{escrow_tx:t.id,simulated:!!r.simulated,message:r.simulated?'Dev mode: payment simulated':'Check the phone for the M-Pesa prompt'}}));}));
app.post('/mpesa/callback',h(async(req,res)=>{ // TODO: restrict to Safaricom IPs / secret path before production
  const cb=req.body?.Body?.stkCallback;await q('insert into webhook_events(source,payload) values($1,$2)',['mpesa',req.body]);
  if(cb&&cb.ResultCode===0)await tx(async c=>{const t=(await c.query("update escrow_transactions set mpesa_ref=$2 where checkout_id=$1 returning id",[cb.CheckoutRequestID,(cb.CallbackMetadata?.Item||[]).find(i=>i.Name==='MpesaReceiptNumber')?.Value])).rows[0];if(t)await markFunded(c,t.id)});
  res.json({ResultCode:0,ResultDesc:'Accepted'});}));
app.post('/contracts/:id/accept',auth('worker'),h(async(req,res)=>{
  const r=await q("update contracts set status='in_progress' where id=$1 and worker_id=$2 and status='funded' returning id",[req.params.id,req.user.id]);if(!r.rowCount)throw bad('Not fundable or not yours',409);res.json({status:'in_progress'});}));
app.post('/contracts/:id/proof',auth('worker'),h(async(req,res)=>{
  const k=await getK(req.params.id),b=req.body,miss=[];if(k.worker_id!==req.user.id||k.status!=='in_progress')throw bad('Not your active contract',409);
  if(k.req_gps&&!(b.lat&&b.lng))miss.push('GPS location');if(k.req_photo&&!b.photo_url)miss.push('photo');if(k.req_signature&&!b.signature)miss.push('client signature');
  if(miss.length)throw bad('Missing proof: '+miss.join(', '));
  res.json(await tx(async c=>{await c.query('insert into proofs(contract_id,lat,lng,photo_url,signature) values($1,$2,$3,$4,$5)',[k.id,b.lat,b.lng,b.photo_url,b.signature]);
    await c.query("update contracts set status='proof_submitted' where id=$1",[k.id]);await audit(c,req.user.id,'proof_submitted','contract',k.id,{status:'in_progress'},{status:'proof_submitted'});return{status:'proof_submitted'}}));}));
app.post('/contracts/:id/release',auth('client','insurer','admin'),h(async(req,res)=>{
  res.json(await tx(async c=>{const k=(await c.query("update contracts set status='released' where id=$1 and status='proof_submitted' returning *",[req.params.id])).rows[0];if(!k)throw bad('Contract is not awaiting release',409);
    await c.query("insert into escrow_transactions(contract_id,kind,amount,status) values($1,'payout',$2,'queued')",[k.id,k.total-k.fee]); // TODO: Daraja B2C payout worker
    await c.query("update active_problems set status='resolved' where id=$1",[k.problem_id]);if(k.claim_id)await c.query("update claims set status='paid' where id=$1",[k.claim_id]);
    await rep(c,k.worker_id,1,'contract_verified',k.id);await c.query('update worker_profiles set active_jobs=greatest(0,active_jobs-1) where user_id=$1',[k.worker_id]);await audit(c,req.user.id,'contract_released','contract',k.id,{status:'proof_submitted'},{status:'released',payout:k.total-k.fee});return{status:'released',payout:k.total-k.fee,fee:k.fee}}));}));
app.post('/contracts/:id/dispute',auth(),h(async(req,res)=>res.json(await tx(async c=>{
  const k=(await c.query("update contracts set status='disputed' where id=$1 and status in('in_progress','proof_submitted') and (worker_id=$2 or payer_id=$2 or $3='admin') returning id",[req.params.id,req.user.id,req.user.role])).rows[0];if(!k)throw bad('Cannot dispute this contract',409);
  const d=(await c.query('insert into disputes(contract_id,raised_by,reason) values($1,$2,$3) returning *',[k.id,req.user.id,req.body.reason])).rows[0];
  await audit(c,req.user.id,'contract_disputed','contract',k.id,null,{reason:req.body.reason});return d}))));
app.post('/disputes/:id/resolve',auth('admin'),h(async(req,res)=>{const worker=req.body.outcome==='worker';
  res.json(await tx(async c=>{const d=(await c.query("update disputes set status='resolved',outcome=$2,resolved_by=$3 where id=$1 and status='open' returning *",[req.params.id,req.body.outcome,req.user.id])).rows[0];if(!d)throw bad('Not found',404);
    const k=(await c.query('select * from contracts where id=$1',[d.contract_id])).rows[0];
    await c.query('update contracts set status=$2 where id=$1',[k.id,worker?'released':'refunded']);await c.query('update worker_profiles set active_jobs=greatest(0,active_jobs-1) where user_id=$1',[k.worker_id]);
    await c.query("insert into escrow_transactions(contract_id,kind,amount,status) values($1,$2,$3,'queued')",[k.id,worker?'payout':'refund',worker?k.total-k.fee:k.total]);
    if(worker)await rep(c,k.worker_id,1,'dispute_won',k.id);else await rep(c,k.worker_id,-2,'contract_disputed',k.id);
    await audit(c,req.user.id,'dispute_resolved','contract',k.id,null,{outcome:req.body.outcome});return d}));}));

/* ---- Insurer portal ---- */
app.post('/claims',auth('insurer','admin'),h(async(req,res)=>{const b=req.body,ins=req.user.insurer_id||b.insurer_id;if(!ins)throw bad('Your account is not linked to an insurer yet',403);
  res.json(await tx(async c=>{const p=await createProblem(c,req.user.id,{...b,source:'api',bounty:b.amount});
    const cl=(await c.query('insert into claims(insurer_id,policy_ref,problem_id,amount) values($1,$2,$3,$4) returning *',[ins,b.policy_ref,p.id,p.bounty])).rows[0];
    await audit(c,req.user.id,'claim_received','claim',cl.id,null,{amount:cl.amount});return cl}));}));
app.post('/claims/:id/dispatch',auth('insurer','admin'),h(async(req,res)=>res.json(await tx(async c=>{
  const cl=(await c.query('select * from claims where id=$1 and ($2::uuid is null or insurer_id=$2)',[req.params.id,req.user.insurer_id])).rows[0];if(!cl)throw bad('Claim not found',404);
  const k=await match(c,cl.problem_id,req.user.id,cl.id);await c.query("update claims set status='dispatched' where id=$1",[cl.id]);return k}))));
app.get('/claims',auth('insurer','admin'),h(async(req,res)=>res.json((await q('select * from claims where ($1::uuid is null or insurer_id=$1) order by created_at desc limit 100',[req.user.insurer_id])).rows)));
app.get('/insurer/summary',auth('insurer','admin'),h(async(req,res)=>res.json((await q("select count(*) claims,coalesce(sum(amount) filter(where status='paid'),0) paid,count(*) filter(where status='paid') settled,coalesce(avg(extract(epoch from now()-created_at)/3600) filter(where status='paid'),0)::int hours_open from claims where ($1::uuid is null or insurer_id=$1)",[req.user.insurer_id])).rows[0])));
app.post('/admin/insurers',auth('admin'),h(async(req,res)=>res.json(await tx(async c=>{const i=(await c.query('insert into insurers(name,license_no) values($1,$2) returning *',[req.body.name,req.body.license_no])).rows[0];
  if(req.body.user_phone)await c.query("update users set insurer_id=$1,role='insurer' where phone=$2",[i.id,req.body.user_phone]);return i}))));

/* ---- Tamper-evident ledger ---- */
app.get('/ledger',auth(),h(async(req,res)=>res.json((await q('select seq,action,entity_type,entity_id,hash,created_at from audit_trail order by seq desc limit 100')).rows)));
app.get('/ledger/verify',auth('admin'),h(async(_,res)=>{let ph='GENESIS',n=0;const {rows}=await q('select * from audit_trail order by seq');
  for(const r of rows){if(r.prev_hash!==ph||r.hash!==sha(ph+r.action+r.entity_type+r.entity_id+JSON.stringify(r.new_state)))return res.json({valid:false,broken_at:r.seq});ph=r.hash;n++}res.json({valid:true,entries:n})}));

require('./brain')(app,{q,tx,h,bad,auth,audit,createProblem,sha});
const port=process.env.PORT||3000;if(!process.env.JWT_SECRET){console.error('JWT_SECRET is required');process.exit(1)}
app.listen(port,()=>console.log('KLM core on :'+port));
